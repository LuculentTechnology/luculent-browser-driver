// "When you click in the AI's tab" (T1288): Cowork / Pause / Disable window mode logic, relay gate and wiring.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { InteractionTracker, normalizeClickMode, CLICK_MODES, DEFAULT_CLICK_MODE } from '../src/cowork.mjs';
import { PlanHub } from '../src/plan.mjs';
import { Relay } from '../src/relay.mjs';
import { KeyStore } from '../src/keys.mjs';
import { TOOLS, handleMcp } from '../src/mcp-tools.mjs';
import { normalize as extNormalize, DEFAULTS, normalizeClickMode as extClickMode } from '../extension/settings.js';
import { packSettings, applyPacked } from '../extension/account-sync.js';

const ext = dirname(fileURLToPath(new URL('../extension/settings.js', import.meta.url)));

function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; }, sleep: async (ms) => { t += ms; } };
}

test('click mode normalizes, defaults to Cowork and maps the legacy disableWindow flag', () => {
  assert.deepEqual(CLICK_MODES, ['cowork', 'pause', 'disable']);
  assert.equal(DEFAULT_CLICK_MODE, 'cowork');
  assert.equal(normalizeClickMode(undefined), 'cowork');
  assert.equal(normalizeClickMode('Pause'), 'pause');
  assert.equal(normalizeClickMode('disable window'), 'disable');
  assert.equal(normalizeClickMode('disable_window'), 'disable');
  assert.equal(normalizeClickMode('nonsense'), 'cowork');
  assert.equal(normalizeClickMode(undefined, { disableWindow: true }), 'disable');
  assert.equal(normalizeClickMode('cowork', { disableWindow: true }), 'cowork');
  assert.equal(extClickMode('pause'), 'pause');
  assert.equal(DEFAULTS.clickMode, 'cowork');
  assert.equal(extNormalize({}).clickMode, 'cowork');
  assert.equal(extNormalize({ disableWindow: true }).clickMode, 'disable');
  assert.equal(extNormalize({ disableWindow: true, clickMode: 'pause' }).clickMode, 'pause');
  assert.equal(extNormalize({ clickMode: 'disable' }).disableWindow, true);
  assert.equal(extNormalize({ clickMode: 'cowork', disableWindow: true }).disableWindow, false);
});

test('the AI\'s own CDP input is never counted as yours', () => {
  const c = clock();
  const tr = new InteractionTracker({ now: c.now, sleep: c.sleep, guardMs: 400 });
  const w = tr.aiStart();
  c.advance(20);
  assert.equal(tr.onUserInput({ at: c.now(), kind: 'pointerdown' }).action, 'ignored');
  tr.aiEnd(w);
  c.advance(300);
  assert.equal(tr.onUserInput({ at: c.now(), kind: 'pointerdown' }).why, 'ai', 'inside the guard after the AI click');
  c.advance(200);
  assert.equal(tr.onUserInput({ at: c.now(), kind: 'pointerdown' }).action, 'cowork');
  assert.equal(tr.onUserInput({ at: c.now(), kind: 'mousemove' }).action, 'ignored', 'moves alone do not count');
});

test('Cowork holds while you interact, waits for idle, then reports that you stepped in', async () => {
  const c = clock();
  const tr = new InteractionTracker({ now: c.now, sleep: c.sleep, idleMs: 900 });
  tr.setMode('cowork');
  const first = tr.onUserInput({ at: c.now(), kind: 'pointerdown' });
  assert.deepEqual(first, { action: 'cowork', changed: true });
  tr.onUserInput({ at: c.now(), kind: 'keydown' });
  assert.equal(tr.userActive(), true);
  const holds = [];
  const g = await tr.gate({ onHold: (s) => holds.push(s) });
  assert.equal(g.held, true);
  assert.ok(g.waitedMs >= 900 && g.waitedMs < 1300, 'idle debounce ' + g.waitedMs);
  assert.deepEqual(holds, ['cowork']);
  const info = tr.consume();
  assert.equal(info.userStepped, true);
  assert.deepEqual(info.kinds.sort(), ['keydown', 'pointerdown']);
  assert.equal(tr.consume(), null);
  const fast = await tr.gate();
  assert.equal(fast.held, false);
  assert.equal(fast.waitedMs, 0, 'no added latency when you did not touch the tab');
});

test('Pause stops the task on your input and continues only after Resume', async () => {
  const tr = new InteractionTracker({ idleMs: 50 });
  tr.setMode('pause');
  assert.deepEqual(tr.onUserInput({ kind: 'pointerdown' }), { action: 'pause', changed: true });
  assert.equal(tr.paused, true);
  let done = false;
  const p = tr.gate({}).then((g) => { done = true; return g; });
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(done, false, 'still paused');
  tr.resume();
  const g = await p;
  assert.equal(g.paused, true);
  assert.equal(tr.paused, false);
  assert.equal(tr.consume().userStepped, true);
});

test('Disable window mode blocks instead of tracking, and switching away from Pause releases a waiting task', async () => {
  const tr = new InteractionTracker({ idleMs: 50 });
  tr.setMode('disable');
  assert.equal(tr.onUserInput({ kind: 'pointerdown' }).action, 'blocked');
  assert.equal(tr.hasPending(), false);
  tr.setMode('pause');
  tr.onUserInput({ kind: 'keydown' });
  const p = tr.gate({});
  tr.setMode('cowork');
  const g = await p;
  assert.equal(g.paused, true);
});

test('a stopped task (Take back control / killswitch) leaves the gate at once', async () => {
  const tr = new InteractionTracker({ idleMs: 50 });
  tr.setMode('pause');
  tr.onUserInput({ kind: 'pointerdown' });
  const g = await tr.gate({ shouldStop: () => true });
  assert.equal(g.stopped, true);
});

test('relay: input from the watched tab drives the gate; other tabs and AI input are ignored', async () => {
  const relay = new Relay({ port: 0, keys: new KeyStore(mkdtempSync(join(tmpdir(), 'lbd-cowork-'))), log: () => {} });
  relay.interact.idleMs = 60;
  relay.extSettings = { clickMode: 'cowork' };
  relay._watchTab = '41';
  const sent = [];
  relay.router.extNotify = (m) => sent.push(m);
  assert.equal(relay.onUserInput({ tabId: 99, kind: 'pointerdown', at: Date.now() }).why, 'tab');
  assert.equal(relay.onUserInput({ tabId: 41, kind: 'pointerdown', at: Date.now() }).action, 'cowork');
  assert.ok(sent.some((m) => m.type === 'interaction' && m.state === 'cowork'));
  const g = await relay.userGate({}, '41');
  assert.equal(g.userStepped, true);
  assert.ok(sent.some((m) => m.type === 'interaction' && m.state === 'resumed'));
  assert.equal(await relay.userGate({}, '41'), null, 'no input, no gate');
  relay.extSettings = { clickMode: 'pause' };
  relay.onUserInput({ tabId: 41, kind: 'keydown', at: Date.now() });
  assert.ok(sent.some((m) => m.type === 'interaction' && m.state === 'paused'));
  assert.equal(relay.interactionPublic().paused, true);
  const waiting = relay.userGate({}, '41');
  setTimeout(() => relay.call('interaction.resume', {}, { admin: true, fromExtension: true }), 80);
  const g2 = await waiting;
  assert.equal(g2.paused, true);
  assert.equal(g2.userStepped, true);
  relay.extSettings = { clickMode: 'disable' };
  assert.equal(relay.onUserInput({ tabId: 41, kind: 'pointerdown', at: Date.now() }).action, 'blocked');
  // Input.* commands sent by the driver open an AI window, so a click in that window is not yours.
  relay.extSettings = { clickMode: 'cowork' };
  relay.router.isHeadless = () => false;
  const origSend = relay.router.send;
  assert.equal(typeof origSend, 'function');
  const w = relay.interact.aiStart();
  assert.equal(relay.onUserInput({ tabId: 41, kind: 'pointerdown', at: Date.now() }).why, 'ai');
  relay.interact.aiEnd(w);
});

test('relay + MCP expose the click mode (read, set) and settings sync carries it', async () => {
  const relay = new Relay({ port: 0, keys: new KeyStore(mkdtempSync(join(tmpdir(), 'lbd-cowork-mcp-'))), log: () => {} });
  const ctx = { admin: false, key: { id: 'k', name: 'k', scopes: ['read', 'act'] }, sid: 'k' };
  const rpc = (m, p) => relay.call(m, p, ctx);
  const tool = TOOLS.find((t) => t.name === 'browser_click_mode');
  assert.ok(tool);
  assert.deepEqual(tool.inputSchema.properties.mode.enum, ['cowork', 'pause', 'disable']);
  const read = await handleMcp({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'browser_click_mode', arguments: {} } }, rpc);
  assert.match(read.result.content[0].text, /"mode": "cowork"/);
  const set = await handleMcp({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'browser_click_mode', arguments: { mode: 'pause' } } }, rpc);
  assert.match(set.result.content[0].text, /"mode": "pause"/);
  assert.equal(relay.clickMode(), 'pause');
  const packed = packSettings({ clickMode: 'pause', aiCursor: false });
  assert.equal(packed.security.clickMode, 'pause');
  assert.equal(applyPacked({ clickMode: 'cowork' }, null, packed).settings.clickMode, 'pause');
});

test('planner: after you step in, steps whose outcome is already on the page are marked done by you', async () => {
  const hub = new PlanHub();
  let page = { url: 'https://example.org/a', title: 'Alpha' };
  const ran = [];
  const engine = {
    docState: async () => [null, 'complete', page.url],
    evaluate: async () => [page.url, page.title, page.title, page.title],
    currentUrl: async () => page.url,
  };
  const runOn = async (_c, req) => { ran.push(req.steps[0].action + ':' + (req.steps[0].ms || '')); return { ok: true, results: [{ ok: true }] }; };
  let stepped = false;
  const out = await hub.run(engine, runOn, {}, {
    tab: 't-cowork',
    steps: [
      { action: 'wait', ms: 1, intent: 'start', expect: { title: 'Alpha' } },
      { action: 'wait', ms: 2, intent: 'get past the stuck dialog', expect: { title: 'Beta' } },
      { action: 'wait', ms: 3, intent: 'finish', expect: { title: 'Beta' } },
      { action: 'wait', ms: 4, intent: 'read result', expect: { title: 'Gamma' } },
    ],
    beforeStep: async (i) => {
      if (i === 1 && !stepped) { stepped = true; page = { url: 'https://example.org/b', title: 'Beta' }; return { userStepped: true, kinds: ['pointerdown'], count: 1 }; }
      return null;
    },
  });
  assert.equal(out.event, 'done');
  assert.deepEqual(ran, ['wait:1', 'wait:4'], 'steps 2 and 3 were done by you, so the AI continued from step 4');
  assert.equal(out.plan.steps[1].status, 'user');
  assert.equal(out.plan.steps[2].status, 'user');
  assert.equal(out.stats.cowork, 1);
  assert.equal(out.stats.userDone, 2);
  assert.equal(out.stats.model, 0, 'no model call for cowork');
});

test('extension wiring: overlay reports trusted input only, shows a quiet indicator, sw forwards it', () => {
  const overlay = readFileSync(join(ext, 'overlay.js'), 'utf8');
  assert.match(overlay, /e\.isTrusted/);
  assert.match(overlay, /You\\u2019re coworking/);
  assert.match(overlay, /Luculent picks up from here/);
  assert.match(overlay, /overlay\.resumeUser/);
  assert.doesNotMatch(overlay, /#FF5C7A|#ff0000|:\s*red\b/i, 'no red in the cowork indicator');
  const sw = readFileSync(join(ext, 'sw.js'), 'utf8');
  assert.match(sw, /case 'overlay\.userInput'/);
  assert.match(sw, /type: 'userInput'/);
  assert.match(sw, /case 'panel\.clickMode'/);
  assert.match(sw, /case 'panel\.resumeUser'/);
  assert.match(sw, /m\.type === 'interaction'/);
  assert.match(sw, /m\.type === 'setClickMode'/);
  assert.match(sw, /reinjectOverlay/);
  const panelJs = readFileSync(join(ext, 'panel.js'), 'utf8');
  assert.match(panelJs, /paintInteraction/);
  assert.match(panelJs, /panel\.resumeUser/);
});

test('side panel calls keep their reply id: the chat id travels as chatId, so Paused/Resume reaches the panel', () => {
  const ext = join(dirname(fileURLToPath(import.meta.url)), '..', 'extension');
  const sw = readFileSync(join(ext, 'sw.js'), 'utf8');
  assert.match(sw, /const \{ id: chatId, \.\.\.rest \} = payload;/);
  assert.match(sw, /send\(\{ \.\.\.rest, \.\.\.\(chatId != null \? \{ chatId \} : \{\}\), id \}\)/);
  const relaySrc = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'relay.mjs'), 'utf8');
  assert.match(relaySrc, /id: m\.chatId != null \? m\.chatId : undefined/);
  // overlay never builds DOM from strings (Trusted Types sites such as GitHub reject it)
  const overlay = readFileSync(join(ext, 'overlay.js'), 'utf8');
  assert.doesNotMatch(overlay, /\.innerHTML\s*=/);
});

test('the page you were on when you stepped in travels with the record; a mode set by an agent is not saved', () => {
  let now = 1000;
  const it = new InteractionTracker({ now: () => now, sleep: async () => {} });
  it.setMode('cowork');
  it.onUserInput({ at: 1000, kind: 'pointerdown', url: 'https://a.example/after-step-0' });
  it.onUserInput({ at: 1100, kind: 'pointerdown', url: 'https://a.example/elsewhere' });
  const rec = it.consume();
  assert.equal(rec.firstUrl, 'https://a.example/after-step-0');
  assert.equal(it.consume(), null);
  const ext = join(dirname(fileURLToPath(import.meta.url)), '..', 'extension');
  const sw = readFileSync(join(ext, 'sw.js'), 'utf8');
  assert.match(sw, /if \(persist\) \{\n    settings = await saveSettings\(\{ clickMode: m \}\);/);
  assert.match(sw, /url: String\(sender\.url/);
  const relaySrc = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'relay.mjs'), 'utf8');
  assert.match(relaySrc, /const before = g\.firstUrl \|\| startUrl;/);
});
