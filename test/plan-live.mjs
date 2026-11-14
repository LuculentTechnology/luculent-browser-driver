// Live preemptive-navigation checks on real sites: correctness of planned confirms and latency vs no plan.
// Usage: node test/plan-live.mjs
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Relay } from '../src/relay.mjs';
import { KeyStore } from '../src/keys.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const BOT = /just a moment|are you a robot|unusual traffic|access denied|enable javascript and cookies/i;

const SITES = [
  {
    id: 'wikipedia-ada',
    start: 'https://en.wikipedia.org/wiki/Ada_Lovelace',
    steps: [
      { action: 'click', target: 'text=Charles Babbage', waitNav: true, label: 'Open Babbage', expect: { url: 'Charles_Babbage', title: 'Babbage' } },
      { action: 'click', target: 'text=Analytical Engine', waitNav: true, label: 'Open Analytical Engine', expect: { url: 'Analytical_Engine', title: 'Analytical Engine' } },
      { action: 'click', target: 'text=Ada Lovelace', waitNav: true, label: 'Return to Ada', expect: { url: 'Ada_Lovelace', title: 'Ada Lovelace' } },
    ],
  },
  {
    id: 'mdn-fetch',
    start: 'https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API',
    steps: [
      { action: 'click', target: 'text=Using the Fetch API', waitNav: true, label: 'Open Using Fetch', expect: { url: '/Using_Fetch|Using_the_Fetch_API/', title: 'Using' } },
      { action: 'click', target: 'text=Fetch API', waitNav: true, label: 'Back to Fetch API', expect: { url: 'Fetch_API', title: 'Fetch' } },
      { action: 'wait', ms: 200, label: 'Settle', expect: { title: 'Fetch' } },
    ],
  },
  {
    id: 'hn-more',
    start: 'https://news.ycombinator.com/',
    steps: [
      { action: 'click', target: 'text=new', waitNav: true, label: 'Open newest', expect: { url: 'newest', title: 'Hacker News' } },
      { action: 'click', target: 'text=past', waitNav: true, label: 'Open past', expect: { url: 'front', title: 'Hacker News' } },
      { action: 'click', target: 'text=new', waitNav: true, label: 'Newest again', expect: { title: 'Hacker News' } },
    ],
  },
];

const keys = new KeyStore(mkdtempSync(join(tmpdir(), 'lbd-plan-live-')));
const relay = await new Relay({ port: 0, keys, log: () => {} }).start();
const ctx = { admin: true, key: { id: 'plan-live', name: 'plan-live', scopes: ['read', 'act', 'tabs', 'headless'] }, sid: 'plan-live' };
const rpc = (m, p) => relay.call(m, p, ctx);
const tab = (await rpc('headless.launch', {})).tab;

function blocked(title, url) {
  return BOT.test(title || '') || BOT.test(url || '');
}

const results = [];
for (const site of SITES) {
  const rec = { id: site.id, status: 'pass' };
  const tAll = performance.now();
  try {
    await rpc('run', { tab, steps: [{ action: 'navigate', url: site.start, timeout: 25000 }, { action: 'wait', for: 'load', timeout: 15000, optional: true }], snapshot: 'none' });
    await sleep(800);
    const first = await rpc('run', { tab, steps: [{ action: 'extract', what: 'text' }], snapshot: 'none' });
    const title0 = first.results?.[0]?.value || '';
    if (blocked(title0, site.start)) throw Object.assign(new Error('bot wall on start'), { blocked: true });

    // Unplanned baseline: same actions with a full snapshot after each step.
    const unplanned = [];
    await rpc('run', { tab, steps: [{ action: 'navigate', url: site.start, timeout: 25000 }, { action: 'wait', for: 'load', timeout: 15000, optional: true }], snapshot: 'none' });
    await sleep(600);
    for (const step of site.steps) {
      const t0 = performance.now();
      const r = await rpc('run', { tab, steps: [{ ...step }], snapshot: 'full' });
      unplanned.push({ ok: r.ok, ms: Math.round(performance.now() - t0), error: r.ok ? null : r.results?.[0]?.error });
      if (!r.ok) break;
    }

    await rpc('run', { tab, steps: [{ action: 'navigate', url: site.start, timeout: 25000 }, { action: 'wait', for: 'load', timeout: 15000, optional: true }], snapshot: 'none' });
    await sleep(600);
    const planned = await rpc('plan.run', { tab, goal: site.id, visionWhenNeeded: true, steps: site.steps });
    if (planned.event === 'replan' && planned.confirmed && blocked(planned.confirmed.title, planned.confirmed.url)) {
      throw Object.assign(new Error('bot wall mid-plan'), { blocked: true });
    }
    rec.plannedOk = !!planned.ok;
    rec.event = planned.event;
    rec.confirmMs = (planned.results || []).map((r) => r.confirm?.ms);
    rec.plannedStepMs = (planned.results || []).map((r) => r.runMs + (r.confirm?.ms || 0));
    rec.unplannedStepMs = unplanned.map((r) => r.ms);
    rec.savedMs = rec.unplannedStepMs.map((b, i) => (rec.plannedStepMs[i] != null ? b - rec.plannedStepMs[i] : null));
    rec.usedVision = (planned.results || []).map((r) => !!r.confirm?.usedVision);
    rec.methods = (planned.results || []).map((r) => r.confirm?.method);
    rec.finalTitle = planned.plan?.steps?.slice(-1)[0]?.confirm ? planned.results?.[planned.results.length - 1]?.confirm?.state?.title : planned.confirmed?.title;
    if (!planned.ok && planned.event === 'replan') rec.status = 'fail';
    if (!planned.ok && planned.event === 'step-failed') rec.status = 'fail';
    rec.error = planned.event === 'replan' ? JSON.stringify(planned.failed || planned.event).slice(0, 240) : (planned.event !== 'done' ? planned.event : null);
  } catch (e) {
    rec.status = e.blocked ? 'blocked' : 'fail';
    rec.error = String(e.message || e).slice(0, 300);
  }
  rec.ms = Math.round(performance.now() - tAll);
  results.push(rec);
  console.error((rec.status.toUpperCase().padEnd(7)) + ' ' + rec.id + ' ' + rec.ms + 'ms' + (rec.savedMs ? ' saved=' + JSON.stringify(rec.savedMs) : '') + (rec.error ? ' :: ' + rec.error : ''));
}

await relay.stop().catch(() => {});
const summary = {
  total: results.length,
  pass: results.filter((r) => r.status === 'pass').length,
  fail: results.filter((r) => r.status === 'fail').length,
  blocked: results.filter((r) => r.status === 'blocked').length,
  results,
  at: new Date().toISOString(),
};
const outDir = 'D:\\Luculent\\ops\\state';
try { mkdirSync(outDir, { recursive: true }); writeFileSync(join(outDir, 'plan-live-results.json'), JSON.stringify(summary, null, 2)); } catch (_) {}
console.log(JSON.stringify(summary, null, 2));
if (summary.fail) process.exitCode = 1;
