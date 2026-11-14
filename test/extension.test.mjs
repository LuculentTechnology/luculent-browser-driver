// Extension E2E: a separate Chromium profile with the unpacked extension, driven through the relay.
// Checks: attach to an existing tab by id (no new tabs), batch flows, multi-tab, relay restart => silent reconnect.
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
import { startFixtures } from './fixtures.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const chromium = process.env.LBD_TEST_CHROMIUM || findPlaywrightChromium();
const skip = !chromium && 'no Playwright Chromium found (branded Chrome blocks --load-extension)';

let relay, keys, fx, browser, rpc, port, extDir;

async function waitExt(timeout = 15000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (relay.router.ext) return true; await sleep(50); }
  throw new Error('extension did not connect');
}
const extTabs = async () => (await rpc('tabs.list', {})).tabs.filter((t) => t.source === 'extension');

before(async () => {
  if (skip) return;
  keys = new KeyStore(mkdtempSync(join(tmpdir(), 'lbd-ext-')));
  relay = await new Relay({ port: 0, keys, log: () => {} }).start();
  port = relay.port;
  fx = await startFixtures();
  extDir = join(mkdtempSync(join(tmpdir(), 'lbd-extsrc-')), 'extension');
  cpSync(resolve(here, '..', 'extension'), extDir, { recursive: true });
  writeFileSync(join(extDir, 'config.json'), JSON.stringify({ relayUrl: `ws://127.0.0.1:${port}/ext`, settings: { grantMode: 'all' } }));
  browser = await HeadlessBrowser.launch({ chromePath: chromium, headless: process.env.LBD_HEADED ? false : true, extensionPath: extDir, args: ['--window-position=0,0', '--window-size=1280,900'] });
  await waitExt();
  rpc = relayClient({ url: `ws://127.0.0.1:${port}/v1/ws`, key: keys.mint({ name: 'e2e', scopes: ['read', 'act', 'tabs', 'admin'] }).token });
});
after(async () => { if (skip) return; rpc && rpc.close(); await relay.stop().catch(() => {}); await browser.close(); await fx.close(); });

test('attaches to an existing tab by id without opening any tab', { skip }, async () => {
  const before = await extTabs();
  assert.ok(before.length >= 1, 'expected the startup tab');
  const tab = before[0].tab;
  const r = await rpc('run', { tab, steps: [{ action: 'navigate', url: fx.url + '/' }, { action: 'extract', target: 'h1' }] });
  assert.equal(r.ok, true, JSON.stringify(r.results));
  assert.equal(r.results[1].value, 'Fixture home');
  const after = await extTabs();
  assert.equal(after.length, before.length, 'no new tabs may appear');
});

test('form flow through chrome.debugger', { skip }, async () => {
  const tab = (await extTabs())[0].tab;
  const r = await rpc('run', { tab, snapshot: 'diff', steps: [
    { action: 'navigate', url: fx.url + '/form' },
    { action: 'type', target: '#name', text: 'Grace Hopper' },
    { action: 'type', target: 'input[name=email]', text: 'grace@example.com' },
    { action: 'select', target: '#plan', value: 'biz' },
    { action: 'check', target: '#tos' },
    { action: 'click', target: 'role=button[name="Create account"]', waitNav: true },
    { action: 'extract', target: '#summary' },
  ] });
  assert.equal(r.ok, true, JSON.stringify(r.results));
  assert.equal(r.results.at(-1).value, 'name=Grace Hopper;email=grace@example.com;plan=biz;tos=on;notes=');
});

test('multi-tab parallel in the real browser', { skip }, async () => {
  const r = await rpc('runParallel', { source: 'extension', jobs: [1, 2, 3].map((i) => ({ steps: [{ action: 'navigate', url: `${fx.url}/item/${i}` }, { action: 'extract', target: 'h1' }] })) });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.results.map((x) => x.results.at(-1).value), ['Item 1', 'Item 2', 'Item 3']);
  for (const x of r.results) await rpc('tabs.close', { tab: x.tab });
});

test('relay restart: extension reconnects silently, no new tabs, same tab still drivable', { skip }, async () => {
  const before = await extTabs();
  rpc.close();
  await relay.stop();
  relay = await new Relay({ port, keys, log: () => {} }).start();
  const t0 = Date.now();
  await waitExt(10000);
  const reconnectMs = Date.now() - t0;
  rpc = relayClient({ url: `ws://127.0.0.1:${port}/v1/ws`, key: keys.mint({ name: 'e2e2', scopes: ['read', 'act', 'tabs', 'admin'] }).token });
  const after = await extTabs();
  assert.equal(after.length, before.length, 'reconnect must not open tabs');
  const r = await rpc('run', { tab: before[0].tab, steps: [{ action: 'navigate', url: fx.url + '/list' }, { action: 'extract', target: '.item', all: true }] });
  assert.equal(r.ok, true);
  assert.equal(r.results[1].value.length, 50);
  console.log(`# extension reconnected in ${reconnectMs}ms`);
});

test('killswitch detaches every tab', { skip }, async () => {
  const tab = (await extTabs())[0].tab;
  await rpc('snapshot', { tab });
  await rpc('admin.kill', {}).catch(() => {});
  await sleep(300);
  const { tabs } = await relay.router.tabs();
  assert.ok(tabs.length > 0 && tabs.every((t) => !t.attached), 'all tabs detached after kill: ' + JSON.stringify(tabs));
  relay.resume();
  rpc.close();
  rpc = relayClient({ url: `ws://127.0.0.1:${port}/v1/ws`, key: keys.mint({ name: 'e2e3', scopes: ['read', 'act', 'tabs'] }).token });
  const r = await rpc('run', { tab, steps: [{ action: 'navigate', url: fx.url + '/' }, { action: 'extract', target: 'h1' }] });
  assert.equal(r.ok, true, 'driving works again after resume (re-attaches on demand)');
});
