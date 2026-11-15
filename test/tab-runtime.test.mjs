import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { KeyStore } from '../src/keys.mjs';
import { Relay } from '../src/relay.mjs';
import { OPEN_POLICY } from '../src/policy.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const sw = readFileSync(join(root, 'extension', 'sw.js'), 'utf8');
const popupHtml = readFileSync(join(root, 'extension', 'popup.html'), 'utf8');
const popupJs = readFileSync(join(root, 'extension', 'popup.js'), 'utf8');

test('extension sw.js and popup implement popup.tabState, popup.pauseTab, popup.releaseTab, and session persistence', () => {
  assert.match(sw, /case 'popup\.tabState':/);
  assert.match(sw, /case 'popup\.pauseTab':/);
  assert.match(sw, /case 'popup\.releaseTab':/);
  assert.match(sw, /computeTabState/);
  assert.match(sw, /applyTabAppearance/);
  assert.match(sw, /TAB_STATE_SYMBOLS/);
  assert.match(sw, /restoreTabAppearance/);
  assert.match(sw, /pausedTabs/);
  assert.match(sw, /tabRuntime/);
  assert.match(sw, /'needs-input'/);
  assert.match(sw, /'stopped'/);
  assert.match(sw, /'paused'/);
  assert.match(sw, /'active'/);
  assert.match(sw, /'idle'/);
  assert.match(popupHtml, /id="release"/);
  assert.match(popupJs, /popup\.tabState/);
  assert.match(popupJs, /popup\.pauseTab/);
  assert.match(popupJs, /popup\.releaseTab/);
});

test('relay per-tab pause blocks only the paused tab, exposes reason to panel.state, and resumes cleanly', async () => {
  const home = mkdtempSync(join(tmpdir(), 'lbd-tab-rt-'));
  const keys = new KeyStore(home);
    const minted = keys.mint({ name: 'test', scopes: ['read', 'act', 'tabs'] });
    const relay = new Relay({ keys, initialPolicy: OPEN_POLICY, routerOptions: {} });
    let ws = null;
    try {
      const extCtx = { fromExtension: true, admin: true, key: { id: 'extension', name: 'extension' } };
      const agentCtx = { key: minted, client: 'test' };
      ws = new EventEmitter();
    ws.readyState = 1;
    ws.close = () => {};
    ws.send = (raw) => {
      const msg = JSON.parse(raw);
      if (msg.id && msg.type === 'tabs') {
        ws.emit('message', Buffer.from(JSON.stringify({ id: msg.id, result: { tabs: [{ id: 101, granted: true, attached: true, url: 'https://example.com' }] } })));
      }
    };
    relay.onExtension(ws, 'ext-test');

    // Simulate extension sending pauseTab for tab 101
    ws.emit('message', Buffer.from(JSON.stringify({ type: 'pauseTab', tabId: 101, pause: true, reason: 'Paused by user' })));

    // panel.state exposes tabPause reason for tab 101 and pausedTabs map
    const state101 = await relay.call('panel.state', { tab: 101 }, extCtx);
    assert.equal(state101.tabPause, 'Paused by user');
    assert.equal(state101.pausedTabs['101'], 'Paused by user');

    // runOn for tab 101 returns paused event without executing
    const pausedRun = await relay.runOn(agentCtx, { tab: '101', steps: [{ action: 'extract', target: 'h1' }] });
    assert.equal(pausedRun.ok, false);
    assert.equal(pausedRun.event, 'paused');
    assert.equal(pausedRun.reason, 'Paused by user');

    // Another tab (102) is not marked paused
    const state102 = await relay.call('panel.state', { tab: 102 }, extCtx);
    assert.equal(state102.tabPause, null);

    // Resume tab 101
    ws.emit('message', Buffer.from(JSON.stringify({ type: 'pauseTab', tabId: 101, pause: false })));
    const resumedState = await relay.call('panel.state', { tab: 101 }, extCtx);
    assert.equal(resumedState.tabPause, null);
    assert.equal(resumedState.pausedTabs['101'], undefined);
  } finally {
    if (ws) ws.emit('close');
    await relay.close?.();
    rmSync(home, { recursive: true, force: true });
  }
});
