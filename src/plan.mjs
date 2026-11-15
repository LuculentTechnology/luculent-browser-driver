// Preemptive navigation: the model files a plan once, with machine-checkable expected
// outcomes and alternate branches for likely variants (cookie banner, login wall, A/B,
// modal). After each action the driver checks expectations in code (zero tokens, cheap
// DOM/diff, target <20ms) and immediately runs the next step or a matching branch.
// Only when no branch matches does control return to the model, with a compact delta.
// There are no per-step confirm model calls and no full re-snapshot on the hot path.
import { createHash } from 'node:crypto';
import { TARGET_ACTIONS, resolveTarget, findBlocker, frameworkView, intentOf } from './framework.mjs';

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
  const { expect, label, branches, when, branchId, intent, hints, estimate, familiarity, host, looseTarget, dropped, resolvedBy, resolved, i, status, confirm, ...action } = step;
  return action;
}

/** First branch whose `when` matches the current cheap state (all fields optional). */
export function pickBranch(branches, state) {
  for (const b of branches || []) {
    if (!b) continue;
    const failed = checkExpect(state, b.when || {});
    if (!failed.length) return b;
  }
  return null;
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
      branches: Array.isArray(s.branches) ? s.branches.map((b, bi) => ({
        i: bi,
        id: b.id || b.label || ('branch-' + bi),
        when: b.when || null,
        steps: (b.steps || []).length,
      })) : undefined,
      intent: s.intent || undefined,
      familiarity: s.familiarity || undefined,
      resolvedBy: s.resolvedBy || undefined,
      dropped: s.dropped ? Object.keys(s.dropped) : undefined,
      status: s.status || (i < plan.index ? 'done' : i === plan.index && plan.status === 'running' ? 'current' : 'pending'),
      confirm: s.confirm ? {
        matched: s.confirm.matched,
        usedVision: !!s.confirm.usedVision,
        ms: s.confirm.ms,
        method: s.confirm.method,
        failed: s.confirm.failed || null,
        branch: s.confirm.branch || null,
      } : null,
    })),
    lastEvent: plan.lastEvent || null,
    savedMs: plan.savedMs || 0,
    stats: plan.stats || null,
  };
}

async function presence(engine, tab, target) {
  if (target == null || target === '') return null;
  try {
    const info = await engine.helper(tab, 'exists', [target]);
    return info || null;
  } catch (_) {
    return null;
  }
}

export function presenceTarget(expect = {}) {
  if (expect.visible) return expect.visible;
  if (expect.selector) return expect.selector;
  if (expect.target) return expect.target;
  if (expect.role || expect.name) {
    const name = expect.name != null && expect.name !== '' ? String(expect.name).replace(/"/g, '') : '';
    if (expect.role && name) return 'role=' + expect.role + '[name="' + name + '"]';
    if (expect.role) return 'role=' + expect.role;
    return 'text=' + name;
  }
  return null;
}

async function cheapState(engine, tab, expect = {}) {
  const t0 = performance.now();
  const methods = [];
  const st = { url: '', path: '', title: '', text: '', headings: '', snapshotLines: [], visible: null, added: [], removed: [], present: null };
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
  try { st.path = st.url ? new URL(st.url).pathname : ''; } catch (_) { st.path = ''; }
  const target = presenceTarget(expect);
  if (target) {
    const info = await presence(engine, tab, target);
    st.present = !!info;
    st.visible = !!info;
    st.presentTarget = target;
    if (info) { st.role = info.role; st.name = info.name; st.ref = info.ref; }
    methods.push('exists');
  }
  const needsSnap = !!(expect.snapshotIncludes || expect.diff || expect.heading || (expect.title && !st.title));
  if (needsSnap) {
    const wantText = !!(expect.snapshotIncludes || expect.diff || expect.heading);
    const snap = await engine.snapshot(tab, { mode: 'diff', max: 80, text: wantText, interactive: !wantText, updateBaseline: false });
    st.url = snap.url || st.url;
    st.title = snap.title || st.title;
    try { if (st.url) st.path = new URL(st.url).pathname; } catch (_) {}
    st.snapshotLines = snap.lines || snap.added || [];
    st.added = snap.added || [];
    st.removed = snap.removed || [];
    if (!st.headings) st.headings = st.snapshotLines.filter((l) => /^h\d/.test(l)).join(' | ');
    methods.push(snap.mode === 'diff' ? 'a11y-diff' : 'a11y');
  }
  st.ms = Math.round(performance.now() - t0);
  st.methods = methods;
  return st;
}

export function checkExpect(st, expect = {}) {
  const failed = [];
  const check = (field, actual) => {
    if (expect[field] == null || expect[field] === '') return;
    const r = matchPattern(actual, expect[field]);
    if (!r.ok) failed.push({ field, expected: String(expect[field]), actual: String(actual ?? '').slice(0, 240) });
  };
  check('url', st.url);
  check('path', st.path);
  check('title', st.title);
  check('text', st.text);
  check('heading', st.headings || (st.snapshotLines || []).join('\n'));
  check('snapshotIncludes', (st.snapshotLines || []).join('\n') + '\n' + (st.title || '') + '\n' + (st.headings || ''));
  if (expect.diff) {
    const blob = (st.added || []).join('\n');
    if (expect.diff.added) check('diff.added', blob);
    if (expect.diff.includes) {
      const r = matchPattern((st.added || []).concat(st.snapshotLines || []).join('\n'), expect.diff.includes);
      if (!r.ok) failed.push({ field: 'diff', expected: String(expect.diff.includes), actual: blob.slice(0, 240) });
    }
  }
  const needsPresence = !!(expect.visible || expect.selector || expect.target || expect.role || expect.name);
  if (needsPresence) {
    const wanted = presenceTarget(expect);
    // visible === null means this state never queried that target (e.g. a branch.when
    // checked against the parent step's cheap state). Do not treat that as a match.
    const verified = st.visible === true && st.presentTarget != null && String(st.presentTarget) === String(wanted);
    if (!verified) {
      failed.push({
        field: expect.visible ? 'visible' : (expect.selector ? 'selector' : (expect.role || expect.name ? 'element' : 'target')),
        expected: String(wanted),
        actual: st.visible === true ? ('present: ' + (st.presentTarget || 'unknown')) : (st.visible === false ? 'not visible' : 'unverified'),
      });
    }
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

export async function confirmExpected(engine, tab, expect = {}, { visionWhenNeeded = false, prevShotHash = null, screenshot = false } = {}) {
  const t0 = performance.now();
  const st = await cheapState(engine, tab, expect);
  let failed = checkExpect(st, expect);
  let usedVision = false;
  let vision = null;
  // Screenshots are opt-in only. There is no confirm model call on this path.
  const wantShot = screenshot || expect.vision === true || (visionWhenNeeded && expect.vision === true);
  if (failed.length > 0 && wantShot) {
    usedVision = true;
    vision = await visionConfirm(engine, tab, expect, failed, prevShotHash);
    const hard = failed.filter((f) => f.field === 'url' || f.field === 'title' || f.field === 'visible' || f.field === 'text' || f.field === 'heading' || f.field === 'snapshotIncludes' || f.field === 'path' || f.field === 'selector' || f.field === 'element');
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
    state: { url: st.url, path: st.path, title: st.title, visible: st.visible, headings: st.headings, added: st.added, removed: st.removed },
    shotHash: vision ? vision.hash : null,
  };
}

export function compactDelta(step, confirm) {
  const st = (confirm && confirm.state) || {};
  return {
    expected: step && step.expect ? step.expect : {},
    failed: (confirm && confirm.failed) || [],
    url: st.url || '',
    path: st.path || '',
    title: st.title || '',
    added: st.added || [],
    removed: st.removed || [],
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
   * Run the plan as a loose framework. Each step: optional cowork gate (zero cost when the user did not
   * touch the tab), target resolution in code (given target if present on the live page, else intent and
   * hints scored against the live interactive snapshot), the action, then a soft code check of expect.
   * A soft miss is normal and the plan keeps going. Control returns to the model only when an intent
   * cannot be resolved with reasonable confidence (event=adapt) or a hard expect misses (event=replan).
   */
  async run(engine, runOn, ctx, input = {}) {
    const tab = String(input.tab || (this.current && this.current.tab) || '');
    if (input.steps) this.set({ ...input, tab });
    const plan = this.get(tab);
    if (!plan || !plan.steps.length) throw new Error('browser_plan needs steps');
    plan.tab = tab;
    plan.status = 'running';
    plan.stats = plan.stats || { given: 0, code: 0, model: 0, cowork: 0, userDone: 0, soft: 0, blockers: 0 };
    if (typeof input.frame === 'function') {
      try {
        const head = plan.steps.slice(0, plan.index);
        const tail = await input.frame(plan.steps.slice(plan.index), plan);
        if (Array.isArray(tail)) plan.steps = head.concat(tail.map((s, k) => ({ ...s, i: plan.index + k })));
      } catch (_) { /* framing is advisory */ }
    }
    const autoConfirm = input.autoConfirm !== false;
    const visionWhenNeeded = input.visionWhenNeeded === true;
    const results = [];
    const prefetch = typeof input.prefetch === 'function' ? input.prefetch : null;
    const finish = (extra = {}) => ({ plan: publicPlan(plan), results, stats: { ...plan.stats }, resolution: resolutionShare(plan.stats), ...extra });

    for (let i = plan.index; i < plan.steps.length; i++) {
      if (input.shouldStop && input.shouldStop()) {
        plan.status = 'paused';
        plan.lastEvent = { event: 'take-back', index: i, at: Date.now() };
        return { ok: false, event: 'take-back', ...finish() };
      }
      if (typeof input.beforeStep === 'function') {
        const g = await input.beforeStep(i, plan);
        if (g && g.stopped) {
          plan.status = 'paused';
          plan.lastEvent = { event: 'take-back', index: i, at: Date.now() };
          return { ok: false, event: 'take-back', ...finish() };
        }
        if (g && g.timeout) {
          plan.status = 'paused';
          plan.lastEvent = { event: 'paused', index: i, at: Date.now(), reason: 'waiting for you to press Resume' };
          return { ok: false, event: 'paused', ...finish() };
        }
        if (g && g.userStepped) {
          plan.stats.cowork += 1;
          const skipped = await this.skipDoneByUser(engine, tab, plan, i);
          const st = await cheapState(engine, tab, {}).catch(() => ({}));
          plan.lastEvent = { event: 'cowork', index: i, at: Date.now(), kinds: g.kinds, count: g.count, url: st.url, title: st.title, skipped };
          if (skipped > 0) { i += skipped - 1; plan.index = i + 1; if (plan.index >= plan.steps.length) break; continue; }
        }
      }
      const step = plan.steps[i];
      plan.index = i;
      step.status = 'current';
      const t0 = performance.now();
      let action = stepAction(step);
      if (!action.action) throw new Error('plan step ' + i + ' needs an action');
      if (TARGET_ACTIONS.has(String(action.action).toLowerCase())) {
        const r = await this.resolveStep(engine, tab, step, action, plan, (req) => runOn(ctx, req));
        if (r.adapt) {
          plan.stats.model += 1;
          step.status = 'unresolved';
          plan.status = 'adapt';
          const st = r.state || {};
          const delta = {
            intent: intentOf(step) || action.action,
            familiarity: step.familiarity || null,
            url: st.url || '', title: st.title || '',
            candidates: r.res ? r.res.candidates : [],
            best: r.res ? { score: r.res.score, line: r.res.line } : null,
            userStepped: !!(plan.lastEvent && plan.lastEvent.event === 'cowork' && plan.lastEvent.index === i),
          };
          plan.lastEvent = { event: 'adapt', reason: 'intent-unresolved', index: i, at: Date.now(), delta };
          return { ok: false, event: 'adapt', index: i, delta, framework: frameworkView(plan.steps, i), remaining: plan.steps.slice(i).map((s) => stepAction(s)), ...finish() };
        }
        action = r.action;
      }
      let ran = await runOn(ctx, { tab, steps: [action], snapshot: 'none' });
      if (!ran.ok && step.resolvedBy === 'given' && (step.intent || (step.hints && step.hints.length))) {
        // The given target was stale; resolve the intent on the live page once, in code.
        const again = await this.resolveStep(engine, tab, { ...step, target: undefined, looseTarget: undefined }, { ...action, target: undefined }, plan, (req) => runOn(ctx, req));
        if (!again.adapt) { action = again.action; step.resolvedBy = 'code'; plan.stats.given = Math.max(0, plan.stats.given - 1); ran = await runOn(ctx, { tab, steps: [action], snapshot: 'none' }); }
      }
      const runMs = Math.round(performance.now() - t0);
      if (!ran.ok) {
        step.status = 'error';
        plan.status = 'failed';
        plan.lastEvent = { event: 'step-failed', index: i, error: ran.results?.[0]?.error || 'step failed' };
        return { ok: false, event: 'step-failed', run: ran, ...finish() };
      }
      let confirm = { matched: true, ms: 0, method: 'skipped', usedVision: false, state: null };
      if (autoConfirm) {
        if (typeof input.checkUrl === 'function') {
          try {
            const st = await engine.docState(tab);
            const url = st && st[2];
            const why = url && input.checkUrl(url);
            if (why) {
              step.status = 'error';
              plan.status = 'failed';
              plan.lastEvent = { event: 'blocked', index: i, error: why };
              return { ok: false, event: 'blocked', denied: true, error: why, ...finish() };
            }
          } catch (err) {
            if (err && (err.denied || err.status === 403)) throw err;
          }
        }
        if (hasExpect(step.expect)) {
          confirm = await confirmExpected(engine, tab, step.expect || {}, { visionWhenNeeded, prevShotHash: plan.shotHash });
          if (confirm.shotHash) plan.shotHash = confirm.shotHash;
        }
      }
      step.confirm = confirm;
      const fullWouldMs = input.fullSnapshotMs || 0;
      const saved = Math.max(0, fullWouldMs - confirm.ms);
      plan.timings.push({ i, runMs, confirmMs: confirm.ms, method: confirm.method, usedVision: !!confirm.usedVision, savedMs: saved, resolvedBy: step.resolvedBy || null });
      plan.savedMs += saved;
      results.push({ i, ok: true, runMs, confirm, savedMs: saved, run: ran.results?.[0], resolvedBy: step.resolvedBy || null, familiarity: step.familiarity || null });
      if (!confirm.matched) {
        let taken = pickBranch(step.branches, confirm.state || {});
        if (!taken && step.branches && step.branches.length) {
          for (const b of step.branches) {
            const when = b && b.when;
            if (!when) { taken = b; break; }
            const wst = await cheapState(engine, tab, when);
            if (!checkExpect(wst, when).length) { taken = b; confirm.state = { ...confirm.state, ...wst }; break; }
          }
        }
        if (taken && Array.isArray(taken.steps) && taken.steps.length) {
          const start = i + 1;
          let injected = taken.steps.map((s, k) => ({ ...s, i: start + k, status: 'pending', confirm: null, branchId: taken.id || taken.label || 'branch' }));
          if (typeof input.frame === 'function') { try { const f = await input.frame(injected, plan); if (Array.isArray(f)) injected = f.map((s, k) => ({ ...s, i: start + k })); } catch (_) {} }
          const rest = plan.steps.slice(start).map((s, k) => ({ ...s, i: start + injected.length + k }));
          plan.steps = plan.steps.slice(0, start).concat(injected, rest);
          step.status = 'branched';
          confirm.branch = taken.id || taken.label || 'branch';
          step.confirm = confirm;
          plan.index = start;
          if (prefetch) {
            const nxt = plan.steps[start];
            if (nxt && nxt.target) prefetch(tab, nxt).catch(() => {});
          }
          continue;
        }
        if (step.expect && step.expect.hard === true) {
          step.status = 'miss';
          plan.status = 'replan';
          const delta = compactDelta(step, confirm);
          plan.lastEvent = {
            event: 'replan', reason: 'expect-miss', index: i, failed: confirm.failed, confirmed: confirm.state, delta,
            remaining: plan.steps.slice(i + 1).map((s) => stepAction(s)),
          };
          return { ok: false, event: 'replan', confirmed: confirm.state, failed: confirm.failed, delta, remaining: plan.lastEvent.remaining, framework: frameworkView(plan.steps, i + 1), ...finish() };
        }
        // Soft miss: the page rarely matches a plan exactly. Keep going; the next intent is resolved on the live page.
        step.status = 'partial';
        plan.stats.soft += 1;
        plan.index = i + 1;
        continue;
      }
      step.status = 'done';
      plan.index = i + 1;
      if (prefetch) {
        const nxt = plan.steps[plan.index];
        if (nxt && nxt.target) prefetch(tab, nxt).catch(() => {});
      }
    }
    plan.status = 'done';
    plan.index = plan.steps.length;
    plan.lastEvent = { event: 'done', at: Date.now() };
    return { ok: true, event: 'done', savedMs: plan.savedMs, ...finish() };
  }

  /** After the user stepped in: mark steps whose outcome already exists on the live page as done by you. */
  async skipDoneByUser(engine, tab, plan, i) {
    let furthest = -1;
    const end = Math.min(plan.steps.length, i + 3);
    for (let k = i; k < end; k++) {
      const s = plan.steps[k];
      if (!hasExpect(s.expect)) continue;
      const c = await confirmExpected(engine, tab, s.expect, {}).catch(() => null);
      if (c && c.matched) furthest = k;
    }
    if (furthest < i) return 0;
    for (let k = i; k <= furthest; k++) { plan.steps[k].status = 'user'; plan.steps[k].resolvedBy = 'user'; }
    plan.stats.userDone += furthest - i + 1;
    return furthest - i + 1;
  }

  /** Resolve a step's target in code. Never calls the model. */
  async resolveStep(engine, tab, step, action, plan, run) {
    const hasIntent = !!(step.intent || (step.hints && step.hints.length));
    const given = action.target;
    if (given != null && given !== '' && (step.familiarity !== 'new' || !hasIntent)) {
      const hit = await presence(engine, tab, given);
      if (hit || !hasIntent) { step.resolvedBy = 'given'; plan.stats.given += 1; return { action }; }
    }
    if (!hasIntent && !step.looseTarget) { step.resolvedBy = 'given'; plan.stats.given += 1; return { action }; }
    let res = null, state = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      const snap = await engine.snapshot(tab, { mode: 'compact', interactive: true, max: 300, updateBaseline: false }).catch(() => null);
      const lines = (snap && snap.lines) || [];
      state = { url: snap && snap.url, title: snap && snap.title };
      res = resolveTarget(lines, step);
      if (res.confident) {
        step.resolvedBy = 'code';
        step.resolved = { target: res.target, score: res.score, line: res.line };
        plan.stats.code += 1;
        const next = { ...action, target: res.target };
        // A resolved link to another page: wait for that navigation so the next intent sees the new page.
        if (next.waitNav == null && String(action.action).toLowerCase() === 'click' && res.role === 'link' && res.href && !/^(#|javascript:)/i.test(res.href)) next.waitNav = true;
        return { action: next };
      }
      if (step.looseTarget) {
        const hit = await presence(engine, tab, step.looseTarget);
        if (hit) {
          step.resolvedBy = 'code';
          step.resolved = { target: step.looseTarget, via: 'live-check' };
          plan.stats.code += 1;
          return { action: { ...action, target: step.looseTarget } };
        }
      }
      let cookieHint = false;
      if (attempt < 2) {
        try { cookieHint = !!(await engine.evaluate(tab, COOKIE_PROBE, { awaitPromise: false })); } catch (_) {}
      }
      const blocker = attempt < 2 ? findBlocker(lines, step, { cookieHint }) : null;
      if (blocker && typeof run === 'function') {
        const r = await run({ tab, steps: [{ action: 'click', target: blocker.target }], snapshot: 'none' }).catch(() => null);
        if (r && r.ok) { plan.stats.blockers += 1; continue; }
      }
      if (attempt === 0 && typeof engine.settle === 'function') { await engine.settle(tab).catch(() => {}); continue; }
      break;
    }
    return { adapt: true, res, state };
  }
}

const COOKIE_PROBE = "(() => { const q = '[id*=cookie i],[class*=cookie i],[id*=consent i],[class*=consent i],[aria-label*=cookie i],[aria-label*=consent i]'; if (document.querySelector(q)) return true; const t = (document.body && document.body.innerText) || ''; return /cookie|consent/i.test(t.slice(0, 3000) + t.slice(-3000)); })()";

function hasExpect(ex) {
  if (!ex || typeof ex !== 'object') return false;
  return Object.keys(ex).some((k) => k !== 'hard' && k !== 'vision' && ex[k] != null && ex[k] !== '');
}

export function resolutionShare(stats = {}) {
  const code = (stats.given || 0) + (stats.code || 0) + (stats.userDone || 0);
  const model = stats.model || 0;
  const total = code + model;
  return { byCode: code, byModel: model, codeShare: total ? Math.round((code / total) * 1000) / 1000 : 1 };
}
