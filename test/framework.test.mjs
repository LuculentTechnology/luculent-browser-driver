// Loose plan framework (T1289): intent + fuzzy hints + estimates, familiarity-scaled detail, code resolution.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { textSim, parseHint, parseLine, resolveTarget, findBlocker, assessFamiliarity, frameSteps, frameworkView, isStructuralTarget } from '../src/framework.mjs';
import { resolutionShare } from '../src/plan.mjs';
import { LocatorCache } from '../src/locators.mjs';
import { Relay } from '../src/relay.mjs';
import { KeyStore } from '../src/keys.mjs';
import { TOOLS } from '../src/mcp-tools.mjs';

const GH = [
  '[e1] link "Skip to content" ->#start-of-content',
  '[e2] link "Homepage" ->https://github.com/',
  '[e3] button "Search or jump to..."',
  '[e4] link "Sign in" ->/login',
  '[e5] link "Sign up" ->/signup',
  'h1 "microsoft/playwright-mcp"',
  '[e6] link "Code" ->/microsoft/playwright-mcp',
  '[e7] link "Issues 42" ->/microsoft/playwright-mcp/issues',
  '[e8] link "Pull requests 12" ->/microsoft/playwright-mcp/pulls',
  '[e9] link "README" ->#readme',
  '[e10] link "Releases 31" ->/microsoft/playwright-mcp/releases',
  '[e11] link "v0.0.85 Latest" ->/microsoft/playwright-mcp/releases/tag/v0.0.85',
  '[e12] link "Terms" ->https://docs.github.com/terms',
];

test('fuzzy text similarity and hint parsing', () => {
  assert.equal(textSim('Releases', 'releases'), 1);
  assert.ok(textSim('Releases 31', 'Releases') >= 0.7);
  assert.ok(textSim('Pull requests 12', 'open pull requests') > 0.3);
  assert.equal(textSim('Terms', 'Releases'), 0);
  assert.deepEqual(parseHint('text=Sign in'), { text: 'Sign in', confidence: 0.7 });
  assert.deepEqual(parseHint('role=link[name="Releases"]'), { role: 'link', text: 'Releases', confidence: 0.7 });
  assert.equal(parseHint('#to-b'), null, 'css is structural, not a fuzzy hint');
  assert.equal(isStructuralTarget('ref=e12'), true);
  assert.equal(isStructuralTarget('[e12]'), true);
  assert.equal(isStructuralTarget('text=Go'), false);
  assert.deepEqual(parseLine('[e10] link "Releases 31" ->/x/releases', 3), { ref: 'e10', role: 'link', name: 'Releases 31', href: '/x/releases', disabled: false, index: 3, line: '[e10] link "Releases 31" ->/x/releases' });
});

test('intent and hints resolve to a confident target in code; ambiguity is not forced', () => {
  const rel = resolveTarget(GH, { action: 'click', intent: 'open the releases list', hints: [{ text: 'Releases', role: 'link', confidence: 0.8 }] });
  assert.equal(rel.confident, true);
  assert.equal(rel.target, 'ref=e10');
  const latest = resolveTarget(GH, { action: 'click', intent: 'open the latest release tag' });
  assert.equal(latest.confident, true, JSON.stringify(latest.candidates));
  assert.ok(['ref=e11', 'ref=e10'].includes(latest.target));
  const login = resolveTarget(GH, { action: 'click', intent: 'sign in' });
  assert.equal(login.target, 'ref=e4');
  const vague = resolveTarget(GH, { action: 'click', intent: 'do the thing' });
  assert.equal(vague.confident, false);
  const typeSearch = resolveTarget(['[e1] link "Search docs" ->/s', '[e2] searchbox "Search"', '[e3] button "Search"'], { action: 'type', intent: 'search for playwright' });
  assert.equal(typeSearch.target, 'ref=e2', 'typing goes to a textbox, not the link or button');
});

test('cookie banners are found as blockers code can clear', () => {
  const lines = ['h2 "We value your privacy"', '[e1] button "Manage cookies"', '[e2] button "Accept all"', '[e3] link "Home" ->/'];
  assert.deepEqual(findBlocker(lines, {}), { kind: 'consent', target: 'ref=e2', name: 'Accept all' });
  assert.equal(findBlocker(['[e1] button "Accept all"'], {}), null, 'no cookie wording, not a blocker');
  assert.equal(findBlocker(['[e1] button "Close"'], { estimate: { blockers: ['newsletter modal'] } }).kind, 'modal');
});

test('familiarity: known from priors or cached locators, seen from this session, else new', () => {
  const priors = { sites: [{ domain: 'github.com', path: '/', flows: [{ goal: 'x', steps: [] }] }] };
  const loc = new LocatorCache(null);
  loc.put('https://news.ycombinator.com/', 'text=More', 'ref=e9');
  assert.equal(assessFamiliarity('github.com', { priors }), 'known');
  assert.equal(assessFamiliarity('ycombinator.com', { locators: loc }), 'known');
  assert.equal(assessFamiliarity('wikipedia.org', { seen: new Set(['wikipedia.org']) }), 'seen');
  assert.equal(assessFamiliarity('never-seen.example', {}), 'new');
});

test('steps on a never-seen site stay at intent level: selectors, refs and positions are dropped', () => {
  const steps = frameSteps([
    { action: 'navigate', url: 'https://brand-new.example/start', intent: 'open the site' },
    { action: 'click', target: '#main > div:nth-child(3) a', x: 120, y: 340, intent: 'open the first result', estimate: { pageType: 'results', next: ['read title'], blockers: ['cookie banner'] } },
    { action: 'click', target: 'text=Next page', label: 'go to page 2' },
    { action: 'navigate', url: 'https://known.example/' },
    { action: 'click', target: '#exact', intent: 'open settings' },
  ], { priors: { sites: [{ domain: 'known.example', path: '/', flows: [{ steps: [] }] }] } });
  assert.equal(steps[1].familiarity, 'new');
  assert.equal(steps[1].target, undefined);
  assert.equal(steps[1].x, undefined);
  assert.deepEqual(Object.keys(steps[1].dropped).sort(), ['target', 'x', 'y']);
  assert.equal(steps[2].hints[0].text, 'Next page', 'a semantic target becomes a fuzzy hint');
  assert.equal(steps[2].intent, 'go to page 2');
  assert.equal(steps[4].familiarity, 'known');
  assert.equal(steps[4].target, '#exact', 'concrete targets only where there is real knowledge');
  const fw = frameworkView(steps, 1);
  assert.equal(fw[0].familiarity, 'new');
  assert.equal(fw[0].estimate.pageType, 'results');
  assert.equal(frameSteps([{ action: 'click', target: '#a', familiarity: 'new' }], { startUrl: 'https://k.example/', seen: new Set(['k.example']) })[0].familiarity, 'new', 'the model can only lower familiarity');
});

test('resolution share counts code vs model', () => {
  assert.deepEqual(resolutionShare({ given: 2, code: 5, userDone: 1, model: 2 }), { byCode: 8, byModel: 2, codeShare: 0.8 });
  assert.deepEqual(resolutionShare({}), { byCode: 0, byModel: 0, codeShare: 1 });
});

test('browser_plan schema documents intent, hints, estimate, familiarity and hard expects', () => {
  const plan = TOOLS.find((t) => t.name === 'browser_plan');
  const props = plan.inputSchema.properties.steps.items.properties;
  for (const k of ['intent', 'hints', 'estimate', 'familiarity']) assert.ok(props[k], k);
  assert.ok(props.expect.properties.hard);
  assert.match(plan.description, /framework/);
  assert.match(plan.description, /event=adapt/);
});

// Live: intent-only plan on local pages, run through the relay with headless Chrome.
const pages = {
  '/a': '<!doctype html><title>Alpha</title><h1>Alpha</h1><nav><a href="/x">Pricing</a><a href="/x">Docs</a></nav><main><p>Start here</p><a href="/b" id="to-b">Go to Beta</a></main>',
  '/b': '<!doctype html><title>Beta</title><h1>Beta</h1><div id="cookies"><p>We use cookies to improve this site.</p><button onclick="document.getElementById(\'cookies\').remove();var a=document.createElement(\'a\');a.href=\'/c\';a.textContent=\'Continue to Gamma\';document.body.appendChild(a)">Accept all</button></div>',
  '/c': '<!doctype html><title>Gamma</title><h1>Gamma</h1><p>All done</p><a href="/a">Back to Alpha</a><a href="/a">Back to start</a>',
};
let fx, relay, tab, ctx;
const rpc = (m, p) => relay.call(m, p, ctx);
before(async () => {
  const server = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(pages[(req.url || '/').split('?')[0]] || pages['/a']); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  fx = { origin: 'http://127.0.0.1:' + server.address().port, close: () => new Promise((r) => server.close(r)) };
  relay = await new Relay({ port: 0, keys: new KeyStore(mkdtempSync(join(tmpdir(), 'lbd-fw-'))), log: () => {} }).start();
  ctx = { admin: true, key: { id: 'fw', name: 'fw', scopes: ['read', 'act', 'tabs', 'headless'] }, sid: 'fw' };
  tab = (await rpc('headless.launch', {})).tab;
});
after(async () => { try { await relay.stop(); } catch (_) {} try { await fx.close(); } catch (_) {} });

test('live: an intent-level plan on a never-seen site resolves every target in code, clears a cookie banner, no model call', async () => {
  const out = await rpc('plan.run', {
    tab,
    goal: 'Alpha to Gamma by intent only',
    steps: [
      { action: 'navigate', url: fx.origin + '/a', intent: 'open the start page', expect: { title: 'Alpha' } },
      { action: 'click', intent: 'go to beta', waitNav: true, estimate: { pageType: 'content', blockers: ['cookie banner'] }, expect: { title: 'Beta' } },
      { action: 'click', intent: 'continue to gamma', hints: ['Continue'], waitNav: true, expect: { title: 'Gamma', heading: 'Gamma' } },
    ],
  });
  assert.equal(out.ok, true, out.event + ' ' + JSON.stringify(out.delta || out.run || ''));
  assert.equal(out.event, 'done');
  assert.equal(out.plan.steps[1].familiarity, 'new');
  assert.equal(out.stats.model, 0);
  assert.ok(out.stats.code >= 2, JSON.stringify(out.stats));
  assert.equal(out.stats.blockers, 1, 'cookie banner cleared in code');
  assert.equal(out.resolution.codeShare, 1);
});

test('live: soft misses keep going; an unresolvable intent returns adapt with candidates and the framework', async () => {
  await rpc('run', { tab, steps: [{ action: 'navigate', url: fx.origin + '/c' }], snapshot: 'none' });
  const soft = await rpc('plan.run', { tab, steps: [
    { action: 'wait', ms: 10, intent: 'look around', expect: { title: 'Not this title' } },
    { action: 'click', intent: 'go back to alpha', hints: ['Back to Alpha'], waitNav: true, expect: { title: 'Alpha' } },
  ] });
  assert.equal(soft.event, 'done', JSON.stringify(soft.delta || ''));
  assert.equal(soft.plan.steps[0].status, 'partial');
  assert.equal(soft.stats.soft, 1);
  const adapt = await rpc('plan.run', { tab, steps: [
    { action: 'click', intent: 'download the quarterly invoice', estimate: { pageType: 'billing' } },
    { action: 'extract', intent: 'read the total' },
  ] });
  assert.equal(adapt.ok, false);
  assert.equal(adapt.event, 'adapt');
  assert.equal(adapt.delta.intent, 'download the quarterly invoice');
  assert.ok(Array.isArray(adapt.delta.candidates));
  assert.equal(adapt.framework.length, 2);
  assert.equal(adapt.stats.model, 1);
  const fixed = await rpc('plan.adjust', { tab, steps: [{ action: 'click', target: 'text=Go to Beta', waitNav: true }] });
  assert.equal(fixed.plan.status, 'ready');
  const cont = await rpc('plan.run', { tab });
  assert.equal(cont.ok, true, JSON.stringify(cont.delta || cont.run || ''));
});

test('a coordinate-only step on a new site keeps its coordinates (nothing else could find the element)', () => {
  const [a, b] = frameSteps([{ action: 'click', x: 120, y: 340 }, { action: 'click', x: 5, y: 6, intent: 'open the menu' }], { startUrl: 'https://never-seen.example/' });
  assert.equal(a.familiarity, 'new');
  assert.equal(a.x, 120);
  assert.equal(a.y, 340);
  assert.equal(b.x, undefined);
  assert.deepEqual(b.dropped, { x: 5, y: 6 });
});
