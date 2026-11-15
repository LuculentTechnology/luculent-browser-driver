// Validation for navigation-metadata events. Keep in lockstep with docs/nav-meta-schema.md and src/meta.mjs.
export const SUPPORTED_SCHEMA = new Set([1]);
export const FORBIDDEN = [
  'text', 'innerText', 'innerHTML', 'html', 'content', 'title', 'value', 'values', 'form', 'forms',
  'password', 'passwords', 'cookie', 'cookies', 'header', 'headers', 'query', 'queryString', 'search',
  'hash', 'fragment', 'input', 'inputs', 'email', 'token', 'tokens', 'rawUrl', 'href', 'name', 'label',
  'accessibleName', 'typed', 'selection', 'screenshot', 'shot', 'htmlSnapshot', 'body', 'pageText',
];
const PAGE_TYPES = new Set(['home', 'search', 'article', 'listing', 'product', 'settings', 'other']);

export function validateEvent(event) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) return { ok: false, reason: 'not-object' };
  if (!SUPPORTED_SCHEMA.has(Number(event.v))) return { ok: false, reason: 'schema' };
  for (const k of FORBIDDEN) {
    if (Object.prototype.hasOwnProperty.call(event, k)) return { ok: false, reason: 'forbidden' };
    if (event.element && Object.prototype.hasOwnProperty.call(event.element, k)) return { ok: false, reason: 'forbidden' };
  }
  if (typeof event.installId !== 'string' || !/^[a-f0-9]{64}$/i.test(event.installId)) return { ok: false, reason: 'installId' };
  if (typeof event.domain !== 'string' || !event.domain || /[/?#@]/.test(event.domain)) return { ok: false, reason: 'domain' };
  if (typeof event.path !== 'string' || !event.path.startsWith('/') || event.path.includes('?') || event.path.includes('#')) {
    return { ok: false, reason: 'path' };
  }
  if (!PAGE_TYPES.has(event.pageType)) return { ok: false, reason: 'pageType' };
  if (event.pageType === 'auth' || event.pageType === 'checkout') return { ok: false, reason: 'pageType' };
  if (typeof event.ts !== 'number' || !Number.isFinite(event.ts)) return { ok: false, reason: 'ts' };
  return { ok: true, reason: null };
}
