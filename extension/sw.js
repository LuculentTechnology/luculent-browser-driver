// Luculent Browser Driver extension service worker.
// Holds ONE persistent WebSocket to the local relay and executes CDP commands on tabs via chrome.debugger.
// Never opens tabs on its own: no welcome/connect pages, reconnects silently.
// Security (enforced here, independent of the relay): relay identity pinning, killswitch, per-tab grants,
// incognito off, internal/extension pages off limits, site block/allow lists, read-only mode, cookie/upload/download
// controls, upload approvals, rate limit, an "AI" badge on every controlled tab, and an audit trail.
import { activeTransport } from './transports.js';
import { loadSettings, urlBlocked } from './settings.js';
import { extractInPage } from './extract.js';
const VERSION = chrome.runtime.getManifest().version;
let ws = null;
let connecting = false;
let backoff = 200;
let killed = false;
let verified = false;
let relayState = 'off'; // on | off | untrusted
let nonce = null;
let settings = null;
const attached = new Set();
const attaching = new Map();
const children = new Map(); // tabId -> Map(targetId -> {sessionId, targetId, url})
const granted = new Set();
let grantedSticky = []; // {url, origin} persists across Chrome restarts (tab ids do not)
const reattaching = new Set();
const attachFailed = new Map(); // tabId -> error message when debugger attach was refused
let profileId = null;
let profileName = 'Default';
let humanPause = null;
const pending = new Map();  // confirmation id -> entry
const approvals = new Map(); // approved confirmation id -> expiry ms
const audit = [];
const cmdTimes = [];
let lastAgentInput = 0;

const ready = (async () => {
  settings = await loadSettings();
  const local = await chrome.storage.local.get(['granted', 'grantedSticky', 'killed', 'profileId', 'profileName']);
  const sess = await chrome.storage.session.get(['granted', 'killed']);
  killed = !!(local.killed || sess.killed);
  for (const id of sess.granted || local.granted || []) granted.add(Number(id) || id);
  grantedSticky = Array.isArray(local.grantedSticky) ? local.grantedSticky : [];
  profileId = local.profileId || (crypto.randomUUID ? crypto.randomUUID() : ('p_' + Math.random().toString(36).slice(2, 10)));
  profileName = local.profileName || 'Default';
  if (!local.profileId) await chrome.storage.local.set({ profileId, profileName });
  await restoreStickyGrants();
})();

const COOKIE_METHODS = /^(Network\.(getCookies|getAllCookies|setCookie|setCookies|deleteCookies|clearBrowserCookies)|Storage\.(getCookies|setCookies|clearCookies))$/;
const READONLY_BLOCK = /^(Input\.|DOM\.(setFileInputFiles|setAttributeValue|setAttributesAsText|setOuterHTML|setNodeValue|removeNode|removeAttribute)|Network\.(setCookie|setCookies|deleteCookies|clearBrowserCookies)|Page\.handleJavaScriptDialog|Emulation\.setGeolocationOverride)/;
const ALWAYS_BLOCK = /^(Browser\.|SystemInfo\.|Target\.(createTarget|attachToBrowserTarget|exposeDevToolsProtocol|closeTarget|createBrowserContext|disposeBrowserContext)|Security\.setIgnoreCertificateErrors|Page\.setDownloadBehavior|Storage\.clearDataForOrigin|Network\.clearBrowserCache)/;
const FORWARD_EVENTS = new Set(['Page.javascriptDialogOpening']);

function paint() {
  const pendingN = pending.size;
  const [text, color] = killed ? ['STOP', '#dc2626'] : relayState === 'untrusted' ? ['!', '#dc2626'] : pendingN ? ['?', '#f59e0b'] : relayState === 'on' ? ['', '#16a34a'] : ['off', '#6b7280'];
  chrome.action.setBadgeText({ text }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ color }).catch(() => {});
  for (const tabId of attached) { // per-tab indicator: "AI" on every tab an agent is controlling
    chrome.action.setBadgeText({ tabId, text: killed ? 'STOP' : pendingN ? '?' : 'AI' }).catch(() => {});
    chrome.action.setBadgeBackgroundColor({ tabId, color: killed ? '#dc2626' : pendingN ? '#f59e0b' : '#7c3aed' }).catch(() => {});
    chrome.action.setTitle({ tabId, title: 'An AI agent is controlling this tab (Luculent Browser Driver). Click for the killswitch.' }).catch(() => {});
  }
  chrome.storage.session.set({ status: killed ? 'kill' : relayState, attached: attached.size, killed, pending: [...pending.values()], audit: audit.slice(-200), granted: [...granted] }).catch(() => {});
}
function unpaintTab(tabId) {
  chrome.action.setBadgeText({ tabId, text: '' }).catch(() => {});
  chrome.action.setTitle({ tabId, title: 'Luculent Browser Driver for AI Agents' }).catch(() => {});
}

function logAudit(entry) {
  audit.push({ t: new Date().toISOString(), ...entry });
  if (audit.length > 200) audit.splice(0, audit.length - 200);
  paint();
}

function send(obj) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); }

function hex(buf) { return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join(''); }
async function hmacHex(secretHex, msg) {
  const key = await crypto.subtle.importKey('raw', new Uint8Array(secretHex.match(/../g).map((h) => parseInt(h, 16))), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(msg)));
}

async function pageEval(tabId, expression) {
  if (!chrome.scripting?.executeScript) throw new Error('scripting is not available');
  const [res] = await chrome.scripting.executeScript({
    target: { tabId }, world: 'MAIN',
    func: (expr) => { try { return { result: { value: (0, eval)(expr) } }; } catch (e) { return { exceptionDetails: { text: e.message } }; } },
    args: [String(expression)],
  });
  return res && res.result ? res.result : { exceptionDetails: { text: 'no result' } };
}
async function extractTab(tabId) {
  const tab = await chrome.tabs.get(tabId);
  const why = urlBlocked(settings, tab.url);
  if (why) { const e = new Error('Blocked by your Luculent security settings: ' + why); e.denied = true; throw e; }
  if (!chrome.scripting?.executeScript) return { title: tab.title, url: tab.url, text: '', headings: [], links: [], tables: [], selection: '' };
  const [res] = await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', func: extractInPage });
  return res?.result || { title: tab.title || '', url: tab.url || '', text: '', headings: [], links: [], tables: [], selection: '' };
}

const panelPending = new Map();
let panelSeq = 0;
function panelCall(payload, timeout = 20000) {
  if (!ws || ws.readyState !== 1 || !verified) return Promise.reject(new Error('Relay is not connected'));
  const id = 'panel_' + (++panelSeq);
  return new Promise((res, rej) => {
    const timer = setTimeout(() => { panelPending.delete(id); rej(new Error('Relay timed out')); }, timeout);
    panelPending.set(id, { res: (v) => { clearTimeout(timer); res(v); }, rej: (e) => { clearTimeout(timer); rej(e); } });
    send({ id, ...payload });
  });
}
async function pullPageContext(tabId) {
  let tab;
  if (tabId != null && tabId !== '') tab = await chrome.tabs.get(Number(tabId));
  else [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab || tab.id < 0) throw new Error('No active tab');
  const raw = await extractTab(tab.id);
  return panelCall({ type: 'panel.pull', raw, tab: String(tab.id) });
}
async function relaySetup(msg = {}) {
  return panelCall({ type: 'setup', clients: msg.clients, startAtLogon: msg.startAtLogon !== false, startNow: !!msg.startNow, dryRun: !!msg.dryRun });
}


async function connect() {
  if (connecting || (ws && (ws.readyState === 0 || ws.readyState === 1))) return;
  connecting = true;
  await ready;
  const transport = await activeTransport();
  let sock, extra = {};
  try { sock = await transport.open(); extra = await transport.hello(); } catch (_) { connecting = false; schedule(); return; }
  ws = sock;
  verified = false;
  sock.onopen = async () => {
    connecting = false; backoff = 200;
    nonce = hex(crypto.getRandomValues(new Uint8Array(16)));
    const { relaySecret } = await chrome.storage.local.get(['relaySecret']);
    send({ type: 'hello', version: VERSION, ua: navigator.userAgent, nonce, paired: !!relaySecret, settings, profileId, profileName, ...extra });
  };
  sock.onmessage = (ev) => { let m; try { m = JSON.parse(ev.data); } catch (_) { return; } handle(m, sock); };
  sock.onclose = () => { connecting = false; if (ws === sock) ws = null; verified = false; if (relayState !== 'untrusted') relayState = 'off'; paint(); schedule(); };
  sock.onerror = () => {};
}
let timer = null;
function schedule() { if (timer) return; timer = setTimeout(() => { timer = null; connect(); }, backoff); backoff = Math.min(backoff * 2, 3000); }

// Keep the service worker alive: WebSocket traffic every 20s extends its lifetime (Chrome 116+),
// and the alarm revives it if Chrome still unloads it.
setInterval(() => { if (ws && ws.readyState === 1) send({ type: 'ping' }); }, 20000);
chrome.alarms.create('lbd-keepalive', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((a) => { if (!a || a.name === 'lbd-keepalive') connect(); if (a && a.name === 'lbd-chat-purge') send({ type: 'chats.purge' }); });
chrome.runtime.onStartup.addListener(() => connect());
chrome.runtime.onInstalled.addListener(() => connect());

function persistGrants() {
  chrome.storage.session.set({ granted: [...granted], killed }).catch(() => {});
  chrome.storage.local.set({ granted: [...granted], grantedSticky, killed }).catch(() => {});
}
function stickyUrl(url) {
  try { const u = new URL(url); return u.origin + u.pathname + u.search; } catch (_) { return url || ''; }
}
function stickyMatch(url) {
  if (!url || !grantedSticky.length) return false;
  try {
    const u = new URL(url);
    const canon = u.origin + u.pathname + u.search;
    return grantedSticky.some((s) => s.url === canon || s.url === url || (s.origin && s.origin === u.origin && u.protocol.startsWith('http')));
  } catch (_) { return false; }
}
async function restoreStickyGrants() {
  if (!grantedSticky.length) return;
  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) if (tab.id >= 0 && stickyMatch(tab.url) && !granted.has(tab.id)) granted.add(tab.id);
  persistGrants();
}
function grant(tabId) {
  granted.add(tabId);
  chrome.tabs.get(tabId).then((tab) => {
    if (tab && tab.url && !/^chrome(-extension)?:/i.test(tab.url)) {
      const url = stickyUrl(tab.url);
      let origin = '';
      try { origin = new URL(tab.url).origin; } catch (_) {}
      if (url && !grantedSticky.some((s) => s.url === url)) grantedSticky.push({ url, origin, title: tab.title || '' });
    }
    persistGrants();
  }).catch(() => persistGrants());
  paint();
}
async function revoke(tabId) {
  granted.delete(tabId);
  try {
    const tab = await chrome.tabs.get(tabId);
    const url = stickyUrl(tab.url);
    const origin = tab.url ? new URL(tab.url).origin : '';
    grantedSticky = grantedSticky.filter((s) => s.url !== url && !(origin && s.origin === origin && s.url === url));
  } catch (_) {}
  persistGrants();
  await detach(tabId);
  paint();
}

async function ensureAttached(tabId) {
  if (attached.has(tabId)) return;
  if (attaching.has(tabId)) return attaching.get(tabId);
  const p = chrome.debugger.attach({ tabId }, '1.3').catch((e) => { if (/already attached/i.test(e.message)) return; attachFailed.set(tabId, e.message || String(e)); const hint = /another debugger|devtools|cannot attach|attach to this|debugger is already|Extension protocol/i.test(e.message || '') ? ' Chrome refused debugger attach on this tab (often a password-manager iframe). Disable the other extension on this site, or retry.' : ''; const err = new Error((e.message || 'debugger attach failed') + hint); err.attachRefused = true; throw err; })
    .then(async () => {
      attachFailed.delete(tabId);
      attached.add(tabId); children.set(tabId, new Map());
      await chrome.debugger.sendCommand({ tabId }, 'Page.enable', {}).catch(() => {});
      // Background tabs are 'hidden': no frames are rendered, so hover styles, rAF-driven UIs and input acks stall.
      // Focus emulation makes the page render and behave as if it were the focused, visible tab while attached.
      await chrome.debugger.sendCommand({ tabId }, 'Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
      await chrome.debugger.sendCommand({ tabId }, 'Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }).catch(() => {});
      paint();
    })
    .finally(() => attaching.delete(tabId));
  attaching.set(tabId, p);
  return p;
}
async function detach(tabId) {
  if (!attached.has(tabId)) return;
  attached.delete(tabId); children.delete(tabId);
  await chrome.debugger.detach({ tabId }).catch(() => {});
  unpaintTab(tabId);
}

chrome.debugger.onDetach.addListener((src, reason) => {
  if (src.tabId == null) return;
  attached.delete(src.tabId); children.delete(src.tabId); unpaintTab(src.tabId);
  send({ type: 'detached', tabId: src.tabId, reason }); paint();
  const tabId = src.tabId;
  const user = /canceled_by_user|replaced_with_devtools/i.test(reason || '');
  const closed = /target_closed|destroyed/i.test(reason || '');
  if (killed || user || closed || reattaching.has(tabId)) return;
  if (!granted.has(tabId) && settings?.grantMode !== 'all') return;
  reattaching.add(tabId);
  setTimeout(async () => {
    reattaching.delete(tabId);
    if (killed || attached.has(tabId)) return;
    if (!granted.has(tabId) && settings?.grantMode !== 'all') return;
    try { await ensureAttached(tabId); send({ type: 'reattached', tabId }); }
    catch (e) { send({ type: 'attachFailed', tabId, error: e.message }); }
  }, 250);
});
chrome.debugger.onEvent.addListener((src, method, params) => {
  if (src.tabId == null) return;
  const kids = children.get(src.tabId);
  if (method === 'Target.attachedToTarget' && kids && params.targetInfo.type === 'iframe') {
    kids.set(params.targetInfo.targetId, { sessionId: params.sessionId, targetId: params.targetInfo.targetId, url: params.targetInfo.url });
    chrome.debugger.sendCommand({ tabId: src.tabId, sessionId: params.sessionId }, 'Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }).catch(() => {});
  } else if (method === 'Target.detachedFromTarget' && kids) {
    for (const [k, v] of kids) if (v.sessionId === params.sessionId) kids.delete(k);
  }
  if (FORWARD_EVENTS.has(method)) send({ type: 'event', tabId: src.tabId, sessionId: src.sessionId, method, params });
});
chrome.tabs.onRemoved.addListener((tabId) => { attached.delete(tabId); children.delete(tabId); if (granted.delete(tabId)) persistGrants(); send({ type: 'tabClosed', tabId }); });
chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.url && stickyMatch(info.url) && !granted.has(tabId)) { granted.add(tabId); persistGrants(); paint(); }
  if (info.url && granted.has(tabId) && tab.url && !/^chrome(-extension)?:/i.test(tab.url)) {
    const url = stickyUrl(tab.url);
    let origin = ''; try { origin = new URL(tab.url).origin; } catch (_) {}
    if (url && !grantedSticky.some((s) => s.url === url)) { grantedSticky.push({ url, origin, title: tab.title || '' }); persistGrants(); }
  }
});
chrome.tabGroups?.onRemoved?.addListener((group) => send({ type: 'groupClosed', groupId: group.id }));
if (chrome.sidePanel?.setPanelBehavior) chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(() => {});
chrome.alarms.create('lbd-chat-purge', { periodInMinutes: 1440 });

// Popups/new tabs opened by a tab the agent controls belong to the agent too.
// Popups and target=_blank tabs opened BY a granted tab belong to the agent too. webNavigation reports the real source
// tab (tabs.openerTabId is just whichever tab was active, so it can't be trusted for this).
chrome.webNavigation.onCreatedNavigationTarget.addListener((d) => { if (granted.has(d.sourceTabId) && !granted.has(d.tabId)) { grant(d.tabId); logAudit({ source: 'extension', tab: d.tabId, result: 'granted', reason: 'opened by agent tab ' + d.sourceTabId }); } });
chrome.downloads.onCreated.addListener((item) => {
  if (settings && settings.downloads === 'deny' && Date.now() - lastAgentInput < 5000) {
    chrome.downloads.cancel(item.id).catch(() => {});
    deny(null, 'download blocked (downloads are off for agents): ' + (item.filename || item.url || '').split(/[\\/]/).pop());
  }
});

function deny(tabId, reason) {
  logAudit({ source: 'extension', tab: tabId, result: 'denied', reason });
  send({ type: 'denied', tabId, reason });
  const e = new Error('Blocked by your Luculent security settings: ' + reason);
  e.denied = true;
  return e;
}

/** Browser-level checks for one CDP command. Throws a denial error. */
async function check(tabId, method, params) {
  if (!verified) throw deny(tabId, 'relay identity not verified');
  if (killed) throw deny(tabId, 'killswitch is engaged');
  const now = Date.now();
  while (cmdTimes.length && now - cmdTimes[0] > 1000) cmdTimes.shift();
  if (cmdTimes.length >= Math.max(200, settings.rateLimit.perSecond * 20)) throw deny(tabId, 'rate limit (too many browser commands per second)');
  cmdTimes.push(now);
  if (ALWAYS_BLOCK.test(method)) throw deny(tabId, `${method} is never allowed through the extension`);
  let tab;
  try { tab = await chrome.tabs.get(tabId); } catch (_) { throw new Error(`No tab with id ${tabId}`); }
  if (tab.incognito && !settings.incognito) throw deny(tabId, 'incognito tabs are off limits');
  if (settings.grantMode !== 'all' && !granted.has(tabId)) throw deny(tabId, 'this tab has not been granted to agents (open the extension popup on that tab and choose "Let agents use this tab")');
  const why = urlBlocked(settings, tab.url || tab.pendingUrl || '');
  if (why) throw deny(tabId, why);
  if (method === 'Page.navigate') { const w = urlBlocked(settings, params && params.url); if (w) throw deny(tabId, w); }
  if (settings.readOnly && READONLY_BLOCK.test(method)) throw deny(tabId, 'read-only mode is on');
  if (COOKIE_METHODS.test(method) && settings.cookies === 'deny') throw deny(tabId, 'cookie access is turned off');
  if (method === 'DOM.setFileInputFiles') {
    if (settings.uploads === 'deny') throw deny(tabId, 'file uploads are turned off');
    if (settings.uploads === 'confirm') {
      const id = params && params.approval;
      if (!id || !(approvals.get(id) > now)) throw deny(tabId, 'file upload needs your approval');
      approvals.delete(id);
    }
  }
  if (/^(Input\.|Runtime\.evaluate)/.test(method)) lastAgentInput = now;
}

async function cdp(tabId, method, params, sessionId) {
  await check(tabId, method, params || {});
  if (params && params.approval) { const { approval, ...rest } = params; params = rest; }
  try { await ensureAttached(tabId); }
  catch (e) {
    if (method === 'Runtime.evaluate' && !sessionId) return pageEval(tabId, params && params.expression);
    throw e;
  }
  const target = sessionId ? { tabId, sessionId } : { tabId };
  // Chrome acks mouse moves/wheels in background tabs only on the next rendered frame (~5 s when hidden). The event is
  // delivered right away, so don't block on the ack.
  if (method === 'Input.dispatchMouseEvent' && params && (params.type === 'mouseMoved' || params.type === 'mouseWheel')) {
    const p = chrome.debugger.sendCommand(target, method, params);
    p.catch(() => {});
    return Promise.race([p, new Promise((r) => setTimeout(() => r({}), 50))]);
  }
  try {
    return await chrome.debugger.sendCommand(target, method, params || {});
  } catch (e) {
    if (!sessionId && /not attached|Detached|No tab with given id.*debugger/i.test(e.message)) {
      attached.delete(tabId);
      await ensureAttached(tabId);
      return chrome.debugger.sendCommand({ tabId }, method, params || {});
    }
    throw e;
  }
}

async function detachAll() {
  const ids = [...attached];
  await Promise.all(ids.map((tabId) => detach(tabId)));
}

async function setKilled(v, reason) {
  killed = v;
  await chrome.storage.session.set({ killed: v }).catch(() => {});
  await chrome.storage.local.set({ killed: v }).catch(() => {});
  if (v) { for (const id of [...pending.keys()]) resolveConfirm(id, false, true); await detachAll(); }
  logAudit({ source: 'extension', result: v ? 'killswitch engaged' : 'killswitch released', reason });
}

function resolveConfirm(id, allow, silent) {
  const p = pending.get(id);
  if (!p) return;
  pending.delete(id);
  if (allow) approvals.set(id, Date.now() + 120000);
  chrome.notifications.clear(id).catch(() => {});
  if (!silent) send({ type: 'confirmResult', id, allow: !!allow });
  logAudit({ source: 'you', result: allow ? 'approved' : 'declined', reason: p.summary, key: p.key });
}

async function handle(m, sock) {
  if (m.type === 'pong') return;
  if (m.type === 'auth') {
    const { relaySecret } = await chrome.storage.local.get(['relaySecret']);
    if (!relaySecret) {
      if (m.secret && /^[0-9a-f]{64}$/.test(m.secret)) { await chrome.storage.local.set({ relaySecret: m.secret, pairedAt: Date.now() }); verified = true; }
    } else {
      const want = await hmacHex(relaySecret, nonce || '');
      verified = !!m.mac && m.mac === want;
    }
    relayState = verified ? 'on' : 'untrusted';
    if (!verified) { logAudit({ source: 'extension', result: 'denied', reason: 'relay on this port failed its identity check (re-pair in Settings if you reinstalled the relay)' }); try { sock.close(4002, 'relay identity mismatch'); } catch (_) {} }
    paint();
    return;
  }
  if (m.id != null && panelPending.has(m.id)) {
    const p = panelPending.get(m.id); panelPending.delete(m.id);
    if (m.error) p.rej(new Error(m.error)); else p.res(m.result);
    return;
  }
  if (!verified) { if (m.id != null) send({ id: m.id, error: 'relay identity not verified', denied: true }); return; }
  if (m.type === 'panel.sync' || m.type === 'humanPause' || m.type === 'humanResume') {
    if (m.type === 'humanPause') humanPause = m;
    if (m.type === 'humanResume') humanPause = null;
    chrome.runtime.sendMessage({ type: m.type === 'humanPause' ? 'panel.pause' : 'panel.sync', pause: humanPause }).catch(() => {});
    if (m.type === 'humanPause') {
      chrome.notifications.create('lbd-pause-' + (m.id || ''), { type: 'basic', iconUrl: 'icons/icon-128.png', title: 'The agent needs you', message: String(m.reason || 'CAPTCHA or 2FA'), contextMessage: String(m.message || 'Finish it in the tab, then resume in the chat panel.'), priority: 1 }).catch(() => {});
    }
    return;
  }
  if (m.type === 'killed') { if (!killed) await setKilled(true, 'relay'); paint(); return; }
  if (m.type === 'resumed') { if (killed) await setKilled(false, 'relay resume'); paint(); return; }
  if (m.type === 'policy') return; // the relay's own policy; this extension only ever follows the settings you set here
  if (m.type === 'audit') { audit.push(m.entry); if (audit.length > 200) audit.splice(0, audit.length - 200); paint(); return; }
  if (m.type === 'confirm') {
    pending.set(m.id, m);
    let host = ''; try { host = new URL(m.url).host; } catch (_) {}
    chrome.notifications.create(m.id, { type: 'basic', iconUrl: 'icons/icon-128.png', title: 'Approve AI agent action?', message: `${m.key} wants to ${m.summary}`, contextMessage: host || 'Luculent Browser Driver', buttons: [{ title: 'Allow' }, { title: 'Deny' }], requireInteraction: true, priority: 2 }).catch(() => {});
    paint();
    return;
  }
  if (m.type === 'confirmExpired') { if (pending.delete(m.id)) chrome.notifications.clear(m.id).catch(() => {}); paint(); return; }
  const reply = (result, error, denied) => send({ id: m.id, result, error, ...(denied ? { denied: true } : {}) });
  try {
    switch (m.type) {
      case 'cdp': return reply(await cdp(m.tabId, m.method, m.params, m.sessionId));
      case 'frames': return reply([...(children.get(m.tabId) || new Map()).values()]);
      case 'tabs': {
        const [tabs, win] = await Promise.all([chrome.tabs.query({}), chrome.windows.getLastFocused().catch(() => null)]);
        const all = settings.grantMode === 'all';
        // Tabs the agent may not use are listed without URL or title.
        return reply({ focusedWindowId: win ? win.id : null, tabs: tabs.filter((t) => t.id >= 0).map((t) => {
          const ok = (all || granted.has(t.id)) && (!t.incognito || settings.incognito);
          return ok ? { id: t.id, url: t.url || t.pendingUrl || '', title: t.title || '', active: t.active, windowId: t.windowId, attached: attached.has(t.id), granted: true, incognito: t.incognito }
            : { id: t.id, url: '', title: '', active: t.active, windowId: t.windowId, attached: false, granted: false, incognito: t.incognito };
        }) });
      }
      case 'newTab': {
        if (killed) throw deny(null, 'killswitch is engaged');
        const t = await chrome.tabs.create({ url: m.url || 'about:blank', active: !!m.active });
        grant(t.id); // tabs the agent opens are the agent's
        return reply({ id: t.id });
      }
      case 'downloads': { const items = await chrome.downloads.search({ orderBy: ['-startTime'], limit: m.limit || 20 }); return reply(items.map((d) => ({ id: d.id, url: d.finalUrl || d.url, filename: d.filename, state: d.state, error: d.error, bytesReceived: d.bytesReceived, totalBytes: d.totalBytes, startTime: Date.parse(d.startTime), mime: d.mime }))); }
      case 'closeTab': {
        if (settings.grantMode !== 'all' && !granted.has(m.tabId)) throw deny(m.tabId, 'this tab has not been granted to agents');
        await chrome.tabs.remove(m.tabId); return reply({});
      }
      case 'activate': {
        if (settings.grantMode !== 'all' && !granted.has(m.tabId)) throw deny(m.tabId, 'this tab has not been granted to agents');
        // Never steal OS focus unless the caller explicitly asks (default off).
        if (m.stealFocus) {
          const tab = await chrome.tabs.update(m.tabId, { active: true });
          await chrome.windows.update(tab.windowId, { focused: true });
        }
        return reply({});
      }
      case 'group': {
        try {
          const groupId = await chrome.tabs.group({ tabIds: [m.tabId].concat(m.tabIds || []).filter(Boolean) });
          await chrome.tabGroups.update(groupId, { title: String(m.title || 'Agent').slice(0, 64), color: m.color || 'purple', collapsed: false });
          return reply({ groupId });
        } catch (e) { return reply(undefined, e.message); }
      }
      case 'evalPage': {
        return reply(await pageEval(m.tabId, m.expression));
      }
      case 'extractContext': {
        return reply(await extractTab(m.tabId));
      }
      case 'openPanel': {
        const windowId = m.windowId || (await chrome.windows.getLastFocused({ windowTypes: ['normal'] })).id;
        await chrome.sidePanel.open({ windowId });
        return reply({ ok: true, windowId });
      }
      case 'panelClickPull': {
        const sent = await chrome.runtime.sendMessage({ type: 'panel.clickPull' }).catch(() => null);
        return reply({ ok: !!(sent && sent.ok), sent });
      }
      case 'detach': await detach(m.tabId); return reply({});
      case 'detachAll': await setKilled(true, 'relay killswitch'); paint(); return reply({});
      default: return reply(undefined, `unknown message ${m.type}`);
    }
  } catch (e) {
    reply(undefined, String((e && e.message) || e), !!(e && e.denied));
  }
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.settings) return;
  const prev = settings;
  settings = changes.settings.newValue ? { ...changes.settings.newValue } : settings;
  send({ type: 'settings', settings });
  if (prev && prev.grantMode === 'all' && settings.grantMode !== 'all') for (const id of [...attached]) if (!granted.has(id)) detach(id);
  logAudit({ source: 'you', result: 'settings changed' });
});

chrome.notifications.onButtonClicked.addListener((id, idx) => resolveConfirm(id, idx === 0));
chrome.commands.onCommand.addListener((cmd) => {
  if (cmd === 'killswitch') { send({ type: 'kill' }); setKilled(true, 'keyboard shortcut').then(paint); }
  if (cmd === 'open-panel') {
    chrome.windows.getLastFocused({ windowTypes: ['normal'] }).then((w) => chrome.sidePanel.open({ windowId: w.id })).catch(() => {});
  }
});

chrome.runtime.onMessage.addListener((msg, sender, respond) => {
  if (sender.id !== chrome.runtime.id || !msg) return false; // only our own popup/options pages
  (async () => {
    await ready;
    switch (msg.type) {
      case 'popup.kill': send({ type: 'kill' }); await setKilled(true, 'popup'); paint(); return { ok: true };
      case 'popup.resume': await setKilled(false, 'popup'); send({ type: 'resume' }); paint(); return { ok: true };
      case 'popup.status': return { connected: relayState === 'on', relayState, attached: attached.size, killed, pending: [...pending.values()], audit: audit.slice(-200), granted: [...granted], settings, profileId, profileName, pause: humanPause };
      case 'popup.reconnect': backoff = 200; connect(); return { ok: true };
      case 'popup.grant': grant(msg.tabId); return { ok: true };
      case 'popup.revoke': await revoke(msg.tabId); return { ok: true };
      case 'popup.confirm': resolveConfirm(msg.id, !!msg.allow); return { ok: true };
      case 'popup.repair': await chrome.storage.local.remove(['relaySecret', 'pairedAt']); relayState = 'off'; if (ws) try { ws.close(); } catch (_) {} connect(); return { ok: true };
      case 'popup.setup': return await relaySetup(msg);
      case 'panel.state': return await panelCall({ type: 'panel.state', id: msg.id });
      case 'panel.post': return await panelCall({ type: 'panel.post', id: msg.id, text: msg.text, from: 'user' });
      case 'panel.save': return await panelCall({ type: 'panel.save', id: msg.id });
      case 'panel.delete': return await panelCall({ type: 'panel.delete', id: msg.id });
      case 'panel.clearContext': return await panelCall({ type: 'panel.clearContext', id: msg.id });
      case 'panel.resume': humanPause = null; return await panelCall({ type: 'panel.resume', id: msg.id, text: msg.text });
      case 'panel.pull': return await pullPageContext(msg.tabId ?? msg.tab);
      default: return { error: 'unknown' };
    }
  })().then(respond, (e) => respond({ error: e.message }));
  return true;
});

connect();