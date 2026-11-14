// Security controls enforced by the extension itself (real Chromium + chrome.debugger). Default settings unless a test
// changes them. "Rogue relay" checks call the extension directly, as a malicious local program on the relay port would.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, cpSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Relay } from '../src/relay.mjs';
import { KeyStore } from '../src/keys.mjs';
import { relayClient } from '../src/mcp-stdio.mjs';
import { HeadlessBrowser, findPlaywrightChromium } from '../src/headless.mjs';
import { startBroadFixtures } from './fixtures-broad.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const chromium = process.env.LBD_TEST_CHROMIUM || findPlaywrightChromium();
const skip = !chromium && 'no Playwright Chromium found (branded Chrome blocks --load-extension)';

let relay, keys, fx, browser, rpc, port, extDir, extId, opt;
const upFile = join(mkdtempSync(join(tmpdir(), 'lbd-extsec-up-')), 'report.txt');
writeFileSync(upFile, 'report');

async function waitFor(fn, timeout = 15000, what = 'condition') {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const v = await Promise.resolve().then(fn).catch((e) => { if (process.env.LBD_DEBUG) console.error('waitFor', what, e.message); return null; }); if (v) return v; await sleep(100); }
  throw new Error('timed out waiting for ' + what);
}
const pageEval = async (expression) => {
  const r = await browser.conn.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, opt.sessionId);
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
};
const msg = (m) => pageEval(`chrome.runtime.sendMessage(${JSON.stringify(m)})`);
const status = () => msg({ type: 'popup.status' });
const setSettings = (patch) => pageEval(`(async () => { const { settings } = await chrome.storage.local.get('settings'); await chrome.storage.local.set({ settings: { ...settings, ...${JSON.stringify(patch)} } }); return true; })()`);
const rogue = (m) => relay.router.extCall(m).then((result) => ({ result }), (e) => ({ error: String(e.message || e) }));
const extTabs = async () => (await rpc('tabs.list', {})).tabs.filter((t) => t.source === 'extension');
const startupTab = async () => { const all = (await relay.router.tabs()).tabs.filter((t) => t.source === 'extension' && !t.url.startsWith('chrome-extension://')); return all.find((t) => !t.granted) || all[0]; };
const newKey = (name, scopes = ['read', 'act', 'tabs']) => relayClient({ url: `ws://127.0.0.1:${port}/v1/ws`, key: keys.mint({ name, scopes }).token });

before(async () => {
  if (skip) return;
  keys = new KeyStore(mkdtempSync(join(tmpdir(), 'lbd-extsec-')));
  relay = await new Relay({ port: 0, keys, log: () => {} }).start();
  relay.policy.set({ rateLimit: { perSecond: 1000, perMinute: 60000 } });
  port = relay.port;
  fx = await startBroadFixtures();
  extDir = join(mkdtempSync(join(tmpdir(), 'lbd-extsecsrc-')), 'extension');
  cpSync(resolve(here, '..', 'extension'), extDir, { recursive: true });
  writeFileSync(join(extDir, 'config.json'), JSON.stringify({ relayUrl: `ws://127.0.0.1:${port}/ext` })); // default security settings
  browser = await HeadlessBrowser.launch({ chromePath: chromium, headless: process.env.LBD_HEADED ? false : true, extensionPath: extDir, args: ['--window-size=1280,900'] });
  await waitFor(() => relay.router.ext && relay.router.extInfo?.paired !== undefined, 15000, 'extension');
  const sw = await waitFor(async () => (await browser.conn.send('Target.getTargets')).targetInfos.find((t) => t.type === 'service_worker' && /^chrome-extension:\/\/[a-p]{32}\/sw\.js$/.test(t.url)), 10000, 'service worker');
  extId = new URL(sw.url).host;
  const { targetId } = await browser.conn.send('Target.createTarget', { url: `chrome-extension://${extId}/options.html` });
  const { sessionId } = await browser.conn.send('Target.attachToTarget', { targetId, flatten: true });
  opt = { targetId, sessionId };
  await browser.conn.send('Runtime.enable', {}, sessionId);
  await waitFor(() => pageEval('document.readyState === "complete" && !!chrome.runtime'), 10000, 'options page');
  await waitFor(async () => (await status()).connected, 10000, 'verified relay');
  rpc = newKey('agent', ['read', 'act', 'tabs', 'eval', 'upload']);
});
after(async () => { if (skip) return; rpc && rpc.close(); await relay.stop().catch(() => {}); await browser.close(); await fx.close(); });

test('pairing: the extension pins the relay identity on first connect', { skip }, async () => {
  const s = await status();
  assert.equal(s.relayState, 'on');
  assert.equal(s.settings.grantMode, 'granted');
  assert.equal(s.settings.passwords, 'deny');
});

test('ungranted tabs are invisible and off limits; agent-opened tabs work and show the AI badge', { skip }, async () => {
  const st = await startupTab();
  const listed = (await extTabs()).find((t) => t.tab === st.tab);
  assert.ok(!listed || listed.url === '', 'ungranted tab is hidden from agents (or listed without its URL)');
  await assert.rejects(rpc('run', { tab: st.tab, steps: [{ action: 'extract', target: 'body' }] }), /grant/i);
  const r1 = await rogue({ type: 'cdp', tabId: Number(st.tab), method: 'Runtime.evaluate', params: { expression: '1' } });
  assert.match(r1.error, /not been granted/);
  const { tab } = await rpc('tabs.new', { url: fx.a + '/item/agent' });
  const r = await rpc('run', { tab, steps: [{ action: 'extract', target: 'h1' }] });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(await pageEval(`chrome.action.getBadgeText({ tabId: ${Number(tab)} })`), 'AI');
  await rpc('tabs.close', { tab });
});

test('per-tab grant from the popup, and revoke', { skip }, async () => {
  const st = await startupTab();
  await msg({ type: 'popup.grant', tabId: Number(st.tab) });
  const r = await rpc('run', { tab: st.tab, steps: [{ action: 'navigate', url: fx.a + '/item/granted' }, { action: 'extract', target: 'h1' }] });
  assert.equal(r.results[1].value, 'Item granted');
  await msg({ type: 'popup.revoke', tabId: Number(st.tab) });
  await assert.rejects(rpc('run', { tab: st.tab, steps: [{ action: 'extract', target: 'h1' }] }), /grant/i);
});

test('popups opened by a granted tab are granted too', { skip }, async () => {
  const { tab } = await rpc('tabs.new', { url: fx.a + '/popup' });
  const r = await rpc('run', { tab, steps: [{ action: 'click', target: '#wo', expectPopup: true }] });
  const pop = r.results[0].value && r.results[0].value.popup;
  assert.ok(pop, JSON.stringify(r));
  const r2 = await rpc('run', { tab: pop.tab || pop, steps: [{ action: 'wait', target: 'h1', text: 'Item popup' }] });
  assert.equal(r2.ok, true, JSON.stringify(r2));
  await rpc('tabs.close', { tab: pop.tab || pop }); await rpc('tabs.close', { tab });
});

test('background agent tabs respond instantly (hover menus, clicks, wheel)', { skip }, async () => {
  const { tab } = await rpc('tabs.new', { url: fx.a + '/hover' });
  const t0 = Date.now();
  const r = await rpc('run', { tab, steps: [{ action: 'hover', target: 'text=Products' }, { action: 'wait', target: 'text=Laptops', timeout: 3000 }, { action: 'click', target: 'text=Laptops', waitNav: true }, { action: 'extract', target: 'h1' }, { action: 'wheel', dy: 300 }] });
  assert.equal(r.ok, true, JSON.stringify(r.results));
  assert.equal(r.results[3].value, 'Item hovered');
  assert.ok(Date.now() - t0 < 2500, 'took ' + (Date.now() - t0) + 'ms (hidden-tab input stall)');
  await rpc('tabs.close', { tab });
});

test('extension blocks dangerous CDP even from a rogue relay', { skip }, async () => {
  const { tab } = await rpc('tabs.new', { url: fx.a + '/upload' });
  const id = Number(tab);
  await sleep(300);
  const cases = [
    [{ method: 'Page.navigate', params: { url: 'chrome://settings' } }, /browser-internal|internal/i],
    [{ method: 'Page.navigate', params: { url: `chrome-extension://${extId}/options.html` } }, /blocked|internal|extension/i],
    [{ method: 'Page.navigate', params: { url: 'https://www.chase.com/' } }, /bank|payment/i],
    [{ method: 'Page.navigate', params: { url: 'file:///C:/Windows/win.ini' } }, /file/i],
    [{ method: 'Network.getAllCookies', params: {} }, /cookie/i],
    [{ method: 'Browser.close', params: {} }, /never allowed/],
    [{ method: 'Target.createTarget', params: { url: 'about:blank' } }, /never allowed/],
    [{ method: 'DOM.setFileInputFiles', params: { files: [upFile], backendNodeId: 1 } }, /approval/],
  ];
  for (const [c, re] of cases) { const r = await rogue({ type: 'cdp', tabId: id, ...c }); assert.match(r.error || 'ALLOWED', re, c.method + ' ' + (c.params.url || '')); }
  await setSettings({ readOnly: true });
  await sleep(200);
  const ro = await rogue({ type: 'cdp', tabId: id, method: 'Input.dispatchMouseEvent', params: { type: 'mouseMoved', x: 1, y: 1 } });
  assert.match(ro.error, /read-only/);
  await setSettings({ readOnly: false });
  await rpc('tabs.close', { tab });
});

test('upload needs approval from the extension (notification or popup); declining blocks it', { skip }, async () => {
  const { tab } = await rpc('tabs.new', { url: fx.a + '/upload' });
  const p = rpc('upload', { tab, target: '#up', files: [upFile] });
  const pend = await waitFor(async () => (await status()).pending[0], 10000, 'pending approval');
  assert.match(pend.summary, /report\.txt/);
  await msg({ type: 'popup.confirm', id: pend.id, allow: true });
  await p;
  const r = await rpc('run', { tab, steps: [{ action: 'extract', target: '#out' }] });
  assert.equal(r.results[0].value, 'report.txt');
  const p2 = rpc('upload', { tab, target: '#up', files: [upFile] }).then(() => 'ok', (e) => String(e.message));
  const pend2 = await waitFor(async () => (await status()).pending[0], 10000, 'pending approval');
  await msg({ type: 'popup.confirm', id: pend2.id, allow: false });
  assert.match(await p2, /declined|denied|Blocked/i);
  await rpc('tabs.close', { tab });
});

test('password fields: redacted and not typeable with default settings, even if the relay policy allows', { skip }, async () => {
  relay.policy.set({ passwords: 'allow' });
  const pk = newKey('pw', ['read', 'act', 'tabs', 'passwords']);
  const { tab } = await pk('tabs.new', { url: fx.a + '/prefilled' });
  const r = await pk('run', { tab, steps: [{ action: 'extract', target: '#pw', what: 'value' }, { action: 'type', target: '#pw', text: 'x' }] });
  assert.equal(r.results[0].value, '[redacted: password field]');
  assert.equal(r.results[1].denied, true);
  await pk('tabs.close', { tab }); pk.close();
  relay.policy.set({ passwords: 'deny' });
});

test('eval is off by default in the extension; "ask me" approval through the popup', { skip }, async () => {
  relay.policy.set({ eval: 'allow' });
  const { tab } = await rpc('tabs.new', { url: fx.a + '/item/ev' });
  await assert.rejects(rpc('eval', { tab, js: '1+1' }), /eval|JavaScript|Blocked/i);
  await setSettings({ eval: 'confirm' });
  await sleep(300);
  const p = rpc('eval', { tab, js: '20+22' });
  const pend = await waitFor(async () => (await status()).pending[0], 10000, 'eval approval');
  await msg({ type: 'popup.confirm', id: pend.id, allow: true });
  assert.equal((await p).results[0].value, 42);
  await setSettings({ eval: 'deny' });
  relay.policy.set({ eval: 'deny' });
  await rpc('tabs.close', { tab });
});

test('audit log in the popup shows agent actions and denials', { skip }, async () => {
  const a = (await status()).audit;
  assert.ok(a.some((e) => e.result === 'denied'), 'has denials');
  assert.ok(a.some((e) => e.result === 'ok'), 'has actions');
  assert.ok(!JSON.stringify(a).includes('hunter2'), 'page secrets never reach the log');
});

test('killswitch in the popup stops agents until you resume', { skip }, async () => {
  await msg({ type: 'popup.kill' });
  await waitFor(() => relay.killed, 5000, 'relay killed');
  await assert.rejects(rpc('tabs.list', {}), /Killswitch/i);
  const s = await status();
  assert.equal(s.killed, true); assert.equal(s.attached, 0);
  await msg({ type: 'popup.resume' });
  await waitFor(() => !relay.killed, 5000, 'relay resumed');
  const { tab } = await rpc('tabs.new', { url: fx.a + '/item/resumed' });
  assert.equal((await rpc('run', { tab, steps: [{ action: 'extract', target: 'h1' }] })).results[0].value, 'Item resumed');
  await rpc('tabs.close', { tab });
});

test('an impostor relay on the same port is refused; the real relay works again', { skip }, async () => {
  rpc.close();
  await relay.stop();
  const fakeKeys = new KeyStore(mkdtempSync(join(tmpdir(), 'lbd-impostor-')));
  const fake = await new Relay({ port, keys: fakeKeys, log: () => {}, policy: { preset: 'open' } }).start();
  await waitFor(async () => (await status()).relayState === 'untrusted', 15000, 'untrusted state');
  const fk = relayClient({ url: `ws://127.0.0.1:${port}/v1/ws`, key: fakeKeys.mint({ name: 'evil', scopes: ['read', 'act', 'tabs', 'admin'] }).token });
  const t = await fk('tabs.list', {}).catch((e) => ({ error: e.message }));
  assert.ok(t.error || !(t.tabs || []).some((x) => x.source === 'extension'), 'impostor sees no extension tabs: ' + JSON.stringify(t));
  fk.close();
  await fake.stop();
  relay = await new Relay({ port, keys, log: () => {} }).start();
  relay.policy.set({ rateLimit: { perSecond: 1000, perMinute: 60000 } });
  await msg({ type: 'popup.reconnect' });
  await waitFor(async () => (await status()).relayState === 'on', 15000, 'verified again');
  rpc = newKey('agent2');
  const { tab } = await rpc('tabs.new', { url: fx.a + '/item/back' });
  assert.equal((await rpc('run', { tab, steps: [{ action: 'extract', target: 'h1' }] })).results[0].value, 'Item back');
});
