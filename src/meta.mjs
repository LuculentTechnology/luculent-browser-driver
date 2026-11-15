// Structural navigation-metadata helpers for preemptive-planner training (LUC / t1275).
// Collects domain, path templates, page types, element fingerprints, action sequences,
// plan confirmations, timings, and success/failure. Never collects page text, form values,
// passwords, cookies, query strings, auth pages, banking/blocked sites, or incognito.
import { createHash } from 'node:crypto';
import { BANKING_PRESET, hostMatch, urlBlocked } from './policy.mjs';

export const META_SCHEMA_VERSION = 1;
export const PRIVACY_POLICY_URL = 'https://privacy.luculent.dev/policy';

export const CONSENT_TITLE = 'Help the driver get much faster over time';
export const CONSENT_BODY = "The Luculent Browser Driver can learn how sites are usually moved through — the kinds of clicks and page-to-page steps that work — and use that to plan a few moves ahead. That is how it gets faster and a little smarter with time, and it is a core part of how a small team like ours improves the product.\n\nIf you leave this on, here is exactly what we collect:\n\n• the site's registrable domain (for example wikipedia.org)\n• a generalized path with IDs and tokens already stripped (for example /wiki/:title, never the raw identifier)\n• a rough page type (article, search, listing, and so on)\n• the accessibility role and a generalized selector pattern of elements an agent acted on — not the visible label or any text\n• the sequence of actions (navigate, click, type, and so on — not what was typed)\n• whether a planned next step matched the real page, and why it was confirmed or adjusted\n• how long those steps took, and whether they succeeded\n\nWe hash an install identifier so events can be grouped without naming you.\n\nHere is what we never collect: the text of a page, anything you type, passwords, cookies, query strings, or anything from sign-in pages, banking and payment sites, or incognito windows.\n\nYou can turn this off at any time. When you do, collection stops immediately and we delete anything still waiting on your computer.\n\nThe full policy is at https://privacy.luculent.dev/policy";

/** Multi-part public suffixes we treat as one registrable unit. Conservative fallback: last two labels. */
export const MULTI_PART_SUFFIXES = [
  'ac.uk', 'co.uk', 'gov.uk', 'ltd.uk', 'me.uk', 'net.uk', 'org.uk', 'plc.uk', 'sch.uk',
  'com.au', 'net.au', 'org.au', 'edu.au', 'gov.au', 'asn.au', 'id.au',
  'co.nz', 'net.nz', 'org.nz', 'govt.nz', 'ac.nz',
  'co.jp', 'ne.jp', 'or.jp', 'ac.jp', 'go.jp', 'ad.jp', 'ed.jp', 'gr.jp',
  'co.kr', 'or.kr', 'ne.kr', 'go.kr', 'ac.kr', 're.kr',
  'com.br', 'org.br', 'net.br', 'gov.br',
  'com.mx', 'org.mx', 'gob.mx',
  'com.tr', 'org.tr', 'gov.tr',
  'co.in', 'firm.in', 'net.in', 'org.in', 'gen.in', 'ind.in', 'ac.in', 'gov.in', 'res.in',
  'com.cn', 'net.cn', 'org.cn', 'gov.cn', 'edu.cn',
  'com.tw', 'org.tw', 'gov.tw', 'edu.tw', 'idv.tw',
  'com.hk', 'org.hk', 'gov.hk', 'edu.hk', 'net.hk', 'idv.hk',
  'co.za', 'org.za', 'web.za', 'gov.za', 'ac.za',
  'com.sg', 'org.sg', 'edu.sg', 'gov.sg', 'net.sg', 'per.sg',
  'co.id', 'or.id', 'go.id', 'ac.id', 'co.th', 'or.th', 'ac.th', 'go.th',
  'com.ar', 'org.ar', 'gov.ar', 'com.co', 'com.pe', 'com.ve', 'com.ph', 'com.vn',
  'com.my', 'com.pk', 'com.ng', 'com.eg', 'co.il', 'org.il', 'gov.il', 'ac.il',
  'com.ua', 'gov.ua', 'com.pl',
  'github.io', 'herokuapp.com', 'vercel.app', 'netlify.app', 'pages.dev', 'azurewebsites.net',
  'cloudfront.net', 's3.amazonaws.com', 'googleusercontent.com',
];

const EU_LANG = new Set([
  'bg', 'cs', 'da', 'de', 'el', 'et', 'fi', 'fr', 'ga', 'hr', 'hu', 'is', 'it', 'lb',
  'lt', 'lv', 'mt', 'nl', 'pl', 'ro', 'sk', 'sl', 'sv', 'nb', 'nn', 'no', 'cy', 'gd', 'rm', 'eu', 'ca',
]);
const EU_REGION = new Set([
  'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IE', 'IT',
  'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE', 'IS', 'LI', 'NO', 'GB', 'UK',
]);
const CLEARLY_NON_EU_REGION = new Set([
  'US', 'CA', 'MX', 'BR', 'AR', 'CL', 'CO', 'PE', 'AU', 'NZ', 'JP', 'KR', 'CN', 'TW', 'HK', 'SG',
  'IN', 'ID', 'TH', 'VN', 'PH', 'MY', 'PK', 'NG', 'EG', 'ZA', 'IL', 'AE', 'SA', 'TR', 'RU', 'UA',
]);

const AUTH_PATH = /(^|\/)(login|log-in|signin|sign-in|signup|sign-up|signon|sign-on|register|registration|auth|oauth|sso|saml|openid|password|passwd|forgot|reset-password|forgot-password|account\/(login|signin)|session|sessions)(\/|$)/i;
const AUTH_HOST = /^(accounts|login|signin|auth|sso|idp|oauth)\./i;
const AUTH_HOST_EXACT = new Set([
  'accounts.google.com', 'login.microsoftonline.com', 'login.live.com', 'appleid.apple.com',
  'auth0.com', 'okta.com', 'onelogin.com',
]);
const CHECKOUT_PATH = /(^|\/)(cart|basket|checkout|payment|payments|billing|wallet|pay)(\/|$)/i;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX_RE = /^[0-9a-f]{16,}$/i;
const NUM_RE = /^\d+$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/i;
const TOKEN_RE = /^(?:eyJ[a-z0-9_-]{8,}|\d{10,}|(?=.*[a-z])(?=.*\d)[a-z0-9_-]{20,})$/i;
const USER_SEG = new Set(['user', 'users', 'u', 'profile', 'profiles', 'account', 'accounts', 'member', 'members', 'people', 'id']);
const TITLE_PREV = new Set(['wiki', 'docs', 'doc', 'blog', 'post', 'posts', 'article', 'articles', 'story', 'thread', 'topic', 'question', 'questions', 'item', 'items', 'entry', 'entries']);

export const FORBIDDEN_EVENT_KEYS = [
  'text', 'innerText', 'innerHTML', 'html', 'content', 'title', 'value', 'values', 'form', 'forms',
  'password', 'passwords', 'cookie', 'cookies', 'header', 'headers', 'query', 'queryString', 'search',
  'hash', 'fragment', 'input', 'inputs', 'email', 'token', 'tokens', 'rawUrl', 'href', 'name', 'label',
  'accessibleName', 'typed', 'selection', 'screenshot', 'shot', 'htmlSnapshot', 'body', 'pageText',
];

export function parseLocale(tag) {
  const s = String(tag || '').trim();
  if (!s) return { language: '', region: '' };
  // LANG can be en_GB.UTF-8 or en_US.UTF-8@euro — strip encoding and modifier before the region.
  const base = s.split('.')[0].split('@')[0].replace(/_/g, '-');
  const [language, region] = base.split('-');
  return { language: (language || '').toLowerCase(), region: (region || '').toUpperCase() };
}

export function timezoneLooksEuEeaUk(tz) {
  const t = String(tz || '');
  if (!t) return false;
  if (t.startsWith('Europe/')) return true;
  return /^(Atlantic\/(Reykjavik|Faroe|Canary|Madeira|Azores|Jan_Mayen)|Arctic\/Longyearbyen)$/i.test(t);
}

export function localeLooksEuEeaUk(tag) {
  const { language, region } = parseLocale(tag);
  if (region && EU_REGION.has(region)) return true;
  if (region && CLEARLY_NON_EU_REGION.has(region)) return false;
  if (language === 'en' && (!region || region === 'GB' || region === 'UK' || region === 'IE' || region === 'MT')) {
    return region === 'GB' || region === 'UK' || region === 'IE' || region === 'MT';
  }
  if (language === 'pt' && region !== 'BR') return !region || region === 'PT';
  if (language === 'es' && !region) return true; // ambiguous Spanish: conservative
  if (language === 'fr' && !region) return true;
  if (EU_LANG.has(language) && !region) return true;
  if (EU_LANG.has(language) && region && !CLEARLY_NON_EU_REGION.has(region)) return EU_REGION.has(region) || !region;
  return false;
}

/**
 * Regional default: ON (opt-out) everywhere, except OFF (opt-in) for EU/EEA/UK.
 * Conservative: if locale or timezone even might be EU/EEA/UK, default off.
 */
export function regionDefaultOn({ locale, locales, timeZone } = {}) {
  const tags = [].concat(locales || [], locale || []).filter(Boolean);
  if (timezoneLooksEuEeaUk(timeZone)) return false;
  for (const tag of tags) if (localeLooksEuEeaUk(tag)) return false;
  return true;
}

export function detectRegion({ locale, locales, timeZone } = {}) {
  const on = regionDefaultOn({ locale, locales, timeZone });
  return { region: on ? 'other' : 'eu-eea-uk', defaultOn: on };
}

export function etld1(host) {
  const h = String(host || '').replace(/\.$/, '').toLowerCase();
  if (!h || h === 'localhost' || /^\d+\.\d+\.\d+\.\d+$/.test(h) || h.includes(':')) return h;
  const labels = h.split('.');
  if (labels.length <= 2) return h;
  const joined = labels.join('.');
  const suffixes = MULTI_PART_SUFFIXES.slice().sort((a, b) => b.length - a.length);
  for (const s of suffixes) {
    if (joined === s) return h;
    if (joined.endsWith('.' + s)) {
      const rest = joined.slice(0, -(s.length + 1));
      const prev = rest.split('.').pop();
      return prev ? prev + '.' + s : s;
    }
  }
  return labels.slice(-2).join('.');
}

export function pathTemplate(pathname) {
  let path = String(pathname || '/');
  try { path = decodeURIComponent(path); } catch (_) { /* keep raw */ }
  if (!path.startsWith('/')) path = '/' + path;
  const parts = path.split('/').map((seg, i, arr) => {
    if (!seg) return seg;
    const prev = (arr[i - 1] || '').toLowerCase();
    if (seg.startsWith('@')) return ':id';
    if (UUID_RE.test(seg) || HEX_RE.test(seg) || NUM_RE.test(seg) || EMAIL_RE.test(seg) || TOKEN_RE.test(seg)) return ':id';
    if (USER_SEG.has(prev)) return ':id';
    if (TITLE_PREV.has(prev) && (/[\s_\-]/.test(seg) || seg.length > 8 || /[A-Z]/.test(seg))) return ':title';
    if (/[\s_]/.test(seg) || (seg.includes('-') && seg.length > 8) || seg.length > 24) return ':slug';
    if (seg.length > 48) return ':id';
    return seg;
  });
  const out = parts.join('/') || '/';
  return out.replace(/\/{2,}/g, '/');
}

export function pageTypeFromPath(pathname) {
  const p = String(pathname || '/').toLowerCase();
  if (AUTH_PATH.test(p)) return 'auth';
  if (CHECKOUT_PATH.test(p)) return 'checkout';
  if (p === '/' || p === '') return 'home';
  if (/(^|\/)(search|find|s)(\/|$)/.test(p) || p.includes('/search')) return 'search';
  if (/(^|\/)(settings|preferences|options|config)(\/|$)/.test(p)) return 'settings';
  if (/(^|\/)(wiki|docs?|blog|post|posts|article|articles|story)(\/|$)/.test(p)) return 'article';
  if (/(^|\/)(product|products|item|dp|gp\/product|p)(\/|$)/.test(p)) return 'product';
  if (/(^|\/)(category|categories|tag|tags|r|issues|news|newest|front|listings?|catalog|collection)(\/|$)/.test(p)) return 'listing';
  return 'other';
}

export function isAuthUrl(url) {
  let u;
  try { u = new URL(url); } catch (_) { return true; }
  const host = u.hostname.toLowerCase();
  if (AUTH_HOST.test(host)) return true;
  if ([...AUTH_HOST_EXACT].some((h) => host === h || host.endsWith('.' + h))) return true;
  if (AUTH_PATH.test(u.pathname)) return true;
  return false;
}

export function shouldCollect({ url, incognito, policy, source } = {}) {
  if (incognito) return { ok: false, reason: 'incognito' };
  if (!url) return { ok: false, reason: 'no-url' };
  let u;
  try { u = new URL(url); } catch (_) { return { ok: false, reason: 'bad-url' }; }
  if (!/^https?:$/i.test(u.protocol)) return { ok: false, reason: 'non-http' };
  if (isAuthUrl(url)) return { ok: false, reason: 'auth' };
  if (CHECKOUT_PATH.test(u.pathname)) return { ok: false, reason: 'checkout' };
  if (policy) {
    const why = urlBlocked(policy, url);
    if (why) return { ok: false, reason: 'blocked' };
  } else if (BANKING_PRESET && BANKING_PRESET.some((p) => hostMatch(p, u.hostname))) {
    return { ok: false, reason: 'banking' };
  }
  if (source === 'incognito') return { ok: false, reason: 'incognito' };
  return { ok: true, reason: null };
}

export function fingerprintElement(el = {}) {
  const role = typeof el.role === 'string' ? el.role.slice(0, 40) : undefined;
  const tag = typeof el.tag === 'string' ? el.tag.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 20) : undefined;
  let pattern = typeof el.pattern === 'string' ? el.pattern : (typeof el.selector === 'string' ? el.selector : undefined);
  if (pattern) {
    pattern = pattern
      .replace(/#([0-9a-f]{8,}|[a-z]*\d[a-z0-9_-]{8,})/ig, '#:id')
      .replace(/\[(?:id|data-id|data-testid|href|value|name|aria-label|placeholder|title|alt)=(?:['"][^'"]*['"]|[^\s\]]+)/ig, '[attr=:omit]')
      .replace(/\/\d+(\/|$)/g, '/:id$1')
      .replace(/\/[0-9a-f]{16,}(?=\/|$)/ig, '/:id')
      .replace(/:has-text\([^)]*\)/g, '')
      .replace(/\b(text|label|name)=("[^"]*"|'[^']*'|.+?)(?=(?:\s+(?:role|text|label|name|css|xpath|ref)=|\s*\[|$))/ig, '$1=:omit')
      .replace(/['"][^'"]{0,80}['"]/g, ':omit')
      .slice(0, 120);
  }
  const out = {};
  if (role) out.role = role;
  if (tag) out.tag = tag;
  if (pattern) out.pattern = pattern;
  return out;
}

export function hashInstallId(raw) {
  return createHash('sha256').update(String(raw || ''), 'utf8').digest('hex');
}

export function sanitizeEvent(input = {}, { installHash } = {}) {
  const url = input.url || input.pageUrl || '';
  const gate = shouldCollect({ url, incognito: input.incognito, policy: input.policy, source: input.source });
  if (!gate.ok) return { ok: false, reason: gate.reason, event: null };
  let u;
  try { u = new URL(url); } catch (_) { return { ok: false, reason: 'bad-url', event: null }; }
  const path = pathTemplate(u.pathname);
  const type = pageTypeFromPath(u.pathname);
  if (type === 'auth') return { ok: false, reason: 'auth', event: null };
  if (type === 'checkout') return { ok: false, reason: 'checkout', event: null };
  const event = {
    v: META_SCHEMA_VERSION,
    ts: Number(input.ts) || Date.now(),
    installId: installHash || (input.installId && /^[a-f0-9]{64}$/i.test(input.installId) ? input.installId.toLowerCase() : undefined),
    domain: etld1(u.hostname),
    path,
    pageType: type,
    action: typeof input.action === 'string' ? input.action.slice(0, 40) : undefined,
    element: fingerprintElement(input.element || {}),
    sequence: Array.isArray(input.sequence) ? input.sequence.map((a) => String(a).slice(0, 40)).slice(0, 20) : undefined,
    plan: input.plan && typeof input.plan === 'object' ? {
      matched: input.plan.matched === true,
      adjusted: input.plan.adjusted === true,
      replan: input.plan.replan === true,
      reason: typeof input.plan.reason === 'string' ? input.plan.reason.slice(0, 80) : undefined,
      failed: Array.isArray(input.plan.failed) ? input.plan.failed.map((f) => typeof f === 'string' ? f.slice(0, 40) : (f && f.field ? String(f.field).slice(0, 40) : 'field')).slice(0, 8) : undefined,
    } : undefined,
    timings: input.timings && typeof input.timings === 'object' ? {
      actionMs: Number.isFinite(Number(input.timings.actionMs)) ? Math.max(0, Math.round(Number(input.timings.actionMs))) : undefined,
      confirmMs: Number.isFinite(Number(input.timings.confirmMs)) ? Math.max(0, Math.round(Number(input.timings.confirmMs))) : undefined,
      totalMs: Number.isFinite(Number(input.timings.totalMs)) ? Math.max(0, Math.round(Number(input.timings.totalMs))) : undefined,
    } : undefined,
    ok: input.ok !== false,
  };
  if (!event.installId) return { ok: false, reason: 'no-install-id', event: null };
  if (event.element && !Object.keys(event.element).length) delete event.element;
  if (event.sequence && !event.sequence.length) delete event.sequence;
  if (event.plan) {
    for (const k of Object.keys(event.plan)) if (event.plan[k] === undefined) delete event.plan[k];
    if (!Object.keys(event.plan).length) delete event.plan;
  }
  if (event.timings) {
    for (const k of Object.keys(event.timings)) if (event.timings[k] === undefined) delete event.timings[k];
    if (!Object.keys(event.timings).length) delete event.timings;
  }
  if (!event.action) delete event.action;
  const leaked = FORBIDDEN_EVENT_KEYS.filter((k) => Object.prototype.hasOwnProperty.call(event, k) || (event.element && Object.prototype.hasOwnProperty.call(event.element, k)));
  if (leaked.length) return { ok: false, reason: 'pii', event: null };
  const blob = JSON.stringify(event);
  if (/(password|cookie|@|:\/\?)/i.test(blob) && /password=|cookie=|[?&](token|key|session)=/i.test(blob)) {
    return { ok: false, reason: 'pii', event: null };
  }
  return { ok: true, reason: null, event };
}

export function consentRecord({ consented, setByUser, locale, locales, timeZone, now } = {}) {
  const det = detectRegion({ locale, locales, timeZone });
  const explicit = consented === true || consented === false;
  return {
    consented: explicit ? !!consented : det.defaultOn,
    setByUser: !!setByUser && explicit,
    region: det.region,
    defaultOn: det.defaultOn,
    updatedAt: Number(now) || Date.now(),
  };
}
