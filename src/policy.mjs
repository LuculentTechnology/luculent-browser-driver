// User security policy: what connected AI agents may do. Default-safe. One global policy (edited from the extension
// popup/options page or `lbd policy`), tightened per API key by its scopes and optional per-key overrides.
// The relay enforces all of it; the extension enforces its own copy of the browser-level rules as well.
import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';

// Banking / payment / crypto sites blocked by default (toggle "bankingPreset"). Host and its subdomains.
export const BANKING_PRESET = [
  'chase.com', 'bankofamerica.com', 'wellsfargo.com', 'citi.com', 'citibank.com', 'capitalone.com', 'usbank.com', 'pnc.com',
  'td.com', 'tdbank.com', 'ally.com', 'discover.com', 'americanexpress.com', 'schwab.com', 'fidelity.com', 'vanguard.com',
  'etrade.com', 'robinhood.com', 'sofi.com', 'chime.com', 'mercury.com', 'wise.com', 'revolut.com', 'monzo.com',
  'hsbc.com', 'barclays.co.uk', 'lloydsbank.com', 'santander.com', 'rbc.com', 'scotiabank.com', 'bmo.com',
  'paypal.com', 'venmo.com', 'cash.app', 'zellepay.com', 'stripe.com', 'squareup.com', 'pay.google.com', 'klarna.com',
  'affirm.com', 'afterpay.com', 'coinbase.com', 'binance.com', 'kraken.com', 'gemini.com', 'crypto.com', 'metamask.io',
  'irs.gov', 'ssa.gov', '/(^|\\.)(my)?bank[a-z0-9-]*\\./', '/(^|\\.)creditunion[a-z0-9-]*\\./',
];

const LEVEL = { allow: 2, confirm: 1, deny: 0 };
export const CAPS = ['passwords', 'eval', 'cookies', 'storage', 'downloads', 'uploads', 'submitSensitive', 'internalPages', 'fileUrls', 'rawCdp', 'headless'];

export const DEFAULT_POLICY = Object.freeze({
  readOnly: false,            // true: agents may navigate, scroll and read, but not click, type, select, upload or run JS
  passwords: 'deny',          // read password field values / type into password fields
  eval: 'deny',               // run arbitrary JavaScript in pages (browser_eval). Note: eval can read anything on a page.
  cookies: 'deny',            // read or change cookies
  storage: 'deny',            // read or change localStorage/sessionStorage
  downloads: 'allow',         // let pages the agent drives download files
  uploads: 'confirm',         // attach local files to file inputs (each upload asks you first)
  submitSensitive: 'confirm', // submit forms on login, password or payment pages / type into card fields
  internalPages: 'deny',      // chrome://, chrome-extension:// (other extensions), devtools://, about: pages
  fileUrls: 'deny',           // file:// URLs (your local disk)
  rawCdp: 'deny',             // raw Chrome DevTools Protocol commands
  headless: 'allow',          // launch background (headless) Chrome
  grantMode: 'granted',       // extension: 'granted' = only tabs you grant + tabs agents open; 'all' = every tab
  incognito: false,           // extension: allow driving incognito tabs (Chrome also requires "Allow in Incognito")
  bankingPreset: true,        // block BANKING_PRESET sites
  blocklist: [],              // extra blocked hosts ("example.com", "*.example.com", "/regex/")
  allowlist: [],              // if non-empty, agents may only act on these hosts
  rateLimit: { perSecond: 20, perMinute: 600 },
  confirmTimeoutSec: 60,
  audit: true,
});

// Everything allowed: used by the test suites and benchmark on local fixtures only.
export const OPEN_POLICY = Object.freeze({ ...DEFAULT_POLICY, passwords: 'allow', eval: 'allow', cookies: 'allow', storage: 'allow', downloads: 'allow', uploads: 'allow', submitSensitive: 'allow', internalPages: 'deny', fileUrls: 'allow', rawCdp: 'allow', grantMode: 'all', bankingPreset: false, rateLimit: { perSecond: 1000, perMinute: 60000 } });

// Scope a key needs for each capability (keys minted before these scopes existed keep read/act/tabs/headless).
export const CAP_SCOPE = { eval: 'eval', cookies: 'cookies', storage: 'storage', uploads: 'upload', downloads: 'act', passwords: 'passwords', submitSensitive: 'act', rawCdp: 'cdp', headless: 'headless', internalPages: 'admin', fileUrls: 'files' };

export function normalize(p = {}) {
  const out = { ...DEFAULT_POLICY, ...p };
  for (const c of CAPS) if (!(out[c] in LEVEL)) out[c] = DEFAULT_POLICY[c];
  out.readOnly = !!out.readOnly; out.bankingPreset = !!out.bankingPreset; out.incognito = !!out.incognito; out.audit = out.audit !== false;
  out.grantMode = out.grantMode === 'all' ? 'all' : 'granted';
  out.blocklist = [].concat(out.blocklist || []).map(String).filter(Boolean);
  out.allowlist = [].concat(out.allowlist || []).map(String).filter(Boolean);
  out.allowlistRequired = !!out.allowlistRequired;
  out.rateLimit = { perSecond: Math.max(1, Number(out.rateLimit?.perSecond) || 20), perMinute: Math.max(1, Number(out.rateLimit?.perMinute) || 600) };
  out.confirmTimeoutSec = Math.min(600, Math.max(5, Number(out.confirmTimeoutSec) || 60));
  return out;
}

const stricter = (a, b) => (LEVEL[a] <= LEVEL[b] ? a : b);

/** Effective policy for a request: global policy, tightened by the key's scopes and per-key overrides. */
export function effective(global, key) {
  const g = normalize(global);
  if (!key) return g; // admin token: global policy only
  const o = key.policy || {};
  const e = { ...g };
  for (const c of CAPS) {
    let v = g[c];
    if (o[c] in LEVEL) v = stricter(v, o[c]);
    const sc = CAP_SCOPE[c];
    if (sc && !key.scopes.includes(sc) && !(c === 'internalPages' || c === 'fileUrls' ? false : key.scopes.includes('admin'))) v = 'deny';
    e[c] = v;
  }
  e.readOnly = g.readOnly || !!o.readOnly || !key.scopes.includes('act');
  e.blocklist = [...g.blocklist, ...[].concat(o.blocklist || [])];
  e.allowlist = g.allowlist.length ? g.allowlist : [];
  e.keyAllow = key.allowOrigins || [];
  if (o.rateLimit) e.rateLimit = { perSecond: Math.min(g.rateLimit.perSecond, o.rateLimit.perSecond || Infinity), perMinute: Math.min(g.rateLimit.perMinute, o.rateLimit.perMinute || Infinity) };
  if (o.confirmAll) e.confirmAll = true;
  return e;
}

export function hasUrlScheme(url) {
  const m = /^([a-z][a-z0-9+.-]*):/i.exec(String(url || ''));
  if (!m) return false;
  const rest = String(url).slice(m[0].length);
  if (rest.startsWith('//')) return true;
  if (/^\d/.test(rest)) return false; // localhost:3000 or example.com:8080, not a scheme
  return !m[1].includes('.');
}

export function hostMatch(pattern, host) {
  if (!pattern || !host) return false;
  const canon = (h) => String(h).replace(/\.+$/, '').toLowerCase();
  host = canon(host);
  if (pattern === '*') return true;
  if (pattern.length > 2 && pattern.startsWith('/') && pattern.endsWith('/')) { try { return new RegExp(pattern.slice(1, -1), 'i').test(host); } catch (_) { return false; } }
  const p = canon(pattern.replace(/^\*\./, ''));
  return host === p || host.endsWith('.' + p);
}


/** Chrome Web Store pages are always refused (install/review surface is off limits to agents). */
export function isChromeWebStore(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/\.+$/, '').toLowerCase();
    const path = u.pathname.toLowerCase();
    if (host === 'chromewebstore.google.com' || host.endsWith('.chromewebstore.google.com')) return true;
    if ((host === 'chrome.google.com' || host === 'www.chrome.google.com') && (path === '/webstore' || path.startsWith('/webstore/'))) return true;
    return false;
  } catch (_) { return false; }
}
const INTERNAL = /^(chrome|chrome-extension|chrome-untrusted|chrome-search|devtools|edge|brave|opera|vivaldi|view-source|about):/i;

/** Why `url` is off-limits under policy `e`, or null if it is allowed. */
export function urlBlocked(e, url) {
  if (!url) return null;
  let u;
  try { u = new URL(url); } catch (_) { return null; }
  if (u.protocol === 'javascript:') return 'javascript: URLs are blocked';
  if (u.protocol === 'about:' && /^about:(blank|srcdoc)$/i.test(url.split(/[?#]/)[0])) return null;
  if (u.protocol === 'data:') return null;
  if (u.protocol === 'blob:') {
    if (u.origin && u.origin !== 'null' && /^https?:/i.test(u.origin)) return urlBlocked(e, u.origin);
    return null;
  }
  if (INTERNAL.test(url)) return e.internalPages === 'allow' ? null : `browser-internal and extension pages are blocked by your security settings (${u.protocol}//)`;
  if (isChromeWebStore(url)) return 'Chrome Web Store pages are blocked by your security settings';
  if (u.protocol === 'file:') return e.fileUrls === 'allow' ? null : 'file:// URLs are blocked by your security settings';
  const host = u.hostname.replace(/\.+$/, '').toLowerCase();
  if (e.bankingPreset && BANKING_PRESET.some((p) => hostMatch(p, host))) return `${host} is on the banking/payment blocklist (turn off "Block banking and payment sites" to allow)`;
  if (e.blocklist.some((p) => hostMatch(p, host))) return `${host} is on your blocklist`;
  if ((e.allowlistRequired || e.allowlist.length) && !e.allowlist.some((p) => hostMatch(p, host))) return `${host} is not on your allowlist`;
  if (e.keyAllow && e.keyAllow.length && !e.keyAllow.some((p) => hostMatch(p, host))) return `this API key may not act on ${host}`;
  return null;
}

export class PolicyStore {
  constructor(home, override) {
    this.path = join(home, 'policy.json');
    this.override = override ? normalize(override.preset === 'open' ? { ...OPEN_POLICY, ...override } : override) : null;
  }
  get() {
    if (this.override) return this.override;
    if (!existsSync(this.path)) return normalize({});
    try { return normalize(JSON.parse(readFileSync(this.path, 'utf8'))); } catch (_) { return normalize({}); }
  }
  set(patch) {
    if (this.override) { this.override = normalize({ ...this.override, ...patch }); return this.override; }
    const next = normalize({ ...this.get(), ...patch });
    const tmp = this.path + '.tmp';
    writeFileSync(tmp, JSON.stringify(next, null, 2), { mode: 0o600 });
    renameSync(tmp, this.path);
    return next;
  }
}

export class RateLimiter {
  constructor() { this.hits = new Map(); }
  take(id, { perSecond, perMinute }) {
    const now = Date.now();
    const a = (this.hits.get(id) || []).filter((t) => now - t < 60000);
    const sec = a.filter((t) => now - t < 1000).length;
    if (sec >= perSecond || a.length >= perMinute) { this.hits.set(id, a); return false; }
    a.push(now); this.hits.set(id, a); return true;
  }
}