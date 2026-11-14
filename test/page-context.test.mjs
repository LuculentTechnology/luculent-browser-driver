import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ChatStore } from '../src/chats.mjs';
import { PanelHub } from '../src/panel.mjs';
import { extractPageContext, sanitizePageContext, pageContextChip, PAGE_CONTEXT_INSTRUCTION, PAGE_CONTEXT_MAX, PULL_BUTTON_LABEL } from '../src/page-context.mjs';

const HTML = `<!doctype html><html><head><title>Ada Lovelace</title></head><body>
  <h1>Ada Lovelace</h1><h2>Biography</h2>
  <p>Ada Lovelace was a mathematician and writer.</p>
  <p>Password field: <input type="password" value="hunter2" name="password"></p>
  <p>Visible: password=should-redact later if present in text.</p>
  <a href="/wiki/Charles_Babbage">Charles Babbage</a>
  <a href="javascript:void(0)">ignore me</a>
  <table><tr><th>Year</th><th>Work</th></tr><tr><td>1843</td><td>Notes</td></tr></table>
</body></html>`;

test('extracts title, URL, headings, links, tables, selection and readable text; skips password inputs', () => {
  const raw = extractPageContext({ title: 'Ada Lovelace', url: 'https://en.wikipedia.org/wiki/Ada_Lovelace', html: HTML, selection: 'mathematician and writer' });
  assert.equal(raw.title, 'Ada Lovelace');
  assert.equal(raw.url, 'https://en.wikipedia.org/wiki/Ada_Lovelace');
  assert.deepEqual(raw.headings.slice(0, 2), ['Ada Lovelace', 'Biography']);
  assert.ok(raw.links.some((l) => /Babbage/.test(l.text)));
  assert.ok(!raw.links.some((l) => /ignore me/.test(l.text)));
  assert.equal(raw.tables[0][0][0], 'Year');
  assert.equal(raw.tables[0][1][1], 'Notes');
  assert.equal(raw.selection, 'mathematician and writer');
  assert.match(raw.text, /Ada Lovelace was a mathematician/);
  assert.doesNotMatch(raw.text, /hunter2/);
  assert.equal(PULL_BUTTON_LABEL, 'Pull page context');
});

test('guard: blocked sites are refused; password values are redacted; oversize text is capped', () => {
  assert.throws(() => sanitizePageContext({ title: 'Bank', url: 'https://mercury.com' }, { blockedReason: 'mercury.com is on the banking/payment blocklist' }), /Blocked by your Luculent security settings/);
  const redacted = sanitizePageContext({ title: 'Login', url: 'https://example.com/login', text: 'use password=hunter2 to continue', headings: ['Sign in'], links: [], tables: [] });
  assert.doesNotMatch(redacted.text, /hunter2/);
  assert.match(redacted.text, /\[redacted\]/);
  const big = sanitizePageContext({ title: 'Long', url: 'https://example.com/long', text: 'x'.repeat(80_000), headings: [], links: [], tables: [] }, { maxChars: 4000 });
  assert.ok(big.truncated);
  assert.ok(big.text.length < 80_000);
  assert.ok(JSON.stringify(big).length < PAGE_CONTEXT_MAX + 8000);
});

test('page context stays attached across follow-up messages; refresh replaces; remove clears; chip shows title', () => {
  const hub = new PanelHub(new ChatStore({ now: () => 7 }));
  const ctx = { key: { id: 'k1', name: 'claude' } };
  hub.identify(ctx, { provider: 'Anthropic', model: 'opus', chatName: 'Research' });
  const pulled = hub.pullPageContext(ctx, { title: 'Ada Lovelace', url: 'https://en.wikipedia.org/wiki/Ada_Lovelace', html: HTML });
  assert.equal(pulled.chip.title, 'Ada Lovelace');
  assert.match(pulled.message.text, /quick blurb/);
  assert.match(pulled.message.text, /Ada Lovelace/);
  assert.equal(pulled.instruction, PAGE_CONTEXT_INSTRUCTION);
  assert.equal(pageContextChip(pulled.pageContext).title, 'Ada Lovelace');
  hub.post(ctx, { from: 'user', text: 'when was she born?' });
  hub.post(ctx, { from: 'agent', text: '1815' });
  const view = hub.view(ctx);
  assert.equal(view.pageContext.title, 'Ada Lovelace');
  assert.equal(view.pageContext.url, 'https://en.wikipedia.org/wiki/Ada_Lovelace');
  assert.equal(view.chip.title, 'Ada Lovelace');
  assert.ok(view.messages.some((m) => m.text === 'when was she born?'));
  assert.ok(view.pageContext, 'follow-ups still carry the attached context');
  const refreshed = hub.refreshPageContext(ctx, { title: 'Ada Lovelace — Wikipedia', url: 'https://en.wikipedia.org/wiki/Ada_Lovelace', text: 'updated body' });
  assert.equal(refreshed.chip.title, 'Ada Lovelace — Wikipedia');
  assert.equal(hub.view(ctx).pageContext.text, 'updated body');
  const cleared = hub.clearPageContext(ctx);
  assert.equal(cleared.pageContext, null);
  assert.equal(cleared.chip, null);
  assert.ok(hub.view(ctx).messages.length >= 2);
});

test('blocked pull does not attach context or post a message', () => {
  const hub = new PanelHub(new ChatStore({ now: () => 8 }));
  const ctx = { key: { id: 'k2', name: 'agent' } };
  assert.throws(() => hub.pullPageContext(ctx, { title: 'Bank', url: 'https://stripe.com' }, { blockedReason: 'stripe.com is on the banking/payment blocklist' }), /Blocked by your Luculent security settings/);
  const view = hub.view(ctx);
  assert.equal(view.pageContext, null);
  assert.equal(view.messages.length, 0);
});

test('chrome:// and Chrome Web Store pulls are refused; password values never survive sanitize', () => {
  assert.throws(() => sanitizePageContext({ title: 'Extensions', url: 'chrome://extensions' }, { blockedReason: 'browser-internal and extension pages are blocked by your security settings (chrome:)' }), /Blocked by your Luculent security settings/);
  assert.throws(() => sanitizePageContext({ title: 'Web Store', url: 'https://chromewebstore.google.com/' }, { blockedReason: 'Chrome Web Store pages are blocked by your security settings' }), /Blocked by your Luculent security settings/);
  const filled = extractPageContext({
    title: 'Sign in',
    url: 'https://example.com/login',
    html: '<html><body><h1>Sign in</h1><form><input type="password" value="super-secret-pass" name="password"><input type="text" value="visible-user"></form><p>Welcome back.</p></body></html>',
  });
  assert.doesNotMatch(filled.text, /super-secret-pass/);
  const sanitized = sanitizePageContext({ ...filled, text: filled.text + ' api_key=sk_live_SHOULD_REDACT' });
  assert.doesNotMatch(sanitized.text, /super-secret-pass/);
  assert.doesNotMatch(JSON.stringify(sanitized), /sk_live_SHOULD_REDACT/);
});

test('main article text is kept when headings and links are large', () => {
  const links = Array.from({ length: 40 }, (_, i) => ({ text: 'Link ' + i + ' ' + 'nav'.repeat(20), href: 'https://example.com/' + i }));
  const headings = Array.from({ length: 40 }, (_, i) => 'Heading ' + i + ' ' + 'section'.repeat(15));
  const tables = Array.from({ length: 8 }, (_, i) => Array.from({ length: 12 }, (_, r) => ['c' + i + r, 'v'.repeat(40)]));
  const article = ('The analytical engine weaves algebraic patterns. ').repeat(400);
  const out = sanitizePageContext({ title: 'World War II', url: 'https://en.wikipedia.org/wiki/World_War_II', text: article, headings, links, tables });
  assert.ok(out.text.length >= 8000, 'reserved main text, got ' + out.text.length);
  assert.match(out.text, /analytical engine/);
  assert.ok(JSON.stringify(out).length < PAGE_CONTEXT_MAX + 9000);
});
