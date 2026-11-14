// Preemptive navigation: matcher unit tests, a local 3-page plan, confirm/replan, panel + MCP wiring, latency vs no plan.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Relay } from '../src/relay.mjs';
import { KeyStore } from '../src/keys.mjs';
import { matchPattern, publicPlan, PlanHub } from '../src/plan.mjs';
import { TOOLS } from '../src/mcp-tools.mjs';

const pages = {
  '/a': '<!doctype html><title>Alpha</title><h1>Alpha</h1><p>Start here</p><a href="/b" id="to-b">Go to Beta</a>',
  '/b': '<!doctype html><title>Beta</title><h1>Beta</h1><p>Middle page</p><a href="/c" id="to-c">Go to Gamma</a>',
  '/c': '<!doctype html><title>Gamma</title><h1>Gamma</h1><p>All done</p><a href="/a" id="home">Back to Alpha</a>',
};

function startFx() {
  const server = http.createServer((req, res) => {
    const url = (req.url || '/').split('?')[0];
    const html = pages[url] || pages['/a'];
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(html);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    const { port } = server.address();
    resolve({ origin: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(r)) });
  }));
}

test('matchPattern accepts substrings and regex', () => {
  assert.equal(matchPattern('https://en.wikipedia.org/wiki/Ada_Lovelace', 'Ada_Lovelace').ok, true);
  assert.equal(matchPattern('Ada Lovelace - Wikipedia', '^Ada Lovelace').ok, true);
  assert.equal(matchPattern('Hacker News', '/hacker news/i').ok, true);
  assert.equal(matchPattern('Beta', 'Gamma').ok, false);
  assert.equal(matchPattern('anything', '').ok, true);
});

test('publicPlan hides nothing required for the panel and keeps confirm summaries', () => {
  const hub = new PlanHub();
  const pub = hub.set({
    goal: 'Open Gamma',
    tab: 't1',
    steps: [
      { action: 'click', target: '#to-b', label: 'Open Beta', expect: { title: 'Beta' } },
      { action: 'click', target: '#to-c', expect: { url: '/c' } },
    ],
  });
  assert.equal(pub.goal, 'Open Gamma');
  assert.equal(pub.steps.length, 2);
  assert.equal(pub.steps[0].label, 'Open Beta');
  assert.equal(pub.steps[0].status, 'pending');
  assert.equal(pub.status, 'ready');
  hub.adjust('t1', { steps: [{ action: 'click', target: '#home' }], reason: 'test' });
  const after = hub.public('t1');
  assert.equal(after.lastEvent.event, 'replan');
  assert.equal(after.steps.length, 1);
});

test('MCP tools/list includes browser_plan with expected-state fields', () => {
  const tool = TOOLS.find((t) => t.name === 'browser_plan');
  assert.ok(tool, 'browser_plan is registered');
  const props = tool.inputSchema.properties;
  assert.ok(props.op);
  assert.ok(props.steps);
  assert.ok(props.autoConfirm);
  const expect = props.steps.items.properties.expect.properties;
  assert.ok(expect.url && expect.title && expect.visible);
});

let relay, fx, tab, ctx;
const rpc = (m, p) => relay.call(m, p, ctx);

before(async () => {
  fx = await startFx();
  relay = await new Relay({ port: 0, keys: new KeyStore(mkdtempSync(join(tmpdir(), 'lbd-plan-'))), log: () => {} }).start();
  ctx = { admin: true, key: { id: 'plan', name: 'plan', scopes: ['read', 'act', 'tabs', 'headless'] }, sid: 'plan-test' };
  tab = (await rpc('headless.launch', {})).tab;
});

after(async () => {
  try { await relay.stop(); } catch (_) {}
  try { await fx.close(); } catch (_) {}
});

test('a 3-step plan confirms cheaply and reaches Gamma', async () => {
  await rpc('run', { tab, steps: [{ action: 'navigate', url: fx.origin + '/a' }], snapshot: 'none' });
  const plan = await rpc('plan.run', {
    tab,
    goal: 'Walk Alpha to Gamma',
    autoConfirm: true,
    visionWhenNeeded: false,
    steps: [
      { action: 'click', target: '#to-b', label: 'Open Beta', waitNav: true, expect: { url: '/b', title: 'Beta', visible: '#to-c' } },
      { action: 'click', target: '#to-c', label: 'Open Gamma', waitNav: true, expect: { url: '/c', title: 'Gamma', heading: 'Gamma' } },
      { action: 'wait', ms: 50, label: 'Settle', expect: { title: 'Gamma', visible: '#home' } },
    ],
  });
  assert.equal(plan.ok, true);
  assert.equal(plan.event, 'done');
  assert.equal(plan.plan.status, 'done');
  assert.equal(plan.plan.steps.every((s) => s.status === 'done'), true);
  assert.equal(plan.results.every((r) => r.confirm.matched), true);
  assert.equal(plan.results.every((r) => r.confirm.usedVision === false), true);
  const state = await rpc('panel.state', { tab });
  assert.ok(state.plan);
  assert.equal(state.plan.goal, 'Walk Alpha to Gamma');
  assert.equal(state.plan.status, 'done');
  assert.ok(state.plan.steps.length === 3);
});

test('a missed expectation returns a re-plan event and adjust continues from confirmed state', async () => {
  await rpc('run', { tab, steps: [{ action: 'navigate', url: fx.origin + '/a' }], snapshot: 'none' });
  const miss = await rpc('plan.run', {
    tab,
    goal: 'Wrong expectation',
    visionWhenNeeded: false,
    steps: [
      { action: 'click', target: '#to-b', waitNav: true, expect: { title: 'This page does not exist' } },
      { action: 'click', target: '#to-c', waitNav: true, expect: { title: 'Gamma' } },
    ],
  });
  assert.equal(miss.ok, false);
  assert.equal(miss.event, 'replan');
  assert.ok(miss.failed && miss.failed.some((f) => f.field === 'title'));
  assert.match(miss.confirmed.title, /Beta/);
  assert.equal(miss.remaining.length, 1);
  const adjusted = await rpc('plan.adjust', {
    tab,
    reason: 'landed on Beta, continue to Gamma',
    steps: [{ action: 'click', target: '#to-c', waitNav: true, expect: { title: 'Gamma', url: '/c' } }],
  });
  assert.equal(adjusted.plan.status, 'ready');
  const cont = await rpc('plan.run', { tab, visionWhenNeeded: false });
  assert.equal(cont.ok, true);
  assert.equal(cont.event, 'done');
  assert.match((await rpc('run', { tab, steps: [{ action: 'extract', what: 'text' }], snapshot: 'none' })).results[0].value || '', /All done|Gamma/);
});

test('planned confirms are cheaper than a full snapshot after each step', async () => {
  await rpc('run', { tab, steps: [{ action: 'navigate', url: fx.origin + '/a' }], snapshot: 'none' });
  const unplanned = [];
  for (const step of [
    { action: 'click', target: '#to-b', waitNav: true },
    { action: 'click', target: '#to-c', waitNav: true },
    { action: 'wait', ms: 50 },
  ]) {
    const t0 = performance.now();
    const r = await rpc('run', { tab, steps: [step], snapshot: 'full' });
    unplanned.push({ ok: r.ok, ms: Math.round(performance.now() - t0) });
  }
  await rpc('run', { tab, steps: [{ action: 'navigate', url: fx.origin + '/a' }], snapshot: 'none' });
  const planned = await rpc('plan.run', {
    tab,
    goal: 'Latency walk',
    visionWhenNeeded: false,
    steps: [
      { action: 'click', target: '#to-b', waitNav: true, expect: { title: 'Beta' } },
      { action: 'click', target: '#to-c', waitNav: true, expect: { title: 'Gamma' } },
      { action: 'wait', ms: 50, expect: { title: 'Gamma' } },
    ],
  });
  assert.equal(planned.ok, true);
  const planMs = planned.results.map((r) => r.runMs + r.confirm.ms);
  const baseMs = unplanned.map((r) => r.ms);
  const saved = baseMs.map((b, i) => b - planMs[i]);
  const report = { unplannedMs: baseMs, plannedMs: planMs, savedMs: saved, confirmMs: planned.results.map((r) => r.confirm.ms) };
  console.log('plan-latency-local ' + JSON.stringify(report));
  const meanConfirm = report.confirmMs.reduce((a, b) => a + b, 0) / report.confirmMs.length;
  const meanUnplanned = baseMs.reduce((a, b) => a + b, 0) / baseMs.length;
  // The confirm itself must stay cheaper than a full click+snapshot step on this tiny fixture.
  assert.ok(meanConfirm < meanUnplanned, 'confirm ' + meanConfirm + 'ms should be under unplanned step ' + meanUnplanned + 'ms');
});
