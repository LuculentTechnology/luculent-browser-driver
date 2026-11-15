// Luculent account settings sync. Device tokens stay in chrome.storage.local and are never written to sync storage.
// API keys, secrets and chats are never packed. Signed-out use is unchanged and fully local.

export const ACCOUNT_ORIGIN = 'https://luculent.dev';
export const SIGN_UP_PATH = '/beta/sign-up';
export const HANDOFF_MESSAGE_TYPE = 'luculent.browserDriver.handoff';
const TOKEN_KEY = 'accountSync';

const SECURITY_FIELDS = [
  'readOnly', 'passwords', 'eval', 'cookies', 'storage', 'downloads', 'uploads',
  'submitSensitive', 'internalPages', 'fileUrls', 'rawCdp', 'headless',
  'grantMode', 'incognito', 'bankingPreset', 'rateLimit', 'confirmTimeoutSec', 'audit',
  'aiCursor', 'clickMode',
];

export function packSettings(settings = {}, navMeta = null, times = {}) {
  const security = {};
  for (const key of SECURITY_FIELDS) {
    if (settings[key] !== undefined) security[key] = settings[key];
  }
  const payload = {
    security,
    blockedDomains: Array.isArray(settings.blocklist) ? settings.blocklist.slice() : [],
    allowedDomains: Array.isArray(settings.allowlist) ? settings.allowlist.slice() : [],
    fieldTimes: { ...times },
  };
  if (navMeta && navMeta.setByUser === true && (navMeta.consented === true || navMeta.consented === false)) {
    payload.metadataOptOut = !navMeta.consented;
  }
  const now = new Date().toISOString();
  for (const field of ['security', 'blockedDomains', 'allowedDomains', 'metadataOptOut']) {
    if (payload[field] !== undefined && !payload.fieldTimes[field]) payload.fieldTimes[field] = now;
  }
  return payload;
}

export function applyPacked(localSettings, localNav, packed) {
  const next = { ...localSettings };
  const incoming = packed && typeof packed === 'object' ? packed : {};
  if (incoming.security && typeof incoming.security === 'object') {
    for (const key of SECURITY_FIELDS) {
      if (incoming.security[key] !== undefined) next[key] = incoming.security[key];
    }
  }
  if (Array.isArray(incoming.blockedDomains)) next.blocklist = incoming.blockedDomains.map(String);
  if (Array.isArray(incoming.allowedDomains)) next.allowlist = incoming.allowedDomains.map(String);
  let nav = localNav;
  if (typeof incoming.metadataOptOut === 'boolean') {
    nav = { ...(localNav || {}), consented: !incoming.metadataOptOut, setByUser: true };
  }
  return { settings: next, navMeta: nav };
}

export function isHandoffMessage(message) {
  return Boolean(message && message.type === HANDOFF_MESSAGE_TYPE && typeof message.code === 'string' && /^[0-9a-f]{32,128}$/i.test(message.code));
}

export function signInUrl(extensionId, label = 'Chrome') {
  const url = new URL(SIGN_UP_PATH, ACCOUNT_ORIGIN);
  url.searchParams.set('handoff', '1');
  if (extensionId) url.searchParams.set('ext', extensionId);
  if (label) url.searchParams.set('label', label);
  return url.toString();
}

export async function loadAccount() {
  const { [TOKEN_KEY]: rec } = await chrome.storage.local.get([TOKEN_KEY]);
  return rec && rec.token ? rec : null;
}

export async function clearAccount() {
  await chrome.storage.local.remove(TOKEN_KEY);
}

export async function storeAccount(rec) {
  const next = { token: rec.token, deviceId: rec.deviceId || null, label: rec.label || 'Chrome', signedInAt: rec.signedInAt || new Date().toISOString() };
  await chrome.storage.local.set({ [TOKEN_KEY]: next });
  return next;
}

async function api(path, { method = 'GET', token, body } = {}) {
  const res = await fetch(`${ACCOUNT_ORIGIN}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.detail || data.error || `sync failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}

export async function exchangeHandoffCode(code, label = 'Chrome') {
  const res = await fetch(`${ACCOUNT_ORIGIN}/api/browser-driver/handoff`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code, label }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.token) {
    throw new Error(data.detail || data.error || 'Sign-in handoff failed.');
  }
  return storeAccount({ token: data.token, deviceId: data.deviceId, label: data.label || label });
}

export async function pullAndApply({ loadSettings, saveSettings, loadNavMeta, saveNavMeta }) {
  const rec = await loadAccount();
  if (!rec) return null;
  applyingRemote = true;
  try {
  const remote = await api('/api/browser-driver/settings', { token: rec.token });
  const localSettings = await loadSettings();
  const localNav = await loadNavMeta();
  const applied = applyPacked(localSettings, localNav, remote.settings || remote);
  await saveSettings(applied.settings);
  if (saveNavMeta && applied.navMeta) await saveNavMeta(applied.navMeta);
  await chrome.storage.local.set({ accountSyncTimes: remote.fieldTimes || {} });
  return applied;
  } finally {
    applyingRemote = false;
  }
}

export async function pushLocal({ loadSettings, loadNavMeta }) {
  const rec = await loadAccount();
  if (!rec) return null;
  const settings = await loadSettings();
  const navMeta = await loadNavMeta();
  const { accountSyncTimes } = await chrome.storage.local.get(['accountSyncTimes']);
  const payload = packSettings(settings, navMeta, accountSyncTimes || {});
  const now = new Date().toISOString();
  payload.fieldTimes = payload.fieldTimes || {};
  for (const field of ['security', 'blockedDomains', 'allowedDomains', 'metadataOptOut']) {
    payload.fieldTimes[field] = now;
  }
  const saved = await api('/api/browser-driver/settings', { method: 'PUT', token: rec.token, body: payload });
  await chrome.storage.local.set({ accountSyncTimes: saved.fieldTimes || payload.fieldTimes });
  return saved;
}

let pushTimer = null;
let applyingRemote = false;
export function queuePush(deps) {
  if (pushTimer) clearTimeout(pushTimer);
  pushTimer = setTimeout(() => {
    pushLocal(deps).catch(() => {});
  }, 750);
}

export function startAccountSync(deps) {
  chrome.runtime.onMessageExternal.addListener((message, sender, sendResponse) => {
    const origin = sender?.url || sender?.origin || '';
    if (!/^https:\/\/(www\.)?(luculent\.dev|luculent\.app)(:|\/|$)/i.test(origin)) {
      sendResponse({ ok: false, error: 'rejected' });
      return false;
    }
    if (!isHandoffMessage(message)) {
      sendResponse({ ok: false, error: 'ignored' });
      return false;
    }
    exchangeHandoffCode(message.code, 'Chrome').then(async (rec) => {
      try { await pullAndApply(deps); } catch (_) {}
      sendResponse({ ok: true, deviceId: rec.deviceId });
    }).catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (applyingRemote) return;
    if (changes.settings || changes.navMeta) queuePush(deps);
  });
  loadAccount().then((rec) => { if (rec) pullAndApply(deps).catch(() => {}); }).catch(() => {});
}

export async function openSignIn() {
  const label = 'Chrome';
  const url = signInUrl(chrome.runtime.id, label);
  await chrome.tabs.create({ url });
}

export async function signOutLocal() {
  await clearAccount();
}
