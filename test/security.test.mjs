// Security controls, enforced by the relay (headless Chrome, default-safe policy). Each control has a test.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Relay } from '../src/relay.mjs';
import { KeyStore } from '../src/keys.mjs';
import { DEFAULT_POLICY, urlBlocked, effective, normalize, isChromeWebStore, hostMatch, hasUrlScheme } from '../src/policy.mjs';
import { startBroadFixtures } from './fixtures-broad.mjs';

let relay, keys, fx, home, tab, admin;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const upFile = join(mkdtempSync(join(tmpdir(), 'lbd-sec-up-')), 'secret-notes.txt');
writeFileSync(upFile, 'top secret');

const req = (path, body, headers) => fetch(`http://127.0.0.1:${relay.port}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) }));
const asKey = (token) => (method, params) => req('/v1/rpc', { method, params }, { authorization: `Bearer ${token}` });
const asAdmin = (method, params) => req('/v1/rpc', { method, params }, { 'x-lbd-admin': keys.adminToken() });
const setPolicy = (p) => asAdmin('policy.set', { policy: p });
const runAs = async (k, steps) => { const j = (await k('run', { tab, steps })).json; return j.result || j; };
// Tests fire many calls per second; the default 20/s limit is checked in 'defaults are safe' and 'rate limit per key'.
const resetPolicy = () => setPolicy({ ...DEFAULT_POLICY, rateLimit: { perSecond: 1000, perMinute: 60000 } });

let full, core;
before(async () => {
  home = mkdtempSync(join(tmpdir(), 'lbd-sec-'));
  keys = new KeyStore(home);
  relay = await new Relay({ port: 0, keys, log: () => {} }).start();
  fx = await startBroadFixtures();
  full = asKey(keys.mint({ name: 'full', scopes: ['read', 'act', 'tabs', 'headless', 'eval', 'cookies', 'storage', 'upload', 'passwords'] }).token);
  core = asKey(keys.mint({ name: 'core', scopes: ['read', 'act', 'tabs', 'headless'] }).token);
  tab = (await asAdmin('headless.launch', {})).json.result.tab;
  await resetPolicy();
});
after(async () => { await relay.stop(); await fx.close(); });

test('defaults are safe', () => {
  const p = normalize({});
  assert.equal(p.passwords, 'deny'); assert.equal(p.eval, 'deny'); assert.equal(p.cookies, 'deny'); assert.equal(p.storage, 'deny');
  assert.equal(p.uploads, 'confirm'); assert.equal(p.submitSensitive, 'confirm'); assert.equal(p.internalPages, 'deny'); assert.equal(p.fileUrls, 'deny');
  assert.equal(p.rawCdp, 'deny'); assert.equal(p.grantMode, 'granted'); assert.equal(p.incognito, false); assert.equal(p.bankingPreset, true); assert.equal(p.readOnly, false);
  assert.deepEqual(p.rateLimit, { perSecond: 20, perMinute: 600 });
});

test('passwords: values are redacted and typing into password fields is blocked by default', async () => {
  await resetPolicy();
  const r = await runAs(full, [{ action: 'navigate', url: fx.a + '/prefilled' }, { action: 'extract', target: '#pw', what: 'value' }, { action: 'extract', target: 'form', what: 'html' }, { action: 'snapshot' }]);
  assert.equal(r.ok, true, JSON.stringify(r.results));
  assert.equal(r.results[1].value, '[redacted: password field]');
  assert.ok(!r.results[2].value.includes('hunter2') && r.results[2].value.includes('[redacted]'), r.results[2].value);
  assert.ok(!JSON.stringify(r.results[3].value).includes('hunter2'));
  const t = await runAs(full, [{ action: 'navigate', url: fx.a + '/login' }, { action: 'type', target: 'label=Password', text: 'x' }]);
  assert.equal(t.ok, false); assert.equal(t.results[1].denied, true); assert.match(t.results[1].error, /password/i);
});

test('passwords: allowed when the setting and the key scope allow it, still blocked for keys without the scope', async () => {
  await setPolicy({ passwords: 'allow' });
  const r = await runAs(full, [{ action: 'navigate', url: fx.a + '/prefilled' }, { action: 'extract', target: '#pw', what: 'value' }, { action: 'type', target: '#pw', text: 'pw2' }]);
  assert.equal(r.results[1].value, 'hunter2'); assert.equal(r.ok, true);
  const c = await runAs(core, [{ action: 'navigate', url: fx.a + '/prefilled' }, { action: 'extract', target: '#pw', what: 'value' }]);
  assert.equal(c.results[1].value, '[redacted: password field]');
  await resetPolicy();
});

test('browser-internal pages, file:// and javascript: URLs are blocked', async () => {
  for (const url of ['chrome://settings', 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/options.html', 'devtools://devtools/bundled/inspector.html', 'about:config', 'file:///C:/Windows/win.ini', 'javascript:alert(1)']) {
    const r = await full('navigate', { tab, url });
    assert.equal(r.status, 403, url + ' ' + JSON.stringify(r.json));
  }
  assert.equal(urlBlocked(normalize({}), 'about:blank'), null);
});


test('Chrome Web Store pages are refused even when bankingPreset is off', async () => {
  await resetPolicy();
  const urls = [
    'https://chromewebstore.google.com/',
    'https://chromewebstore.google.com/detail/example/abcdefghijklmnopqrstuvwxyzabcdef',
    'https://chrome.google.com/webstore',
    'https://chrome.google.com/webstore/detail/foo',
  ];
  for (const url of urls) {
    assert.ok(isChromeWebStore(url), url);
    assert.match(urlBlocked(normalize({}), url) || '', /Chrome Web Store/i);
    assert.match(urlBlocked(normalize({ bankingPreset: false }), url) || '', /Chrome Web Store/i);
    const r = await full('navigate', { tab, url });
    assert.equal(r.status, 403, url + ' ' + JSON.stringify(r.json));
  }
  assert.equal(isChromeWebStore('https://www.google.com/'), false);
  assert.equal(isChromeWebStore('https://chrome.google.com/'), false);
});


test('banking/payment preset blocks by default and can be turned off; blocklist and allowlist work', async () => {
  await resetPolicy();
  for (const url of ['https://www.chase.com/', 'https://dashboard.stripe.com/', 'https://www.paypal.com/', 'https://online.mybankcorp.com/']) assert.equal((await full('navigate', { tab, url })).status, 403, url);
  assert.equal(urlBlocked(normalize({ bankingPreset: false }), 'https://www.chase.com/'), null);
  assert.match(urlBlocked(normalize({}), 'https://www.chase.com./') || '', /banking\/payment blocklist/i);
  assert.equal(hostMatch('chase.com', 'www.chase.com.'), true);
  assert.equal(hostMatch('chase.com.', 'www.chase.com'), true);
  assert.equal(isChromeWebStore('https://chromewebstore.google.com./detail/foo'), true);
  await setPolicy({ blocklist: ['127.0.0.1'] });
  assert.equal((await full('navigate', { tab, url: fx.a + '/item/x' })).status, 403);
  await setPolicy({ blocklist: [], allowlist: ['example.org'] });
  assert.equal((await full('navigate', { tab, url: fx.a + '/item/x' })).status, 403);
  await setPolicy({ allowlist: ['127.0.0.1'] });
  assert.equal((await full('navigate', { tab, url: fx.a + '/item/x' })).status, 200);
  await resetPolicy();
});

test('eval: off by default, needs the eval scope, and "ask me" waits for approval', async () => {
  await resetPolicy();
  await full('navigate', { tab, url: fx.a + '/item/e' });
  assert.equal((await full('eval', { tab, js: '1+1' })).status, 403);
  await setPolicy({ eval: 'allow' });
  assert.equal((await full('eval', { tab, js: '1+1' })).json.result.results[0].value, 2);
  assert.equal((await core('eval', { tab, js: '1+1' })).status, 403, 'key without eval scope');
  await setPolicy({ eval: 'confirm' });
  const p = full('eval', { tab, js: '6*7' });
  let pend = [];
  for (let i = 0; i < 50 && !pend.length; i++) { await sleep(50); pend = (await asAdmin('confirm.list', {})).json.result.pending; }
  assert.equal(pend.length, 1); assert.equal(pend[0].kind, 'eval'); assert.equal(pend[0].key, 'full');
  await asAdmin('confirm.resolve', { id: pend[0].id, allow: true });
  assert.equal((await p).json.result.results[0].value, 42);
  const p2 = full('eval', { tab, js: '1' });
  for (pend = []; !pend.length;) { await sleep(50); pend = (await asAdmin('confirm.list', {})).json.result.pending; }
  await asAdmin('confirm.resolve', { id: pend[0].id, allow: false });
  assert.equal((await p2).status, 403);
  await resetPolicy();
});

test('approval requests time out as declined', async () => {
  await setPolicy({ eval: 'confirm', confirmTimeoutSec: 5 });
  const t0 = Date.now();
  const r = await full('eval', { tab, js: '1' });
  assert.equal(r.status, 403, JSON.stringify(r.json)); assert.ok(Date.now() - t0 >= 4500);
  await resetPolicy();
});

test('cookies and site storage are off by default', async () => {
  await resetPolicy();
  await full('navigate', { tab, url: fx.a + '/item/c' });
  assert.equal((await full('cookies', { tab, op: 'get' })).status, 403);
  assert.equal((await full('storage', { tab, op: 'get' })).status, 403);
  await setPolicy({ cookies: 'allow', storage: 'allow' });
  assert.equal((await full('cookies', { tab, op: 'set', name: 'a', value: '1' })).status, 200);
  assert.equal((await full('storage', { tab, op: 'set', key: 'k', value: 'v' })).status, 200);
  assert.equal((await core('cookies', { tab, op: 'get' })).status, 403, 'no cookies scope');
  await resetPolicy();
});

test('uploads ask first by default (approve uploads, decline blocks), and can be turned off', async () => {
  await resetPolicy();
  await full('navigate', { tab, url: fx.a + '/download' });
  await setPolicy({ eval: 'allow' });
  await full('eval', { tab, js: "document.body.insertAdjacentHTML('beforeend','<input type=file id=up>');1" });
  await setPolicy({ eval: 'deny' });
  const p = full('upload', { tab, target: '#up', files: [upFile] });
  let pend = [];
  for (let i = 0; i < 60 && !pend.length; i++) { await sleep(50); pend = (await asAdmin('confirm.list', {})).json.result.pending; }
  assert.match(pend[0].summary, /secret-notes\.txt/);
  await asAdmin('confirm.resolve', { id: pend[0].id, allow: true });
  assert.equal((await p).status, 200);
  const p2 = full('upload', { tab, target: '#up', files: [upFile] });
  for (pend = []; !pend.length;) { await sleep(50); pend = (await asAdmin('confirm.list', {})).json.result.pending; }
  await asAdmin('confirm.resolve', { id: pend[0].id, allow: false });
  assert.equal((await p2).status, 403);
  await setPolicy({ uploads: 'deny' });
  assert.equal((await full('upload', { tab, target: '#up', files: [upFile] })).status, 403);
  await resetPolicy();
});

test('downloads can be turned off', async () => {
  await setPolicy({ downloads: 'deny' });
  const r = await runAs(full, [{ action: 'navigate', url: fx.a + '/download' }, { action: 'click', target: 'text=Get CSV' }]);
  assert.equal(r.ok, true);
  await sleep(800);
  const b = [...relay.router.browsers.values()][0];
  assert.ok(!b.downloads.some((d) => d.state === 'completed'), JSON.stringify(b.downloads));
  assert.equal((await full('downloads', { tab, op: 'list' })).status, 403);
  await resetPolicy();
});

test('submitting a login or payment form asks first; declining sends nothing', async () => {
  await setPolicy({ passwords: 'allow' });
  const before = fx.submissions.length;
  const p = runAs(full, [{ action: 'navigate', url: fx.a + '/login' }, { action: 'type', target: 'label=Username', text: 'u1' }, { action: 'type', target: 'label=Password', text: 'p1' }, { action: 'click', target: 'text=Sign in', waitNav: true }]);
  let pend = [];
  for (let i = 0; i < 100 && !pend.length; i++) { await sleep(50); pend = (await asAdmin('confirm.list', {})).json.result.pending; }
  assert.equal(pend[0].kind, 'submitSensitive'); assert.match(pend[0].summary, /password form/);
  await asAdmin('confirm.resolve', { id: pend[0].id, allow: false });
  const r = await p;
  assert.equal(r.ok, false); assert.equal(r.results[3].denied, true);
  assert.equal(fx.submissions.length, before, 'nothing was submitted');
  const c = runAs(full, [{ action: 'navigate', url: fx.a + '/checkout' }, { action: 'type', target: 'label=Card number', text: '4242424242424242' }]);
  for (pend = []; !pend.length;) { await sleep(50); pend = (await asAdmin('confirm.list', {})).json.result.pending; }
  assert.match(pend[0].summary, /payment field/);
  await asAdmin('confirm.resolve', { id: pend[0].id, allow: true });
  assert.equal((await c).ok, true);
  await resetPolicy();
});

test('read-only mode: reading and navigation work, clicks and typing are refused', async () => {
  await setPolicy({ readOnly: true });
  const r = await runAs(full, [{ action: 'navigate', url: fx.a + '/modal' }, { action: 'extract', target: 'h1' }, { action: 'click', target: 'text=Accept all' }]);
  assert.equal(r.results[1].value, 'Modal page'); assert.equal(r.results[2].denied, true); assert.match(r.results[2].error, /read-only/);
  await resetPolicy();
});

test('per-key override and key scopes tighten the global policy', async () => {
  const ro = asKey(keys.mint({ name: 'ro-key', scopes: ['read', 'act'], policy: { readOnly: true } }).token);
  const r = await runAs(ro, [{ action: 'navigate', url: fx.a + '/modal' }, { action: 'click', target: 'text=Accept all' }]);
  assert.equal(r.results[1].denied, true);
  const e = effective(normalize({ eval: 'allow' }), { scopes: ['read', 'act'], policy: { eval: 'allow' } });
  assert.equal(e.eval, 'deny', 'no eval scope means no eval');
  const e2 = effective(normalize({ eval: 'confirm' }), { scopes: ['read', 'act', 'eval'], policy: { eval: 'allow' } });
  assert.equal(e2.eval, 'confirm', 'a key can never loosen the global setting');
});

test('rate limit per key', async () => {
  const k = asKey(keys.mint({ name: 'slow', scopes: ['read'], policy: { rateLimit: { perSecond: 3, perMinute: 100 } } }).token);
  const codes = [];
  for (let i = 0; i < 6; i++) codes.push((await k('status', {})).status);
  assert.ok(codes.includes(429), codes.join(','));
});

test('raw CDP is off by default', async () => {
  const k = asKey(keys.mint({ name: 'cdp', scopes: ['read', 'cdp'] }).token);
  assert.equal((await k('cdp', { tab, method: 'Runtime.evaluate', params: { expression: '1' } })).status, 403);
});

test('audit log records actions and denials without typed text', async () => {
  const r = (await asAdmin('audit.list', { limit: 500 })).json.result.entries;
  assert.ok(r.some((e) => e.result === 'denied' && /password/i.test(e.reason || '')));
  assert.ok(r.some((e) => e.result === 'ok' && e.actions && e.actions.includes('navigate')));
  const file = readFileSync(join(home, 'audit.log'), 'utf8');
  assert.ok(file.length > 0);
  assert.ok(!file.includes('p1') || !file.includes('"text"'), 'typed text is never logged');
  assert.ok(!file.includes('4242424242424242') && !file.includes('hunter2'));
});

test('DNS-rebinding guard: foreign Host header is refused', async () => {
  const { request } = await import('node:http');
  const status = await new Promise((res, rej) => { const q = request({ host: '127.0.0.1', port: relay.port, path: '/v1/rpc', method: 'POST', headers: { host: 'evil.example', 'x-lbd-admin': keys.adminToken(), 'content-type': 'application/json' } }, (r) => { r.resume(); res(r.statusCode); }); q.on('error', rej); q.end('{"method":"status"}'); });
  const r = { status };
  assert.equal(r.status, 403);
});
test('blob: URLs inherit the origin host for blocklist, allowlist, and banking rules', () => {
  const p = normalize({});
  assert.match(urlBlocked(p, 'blob:https://www.chase.com/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee') || '', /banking\/payment blocklist/i);
  assert.equal(urlBlocked(normalize({ bankingPreset: false }), 'blob:https://www.chase.com/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'), null);
  const blocked = normalize({ bankingPreset: false, blocklist: ['example.org'] });
  assert.match(urlBlocked(blocked, 'blob:https://example.org/abc') || '', /blocklist/i);
  const allowed = normalize({ bankingPreset: false, allowlist: ['example.org'] });
  assert.match(urlBlocked(allowed, 'blob:https://other.example/abc') || '', /allowlist/i);
  assert.equal(urlBlocked(allowed, 'blob:https://example.org/abc'), null);
  assert.equal(urlBlocked(p, 'blob:null/foo'), null);
  assert.equal(urlBlocked(p, 'data:text/html,hi'), null);
});

test('hasUrlScheme distinguishes real schemes from host:port', () => {
  assert.equal(hasUrlScheme('https://example.com'), true);
  assert.equal(hasUrlScheme('http://localhost:3000'), true);
  assert.equal(hasUrlScheme('mailto:a@b.com'), true);
  assert.equal(hasUrlScheme('localhost:3000'), false);
  assert.equal(hasUrlScheme('example.com:8080'), false);
  assert.equal(hasUrlScheme('example.com'), false);
});

test('disjoint allowlists in combination block every host', async () => {
  const { strictest } = await import('../src/relay.mjs');
  const e = strictest(normalize({ allowlist: ['a.example'] }), normalize({ allowlist: ['b.example'] }));
  assert.equal(e.allowlistRequired, true);
  assert.equal(e.allowlist.length, 0);
  assert.match(urlBlocked(e, 'https://a.example/') || '', /allowlist/i);
  assert.match(urlBlocked(e, 'https://b.example/') || '', /allowlist/i);
});

test('tabs.new and runParallel cannot launch headless Chrome without the headless scope or when policy denies it', async () => {
  const k = asKey(keys.mint({ name: 'tabs-only', scopes: ['read', 'act', 'tabs'] }).token);
  assert.equal((await k('tabs.new', { url: 'about:blank' })).status, 403);
  assert.equal((await k('tabs.new', { source: 'headless' })).status, 403);
  const par = await k('runParallel', { jobs: [{ newTab: true, source: 'headless', steps: [{ action: 'extract', target: 'body' }] }] });
  const res = par.json.result || par.json;
  assert.equal(res.ok, false);
  assert.match(JSON.stringify(res), /headless/i);
  await setPolicy({ headless: 'deny' });
  assert.equal((await full('tabs.new', { source: 'headless' })).status, 403);
  await resetPolicy();
});

test('tabs.new treats host:port as a host, not a scheme, and still applies banking and blocklist rules', async () => {
  await resetPolicy();
  assert.equal((await full('tabs.new', { source: 'headless', url: 'www.chase.com:443' })).status, 403);
  assert.equal((await full('tabs.new', { source: 'headless', url: 'https://www.chase.com/' })).status, 403);
  await setPolicy({ bankingPreset: false, blocklist: ['example.org'] });
  assert.equal((await full('tabs.new', { source: 'headless', url: 'example.org:8080' })).status, 403);
  await resetPolicy();
});
