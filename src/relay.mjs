// Luculent Browser Driver relay: one local process that agents talk to (WS/HTTP/MCP) and that
// drives the user's Chrome through the extension, or headless Chrome over CDP.
import http from 'node:http';
import { createHmac, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, appendFileSync, statSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { WebSocketServer } from 'ws';
import { Engine } from './engine.mjs';
import { HeadlessBrowser } from './headless.mjs';
import { KeyStore } from './keys.mjs';
import { handleMcp } from './mcp-tools.mjs';
import { ChatStore } from './chats.mjs';
import { PanelHub } from './panel.mjs';
import { FlowStore } from './flows.mjs';
import { PlanHub } from './plan.mjs';
import { setup as onboardSetup } from './onboard.mjs';
import { sanitizePageContext, pageContextMessage, PAGE_CONTEXT_INSTRUCTION } from './page-context.mjs';
import { extractInPage } from '../extension/extract.js';

import { PolicyStore, RateLimiter, effective, normalize, urlBlocked, CAPS } from './policy.mjs';

export const VERSION = '0.3.0';
export const DEFAULT_PORT = 47800;
// Stable ID derived from the "key" in extension/manifest.json.
export const EXTENSION_ID = 'oddcfadbpoapebpdmfbggiiibpbcpdoo';

class ApiError extends Error { constructor(status, message) { super(message); this.status = status; } }
const denyErr = (msg) => { const e = new ApiError(403, 'Blocked by your Luculent security settings: ' + msg); e.denied = true; return e; };

const READ_ACTIONS = new Set(['snapshot', 'extract', 'text', 'wait', 'screenshot', 'scroll', 'downloads', 'table', 'pdf']);
// Allowed in read-only mode: look, scroll, navigate; no clicks, typing, uploads or JS.
const READONLY_OK = new Set(['navigate', 'goto', 'back', 'forward', 'reload', 'snapshot', 'extract', 'text', 'wait', 'screenshot', 'scroll', 'hover', 'table', 'pdf', 'downloads', 'viewport']);
const STEP_METHODS = new Set(['key', 'upload', 'cookies', 'storage', 'downloads', 'dialog', 'viewport', 'navigate', 'goto', 'click', 'dblclick', 'rightclick', 'hover', 'type', 'fill', 'press', 'select', 'check', 'uncheck', 'wait', 'extract', 'eval', 'scroll', 'back', 'forward', 'reload', 'drag', 'wheel', 'table', 'media', 'pdf', 'geolocation', 'permissions']);
const LABEL = { passwords: 'Reading or typing passwords', eval: 'Running JavaScript in pages', cookies: 'Reading or changing cookies', storage: 'Reading or changing site storage', downloads: 'Downloads', uploads: 'Uploading local files', submitSensitive: 'Submitting login/payment forms', rawCdp: 'Raw DevTools protocol access', headless: 'Background (headless) Chrome', internalPages: 'Browser-internal pages', fileUrls: 'Local file:// pages' };

/** Most restrictive combination of two policies (relay file + the extension's own settings). */
export function strictest(a, b) {
  if (!b) return normalize(a);
  a = normalize(a); b = normalize(b);
  const L = { allow: 2, confirm: 1, deny: 0 };
  const out = { ...a };
  for (const c of CAPS) out[c] = L[a[c]] <= L[b[c]] ? a[c] : b[c];
  out.readOnly = a.readOnly || b.readOnly; out.bankingPreset = a.bankingPreset || b.bankingPreset;
  out.grantMode = a.grantMode === 'granted' || b.grantMode === 'granted' ? 'granted' : 'all';
  out.incognito = a.incognito && b.incognito;
  out.blocklist = [...new Set([...a.blocklist, ...b.blocklist])];
  out.allowlist = a.allowlist.length && b.allowlist.length ? a.allowlist.filter((x) => b.allowlist.includes(x)) : a.allowlist.length ? a.allowlist : b.allowlist;
  out.rateLimit = { perSecond: Math.min(a.rateLimit.perSecond, b.rateLimit.perSecond), perMinute: Math.min(a.rateLimit.perMinute, b.rateLimit.perMinute) };
  return out;
}

export class Router {
  constructor() {
    this.ext = null;
    this.extInfo = null;
    this.exts = new Map(); // profileId -> { ws, info }
    this.tabProfile = new Map(); // tabId -> profileId
    this.extSeq = 0;
    this.extPending = new Map();
    this.browsers = new Map(); // id -> HeadlessBrowser
    this.onEvent = () => {};
    this.downloadPolicy = 'allow';
  }
  listProfiles() { return [...this.exts.values()].map((r) => r.info); }
  recForWs(ws) { return [...this.exts.values()].find((r) => r.ws === ws) || null; }
  wsFor(msg = {}) {
    const pid = msg.profileId || msg.profile || (msg.tabId != null ? this.tabProfile.get(String(msg.tabId)) : null);
    if (pid) {
      const rec = this.exts.get(pid) || [...this.exts.values()].find((r) => r.info?.profileId === pid || r.info?.id === pid);
      if (rec?.ws?.readyState === 1) return rec.ws;
    }
    if (this.ext?.readyState === 1) return this.ext;
    const any = [...this.exts.values()].find((r) => r.ws?.readyState === 1);
    return any?.ws || null;
  }
  attachExtension(ws, info = {}) {
    const key = info.profileId || info.id || this.recForWs(ws)?.info?.profileId || 'default';
    const rec = { ws, info: { ...info, profileId: info.profileId || info.id || key } };
    const prev = this.exts.get(key);
    if (prev && prev.ws && prev.ws !== ws) { try { prev.ws.close(4000, 'replaced by newer connection for this profile'); } catch (_) {} }
    // drop any other map entry for the same socket (hello refreshes profileId)
    for (const [k, r] of this.exts) if (r.ws === ws && k !== key) this.exts.delete(k);
    this.exts.set(key, rec);
    if (!this.ext || this.ext.readyState !== 1 || this.ext === ws) { this.ext = ws; this.extInfo = rec.info; }
  }
  detachExtension(ws) {
    for (const [k, rec] of [...this.exts]) if (rec.ws === ws) this.exts.delete(k);
    for (const [id, p] of [...this.extPending]) {
      if (!p.ws || p.ws === ws) { p.rej(new ApiError(503, 'Extension disconnected')); this.extPending.delete(id); }
    }
    if (this.ext === ws) {
      const next = [...this.exts.values()][0];
      this.ext = next?.ws || null;
      this.extInfo = next?.info || null;
    }
  }
  onExtMessage(m) {
    const p = this.extPending.get(m.id);
    if (!p) return;
    this.extPending.delete(m.id);
    if (m.error) { const e = new Error(m.error); if (m.denied) { e.denied = true; e.status = 403; } p.rej(e); } else p.res(m.result);
  }
  extCall(msg, timeout = 30000) {
    const ws = this.wsFor(msg);
    if (!ws || ws.readyState !== 1) return Promise.reject(new ApiError(503, 'Chrome extension is not connected. Open Chrome with the Luculent Browser Driver extension, or use a headless tab (browser_headless launch).'));
    const id = ++this.extSeq;
    return new Promise((res, rej) => {
      const timer = setTimeout(() => { this.extPending.delete(id); rej(new Error(`extension call ${msg.method || msg.type} timed out`)); }, timeout);
      this.extPending.set(id, { res: (v) => { clearTimeout(timer); res(v); }, rej: (e) => { clearTimeout(timer); rej(e); }, ws });
      ws.send(JSON.stringify({ id, ...msg }));
    });
  }
  extNotify(msg) {
    const seen = new Set();
    for (const rec of this.exts.values()) {
      if (rec.ws?.readyState === 1 && !seen.has(rec.ws)) { seen.add(rec.ws); try { rec.ws.send(JSON.stringify(msg)); } catch (_) {} }
    }
    if (!seen.size && this.ext?.readyState === 1) { try { this.ext.send(JSON.stringify(msg)); } catch (_) {} }
  }
  isHeadless(tab) { return /^h\d+:\d+$/.test(tab); }
  browserFor(tab) {
    const b = this.browsers.get(tab.split(':')[0]);
    if (!b) throw new ApiError(404, `Unknown headless tab ${tab}`);
    return b;
  }
  send(tab, method, params = {}, session) {
    tab = String(tab);
    if (this.isHeadless(tab)) { if (params && params.approval) { const { approval, ...rest } = params; params = rest; } return this.browserFor(tab).send(tab, method, params, session); }
    if (!/^\d+$/.test(tab)) return Promise.reject(new ApiError(400, `Bad tab id ${tab}`));
    return this.extCall({ type: 'cdp', tabId: Number(tab), method, params, ...(session ? { sessionId: session } : {}) });
  }
  async children(tab) {
    tab = String(tab);
    if (this.isHeadless(tab)) return this.browserFor(tab).children(tab);
    return this.extCall({ type: 'frames', tabId: Number(tab) });
  }
  async grantPermissions(tab, perms) {
    tab = String(tab);
    if (!this.isHeadless(tab)) throw new ApiError(400, 'permissions can only be pre-granted in headless Chrome; in your own Chrome, the site asks you');
    return this.browserFor(tab).grantPermissions(tab, perms);
  }
  async tabs() {
    const out = [];
    let focusedWindowId = null;
    const recs = this.exts.size ? [...this.exts.values()] : (this.ext ? [{ ws: this.ext, info: this.extInfo }] : []);
    for (const rec of recs) {
      if (!rec.ws || rec.ws.readyState !== 1) continue;
      try {
        const r = await this.extCall({ type: 'tabs', profileId: rec.info?.profileId }, 5000);
        if (rec.info?.profileId && rec === recs[0]) focusedWindowId = r.focusedWindowId;
        if (focusedWindowId == null) focusedWindowId = r.focusedWindowId;
        const pid = rec.info?.profileId || rec.info?.id;
        for (const t of r.tabs) {
          if (pid) this.tabProfile.set(String(t.id), pid);
          out.push({ tab: String(t.id), url: t.url, title: t.title, active: t.active && t.windowId === r.focusedWindowId, windowActive: t.active, windowId: t.windowId, source: 'extension', attached: t.attached, granted: t.granted !== false, incognito: !!t.incognito, profileId: pid, profileName: rec.info?.profileName || null, groupId: t.groupId ?? null });
        }
      } catch (_) {}
    }
    for (const b of this.browsers.values()) out.push(...b.list());
    return { tabs: out, focusedWindowId };
  }
  async newTab({ url, source, active = false } = {}) {
    if (source === 'headless' || (!source && !this.ext)) {
      let b = [...this.browsers.values()].find((x) => x.headless);
      if (!b) b = await this.launch({});
      const tab = await b.newTab();
      return { tab };
    }
    const r = await this.extCall({ type: 'newTab', url: 'about:blank', active: !!active });
    return { tab: String(r.id) };
  }
  async closeTab(tab) {
    tab = String(tab);
    if (this.isHeadless(tab)) return this.browserFor(tab).closeTab(tab);
    await this.extCall({ type: 'closeTab', tabId: Number(tab) });
  }
  async activate(tab, opts = {}) {
    tab = String(tab);
    if (this.isHeadless(tab)) return this.send(tab, 'Page.bringToFront', {});
    await this.extCall({ type: 'activate', tabId: Number(tab), stealFocus: !!(opts && opts.stealFocus) });
  }
  async downloads(tab, s = {}) {
    tab = String(tab);
    const op = s.op || (s.action === 'downloads' && s.wait ? 'wait' : 'list');
    const list = async () => {
      if (this.isHeadless(tab)) return this.browserFor(tab).downloads.slice(-(s.limit || 20)).reverse();
      return this.extCall({ type: 'downloads', limit: s.limit || 20 });
    };
    if (op === 'list') return list();
    const deadline = Date.now() + (s.timeout || 30000);
    const since = s.since || Date.now() - 4000;
    while (Date.now() < deadline) {
      const l = await list();
      const d = l.find((x) => x.startTime >= since && (x.state === 'complete' || x.state === 'completed'));
      if (d) return d;
      const bad = l.find((x) => x.startTime >= since && (x.state === 'interrupted' || x.state === 'canceled'));
      if (bad) throw new Error(`Download ${bad.state}${bad.error ? ' (' + bad.error + ')' : ''}`);
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('Timeout waiting for a download to complete');
  }
  async launch({ headed = false, extensionPath } = {}) {
    const b = await HeadlessBrowser.launch({ headless: !headed, extensionPath });
    b.onEvent = (tab, method, params, session) => this.onEvent(tab, method, params, session);
    if (this.downloadPolicy === 'deny') await b.conn.send('Browser.setDownloadBehavior', { behavior: 'deny' }).catch(() => {});
    this.browsers.set(b.id, b);
    b.conn.ws.once('close', () => this.browsers.delete(b.id));
    return b;
  }
  async setDownloadPolicy(v) {
    if (v === this.downloadPolicy) return;
    this.downloadPolicy = v;
    for (const b of this.browsers.values()) await b.conn.send('Browser.setDownloadBehavior', v === 'deny' ? { behavior: 'deny' } : { behavior: 'allow', downloadPath: b.downloadDir, eventsEnabled: true }).catch(() => {});
  }

  async extractPageContext(tab) {
    tab = String(tab);
    if (this.isHeadless(tab)) {
      const r = await this.send(tab, 'Runtime.evaluate', {
        expression: '(' + extractInPage.toString() + ')()',
        returnByValue: true,
        awaitPromise: false,
      });
      if (r?.exceptionDetails) {
        const d = r.exceptionDetails;
        const msg = (d.exception && (d.exception.description || d.exception.value)) || d.text || 'page context extract failed';
        throw new Error(String(msg).split('\n')[0]);
      }
      return r?.result?.value || { title: '', url: '', text: '', headings: [], links: [], tables: [], selection: '' };
    }
    return this.extCall({ type: 'extractContext', tabId: Number(tab) });
  }
  async closeBrowser(id) {
    const list = id ? [this.browsers.get(id)].filter(Boolean) : [...this.browsers.values()];
    for (const b of list) { await b.close(); this.browsers.delete(b.id); }
    return list.length;
  }
}

export class Relay {
  constructor({ port = DEFAULT_PORT, host = '127.0.0.1', keys = new KeyStore(), allowExtensionIds = [], log = console.error, policy } = {}) {
    this.port = port; this.host = host; this.keys = keys; this.log = log;
    this.allowExtensionIds = new Set([EXTENSION_ID, ...allowExtensionIds, ...(process.env.LBD_EXTENSION_IDS || '').split(',').filter(Boolean)]);
    this.router = new Router();
    this.engine = new Engine(this.router);
    this.router.onEvent = (tab, method, params, session) => this.engine.onEvent(tab, method, params, session);
    this.policy = new PolicyStore(keys.home, policy);
    this.extSettings = null;
    this.limiter = new RateLimiter();
    this.chats = new ChatStore({ path: join(keys.home, 'chats.json') });
    this.panel = new PanelHub(this.chats);
    this.plans = new PlanHub();
    this.flows = new FlowStore(join(keys.home, 'flows'));
    this.humanPauses = new Map();
    this.chats.purge();
    this.pending = new Map(); // confirmation id -> request
    this.auditLog = [];
    this.auditPath = join(keys.home, 'audit.log');
    this.locks = new Map();
    this.agents = new Set();
    this.sessions = new Map(); // key id -> {lastTab}
    this.stats = { calls: 0, started: Date.now() };
    this.router.setDownloadPolicy(this.policy.get().downloads === 'deny' ? 'deny' : 'allow');
  }

  get killed() { return !!this.keys.state().killed; }

  relaySecret() {
    const p = join(this.keys.home, 'relay.secret');
    if (!existsSync(p)) writeFileSync(p, randomBytes(32).toString('hex'), { mode: 0o600 });
    return readFileSync(p, 'utf8').trim();
  }

  /** Effective policy for this caller and tab (extension tabs are also bound by the extension's own settings). */
  policyFor(ctx, tab) {
    let g = this.policy.get();
    if (tab != null && !this.router.isHeadless(String(tab)) && this.extSettings) g = strictest(g, this.extSettings);
    return effective(g, ctx.admin ? null : ctx.key);
  }

  audit(ctx, entry) {
    const e = { t: new Date().toISOString(), key: ctx && ctx.key ? ctx.key.name : ctx && ctx.admin ? 'admin' : '-', ...entry };
    this.auditLog.push(e);
    if (this.auditLog.length > 500) this.auditLog.splice(0, this.auditLog.length - 500);
    if (this.policy.get().audit) {
      try {
        try { if (statSync(this.auditPath).size > 2e6) renameSync(this.auditPath, this.auditPath + '.1'); } catch (_) {}
        appendFileSync(this.auditPath, JSON.stringify(e) + '\n', { mode: 0o600 });
      } catch (_) {}
    }
    this.router.extNotify({ type: 'audit', entry: e });
    return e;
  }

  /** Ask the user to approve a sensitive action (extension popup/notification, or `lbd approve <id>`). */
  confirm(ctx, req, e) {
    const id = randomBytes(6).toString('hex');
    const entry = { id, key: ctx.key ? ctx.key.name : 'admin', at: new Date().toISOString(), timeoutSec: e.confirmTimeoutSec, ...req };
    this.log(`[lbd] approval needed ${id}: ${entry.key} wants to ${req.summary} (${req.url || req.tab}). Approve in the extension popup or: lbd approve ${id}`);
    return new Promise((res) => {
      const timer = setTimeout(() => { this.pending.delete(id); this.router.extNotify({ type: 'confirmExpired', id }); res(false); }, e.confirmTimeoutSec * 1000);
      this.pending.set(id, { ...entry, resolve: (ok) => { clearTimeout(timer); this.pending.delete(id); res(ok ? id : false); } });
      this.router.extNotify({ type: 'confirm', ...entry });
    });
  }
  resolveConfirm(id, allow) { const p = this.pending.get(id); if (!p) return false; p.resolve(!!allow); return true; }
  pendingList() { return [...this.pending.values()].map(({ resolve, ...p }) => p); }

  lock(tab, fn) {
    const prev = this.locks.get(tab) || Promise.resolve();
    const next = prev.catch(() => {}).then(fn);
    const tail = next.catch(() => {});
    this.locks.set(tab, tail);
    tail.then(() => { if (this.locks.get(tab) === tail) this.locks.delete(tab); });
    return next;
  }

  async kill(reason = 'killswitch') {
    this.keys.setState({ killed: true, killedAt: new Date().toISOString(), reason });
    for (const ws of this.agents) { try { ws.close(4001, 'killswitch engaged'); } catch (_) {} }
    this.agents.clear();
    for (const p of this.pending.values()) p.resolve(false);
    if (this.router.ext) { try { await this.router.extCall({ type: 'detachAll' }, 3000); } catch (_) {} }
    await this.router.closeBrowser();
    this.audit(null, { method: 'killswitch', result: 'engaged', reason });
    this.log(`[lbd] KILLSWITCH engaged (${reason})`);
    return { killed: true };
  }
  resume() { this.keys.setState({ killed: false, resumedAt: new Date().toISOString() }); this.router.extNotify({ type: 'resumed' }); this.audit(null, { method: 'killswitch', result: 'released' }); this.log('[lbd] killswitch released'); return { killed: false }; }

  need(ctx, scope) {
    if (ctx.admin) return;
    if (!ctx.key.scopes.includes(scope)) throw new ApiError(403, `API key "${ctx.key.name}" lacks scope "${scope}"`);
  }

  visibleTab(t, e) {
    if (t.source !== 'extension') return true;
    if (t.incognito && !e.incognito) return false;
    if (e.grantMode === 'granted' && !t.granted) return false;
    if (urlBlocked(e, t.url) && /^(chrome|chrome-extension|devtools|edge|about|view-source)/i.test(t.url || '') && !/^about:blank/.test(t.url || '')) return false;
    return true;
  }

  async defaultTab(ctx) {
    const s = this.sessions.get(ctx.sid);
    if (s && s.lastTab) return s.lastTab;
    const e = this.policyFor(ctx, 0);
    const { tabs } = await this.router.tabs();
    const vis = tabs.filter((t) => this.visibleTab(t, e));
    const active = vis.find((t) => t.active && t.source === 'extension' && /^https?:|^about:blank/.test(t.url || ''))
      || vis.find((t) => t.windowActive && t.source === 'extension' && /^https?:|^about:blank/.test(t.url || ''))
      || vis.find((t) => t.source === 'extension');
    if (active) return active.tab;
    const h = vis.find((t) => t.source !== 'extension');
    if (h) return h.tab;
    throw new ApiError(404, e.grantMode === 'granted' && this.router.ext ? 'No tab to drive: grant a tab in the Luculent extension popup ("Let agents use this tab"), or open one with browser_tabs new.' : 'No tab to drive: open Chrome with the extension, or call tabs.new / headless.launch first.');
  }
  remember(ctx, tab) { this.sessions.set(ctx.sid, { lastTab: String(tab) }); }

  async cap(ctx, e, name, req) {
    const v = e[name];
    if (v === 'allow') return null;
    if (v === 'deny') throw denyErr(`${LABEL[name] || name} is turned off${ctx.key && e[name] === 'deny' && this.policy.get()[name] !== 'deny' ? ` for API key "${ctx.key.name}" (scope or key setting)` : ''}.`);
    const id = await this.confirm(ctx, { kind: name, ...req }, e);
    if (!id) throw denyErr(`you did not approve "${req.summary}"`);
    return { approval: id };
  }

  /** Security guard run before every step. */
  async guardStep(ctx, e, tab, s, allSteps) {
    const a = s.action;
    let url = null;
    if (a === 'navigate' || a === 'goto') {
      url = s.url && !/^[a-z][a-z0-9+.-]*:/i.test(s.url) ? 'https://' + s.url : s.url;
      const why = urlBlocked(e, url);
      if (why) throw denyErr(why);
    } else {
      const st = await this.engine.docState(tab);
      url = st && st[2];
      const why = urlBlocked(e, url);
      if (why) throw denyErr(why);
    }
    if (e.readOnly && !(READONLY_OK.has(a) && !(a === 'wait' && s.js))) throw denyErr(`read-only mode is on ("${a}" is not allowed)`);
    let g = null;
    const req = (summary) => ({ summary, url, tab });
    if (a === 'eval' || (a === 'wait' && s.js)) g = await this.cap(ctx, e, 'eval', req('run JavaScript: ' + String(s.js ?? s.expression ?? '').slice(0, 120)));
    else if (a === 'cookies') g = await this.cap(ctx, e, 'cookies', req(`${s.op || 'get'} cookies`));
    else if (a === 'storage') g = await this.cap(ctx, e, 'storage', req(`${s.op || 'get'} ${s.area === 'session' ? 'sessionStorage' : 'localStorage'}`));
    else if (a === 'upload') g = await this.cap(ctx, e, 'uploads', req(`upload ${[].concat(s.files || s.file || []).map((f) => String(f).split(/[\\/]/).pop()).join(', ')}`));
    else if (a === 'downloads' && e.downloads === 'deny') throw denyErr('Downloads are turned off.');
    else if (['type', 'fill', 'press', 'key', 'click', 'dblclick'].includes(a) && (e.passwords !== 'allow' || e.submitSensitive !== 'allow' || e.confirmAll)) {
      const tgt = a === 'press' || a === 'key' ? s.target ?? null : s.target;
      let info = null;
      if (tgt !== undefined && !(a.includes('click') && tgt == null)) {
        try { info = await this.engine.helper(tab, 'inspect', [tgt], { frame: s.frame, retryUntil: Date.now() + Math.min(s.timeout || 5000, 5000) }); } catch (_) { info = null; }
        if (!info && tgt != null && a !== 'press') { try { await this.engine.helper(tab, 'waitFor', [tgt, Math.min(s.timeout || 5000, 5000), 'attached'], { frame: s.frame, retryUntil: Date.now() + 5000 }); info = await this.engine.helper(tab, 'inspect', [tgt], { frame: s.frame }); } catch (_) {} }
      }
      if (info) {
        const typing = a === 'type' || a === 'fill' || (a === 'press' || a === 'key');
        if (typing && info.isPassword) g = await this.cap(ctx, e, 'passwords', req('type into a password field'));
        else if (typing && info.isPayment) g = await this.cap(ctx, e, 'submitSensitive', req('type into a payment field'));
        const submitting = (a.includes('click') && info.isSubmit) || ((a === 'type' || a === 'fill') && s.submit) || ((a === 'press' || a === 'key') && [].concat(s.key || s.keys).some((k) => /^(Enter|Return)$/i.test(String(k))));
        if (!g && submitting && info.formSensitive) g = await this.cap(ctx, e, 'submitSensitive', req(`submit a ${info.formSensitive} form`));
      }
    }
    if (!g && e.confirmAll && !READ_ACTIONS.has(a)) g = await this.cap(ctx, { ...e, confirmAll: 'confirm' }, 'confirmAll', req(`${a} ${s.target ? String(s.target).slice(0, 60) : s.url || ''}`));
    return g;
  }

  async runOn(ctx, p) {
    const steps = p.steps || [];
    if (!Array.isArray(steps) || !steps.length) throw new ApiError(400, 'steps must be a non-empty array');
    this.need(ctx, steps.every((s) => READ_ACTIONS.has(s.action)) ? 'read' : 'act');
    const tab = String(p.tab ?? (await this.defaultTab(ctx)));
    const e = this.policyFor(ctx, tab);
    if (!this.router.isHeadless(tab)) {
      const { tabs } = await this.router.tabs();
      const t = tabs.find((x) => x.tab === tab);
      if (t && !this.visibleTab(t, e)) throw denyErr(t.incognito ? 'incognito tabs are off limits' : 'this tab has not been granted to agents (use "Let agents use this tab" in the extension popup)');
    }
    this.remember(ctx, tab);
    const actions = steps.map((s) => s.action);
    try {
      const r = await this.lock(tab, () => this.engine.run(tab, steps, {
        stopOnError: p.stopOnError !== false, snapshot: p.snapshot || 'none', snapshotMax: p.snapshotMax, dialogs: p.dialogs,
        redactPasswords: e.passwords !== 'allow', guard: (s) => this.guardStep(ctx, e, tab, s, steps),
      }));
      const denied = r.results.find((x) => x.denied);
      this.audit(ctx, { method: 'run', tab, actions, host: this.hostOf(r, steps), result: denied ? 'denied' : r.ok ? 'ok' : 'error', ...(denied ? { reason: denied.error.replace(/^Blocked by your Luculent security settings: /, '') } : {}), ms: r.totalMs });
      return r;
    } catch (err) {
      this.audit(ctx, { method: 'run', tab, actions, result: err.denied ? 'denied' : 'error', reason: String(err.message).slice(0, 200) });
      throw err;
    }
  }
  hostOf(r, steps) { const n = steps.find((s) => s.action === 'navigate' || s.action === 'goto'); try { return new URL(n ? n.url : r.snapshot?.url || '').host; } catch (_) { return undefined; } }

  /** Central API used by WS, HTTP RPC and MCP. */
  async call(method, p = {}, ctx) {
    this.stats.calls++;
    if (this.killed && !['status', 'admin.resume', 'policy.get'].includes(method)) throw new ApiError(423, 'Killswitch is engaged. Run `lbd resume` (or press Resume in the extension popup) to re-enable agent control.');
    if (!ctx.admin) {
      const e0 = this.policyFor(ctx, null);
      if (!this.limiter.take(ctx.key.id, e0.rateLimit)) { this.audit(ctx, { method, result: 'denied', reason: 'rate limit' }); throw new ApiError(429, `Rate limit: at most ${e0.rateLimit.perSecond} calls/s and ${e0.rateLimit.perMinute} calls/min for this key. Batch steps with browser_run.`); }
    }
    switch (method) {
      case 'status': {
        const { tabs } = await this.router.tabs().catch(() => ({ tabs: [] }));
        return { ok: true, version: VERSION, extension: !!this.router.ext, extensionVersion: this.router.extInfo?.version, paired: !!this.router.extInfo?.paired, headless: [...this.router.browsers.keys()], tabs: tabs.length, killed: this.killed, key: ctx.key ? { name: ctx.key.name, scopes: ctx.key.scopes } : 'admin', policy: this.policyFor(ctx, 0), pending: this.pendingList().length };
      }
      case 'policy.get': return { policy: this.policy.get(), extension: this.extSettings, effective: this.policyFor(ctx, 0) };
      case 'policy.set': this.need(ctx, 'admin'); { const r = this.policy.set(p.policy || p); await this.router.setDownloadPolicy(r.downloads === 'deny' ? 'deny' : 'allow'); this.router.extNotify({ type: 'policy', policy: r }); this.audit(ctx, { method: 'policy.set', result: 'ok', changed: Object.keys(p.policy || p) }); return { policy: r }; }
      case 'audit.list': this.need(ctx, 'admin'); return { entries: this.auditLog.slice(-(p.limit || 100)) };
      case 'confirm.list': this.need(ctx, 'admin'); return { pending: this.pendingList() };
      case 'confirm.resolve': this.need(ctx, 'admin'); return { ok: this.resolveConfirm(p.id, p.allow) };
      case 'tabs.list': {
        this.need(ctx, 'read');
        const e = this.policyFor(ctx, 0);
        const r = await this.router.tabs();
        const vis = r.tabs.filter((t) => this.visibleTab(t, e));
        return { extension: !!this.router.ext, killed: this.killed, tabs: vis, hidden: r.tabs.length - vis.length };
      }
      case 'tabs.new': {
        this.need(ctx, 'tabs');
        if (p.source === 'headless') { this.need(ctx, 'headless'); if (this.policyFor(ctx, null).headless === 'deny') throw denyErr('Background (headless) Chrome is turned off.'); }
        if (p.url) { const why = urlBlocked(this.policyFor(ctx, p.source === 'headless' ? 'h0:0' : 0), /^[a-z][a-z0-9+.-]*:/i.test(p.url) ? p.url : 'https://' + p.url); if (why) throw denyErr(why); }
        const r = await this.router.newTab({ url: p.url, source: p.source === 'extension' ? 'ext' : p.source, active: p.active });
        this.remember(ctx, r.tab);
        this.audit(ctx, { method: 'tabs.new', tab: r.tab, result: 'ok' });
        if (p.url) await this.engine.navigate(r.tab, { url: p.url, wait: p.wait || 'domcontentloaded' });
        return { tab: r.tab, url: p.url };
      }
      case 'tabs.close': this.need(ctx, 'tabs'); await this.router.closeTab(p.tab); this.engine.forget(String(p.tab)); return {};
      case 'tabs.activate': this.need(ctx, 'tabs'); await this.router.activate(p.tab, { stealFocus: !!p.stealFocus }); this.remember(ctx, p.tab); return {};
      case 'tabs.attach': case 'tabs.use': this.need(ctx, 'read'); this.remember(ctx, p.tab); await this.engine.docState(String(p.tab)); return { tab: String(p.tab) };
      case 'run': return this.runOn(ctx, p);
      case 'runParallel': {
        const t0 = performance.now();
        const jobs = p.jobs || [];
        const results = await Promise.all(jobs.map(async (j) => {
          let tab = j.tab;
          try {
            if (tab == null && j.newTab !== false) { this.need(ctx, 'tabs'); tab = (await this.router.newTab({ source: j.source === 'extension' ? 'ext' : j.source || (p.source === 'extension' ? 'ext' : p.source) })).tab; }
            return await this.runOn({ ...ctx, sid: ctx.sid + ':' + tab }, { ...j, tab });
          } catch (e) { return { ok: false, tab, error: e.message }; }
        }));
        return { ok: results.every((r) => r.ok), results, totalMs: +(performance.now() - t0).toFixed(1) };
      }
      case 'snapshot': {
        this.need(ctx, 'read');
        const tab = String(p.tab ?? (await this.defaultTab(ctx)));
        const r = await this.runOn(ctx, { tab, steps: [{ action: 'snapshot', mode: p.mode, max: p.max, text: p.text, viewport: p.viewport, frame: p.frame }] });
        if (!r.ok) throw new ApiError(r.results[0]?.denied ? 403 : 500, r.results[0]?.error || 'snapshot failed');
        return r.results[0].value;
      }
      case 'screenshot': {
        this.need(ctx, 'read');
        const tab = String(p.tab ?? (await this.defaultTab(ctx)));
        const r = await this.runOn(ctx, { tab, steps: [{ action: 'screenshot', fullPage: p.fullPage, quality: p.quality, format: p.format }] });
        if (!r.ok) throw new ApiError(r.results[0]?.denied ? 403 : 500, r.results[0]?.error || 'screenshot failed');
        return r.results[0].value;
      }
      case 'headless.launch': {
        this.need(ctx, 'headless');
        if (this.policyFor(ctx, null).headless === 'deny') throw denyErr('Background (headless) Chrome is turned off.');
        const b = await this.router.launch({ headed: !!p.headed });
        const tab = b.list()[0]?.tab || (await b.newTab());
        this.remember(ctx, tab);
      try {
        if (tab != null && !this.router.isHeadless(String(tab))) {
          this.panel.attachTab(ctx, tab);
          const colors = ['purple', 'blue', 'cyan', 'green', 'orange', 'pink', 'red', 'yellow'];
          const color = colors[Math.abs((ctx.key?.id || '0').split('').reduce((a, c) => a + c.charCodeAt(0), 0)) % colors.length];
          const g = await this.router.extCall({ type: 'group', tabId: Number(tab), title: ctx.key?.name || 'Agent', color }, 3000).catch(() => null);
          if (g && g.groupId != null) this.panel.attachTab(ctx, tab, g.groupId);
        }
      } catch (_) {}
        this.audit(ctx, { method: 'headless.launch', tab, result: 'ok' });
        return { browser: b.id, tab, headed: !!p.headed };
      }
      case 'headless.close': this.need(ctx, 'headless'); return { closed: await this.router.closeBrowser(p.browser) };
      case 'cdp': {
        this.need(ctx, 'cdp');
        const tab = String(p.tab ?? (await this.defaultTab(ctx)));
        const e = this.policyFor(ctx, tab);
        if (e.rawCdp === 'deny') throw denyErr('Raw DevTools protocol access is turned off.');
        if (e.rawCdp === 'confirm') await this.cap(ctx, e, 'rawCdp', { summary: `send raw CDP ${p.method}`, tab });
        this.audit(ctx, { method: 'cdp', tab, actions: [p.method], result: 'ok' });
        return this.router.send(tab, p.method, p.params || {});
      }
      case 'admin.kill': this.need(ctx, 'admin'); return this.kill(p.reason || 'api');
      case 'admin.resume': this.need(ctx, 'admin'); return this.resume();
      case 'panel.hello': return this.panel.hello(ctx, p.clientInfo || p);
      case 'panel.identify': return this.panel.identify(ctx, p);
      case 'panel.post': {
        const from = p.from === 'user' ? 'user' : 'agent';
        const m = this.panel.post(ctx, { from, text: p.text, pauseId: p.pauseId }, { id: p.id });
        this.syncPanel();
        return { message: m, view: this.panel.view(ctx, { id: p.id }) };
      }
      case 'panel.read': case 'panel.state': {
        const view = p.id ? this.panel.view(ctx, { id: p.id }) : this.panel.view(ctx);
        return { view, sections: this.panel.sections(), pause: this.pauseFor(ctx), plan: this.plans.public(p.tab || view && this.plans.current && this.plans.current.tab) };
      }
      case 'panel.save': return this.panel.save(p.id || this.panel.sessionFor(ctx).id);
      case 'panel.delete': return { ok: this.panel.delete(p.id) };
      case 'panel.clearContext': return this.panel.clearPageContext(ctx, { id: p.id });
      case 'panel.open': return this.router.extCall({ type: 'openPanel', windowId: p.windowId });
      case 'panel.clickPull': return this.router.extCall({ type: 'panelClickPull' });
      case 'pageContext.pull': {
        const tab = String(p.tab || '');
        if (!tab) throw new ApiError(400, 'pageContext.pull needs a tab');
        const listed = (await this.router.tabs()).tabs.find((x) => String(x.tab) === tab);
        const tabUrl = listed?.url || p.url;
        const e = this.policyFor(ctx, tab);
        const why = tabUrl ? urlBlocked(e, tabUrl) : null;
        if (why) {
          const err = new ApiError(403, 'Blocked by your Luculent security settings: ' + why);
          err.denied = true;
          throw err;
        }
        let raw = await this.router.extractPageContext(tab);
        if (raw && (raw.isPdf || /\.pdf(\?|#|$)/i.test(raw.url || '') || ((raw.text || '').length < 80))) {
          try {
            const pdf = await this.engine.run(tab, [{ action: 'pdf' }]);
            const val = pdf?.results?.[0]?.value;
            if (val && val.text) {
              raw = { ...raw, text: [raw.text, val.text].filter(Boolean).join('\n').trim() };
            }
          } catch (_) {}
        }
        const pulled = this.panel.pullPageContext(ctx, raw, { hint: { id: p.id } });
        this.syncPanel();
        return pulled;
      }
      case 'panel.pull': {
        if (!p.raw) throw new ApiError(400, 'panel.pull needs extracted page content');
        const tabUrl = p.raw.url;
        const e = this.policyFor(ctx, p.tab);
        const why = tabUrl ? urlBlocked(e, tabUrl) : null;
        const pulled = this.panel.pullPageContext(ctx, p.raw, { blockedReason: why, hint: { id: p.id } });
        this.syncPanel();
        return pulled;
      }
      case 'panel.resume': {
        const id = p.id;
        const wait = this.humanPauses.get(id);
        if (wait) { wait.resolve({ resumed: true, reply: p.text || '' }); this.humanPauses.delete(id); }
        this.syncPanel();
        return { ok: true };
      }
      case 'pause_for_human': return this.pauseForHuman(ctx, p);
      case 'flow.record': this.flows.start(p.name || 'flow'); return { recording: true, name: this.flows.recording.name };
      case 'flow.step': return { n: this.flows.record(p.step || p) };
      case 'flow.stop': return this.flows.stop();
      case 'flow.list': return { flows: this.flows.list() };
      case 'flow.get': return this.flows.get(p.name);
      case 'flow.delete': return { ok: this.flows.delete(p.name) };
      case 'flow.replay': {
        this.need(ctx, 'act');
        const tab = p.tab;
        return this.flows.replay(p.name, async (step) => {
          const r = await this.runOn(ctx, { tab, steps: [step], snapshot: 'none' });
          if (!r.ok) throw new Error((r.results.find((x) => !x.ok) || {}).error || 'step failed');
          return r.results.at(-1);
        }, { snapshot: async () => { const r = await this.runOn(ctx, { tab, steps: [{ action: 'snapshot' }] }); return r.results?.[0]?.value || r.snapshot; } });
      }
      case 'profiles.list': {
        const exts = this.router.listProfiles ? this.router.listProfiles() : (this.router.extInfo ? [this.router.extInfo] : []);
        return { profiles: exts };
      }
      case 'setup': {
        // Trusted path: paired extension or admin key. Reports paths only, never the API key.
        if (!ctx.fromExtension) this.need(ctx, 'admin');
        const r = await onboardSetup({
          home: this.keys.home, keys: this.keys, clients: p.clients, port: this.port,
          startAtLogon: !!p.startAtLogon, startNow: !!p.startNow, dryRun: !!p.dryRun,
          hooks: p.hooks || {}, userHome: p.userHome,
        });
        this.audit(ctx, { method: 'setup', result: 'ok', keyFile: r.keyFile });
        return r;
      }
      case 'plan.set': case 'plan.start': {
        const tab = p.tab || await this.defaultTab(ctx).catch(() => null);
        const pub = this.plans.set({ ...p, tab });
        this.syncPanel();
        return { plan: pub };
      }
      case 'plan.get': return { plan: this.plans.public(p.tab) };
      case 'plan.clear': {
        const r = this.plans.clear(p.tab);
        this.syncPanel();
        return r;
      }
      case 'plan.confirm': {
        const tab = String(p.tab || (this.plans.get(p.tab) && this.plans.get(p.tab).tab) || await this.defaultTab(ctx));
        const result = await this.plans.confirm(this.engine, tab, p.expect, { visionWhenNeeded: p.visionWhenNeeded !== false });
        this.syncPanel();
        return result;
      }
      case 'plan.adjust': {
        const pub = this.plans.adjust(p.tab, { steps: p.steps, reason: p.reason, fromIndex: p.fromIndex });
        this.syncPanel();
        return { plan: pub };
      }
      case 'plan.run': case 'plan.next': {
        this.need(ctx, 'act');
        const tab = String(p.tab || await this.defaultTab(ctx));
        const out = await this.plans.run(this.engine, (c, req) => this.runOn(c, req), ctx, { ...p, tab });
        this.syncPanel();
        return out;
      }
      case 'chats.purge': return { removed: this.panel.purge().length };
      default:
        if (STEP_METHODS.has(method)) {
          const { tab, snapshot, ...step } = p;
          const r = await this.runOn(ctx, { tab, snapshot, steps: [{ action: method, ...step }] });
          if (r.results[0] && r.results[0].denied) throw new ApiError(403, r.results[0].error);
          return r;
        }
        throw new ApiError(404, `Unknown method ${method}`);
    }
  }

  authFromReq(req, url) {
    const h = req.headers.authorization || '';
    const bearer = h.startsWith('Bearer ') ? h.slice(7).trim() : null;
    const tok = bearer || req.headers['x-lbd-key'] || url.searchParams.get('key');
    const adminTok = req.headers['x-lbd-admin'];
    if (adminTok && this.keys.isAdminToken(adminTok)) return { admin: true, key: null, sid: 'admin' };
    const key = this.keys.verify(tok);
    if (!key) return null;
    return { admin: false, key, sid: key.id };
  }

  webOriginBlocked(req) {
    const o = req.headers.origin;
    return !!o && /^https?:/i.test(o); // block drive-by requests from web pages (DNS rebinding / CSRF)
  }
  hostOk(req) {
    // DNS-rebinding guard: only accept requests addressed to the loopback host the relay listens on.
    const h = String(req.headers.host || '').replace(/:\d+$/, '').toLowerCase();
    return !h || h === '127.0.0.1' || h === 'localhost' || h === '[::1]' || h === this.host || process.env.LBD_ALLOW_ANY_HOST === '1';
  }


  syncPanel() {
    const payload = { type: 'panel.sync', sections: this.panel.sections(), pause: this.humanPauses.size ? [...this.humanPauses.values()].map((x) => x.public)[0] : null, plan: this.plans.public() };
    this.router.extNotify(payload);
  }
  pauseFor(ctx) {
    for (const v of this.humanPauses.values()) if (!ctx?.key || v.keyId === ctx.key?.id) return v.public;
    return null;
  }
  async pauseForHuman(ctx, p = {}) {
    const id = 'hp_' + Math.random().toString(36).slice(2, 10);
    const rawT = Number(p.timeout);
    const timeout = Number.isFinite(rawT) ? Math.min(Math.max(rawT, 20), 30 * 60 * 1000) : 300000;
    const pub = { id, reason: p.reason || 'CAPTCHA or 2FA', message: p.message || 'Please finish this in the real tab, then resume.', tab: p.tab || null, key: ctx.key?.name };
    this.panel.post(ctx, { from: 'agent', text: pub.message, pauseId: id });
    this.router.extNotify({ type: 'humanPause', ...pub });
    this.syncPanel();
    const result = await new Promise((resolve) => {
      const timer = setTimeout(() => { this.humanPauses.delete(id); resolve({ resumed: false, timedOut: true }); }, timeout);
      this.humanPauses.set(id, { resolve: (v) => { clearTimeout(timer); resolve(v); }, public: pub, keyId: ctx.key?.id, timer });
    });
    this.router.extNotify({ type: 'humanResume', id, ...result });
    this.syncPanel();
    return result;
  }

  async handleHttp(req, res) {

    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const send = (status, obj, headers = {}) => { const body = JSON.stringify(obj); res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers }); res.end(body); };
    if (url.pathname === '/v1/health' && req.method === 'GET') return send(200, { ok: true, extension: !!this.router.ext, killed: this.killed });
    if (this.webOriginBlocked(req) || !this.hostOk(req)) return send(403, { error: { message: 'Requests from web pages are not allowed' } });
    const ctx = this.authFromReq(req, url);
    if (!ctx) return send(401, { error: { message: 'Missing or invalid API key (Authorization: Bearer lbd_...)' } }, { 'www-authenticate': 'Bearer' });
    let body = '';
    for await (const c of req) { body += c; if (body.length > 8e6) return send(413, { error: { message: 'body too large' } }); }
    let json = {};
    try { json = body ? JSON.parse(body) : {}; } catch (_) { return send(400, { error: { message: 'invalid JSON' } }); }
    try {
      if (url.pathname === '/v1/rpc' && req.method === 'POST') return send(200, { result: await this.call(json.method, json.params || {}, ctx) });
      if (url.pathname === '/v1/admin/kill' && req.method === 'POST') { this.need(ctx, 'admin'); return send(200, await this.kill(json.reason || 'http')); }
      if (url.pathname === '/v1/admin/resume' && req.method === 'POST') { this.need(ctx, 'admin'); return send(200, this.resume()); }
      if (url.pathname === '/v1/admin/policy' && req.method === 'POST') return send(200, await this.call('policy.set', json, ctx));
      if (url.pathname === '/v1/admin/confirm' && req.method === 'POST') return send(200, await this.call('confirm.resolve', json, ctx));
      if (url.pathname === '/v1/admin/pending' && req.method === 'POST') return send(200, await this.call('confirm.list', json, ctx));
      if (url.pathname === '/v1/admin/audit' && req.method === 'POST') return send(200, await this.call('audit.list', json, ctx));
      if (url.pathname === '/mcp') {
        if (req.method !== 'POST') { res.writeHead(405, { allow: 'POST' }); return res.end(); }
        const rpc = (m, p) => this.call(m, p, ctx);
        const msgs = Array.isArray(json) ? json : [json];
        const out = (await Promise.all(msgs.map((m) => handleMcp(m, rpc)))).filter(Boolean);
        try { const init = (Array.isArray(json) ? json : [json]).find((m) => m && m.method === 'initialize'); if (init?.params?.clientInfo) await this.call('panel.hello', { clientInfo: init.params.clientInfo }, ctx); } catch (_) {}

        if (!out.length) { res.writeHead(202); return res.end(); }
        return send(200, Array.isArray(json) ? out : out[0]);
      }
      return send(404, { error: { message: 'not found' } });
    } catch (e) {
      return send(e.status || 500, { error: { message: e.message } });
    }
  }

  handleUpgrade(req, socket, head) {
    const url = new URL(req.url, 'http://localhost');
    socket.setNoDelay(true);
    const reject = (code, msg) => { socket.write(`HTTP/1.1 ${code} ${msg}\r\nConnection: close\r\n\r\n`); socket.destroy(); };
    if (url.pathname === '/ext') {
      const origin = req.headers.origin || '';
      const m = /^chrome-extension:\/\/([a-p]{32})$/.exec(origin);
      if (!m) return reject(403, 'Forbidden');
      if (!this.allowExtensionIds.has(m[1]) && !process.env.LBD_ALLOW_ANY_EXTENSION) {
        this.log(`[lbd] rejected extension ${m[1]} (set LBD_EXTENSION_IDS to allow it)`);
        return reject(403, 'Forbidden');
      }
      return this.wss.handleUpgrade(req, socket, head, (ws) => this.onExtension(ws, m[1]));
    }
    if (url.pathname === '/v1/ws') {
      if (this.webOriginBlocked(req) || !this.hostOk(req)) return reject(403, 'Forbidden');
      const ctx = this.authFromReq(req, url);
      if (!ctx) return reject(401, 'Unauthorized');
      if (this.killed && !ctx.admin) return reject(423, 'Locked');
      return this.wss.handleUpgrade(req, socket, head, (ws) => this.onAgent(ws, ctx));
    }
    reject(404, 'Not Found');
  }

  onExtension(ws, extId) {
    this.log(`[lbd] extension connected (${extId})`);
    this.router.attachExtension(ws, { id: extId });
    ws.on('message', (buf) => {
      let m; try { m = JSON.parse(buf.toString()); } catch (_) { return; }
      if (m.type === 'ping') return ws.send('{"type":"pong"}');
      if (m.type === 'hello') {
        const info = { id: extId, version: m.version, ua: m.ua, paired: !!m.paired, profileId: m.profileId || extId, profileName: m.profileName || 'Default' };
        this.router.attachExtension(ws, info);
        this.router.extInfo = info;
        // Relay identity proof (trust on first use): the extension pins this relay's secret on first contact and
        // refuses any later "relay" on this port that cannot prove it holds the same secret.
        const secret = this.relaySecret();
        const mac = m.nonce ? createHmac('sha256', Buffer.from(secret, 'hex')).update(String(m.nonce)).digest('hex') : null;
        ws.send(JSON.stringify({ type: 'auth', mac, ...(m.paired ? {} : { secret }) }));
        if (m.settings) this.extSettings = normalize(m.settings);
        ws.send(JSON.stringify({ type: 'policy', policy: this.policy.get() }));
        if (this.killed) ws.send(JSON.stringify({ type: 'killed' }));
        for (const p of this.pendingList()) ws.send(JSON.stringify({ type: 'confirm', ...p }));
        return;
      }
      if (m.type === 'settings') {
        // Changed in the popup/options page: becomes the global policy and binds extension tabs.
        this.extSettings = normalize(m.settings);
        if (m.persist !== false) { const r = this.policy.set(m.settings); this.router.setDownloadPolicy(r.downloads === 'deny' ? 'deny' : 'allow'); }
        this.audit(null, { method: 'settings', result: 'ok', source: 'extension' });
        return;
      }
      if (m.type === 'confirmResult') { this.resolveConfirm(m.id, !!m.allow); this.audit(null, { method: 'confirm', id: m.id, result: m.allow ? 'approved' : 'declined', source: 'extension' }); return; }
      if (m.type === 'resume') { this.resume(); return; }
      if (m.type === 'event') { this.router.onEvent(String(m.tabId), m.method, m.params || {}, m.sessionId); return; }
      if (m.type === 'tabClosed' || m.type === 'detached') { this.engine.forget(String(m.tabId)); if (m.type === 'tabClosed') { this.panel.closeByTab(m.tabId, 'tab-closed'); this.syncPanel(); } return; }
      if (m.type === 'kill') { this.kill('extension popup'); return; }
      if (m.type === 'groupClosed') { this.panel.closeByGroup(m.groupId, 'group-closed'); this.syncPanel(); return; }
      if (m.type === 'chats.purge') { this.panel.purge(); this.syncPanel(); return; }
      if (m.type === 'setup' || (m.type && String(m.type).startsWith('panel.'))) {
        const ctx = { fromExtension: true, admin: true, key: { id: 'extension', name: 'extension' } };
        this.call(m.type, m, ctx).then((result) => { if (m.id != null) try { ws.send(JSON.stringify({ id: m.id, result })); } catch (_) {} })
          .catch((e) => { if (m.id != null) try { ws.send(JSON.stringify({ id: m.id, error: e.message })); } catch (_) {} });
        return;
      }
      if (m.type === 'denied') { this.audit(null, { method: 'extension', tab: m.tabId != null ? String(m.tabId) : undefined, result: 'denied', reason: m.reason, source: 'extension' }); return; }
      if (m.id != null) this.router.onExtMessage(m);
    });
    ws.on('close', () => { this.log('[lbd] extension disconnected'); this.router.detachExtension(ws); });
    ws.on('error', () => {});
  }

  onAgent(ws, ctx) {
    this.agents.add(ws);
    const sctx = { ...ctx, sid: (ctx.sid || 'admin') + ':' + Math.random().toString(36).slice(2, 8) };
    ws.on('message', async (buf) => {
      let m; try { m = JSON.parse(buf.toString()); } catch (_) { return ws.send(JSON.stringify({ error: { message: 'invalid JSON' } })); }
      try {
        if (!ctx.admin) { const k = this.keys.list().find((x) => x.id === ctx.key.id); if (!k || k.revokedAt) { setTimeout(() => ws.close(4003, 'API key revoked'), 10); throw new ApiError(401, 'API key revoked'); } }
        const result = await this.call(m.method, m.params || {}, sctx);
        ws.send(JSON.stringify({ id: m.id, result }));
      } catch (e) {
        ws.send(JSON.stringify({ id: m.id, error: { message: e.message, status: e.status || 500 } }));
      }
    });
    ws.on('close', () => this.agents.delete(ws));
    ws.on('error', () => {});
  }

  start() {
    this.keys.adminToken();
    this.relaySecret();
    this.server = http.createServer((req, res) => this.handleHttp(req, res).catch((e) => { try { res.writeHead(500); res.end(e.message); } catch (_) {} }));
    this.server.keepAliveTimeout = 60000;
    this.wss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: 64 * 1024 * 1024 });
    this.server.on('upgrade', (req, socket, head) => this.handleUpgrade(req, socket, head));
    return new Promise((res, rej) => {
      this.server.once('error', rej);
      this.server.listen(this.port, this.host, () => { this.port = this.server.address().port; this.log(`[lbd] relay listening on http://${this.host}:${this.port} (home ${this.keys.home})`); res(this); });
    });
  }

  async stop() {
    for (const ws of this.agents) { try { ws.terminate(); } catch (_) {} }
    if (this.router.ext) { try { this.router.ext.terminate(); } catch (_) {} }
    for (const p of this.pending.values()) p.resolve(false);
    await this.router.closeBrowser();
    await new Promise((r) => { this.server.closeAllConnections?.(); this.server.close(() => r()); });
  }
}