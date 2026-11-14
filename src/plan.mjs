// Preemptive navigation: the agent files a short plan (next ~3 moves) with expected
// state after each step. After a step runs, a cheap confirm (URL/title, visibility,
// short accessibility snapshot) is compared to that expectation. A match means the
// next planned move runs immediately, without a full page re-analysis. A miss returns
// a re-plan event with the confirmed state so the remaining plan can be adjusted.
import { createHash } from 'node:crypto';

export function matchPattern(actual, pattern) {
  if (pattern == null || pattern === '') return { ok: true, skipped: true };
  const got = String(actual ?? '');
  const p = String(pattern);
  if (p.length >= 2 && p.startsWith('/') && p.lastIndexOf('/') > 0) {
    const last = p.lastIndexOf('/');
    try {
      const re = new RegExp(p.slice(1, last), p.slice(last + 1));
      return { ok: re.test(got), kind: 'regex' };
    } catch {
      return { ok: got.toLowerCase().includes(p.toLowerCase()), kind: 'substr' };
    }
  }
  if (p.startsWith('^') || p.endsWith('$')) {
    try { return { ok: new RegExp(p, 'i').test(got), kind: 'regex' }; }
    catch { /* fall through */ }
  }
  return { ok: got.toLowerCase().includes(p.toLowerCase()), kind: 'substr' };
}

function stepAction(step = {}) {
  const { expect, label, ...action } = step;
  return action;
}

export function publicPlan(plan) {
  if (!plan) return null;
  return {
    id: plan.id,
    goal: plan.goal || '',
    tab: plan.tab || null,
    index: plan.index,
    status: plan.status,
    steps: (plan.steps || []).map((s, i) => ({
      i,
      label: s.label || s.action || 'step',
      action: s.action,
      target: s.target,
      url: s.url,
      expect: s.expect || null,
      status: s.status || (i < plan.index ? 'done' : i === plan.index && plan.status === 'running' ? 'current' : 'pending'),
      confirm: s.confirm ? {
        matched: s.confirm.matched,
        usedVision: !!s.confirm.usedVision,
        ms: s.confirm.ms,
        method: s.confirm.method,
        failed: s.confirm.failed || null,
      } : null,
    })),
    lastEvent: plan.lastEvent || null,
    savedMs: plan.savedMs || 0,
  };
}

async function cheapState(engine, tab, expect = {}) {
  const t0 = performance.now();
  const methods = [];
  const st = { url: '', title: '', text: '', headings: '', snapshotLines: [], visible: null };
  const doc = await engine.docState(tab).catch(() => null);
  if (doc && doc[2]) st.url = String(doc[2]);
  // Title + a short text sample in one evaluate (cheaper than a full accessibility snapshot).
  try {
    const packed = await engine.evaluate(
      tab,
      `[location.href, document.title, (document.body && (document.body.innerText || document.body.textContent) || '').slice(0, 2000), Array.from(document.querySelectorAll('h1,h2,h3')).slice(0, 12).map((h) => (h.innerText || h.textContent || '').trim()).filter(Boolean).join(' | ')]`,
      { awaitPromise: false },
    );
    if (Array.isArray(packed)) {
      st.url = packed[0] || st.url;
      st.title = packed[1] || '';
      st.text = packed[2] || '';
      st.headings = packed[3] || '';
      methods.push('dom');
    }
  } catch (_) {
    methods.push('dom-miss');
  }
  if (expect.visible) {
    try {
      const info = await engine.helper(tab, 'waitFor', [expect.visible, 800, 'visible'], { retryUntil: Date.now() + 900 });
      st.visible = !!info;
      methods.push('visible');
    } catch (_) {
      st.visible = false;
      methods.push('visible');
    }
  }
  const needsSnap = !!(expect.snapshotIncludes || expect.heading || (expect.title && !st.title));
  if (needsSnap) {
    const snap = await engine.snapshot(tab, { mode: 'diff', max: 80, text: true });
    st.url = snap.url || st.url;
    st.title = snap.title || st.title;
    st.snapshotLines = snap.lines || snap.added || [];
    if (!st.headings) st.headings = st.snapshotLines.filter((l) => /^h\d/.test(l)).join(' | ');
    methods.push(snap.mode === 'diff' ? 'a11y-diff' : 'a11y');
  }
  st.ms = Math.round(performance.now() - t0);
  st.methods = methods;
  return st;
}

function checkExpect(st, expect = {}) {
  const failed = [];
  const check = (field, actual) => {
    if (expect[field] == null || expect[field] === '') return;
    const r = matchPattern(actual, expect[field]);
    if (!r.ok) failed.push({ field, expected: String(expect[field]), actual: String(actual ?? '').slice(0, 240) });
  };
  check('url', st.url);
  check('title', st.title);
  check('text', st.text);
  check('heading', st.headings || (st.snapshotLines || []).join('\n'));
  check('snapshotIncludes', (st.snapshotLines || []).join('\n') + '\n' + (st.title || '') + '\n' + (st.headings || ''));
  if (expect.visible && st.visible === false) {
    failed.push({ field: 'visible', expected: String(expect.visible), actual: 'not visible' });
  }
  return failed;
}

function shotHash(data) {
  if (!data) return null;
  return createHash('sha256').update(String(data).slice(0, 8000)).digest('hex').slice(0, 16);
}

async function visionConfirm(engine, tab, expect, cheapFailed, prevHash) {
  const t0 = performance.now();
  try {
    const shot = await engine.screenshot(tab, { format: 'jpeg', quality: 40, fullPage: false });
    const hash = shotHash(shot && shot.data);
    const notes = [];
    let ok = true;
    if (prevHash && expect.changed !== false && hash === prevHash) {
      // Screenshot unchanged is only a failure if cheap checks already missed and we expected a new screen.
      if (cheapFailed.length) { ok = false; notes.push('screenshot-unchanged'); }
    }
    if (!shot || !shot.data || String(shot.data).length < 80) {
      ok = false;
      notes.push('screenshot-empty');
    }
    return { ok, hash, notes, ms: Math.round(performance.now() - t0) };
  } catch (e) {
    return { ok: false, hash: null, notes: ['screenshot-failed'], ms: Math.round(performance.now() - t0), error: e.message };
  }
}

export async function confirmExpected(engine, tab, expect = {}, { visionWhenNeeded = true, prevShotHash = null } = {}) {
  const t0 = performance.now();
  const st = await cheapState(engine, tab, expect);
  let failed = checkExpect(st, expect);
  let usedVision = false;
  let vision = null;
  const inconclusive = failed.length > 0 && visionWhenNeeded && (expect.vision !== false);
  if (inconclusive) {
    usedVision = true;
    vision = await visionConfirm(engine, tab, expect, failed, prevShotHash);
    // Vision can only rescue an inconclusive visual change; it cannot invent a missing URL/title match.
    const hard = failed.filter((f) => f.field === 'url' || f.field === 'title' || f.field === 'visible');
    if (!hard.length && vision.ok) failed = [];
  }
  const matched = failed.length === 0;
  return {
    matched,
    usedVision,
    method: usedVision ? (st.methods || []).concat(['vision']).join('+') : (st.methods || []).join('+') || 'dom',
    ms: Math.round(performance.now() - t0),
    cheapMs: st.ms,
    visionMs: vision ? vision.ms : 0,
    failed: failed.length ? failed : null,
    state: { url: st.url, title: st.title, visible: st.visible, headings: st.headings },
    shotHash: vision ? vision.hash : null,
  };
}

function newId() {
  return 'plan_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

export class PlanHub {
  constructor() {
    this.byTab = new Map();
    this.current = null;
  }

  get(tab) {
    if (tab && this.byTab.has(String(tab))) return this.byTab.get(String(tab));
    return this.current;
  }

  set(input = {}) {
    const tab = input.tab != null ? String(input.tab) : null;
    const steps = (input.steps || []).map((s, i) => ({ ...s, i, status: 'pending', confirm: null }));
    const plan = {
      id: input.id || newId(),
      goal: input.goal || '',
      tab,
      index: 0,
      status: 'ready',
      steps,
      lastEvent: null,
      savedMs: 0,
      timings: [],
      shotHash: null,
    };
    if (tab) this.byTab.set(tab, plan);
    this.current = plan;
    return publicPlan(plan);
  }

  clear(tab) {
    const key = tab != null ? String(tab) : (this.current && this.current.tab);
    if (key) this.byTab.delete(String(key));
    if (this.current && (!key || this.current.tab === String(key))) this.current = null;
    return { ok: true };
  }

  public(tab) { return publicPlan(this.get(tab)); }

  adjust(tab, { steps, reason, fromIndex } = {}) {
    const plan = this.get(tab);
    if (!plan) throw new Error('No current plan to adjust');
    const start = fromIndex != null ? fromIndex : plan.index;
    const kept = plan.steps.slice(0, start);
    const next = (steps || []).map((s, i) => ({ ...s, i: start + i, status: 'pending', confirm: null }));
    plan.steps = kept.concat(next);
    plan.status = 'ready';
    plan.lastEvent = { event: 'replan', reason: reason || 'adjusted', at: Date.now(), remaining: next.length };
    return publicPlan(plan);
  }

  async confirm(engine, tab, expect, opts = {}) {
    const plan = this.get(tab);
    const ex = expect || (plan && plan.steps[Math.max(0, plan.index - 1)] && plan.steps[Math.max(0, plan.index - 1)].expect) || {};
    const result = await confirmExpected(engine, tab || (plan && plan.tab), ex, { ...opts, prevShotHash: plan && plan.shotHash });
    if (plan && result.shotHash) plan.shotHash = result.shotHash;
    return result;
  }

  /**
   * Run the plan: each step is executed with snapshot "none", then cheap-confirmed.
   * A match continues immediately. A miss stops and returns a re-plan event.
   * compareFullSnapshot, when provided as an async (tab) => ms-of-a-full-snapshot,
   * is used only to report what a no-plan path would have spent (not executed on the hot path).
   */
  async run(engine, runOn, ctx, input = {}) {
    const tab = String(input.tab || (this.current && this.current.tab) || '');
    if (input.steps) this.set({ ...input, tab });
    const plan = this.get(tab);
    if (!plan || !plan.steps.length) throw new Error('browser_plan needs steps');
    plan.tab = tab;
    plan.status = 'running';
    const autoConfirm = input.autoConfirm !== false;
    const visionWhenNeeded = input.visionWhenNeeded !== false;
    const startedAt = plan.index;
    const results = [];

    for (let i = startedAt; i < plan.steps.length; i++) {
      const step = plan.steps[i];
      plan.index = i;
      step.status = 'current';
      const t0 = performance.now();
      const action = stepAction(step);
      if (!action.action) throw new Error('plan step ' + i + ' needs an action');
      const ran = await runOn(ctx, { tab, steps: [action], snapshot: 'none' });
      const runMs = Math.round(performance.now() - t0);
      if (!ran.ok) {
        step.status = 'error';
        plan.status = 'failed';
        plan.lastEvent = { event: 'step-failed', index: i, error: ran.results?.[0]?.error || 'step failed' };
        return { ok: false, event: 'step-failed', plan: publicPlan(plan), run: ran, results };
      }
      let confirm = { matched: true, ms: 0, method: 'skipped', usedVision: false, state: null };
      if (autoConfirm) {
        confirm = await confirmExpected(engine, tab, step.expect || {}, { visionWhenNeeded, prevShotHash: plan.shotHash });
        if (confirm.shotHash) plan.shotHash = confirm.shotHash;
      }
      step.confirm = confirm;
      const fullWouldMs = input.fullSnapshotMs || 0;
      const saved = Math.max(0, fullWouldMs - confirm.ms);
      plan.timings.push({ i, runMs, confirmMs: confirm.ms, method: confirm.method, usedVision: !!confirm.usedVision, savedMs: saved });
      plan.savedMs += saved;
      results.push({ i, ok: true, runMs, confirm, savedMs: saved, run: ran.results?.[0] });
      if (!confirm.matched) {
        step.status = 'miss';
        plan.status = 'replan';
        plan.lastEvent = {
          event: 'replan',
          reason: 'expect-miss',
          index: i,
          failed: confirm.failed,
          confirmed: confirm.state,
          remaining: plan.steps.slice(i + 1).map((s) => stepAction(s)),
        };
        return { ok: false, event: 'replan', plan: publicPlan(plan), results, confirmed: confirm.state, failed: confirm.failed, remaining: plan.lastEvent.remaining };
      }
      step.status = 'done';
      plan.index = i + 1;
    }
    plan.status = 'done';
    plan.lastEvent = { event: 'done', at: Date.now() };
    return { ok: true, event: 'done', plan: publicPlan(plan), results, savedMs: plan.savedMs };
  }
}
