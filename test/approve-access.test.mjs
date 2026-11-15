import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULTS, normalize } from '../extension/settings.js';
import { KeyStore } from '../src/keys.mjs';
import { Relay } from '../src/relay.mjs';
import { OPEN_POLICY } from '../src/policy.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const sw = readFileSync(join(root, 'extension', 'sw.js'), 'utf8');
const optionsHtml = readFileSync(join(root, 'extension', 'options.html'), 'utf8');
const popupJs = readFileSync(join(root, 'extension', 'popup.js'), 'utf8');

test('approveAccessMode defaults to false and normalizes booleans', () => {
  assert.equal(DEFAULTS.approveAccessMode, false);
  assert.equal(normalize().approveAccessMode, false);
  assert.equal(normalize({ approveAccessMode: true }).approveAccessMode, true);
  assert.equal(normalize({ approveAccessMode: 0 }).approveAccessMode, false);
});

test('extension options, sw.js, and popup implement Approve access mode with badge and 3 approval scopes', () => {
  assert.match(optionsHtml, /data-k="approveAccessMode"/);
  assert.match(sw, /pendingAccess/);
  assert.match(sw, /case 'popup\.accessResolve':/);
  assert.match(sw, /m\.type === 'accessRequest'/);
  assert.match(sw, /ACCESS_24H_MS/);
  assert.match(sw, /setBadgeText/);
  assert.match(popupJs, /Approve once/);
  assert.match(popupJs, /Approve 24h/);
  assert.match(popupJs, /Always approve/);
  assert.match(popupJs, /popup\.accessResolve/);
});

test('relay gates non-admin agent calls on extension access approval when approveAccessMode is enabled', async () => {
  const home = mkdtempSync(join(tmpdir(), 'lbd-access-'));
  const keys = new KeyStore(home);
  const minted = keys.mint({ name: 'codex-agent', scopes: ['read', 'act', 'tabs'] });
  const relay = new Relay({ keys, initialPolicy: OPEN_POLICY, routerOptions: {} });
  const sent = [];
  relay.router.ext = { readyState: 1, send: (raw) => sent.push(JSON.parse(raw)) };
  relay.router.tabs = async () => ({ tabs: [] });
  const agentCtx = { admin: false, key: keys.verify(minted.token), sid: 's1' };

  try {
    relay.extSettings = { approveAccessMode: false };
    const offRes = await relay.call('tabs.list', {}, agentCtx);
    assert.deepEqual(offRes.tabs, []);
    assert.equal(sent.some((m) => m.type === 'accessRequest'), false);

    relay.extSettings = { approveAccessMode: true, confirmTimeoutSec: 10 };
    const pendingCall = relay.call('tabs.list', {}, agentCtx);
    await new Promise((r) => setTimeout(r, 20));
    const req = sent.find((m) => m.type === 'accessRequest');
    assert.ok(req, 'expected accessRequest sent to extension');
    assert.equal(req.keyName, 'codex-agent');

    relay.resolveAccess(req.id, true, '24h');
    const okRes = await pendingCall;
    assert.deepEqual(okRes.tabs, []);

    sent.length = 0;
    const deniedCall = relay.call('tabs.list', {}, agentCtx);
    await new Promise((r) => setTimeout(r, 20));
    const req2 = sent.find((m) => m.type === 'accessRequest');
    assert.ok(req2);
    relay.resolveAccess(req2.id, false, 'deny');
    await assert.rejects(deniedCall, /did not approve this AI agent connection/);
  } finally {
    relay.router.ext = null;
    if (relay.http) await relay.stop();
    rmSync(home, { recursive: true, force: true });
  }
});
