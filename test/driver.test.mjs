// End-to-end tests against headless Chrome through the relay (no extension needed).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { Relay } from '../src/relay.mjs';
import { KeyStore } from '../src/keys.mjs';
import { relayClient } from '../src/mcp-stdio.mjs';
import { startFixtures } from './fixtures.mjs';

let relay, fx, keys, full, readonly, rpc, tab;

before(async () => {
  keys = new KeyStore(mkdtempSync(join(tmpdir(), 'lbd-test-')));
  relay = await new Relay({ port: 0, keys, log: () => {} }).start();
  fx = await startFixtures();
  full = keys.mint({ name: 'full', scopes: ['read', 'act', 'tabs', 'headless', 'admin'] }).token;
  readonly = keys.mint({ name: 'ro', scopes: ['read'] }).token;
  rpc = relayClient({ url: `ws://127.0.0.1:${relay.port}/v1/ws`, key: full });
  const r = await rpc('headless.launch', {});
  tab = r.tab;
});
after(async () => { rpc.close(); await relay.stop(); await fx.close(); });

const http = (path, body, key = full) => fetch(`http://127.0.0.1:${relay.port}${path}`, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) }));

test('batch: form fill + submit + extract in one call', async () => {
  const r = await rpc('run', { tab, snapshot: 'none', steps: [
    { action: 'navigate', url: fx.url + '/form' },
    { action: 'type', target: 'label=Full name', text: 'Ada Lovelace' },
    { action: 'type', target: 'text=you@example.com', text: 'ada@example.com' },
    { action: 'select', target: '#plan', value: 'Pro' },
    { action: 'check', target: 'label=I agree' },
    { action: 'type', target: 'role=textbox[name=Notes]', text: 'hi' },
    { action: 'click', target: 'text=Create account', waitNav: true },
    { action: 'extract', target: '#summary' },
  ] });
  assert.equal(r.ok, true, JSON.stringify(r.results));
  assert.equal(r.results.at(-1).value, 'name=Ada Lovelace;email=ada@example.com;plan=pro;tos=on;notes=hi');
});

test('search with Enter, wait for async results, extract all', async () => {
  const r = await rpc('run', { tab, steps: [
    { action: 'navigate', url: fx.url + '/search' },
    { action: 'type', target: '#q', text: 'luculent', submit: true },
    { action: 'wait', target: '.result' },
    { action: 'extract', target: '.result a', all: true },
  ] });
  assert.equal(r.ok, true, JSON.stringify(r.results));
  assert.deepEqual(r.results.at(-1).value, ['luculent alpha', 'luculent beta', 'luculent gamma']);
});

test('waitNav on a click that does not navigate returns quickly; [e12] refs and wait aliases work', async () => {
  const snap = await rpc('run', { tab, steps: [{ action: 'navigate', url: fx.url + '/search' }], snapshot: 'full' });
  const ref = /\[(e\d+)\] searchbox/.exec(snap.snapshot.lines.join('\n'))[1];
  const t0 = Date.now();
  const r = await rpc('run', { tab, steps: [
    { action: 'type', target: `[${ref}]`, text: 'luculent' },
    { action: 'click', target: 'role=button[name="Search"]', waitNav: true },
    { action: 'wait', for: 'idle' },
    { action: 'extract', target: '.result a', all: true },
  ] });
  assert.equal(r.ok, true, JSON.stringify(r.results));
  assert.equal(r.results[1].value.navigated, false);
  assert.ok(Date.now() - t0 < 5000, `took ${Date.now() - t0}ms`);
  assert.deepEqual(r.results.at(-1).value, ['luculent alpha', 'luculent beta', 'luculent gamma']);
});

test('stale ref after navigation fails fast with a hint', async () => {
  await rpc('run', { tab, steps: [{ action: 'navigate', url: fx.url + '/form' }], snapshot: 'full' });
  const t0 = Date.now();
  const r = await rpc('run', { tab, steps: [{ action: 'navigate', url: fx.url + '/search' }, { action: 'click', target: 'e99' }] });
  assert.equal(r.ok, false);
  assert.match(r.results[1].error, /not on this page/);
  assert.ok(Date.now() - t0 < 2000);
});

test('snapshot refs are stable and diffs only show changes', async () => {
  await rpc('navigate', { tab, url: fx.url + '/dynamic' });
  const s1 = await rpc('snapshot', { tab, mode: 'full' });
  assert.equal(s1.mode, 'full');
  const btn = s1.lines.find((l) => l.includes('button "Load"'));
  assert.ok(btn, s1.lines.join('\n'));
  const ref = /\[(e\d+)\]/.exec(btn)[1];
  const r = await rpc('run', { tab, snapshot: 'diff', steps: [{ action: 'click', target: ref }, { action: 'wait', text: 'Loaded late' }] });
  assert.equal(r.ok, true, JSON.stringify(r.results));
  assert.equal(r.snapshot.mode, 'diff');
  assert.ok(r.snapshot.added.some((l) => l.includes('Loaded late')), JSON.stringify(r.snapshot));
  assert.equal(r.snapshot.removed.length, 0);
});

test('shadow DOM targets', async () => {
  const r = await rpc('run', { tab, steps: [{ action: 'navigate', url: fx.url + '/shadow' }, { action: 'click', target: 'text=Shadow button' }, { action: 'extract', target: '#out' }] });
  assert.equal(r.ok, true, JSON.stringify(r.results));
  assert.equal(r.results.at(-1).value, 'clicked');
});

test('errors are per step and stop the batch', async () => {
  const r = await rpc('run', { tab, steps: [{ action: 'navigate', url: fx.url + '/' }, { action: 'click', target: '#missing', timeout: 300 }, { action: 'extract', target: 'h1' }] });
  assert.equal(r.ok, false);
  assert.equal(r.results.length, 2);
  assert.match(r.results[1].error, /Timeout 300ms/);
});

test('parallel jobs on new headless tabs', async () => {
  const r = await rpc('runParallel', { source: 'headless', jobs: [1, 2, 3].map((i) => ({ steps: [{ action: 'navigate', url: `${fx.url}/item/${i}` }, { action: 'extract', target: 'h1' }] })) });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.results.map((x) => x.results.at(-1).value), ['Item 1', 'Item 2', 'Item 3']);
});

test('screenshot only on request', async () => {
  const r = await rpc('screenshot', { tab });
  assert.equal(r.mime, 'image/jpeg');
  assert.ok(r.data.length > 1000);
});

test('HTTP RPC + scopes: read-only key cannot act', async () => {
  const ok = await http('/v1/rpc', { method: 'snapshot', params: { tab, mode: 'full' } }, readonly);
  assert.equal(ok.status, 200);
  const no = await http('/v1/rpc', { method: 'click', params: { tab, target: 'h1' } }, readonly);
  assert.equal(no.status, 403);
  const bad = await http('/v1/rpc', { method: 'status' }, 'lbd_nope');
  assert.equal(bad.status, 401);
});

test('web page origins are refused', async () => {
  const r = await fetch(`http://127.0.0.1:${relay.port}/v1/rpc`, { method: 'POST', headers: { authorization: `Bearer ${full}`, origin: 'https://evil.example' }, body: '{"method":"status"}' });
  assert.equal(r.status, 403);
});

test('origin allowlist on a key', async () => {
  const k = keys.mint({ name: 'scoped', scopes: ['read', 'act'], allowOrigins: ['example.org'] }).token;
  const r = await http('/v1/rpc', { method: 'navigate', params: { tab, url: fx.url + '/' } }, k);
  assert.equal(r.status, 403);
});

test('MCP over HTTP: tools/list and browser_run', async () => {
  const init = await http('/mcp', { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
  assert.equal(init.json.result.serverInfo.name, 'luculent-browser-driver');
  const list = await http('/mcp', { jsonrpc: '2.0', id: 2, method: 'tools/list' });
  assert.ok(list.json.result.tools.some((t) => t.name === 'browser_run'));
  const call = await http('/mcp', { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'browser_run', arguments: { tab, steps: [{ action: 'navigate', url: fx.url + '/list' }, { action: 'extract', target: '.price', all: true }], snapshot: 'none' } } });
  assert.match(call.json.result.content[0].text, /^ok /);
  assert.match(call.json.result.content[0].text, /\$150\.00/);
});

test('revoked key is rejected immediately', async () => {
  const k = keys.mint({ name: 'temp', scopes: ['read'] });
  assert.equal((await http('/v1/rpc', { method: 'status' }, k.token)).status, 200);
  keys.revoke(k.id);
  assert.equal((await http('/v1/rpc', { method: 'status' }, k.token)).status, 401);
});

test('killswitch drops agents and refuses calls until resume', async () => {
  const other = relayClient({ url: `ws://127.0.0.1:${relay.port}/v1/ws`, key: full });
  await other('status', {});
  const killed = await http('/v1/admin/kill', {});
  assert.equal(killed.json.killed, true);
  await assert.rejects(other('status', {}));
  assert.equal((await http('/v1/rpc', { method: 'tabs.list' })).status, 423);
  const ws = new WebSocket(`ws://127.0.0.1:${relay.port}/v1/ws`, { headers: { authorization: `Bearer ${full}` } });
  const code = await new Promise((r) => ws.on('unexpected-response', (_q, res) => r(res.statusCode)));
  assert.equal(code, 423);
  await http('/v1/admin/resume', {});
  rpc.close();
  rpc = relayClient({ url: `ws://127.0.0.1:${relay.port}/v1/ws`, key: full });
  const r = await rpc('headless.launch', {});
  tab = r.tab;
  assert.equal((await rpc('navigate', { tab, url: fx.url + '/' })).ok, true);
});
