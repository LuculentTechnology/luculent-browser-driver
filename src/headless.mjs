// Headless (or headed) Chrome launched by the relay and driven over raw CDP (no extension needed).
import { spawn } from 'node:child_process';
import { mkdtempSync, existsSync, readFileSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function findChrome() {
  if (process.env.LBD_CHROME && existsSync(process.env.LBD_CHROME)) return process.env.LBD_CHROME;
  const c = [];
  if (process.platform === 'win32') {
    for (const base of [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA].filter(Boolean)) c.push(join(base, 'Google', 'Chrome', 'Application', 'chrome.exe'));
  } else if (process.platform === 'darwin') {
    c.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
  } else {
    c.push('/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser');
  }
  const found = c.find((p) => existsSync(p));
  return found || findPlaywrightChromium();
}

export function findPlaywrightChromium() {
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH || (process.platform === 'win32' ? join(process.env.LOCALAPPDATA || '', 'ms-playwright') : join(homedir(), '.cache', 'ms-playwright'));
  if (!existsSync(root)) return null;
  const dirs = readdirSync(root).filter((d) => /^chromium-\d+$/.test(d)).sort().reverse();
  for (const d of dirs) {
    for (const rel of ['chrome-win64/chrome.exe', 'chrome-win/chrome.exe', 'chrome-linux/chrome', 'chrome-linux64/chrome', 'chrome-mac/Chromium.app/Contents/MacOS/Chromium']) {
      const p = join(root, d, rel);
      if (existsSync(p)) return p;
    }
  }
  return null;
}

export class CdpConnection {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.id = 0;
    this.pending = new Map();
    this.listeners = new Set();
  }
  open() {
    return new Promise((res, rej) => {
      const ws = new WebSocket(this.wsUrl, { perMessageDeflate: false, maxPayload: 512 * 1024 * 1024 });
      this.ws = ws;
      ws.once('open', () => { ws._socket && ws._socket.setNoDelay(true); res(this); });
      ws.once('error', rej);
      ws.on('message', (buf) => {
        const m = JSON.parse(buf.toString());
        if (m.id != null) {
          const p = this.pending.get(m.id);
          if (!p) return;
          this.pending.delete(m.id);
          if (m.error) p.rej(new Error(m.error.message + (m.error.data ? ': ' + m.error.data : ''))); else p.res(m.result);
        } else for (const l of this.listeners) l(m);
      });
      ws.on('close', () => { for (const p of this.pending.values()) p.rej(new Error('Target closed (CDP socket closed)')); this.pending.clear(); this.closed = true; });
    });
  }
  send(method, params = {}, sessionId, timeout = 30000) {
    if (this.closed) return Promise.reject(new Error('Target closed (CDP socket closed)'));
    const id = ++this.id;
    return new Promise((res, rej) => {
      const timer = setTimeout(() => { this.pending.delete(id); rej(new Error(`CDP ${method} timed out after ${timeout}ms`)); }, timeout);
      this.pending.set(id, { res: (v) => { clearTimeout(timer); res(v); }, rej: (e) => { clearTimeout(timer); rej(e); } });
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }
  close() { try { this.ws.close(); } catch (_) {} }
}

let browserSeq = 0;

export class HeadlessBrowser {
  static async launch({ chromePath = findChrome(), headless = true, extensionPath, userDataDir, args = [] } = {}) {
    if (!chromePath) throw new Error('No Chrome/Chromium found. Set LBD_CHROME to chrome.exe');
    const udd = userDataDir || mkdtempSync(join(tmpdir(), 'lbd-chrome-'));
    const argv = [
      ...(headless ? ['--headless=new'] : []),
      '--remote-debugging-port=0', `--user-data-dir=${udd}`, '--no-first-run', '--no-default-browser-check',
      '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
      '--disable-features=Translate,MediaRouter,OptimizationHints,HttpsFirstBalancedModeAutoEnable,HttpsUpgrades', '--disable-sync', '--metrics-recording-only', '--password-store=basic', ...(headless && !args.some((a) => a.startsWith('--window-size')) ? ['--window-size=1366,900'] : []),
      ...(extensionPath ? [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`] : ['--disable-extensions']),
      ...args, 'about:blank',
    ];
    const proc = spawn(chromePath, argv, { stdio: 'ignore', windowsHide: true, detached: false });
    const portFile = join(udd, 'DevToolsActivePort');
    const deadline = Date.now() + 20000;
    let wsUrl = null;
    while (Date.now() < deadline) {
      if (existsSync(portFile)) {
        let txt = '';
        try { txt = readFileSync(portFile, 'utf8'); } catch (_) { /* Chrome still writing it (EBUSY on Windows) */ }
        const [port, path] = txt.trim().split(/\r?\n/);
        if (port && path) { wsUrl = `ws://127.0.0.1:${port}${path}`; break; }
      }
      // Branded Chrome on Windows may hand off to a child process and exit 0; keep waiting for the port file.
      if (proc.exitCode != null && proc.exitCode !== 0) throw new Error(`Chrome exited early (code ${proc.exitCode})`);
      await sleep(50);
    }
    if (!wsUrl) { proc.kill(); throw new Error('Chrome did not open a DevTools port within 20s'); }
    const conn = await new CdpConnection(wsUrl).open();
    const b = new HeadlessBrowser(conn, proc, udd, !userDataDir);
    b.id = 'h' + (++browserSeq);
    b.headless = headless;
    await conn.send('Target.setDiscoverTargets', { discover: true });
    conn.listeners.add((m) => {
      if (m.method === 'Target.targetDestroyed') b.forgetTarget(m.params.targetId);
      if (m.method === 'Target.detachedFromTarget') for (const [k, v] of b.tabs) if (v.sessionId === m.params.sessionId) v.sessionId = null;
      if (m.method === 'Target.targetInfoChanged') { const t = [...b.tabs.values()].find((x) => x.targetId === m.params.targetInfo.targetId); if (t) { t.url = m.params.targetInfo.url; t.title = m.params.targetInfo.title; } }
      if (m.method === 'Target.targetCreated' && m.params.targetInfo.type === 'page') b.adopt(m.params.targetInfo);
      if (m.sessionId) b.routeEvent(m);
    });
    // Normal desktop user agent (headless Chrome otherwise announces "HeadlessChrome" and many sites refuse it).
    try { const v = await conn.send('Browser.getVersion'); b.userAgent = String(v.userAgent || '').replace(/HeadlessChrome/g, 'Chrome'); } catch (_) {}
    b.downloads = [];
    b.downloadDir = join(udd, 'Downloads');
    try { await conn.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: b.downloadDir, eventsEnabled: true }); } catch (_) {}
    conn.listeners.add((m) => {
      if (m.method === 'Browser.downloadWillBegin') b.downloads.push({ id: m.params.guid, url: m.params.url, filename: join(b.downloadDir, m.params.suggestedFilename), state: 'in_progress', startTime: Date.now() });
      if (m.method === 'Browser.downloadProgress') { const d = b.downloads.find((x) => x.id === m.params.guid); if (d) { d.bytesReceived = m.params.receivedBytes; d.totalBytes = m.params.totalBytes; if (m.params.state !== 'inProgress') d.state = m.params.state; } }
    });
    const { targetInfos } = await conn.send('Target.getTargets');
    for (const t of targetInfos) if (t.type === 'page') b.adopt(t);
    return b;
  }

  constructor(conn, proc, udd, ownsProfile) {
    this.conn = conn; this.proc = proc; this.udd = udd; this.ownsProfile = ownsProfile;
    this.tabs = new Map(); // tabKey -> {targetId, sessionId, url, title}
    this.seq = 0;
  }

  adopt(info) {
    if ([...this.tabs.values()].some((t) => t.targetId === info.targetId)) return;
    if (info.url && info.url.startsWith('chrome-extension://')) return;
    const key = `${this.id}:${++this.seq}`;
    this.tabs.set(key, { targetId: info.targetId, sessionId: null, url: info.url, title: info.title });
    return key;
  }
  forgetTarget(targetId) { for (const [k, v] of this.tabs) if (v.targetId === targetId) this.tabs.delete(k); }

  async session(key) {
    const t = this.tabs.get(key);
    if (!t) throw new Error(`Unknown tab ${key}`);
    if (!t.sessionId) {
      if (!t.attaching) t.attaching = this.conn.send('Target.attachToTarget', { targetId: t.targetId, flatten: true }).then(async (r) => {
        t.sessionId = r.sessionId; t.children = new Map();
        // Dialog events + out-of-process iframes (cross-site frames get their own session).
        await Promise.all([
          this.conn.send('Page.enable', {}, r.sessionId).catch(() => {}),
          this.conn.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, r.sessionId).catch(() => {}),
          ...(this.userAgent && this.headless ? [this.conn.send('Emulation.setUserAgentOverride', { userAgent: this.userAgent }, r.sessionId).catch(() => {})] : []),
          ...(this.downloadPolicy === 'deny' ? [this.conn.send('Page.setDownloadBehavior', { behavior: 'deny' }, r.sessionId).catch(() => {})] : []),
        ]);
        t.attaching = null; return r.sessionId;
      }, (e) => { t.attaching = null; throw e; });
      await t.attaching;
    }
    return t.sessionId;
  }

  routeEvent(m) {
    for (const [key, t] of this.tabs) {
      if (t.sessionId === m.sessionId) {
        if (m.method === 'Target.attachedToTarget') {
          const ti = m.params.targetInfo;
          if (ti.type === 'iframe') { t.children.set(ti.targetId, { sessionId: m.params.sessionId, targetId: ti.targetId, url: ti.url }); this.conn.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, m.params.sessionId).catch(() => {}); this.conn.send('Page.enable', {}, m.params.sessionId).catch(() => {}); }
        } else if (m.method === 'Target.detachedFromTarget') {
          for (const [id, c] of t.children) if (c.sessionId === m.params.sessionId) t.children.delete(id);
        }
        if (this.onEvent) this.onEvent(key, m.method, m.params, undefined);
        return;
      }
      if (t.children) for (const c of t.children.values()) if (c.sessionId === m.sessionId) {
        if (m.method === 'Target.attachedToTarget' && m.params.targetInfo.type === 'iframe') { const ti = m.params.targetInfo; t.children.set(ti.targetId, { sessionId: m.params.sessionId, targetId: ti.targetId, url: ti.url }); this.conn.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, m.params.sessionId).catch(() => {}); }
        if (this.onEvent) this.onEvent(key, m.method, m.params, m.sessionId);
        return;
      }
    }
  }

  async children(key) { await this.session(key); const t = this.tabs.get(key); return t && t.children ? [...t.children.values()] : []; }

  async grantPermissions(key, permissions) {
    const t = this.tabs.get(key);
    let origin;
    try { origin = new URL(t.url).origin; } catch (_) {}
    const map = { geolocation: 'geolocation', notifications: 'notifications', camera: 'videoCapture', microphone: 'audioCapture', clipboard: 'clipboardReadWrite', 'clipboard-read': 'clipboardReadWrite', midi: 'midi' };
    await this.conn.send('Browser.grantPermissions', { permissions: permissions.map((p) => map[p] || p), ...(origin && origin !== 'null' ? { origin } : {}) });
  }

  async send(key, method, params, session) {
    if (session) return this.conn.send(method, params, session);
    const sid = await this.session(key);
    return this.conn.send(method, params, sid);
  }

  async newTab(url = 'about:blank') {
    const { targetId } = await this.conn.send('Target.createTarget', { url: 'about:blank' });
    let key = [...this.tabs].find(([, v]) => v.targetId === targetId)?.[0];
    if (!key) key = this.adopt({ targetId, url: 'about:blank', title: '' });
    return key;
  }

  async closeTab(key) {
    const t = this.tabs.get(key);
    if (!t) throw new Error(`Unknown tab ${key}`);
    await this.conn.send('Target.closeTarget', { targetId: t.targetId });
    this.tabs.delete(key);
  }

  list() { return [...this.tabs].map(([tab, v]) => ({ tab, url: v.url, title: v.title, source: this.headless ? 'headless' : 'cdp', attached: !!v.sessionId })); }

  async close() {
    try { await this.conn.send('Browser.close', {}, undefined, 3000); } catch (_) {}
    this.conn.close();
    try { this.proc.kill(); } catch (_) {}
    if (this.ownsProfile) setTimeout(() => { try { rmSync(this.udd, { recursive: true, force: true }); } catch (_) {} }, 1500);
  }
}
