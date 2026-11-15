// Preemptive navigation: matcher unit tests, a local 3-page plan, confirm/replan, panel + MCP wiring, latency vs no plan.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Relay } from '../src/relay.mjs';
import { KeyStore } from '../src/keys.mjs';
import { matchPattern, publicPlan, PlanHub, pickBranch, checkExpect, compactDelta, presenceTarget } from '../src/plan.mjs';
import { TOOLS } from '../src/mcp-tools.mjs';

const pages = {
  '/a': '<!doctype html><title>Alpha</title><h1>Alpha</h1><p>Start here</p><a href="/b" id="to-b">Go to Beta</a>',
  '/b': '<!doctype html><title>Beta</title><h1>Beta</h1><p>Middle page</p><a href="/c" id="to-c">Go to Gamma</a>',
  '/c': '<!doctype html><title>Gamma</title><h1>Gamma</h1><p>All done</p><a href="/a" id="home">Back to Alpha</a>',
  '/gate': '<!doctype html><title>Gate</title><h1>Gate</h1><div id="cookie-banner"><p>We use cookies</p><button type="button" id="accept">Accept cookies</button></div><script>document.getElementById("accept").onclick=function(){document.getElementById("cookie-banner").remove();var a=document.createElement("a");a.href="/b";a.id="to-b";a.textContent="Go to Beta";document.body.appendChild(a);};</script>',
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
  const step = props.steps.items.properties;
  const expect = step.expect.properties;
  assert.ok(expect.url && expect.title && expect.visible);
  assert.ok(expect.path && expect.selector && expect.role && expect.name);
  assert.ok(step.branches);
  assert.match(tool.description, /no confirm model call/i);
  const snap = TOOLS.find((t) => t.name === 'browser_snapshot');
  assert.ok(snap.inputSchema.properties.mode.enum.includes('compact'));
});

test('checkExpect matches path and presence-free fields', () => {
  const st = { url: 'https://github.com/dProFoSho/luculent/actions', path: '/dProFoSho/luculent/actions', title: 'Actions', text: 'All workflows', headings: 'Actions', snapshotLines: ['link Actions'], visible: true, added: ['link Run workflow'], removed: [] };
  assert.deepEqual(checkExpect(st, { path: '/dProFoSho/luculent/actions', title: 'Actions' }), []);
  assert.equal(checkExpect(st, { path: '/settings' })[0].field, 'path');
  assert.equal(checkExpect(st, { url: '/github\\.com\\/.*\\/actions/' }).length, 0);
});

test('pickBranch selects the first when that matches and compactDelta stays small', () => {
  const st = { url: 'https://example.com/', path: '/', title: 'Home', visible: true, added: ['button Accept cookies'], removed: [] };
  const branches = [
    { id: 'login', when: { title: 'Sign in' }, steps: [{ action: 'click', target: '#login' }] },
    { id: 'cookies', when: { title: 'Home' }, steps: [{ action: 'click', target: '#accept' }, { action: 'click', target: '#next' }] },
  ];
  const hit = pickBranch(branches, st);
  assert.equal(hit.id, 'cookies');
  assert.equal(pickBranch(branches, { title: 'Other' }), null);
  const delta = compactDelta({ expect: { title: 'Beta' } }, { failed: [{ field: 'title', expected: 'Beta', actual: 'Home' }], state: st });
  assert.equal(delta.expected.title, 'Beta');
  assert.equal(delta.title, 'Home');
  assert.equal(delta.path, '/');
  assert.deepEqual(delta.added, ['button Accept cookies']);
  assert.ok(!('snapshotLines' in delta));
  assert.ok(!('text' in delta));
});

test('pickBranch does not treat unverified presence as a match', () => {
  const unverified = { title: 'Gate', path: '/gate', visible: null };
  assert.equal(pickBranch([{ id: 'cookies', when: { selector: '#accept' }, steps: [{ action: 'click', target: '#accept' }] }], unverified), null);
  assert.ok(checkExpect(unverified, { selector: '#accept' }).some((f) => f.actual === 'unverified'));
  const other = { title: 'Gate', visible: true, presentTarget: '#to-b' };
  assert.equal(pickBranch([{ id: 'cookies', when: { selector: '#accept' }, steps: [] }], other), null);
  const same = { title: 'Gate', visible: true, presentTarget: '#accept' };
  assert.equal(pickBranch([{ id: 'cookies', when: { selector: '#accept' }, steps: [] }], same).id, 'cookies');
  const missing = { title: 'Gate', visible: false, presentTarget: '#accept' };
  assert.equal(pickBranch([{ id: 'cookies', when: { selector: '#accept' }, steps: [] }], missing), null);
});

test('presenceTarget uses helper role[name] syntax and snapshot includes need text', () => {
  assert.equal(presenceTarget({ role: 'button', name: 'Run workflow' }), 'role=button[name="Run workflow"]');
  assert.equal(presenceTarget({ role: 'link' }), 'role=link');
  assert.equal(presenceTarget({ name: 'Accept cookies' }), 'text=Accept cookies');
  assert.equal(presenceTarget({ selector: '#accept' }), '#accept');
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

test('a missed hard expectation returns a re-plan event and adjust continues from confirmed state', async () => {
  await rpc('run', { tab, steps: [{ action: 'navigate', url: fx.origin + '/a' }], snapshot: 'none' });
  const miss = await rpc('plan.run', {
    tab,
    goal: 'Wrong expectation',
    visionWhenNeeded: false,
    steps: [
      { action: 'click', target: '#to-b', waitNav: true, expect: { title: 'This page does not exist', hard: true } },
      { action: 'click', target: '#to-c', waitNav: true, expect: { title: 'Gamma' } },
    ],
  });
  assert.equal(miss.ok, false);
  assert.equal(miss.event, 'replan');
  assert.ok(miss.failed && miss.failed.some((f) => f.field === 'title'));
  assert.match(miss.confirmed.title, /Beta/);
  assert.equal(miss.remaining.length, 1);
  assert.ok(miss.delta);
  assert.equal(miss.delta.expected.title, 'This page does not exist');
  assert.ok(Array.isArray(miss.framework) && miss.framework.length === 1);
  assert.ok(miss.delta.failed.some((f) => f.field === 'title'));
  assert.match(miss.delta.title, /Beta/);
  assert.equal(typeof miss.delta.path, 'string');
  assert.ok('added' in miss.delta && 'removed' in miss.delta);
  assert.equal(miss.delta.url.includes('/b'), true);
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

test('a matching cookie-banner branch continues without returning to the model', async () => {
  await rpc('run', { tab, steps: [{ action: 'navigate', url: fx.origin + '/gate' }], snapshot: 'none' });
  const plan = await rpc('plan.run', {
    tab,
    goal: 'Dismiss cookies then open Beta',
    visionWhenNeeded: false,
    steps: [
      {
        action: 'wait',
        ms: 20,
        label: 'Expect Beta or a cookie banner',
        expect: { title: 'Beta', path: '/b' },
        branches: [
          {
            id: 'cookies',
            when: { selector: '#accept' },
            steps: [
              { action: 'click', target: '#accept', expect: { visible: '#to-b' } },
              { action: 'click', target: '#to-b', waitNav: true, expect: { title: 'Beta', path: '/b' } },
            ],
          },
        ],
      },
    ],
  });
  assert.equal(plan.ok, true, plan.event + ' ' + JSON.stringify(plan.failed || plan.delta || ''));
  assert.equal(plan.event, 'done');
  assert.ok(plan.plan.steps.some((s) => s.status === 'branched' || (s.confirm && s.confirm.branch)));
  const text = (await rpc('run', { tab, steps: [{ action: 'extract', what: 'text' }], snapshot: 'none' })).results[0].value || '';
  assert.match(text, /Middle page|Beta/);
});

test('PlanHub pauses on take-back without a confirm model call', async () => {
  const hub = new PlanHub();
  let calls = 0;
  const runOn = async () => { calls += 1; return { ok: true, results: [{ ok: true }] }; };
  const engine = {
    docState: async () => [null, null, 'https://example.com/a'],
    evaluate: async () => ['https://example.com/a', 'Alpha', 'Start here', 'Alpha'],
  };
  const out = await hub.run(engine, runOn, {}, {
    tab: 't-take',
    visionWhenNeeded: false,
    shouldStop: () => calls >= 1,
    steps: [
      { action: 'wait', ms: 1, expect: { title: 'Alpha' } },
      { action: 'wait', ms: 1, expect: { title: 'Beta' } },
    ],
  });
  assert.equal(out.event, 'take-back');
  assert.equal(out.ok, false);
  assert.equal(calls, 1);
});
