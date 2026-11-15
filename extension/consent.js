// Consent copy, regional default, and local storage for navigation-metadata collection.
// Must stay in sync with src/meta.mjs (tested).
export const PRIVACY_POLICY_URL = "https://privacy.luculent.dev/policy";
export const CONSENT_TITLE = "Help the driver get much faster over time";
export const CONSENT_BODY = "The Luculent Browser Driver can learn how sites are usually moved through — the kinds of clicks and page-to-page steps that work — and use that to plan a few moves ahead. That is how it gets faster and a little smarter with time, and it is a core part of how a small team like ours improves the product.\n\nIf you leave this on, here is exactly what we collect:\n\n• the site's registrable domain (for example wikipedia.org)\n• a generalized path with IDs and tokens already stripped (for example /wiki/:title, never the raw identifier)\n• a rough page type (article, search, listing, and so on)\n• the accessibility role and a generalized selector pattern of elements an agent acted on — not the visible label or any text\n• the sequence of actions (navigate, click, type, and so on — not what was typed)\n• whether a planned next step matched the real page, and why it was confirmed or adjusted\n• how long those steps took, and whether they succeeded\n\nWe hash an install identifier so events can be grouped without naming you.\n\nHere is what we never collect: the text of a page, anything you type, passwords, cookies, query strings, or anything from sign-in pages, banking and payment sites, or incognito windows.\n\nYou can turn this off at any time. When you do, collection stops immediately and we delete anything still waiting on your computer.\n\nThe full policy is at https://privacy.luculent.dev/policy";

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
  if (language === 'en' && (region === 'GB' || region === 'UK' || region === 'IE' || region === 'MT')) return true;
  if (language === 'pt' && region !== 'BR') return !region || region === 'PT';
  if (language === 'es' && !region) return true;
  if (language === 'fr' && !region) return true;
  if (EU_LANG.has(language) && !region) return true;
  return false;
}

export function regionDefaultOn({ locale, locales, timeZone } = {}) {
  const tags = [].concat(locales || [], locale || []).filter(Boolean);
  if (timezoneLooksEuEeaUk(timeZone)) return false;
  for (const tag of tags) if (localeLooksEuEeaUk(tag)) return false;
  return true;
}

export function detectEnv() {
  const locales = (typeof navigator !== 'undefined' && navigator.languages && navigator.languages.length)
    ? [...navigator.languages]
    : (typeof navigator !== 'undefined' && navigator.language ? [navigator.language] : []);
  const locale = locales[0] || '';
  let timeZone = '';
  try { timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch (_) {}
  const defaultOn = regionDefaultOn({ locales, locale, timeZone });
  return { locale, locales, timeZone, region: defaultOn ? 'other' : 'eu-eea-uk', defaultOn };
}

export function toggleCaption(nav) {
  if (!nav) return '';
  if (nav.setByUser) return nav.consented ? 'On — you can turn this off any time.' : 'Off — nothing is collected.';
  return nav.defaultOn
    ? 'This is on unless you turn it off.'
    : 'This is off unless you turn it on.';
}

export async function loadNavMeta() {
  const { navMeta } = await chrome.storage.local.get(['navMeta']);
  if (navMeta && (navMeta.consented === true || navMeta.consented === false)) return navMeta;
  const env = detectEnv();
  const rec = {
    consented: env.defaultOn,
    setByUser: false,
    region: env.region,
    defaultOn: env.defaultOn,
    seenDisclaimer: false,
    updatedAt: Date.now(),
  };
  // Regional defaults stay in memory so a later locale/timezone can still be re-evaluated.
  return rec;
}

export async function saveNavMeta(patch) {
  const cur = await loadNavMeta();
  const next = { ...cur, ...patch, updatedAt: Date.now() };
  await chrome.storage.local.set({ navMeta: next });
  return next;
}
