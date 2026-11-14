// Security settings shared by the service worker, popup and options page. Mirrors src/policy.mjs (the relay enforces
// the same rules; the extension enforces the browser-level ones itself so a misbehaving local program can't skip them).
export const BANKING_PRESET = [
  'chase.com', 'bankofamerica.com', 'wellsfargo.com', 'citi.com', 'citibank.com', 'capitalone.com', 'usbank.com', 'pnc.com',
  'td.com', 'tdbank.com', 'ally.com', 'discover.com', 'americanexpress.com', 'schwab.com', 'fidelity.com', 'vanguard.com',
  'etrade.com', 'robinhood.com', 'sofi.com', 'chime.com', 'mercury.com', 'wise.com', 'revolut.com', 'monzo.com',
  'hsbc.com', 'barclays.co.uk', 'lloydsbank.com', 'santander.com', 'rbc.com', 'scotiabank.com', 'bmo.com',
  'paypal.com', 'venmo.com', 'cash.app', 'zellepay.com', 'stripe.com', 'squareup.com', 'pay.google.com', 'klarna.com',
  'affirm.com', 'afterpay.com', 'coinbase.com', 'binance.com', 'kraken.com', 'gemini.com', 'crypto.com', 'metamask.io',
  'irs.gov', 'ssa.gov', '/(^|\\.)(my)?bank[a-z0-9-]*\\./', '/(^|\\.)creditunion[a-z0-9-]*\\./',
];

export const DEFAULTS = {
  readOnly: false, passwords: 'deny', eval: 'deny', cookies: 'deny', storage: 'deny', downloads: 'allow', uploads: 'confirm',
  submitSensitive: 'confirm', internalPages: 'deny', fileUrls: 'deny', rawCdp: 'deny', headless: 'allow',
  grantMode: 'granted', incognito: false, bankingPreset: true, blocklist: [], allowlist: [],
  rateLimit: { perSecond: 20, perMinute: 600 }, confirmTimeoutSec: 60, audit: true,
};
const CAPS = ['passwords', 'eval', 'cookies', 'storage', 'downloads', 'uploads', 'submitSensitive', 'internalPages', 'fileUrls', 'rawCdp', 'headless'];
const LEVELS = ['allow', 'confirm', 'deny'];

export function normalize(p = {}) {
  const o = { ...DEFAULTS, ...p };
  for (const c of CAPS) if (!LEVELS.includes(o[c])) o[c] = DEFAULTS[c];
  o.readOnly = !!o.readOnly; o.incognito = !!o.incognito; o.bankingPreset = !!o.bankingPreset;
  o.grantMode = o.grantMode === 'all' ? 'all' : 'granted';
  o.blocklist = [].concat(o.blocklist || []).map(String).map((x) => x.trim()).filter(Boolean);
  o.allowlist = [].concat(o.allowlist || []).map(String).map((x) => x.trim()).filter(Boolean);
  o.rateLimit = { perSecond: Math.max(1, Number(o.rateLimit?.perSecond) || 20), perMinute: Math.max(1, Number(o.rateLimit?.perMinute) || 600) };
  o.confirmTimeoutSec = Math.min(600, Math.max(5, Number(o.confirmTimeoutSec) || 60));
  return o;
}

export async function loadSettings() {
  const { settings } = await chrome.storage.local.get(['settings']);
  if (settings) return normalize(settings);
  let seed = {};
  try { const r = await fetch(chrome.runtime.getURL('config.json')); if (r.ok) seed = (await r.json()).settings || {}; } catch (_) {}
  const s = normalize(seed);
  await chrome.storage.local.set({ settings: s });
  return s;
}
export async function saveSettings(patch) {
  const cur = await loadSettings();
  const next = normalize({ ...cur, ...patch, updatedAt: Date.now() });
  await chrome.storage.local.set({ settings: next });
  return next;
}

export function hostMatch(pattern, host) {
  if (!pattern || !host) return false;
  if (pattern === '*') return true;
  if (pattern.length > 2 && pattern.startsWith('/') && pattern.endsWith('/')) { try { return new RegExp(pattern.slice(1, -1), 'i').test(host); } catch (_) { return false; } }
  const p = pattern.replace(/^\*\./, '').toLowerCase();
  return host === p || host.endsWith('.' + p);
}

/** Chrome Web Store pages are always refused (install/review surface is off limits to agents). */
export function isChromeWebStore(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    const path = u.pathname.toLowerCase();
    if (host === 'chromewebstore.google.com' || host.endsWith('.chromewebstore.google.com')) return true;
    if ((host === 'chrome.google.com' || host === 'www.chrome.google.com') && (path === '/webstore' || path.startsWith('/webstore/'))) return true;
    return false;
  } catch (_) { return false; }
}
const INTERNAL = /^(chrome|chrome-extension|chrome-untrusted|chrome-search|devtools|edge|brave|opera|vivaldi|view-source|about):/i;
export function urlBlocked(s, url) {
  if (!url) return null;
  let u; try { u = new URL(url); } catch (_) { return null; }
  if (u.protocol === 'javascript:') return 'javascript: URLs are blocked';
  if (/^about:(blank|srcdoc)$/i.test(url.split(/[?#]/)[0]) || u.protocol === 'data:' || u.protocol === 'blob:') return null;
  if (INTERNAL.test(url)) return s.internalPages === 'allow' && !url.startsWith('chrome-extension://' + chrome.runtime.id) ? null : 'browser-internal and extension pages are off limits';
  if (isChromeWebStore(url)) return 'Chrome Web Store pages are blocked by your security settings';
  if (u.protocol === 'file:') return s.fileUrls === 'allow' ? null : 'file:// URLs are blocked';
  const host = u.hostname.toLowerCase();
  if (s.bankingPreset && BANKING_PRESET.some((p) => hostMatch(p, host))) return `${host} is on the banking/payment blocklist`;
  if (s.blocklist.some((p) => hostMatch(p, host))) return `${host} is on your blocklist`;
  if (s.allowlist.length && !s.allowlist.some((p) => hostMatch(p, host))) return `${host} is not on your allowlist`;
  return null;
}