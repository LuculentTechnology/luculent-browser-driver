// Loose plan framework (T1289). A plan is guidance for the next set of actions, not an exact script.
// Each step carries an intent, optional fuzzy target hints, and contextual estimates (likely page type,
// likely next actions, likely blockers). Detail scales with familiarity: on a site the driver has never
// seen (no priors, no cached locators, not visited) a step stays at intent level and its concrete
// selectors, refs and positions are dropped; the target is resolved in code against the live snapshot
// when the page arrives. Partial matches are normal. The model is asked only when an intent cannot be
// resolved with reasonable confidence, and then it gets a compact delta plus this framework to adapt.
import { etld1 } from './meta.mjs';

export const FAMILIARITY = ['new', 'seen', 'known'];
export const TARGET_ACTIONS = new Set(['click', 'dblclick', 'type', 'fill', 'select', 'hover', 'check', 'uncheck', 'focus', 'upload']);
export const CONFIDENT = 0.6;
export const MARGIN = 0.12;

const STRUCTURAL = /^(css=|xpath=|\/\/|[#.\[]|ref=|@?e\d+$|\[e\d+\]$|\d+\s*,\s*\d+$)/i;
const STOP = new Set('the a an to of on in for and or is it this that with my your from by at as be into click open go get tap press select then page button link field box enter type'.split(' '));

export const norm = (s) => String(s == null ? '' : s).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const words = (s) => norm(s).split(' ').filter((w) => w && w.length > 1 && !STOP.has(w));

export function hostOf(url) {
  try { return etld1(new URL(url).hostname); } catch (_) { return ''; }
}

/** 0..1 similarity between an element name and a hint or intent text. */
export function textSim(a, b) {
  const x = norm(a), y = norm(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  if (x.includes(y) || y.includes(x)) {
    const r = Math.min(x.length, y.length) / Math.max(x.length, y.length);
    return r >= 0.5 ? 0.9 : 0.72;
  }
  const A = new Set(words(a)), B = new Set(words(b));
  if (!A.size || !B.size) return 0;
  let n = 0;
  for (const w of A) if (B.has(w) || [...B].some((v) => v.length > 3 && w.length > 3 && (v.startsWith(w) || w.startsWith(v)))) n++;
  if (!n) return 0;
  return 0.7 * (n / Math.min(A.size, B.size)) * Math.pow(n / Math.max(A.size, B.size), 0.35);
}

export function isStructuralTarget(t) { return typeof t === 'string' && STRUCTURAL.test(t.trim()); }

/** Turn "text=Foo", 'role=link[name="Foo"]', a plain string or an object into a hint object. */
export function parseHint(h, confidence) {
  if (h == null) return null;
  if (typeof h === 'object') {
    const o = { role: h.role ? String(h.role).toLowerCase() : undefined, text: h.text != null ? String(h.text) : (h.name != null ? String(h.name) : undefined), landmark: h.landmark ? String(h.landmark).toLowerCase() : undefined, confidence: Number.isFinite(Number(h.confidence)) ? Math.max(0, Math.min(1, Number(h.confidence))) : (confidence ?? 0.7) };
    return o.role || o.text || o.landmark ? o : null;
  }
  const s = String(h).trim();
  if (!s) return null;
  let m = /^role=([a-z]+)(?:\[name="?([^"\]]*)"?\])?$/i.exec(s);
  if (m) return { role: m[1].toLowerCase(), text: m[2] || undefined, confidence: confidence ?? 0.7 };
  m = /^text=(.+)$/i.exec(s);
  if (m) return { text: m[1].replace(/^"|"$/g, ''), confidence: confidence ?? 0.7 };
  if (isStructuralTarget(s)) return null;
  return { text: s, confidence: confidence ?? 0.6 };
}

/** One interactive snapshot line: [e12] link "Name" ->/href */
export function parseLine(line, index = 0) {
  const m = /^\[(e\d+)\]\s+(\S+)\s+"([^"]*)"(.*)$/.exec(String(line || ''));
  if (!m) return null;
  const rest = m[4] || '';
  const href = (/->(\S+)/.exec(rest) || [])[1] || '';
  return { ref: m[1], role: m[2].toLowerCase(), name: m[3], href, disabled: /\bdisabled\b/.test(rest), index, line };
}

// Generic intents the code understands without a model call. Each maps intent words to roles and names.
export const INTENTS = [
  { id: 'search', re: /\b(search|find|look ?up|query)\b/i, typeRoles: ['searchbox', 'textbox', 'combobox', 'textarea'], clickRoles: ['button', 'link'], name: /\b(search|find|query|look ?up)\b|^q$|^go$/i },
  { id: 'login', re: /\b(sign ?in|log ?in|login)\b/i, clickRoles: ['link', 'button'], typeRoles: ['textbox'], name: /\b(sign ?in|log ?in|login|email|user ?name)\b/i },
  { id: 'consent', re: /\b(cookie|consent|accept|agree)\b/i, clickRoles: ['button', 'link'], name: /\b(accept|agree|allow|got it|i understand)\b|^ok$/i },
  { id: 'dismiss', re: /\b(close|dismiss|no thanks|not now)\b/i, clickRoles: ['button', 'link'], name: /^(close|dismiss|no thanks|not now|x|\u00d7|\u2715)$/i },
  { id: 'next', re: /\b(next|more|older|page \d|load more)\b/i, clickRoles: ['link', 'button'], name: /\b(next|more|older)\b|\u203a|\u00bb|\u2192/i },
  { id: 'release', re: /\b(release|tag|version|changelog)\b/i, clickRoles: ['link'], name: /\b(releases?|tags?|changelog)\b|^v?\d+\.\d+/i },
  { id: 'submit', re: /\b(submit|continue|send|save|confirm|apply)\b/i, clickRoles: ['button'], name: /\b(submit|continue|send|save|confirm|apply|next|search|go)\b/i },
  { id: 'cart', re: /\b(add to cart|basket|buy)\b/i, clickRoles: ['button'], name: /add to (cart|basket|bag)|buy/i },
];

const TYPE_ROLES = new Set(['textbox', 'searchbox', 'combobox', 'textarea', 'input', 'spinbutton']);
const CLICK_ROLES = new Set(['link', 'button', 'tab', 'menuitem', 'checkbox', 'radio', 'option', 'switch', 'treeitem', 'summary', 'combobox']);

export function intentOf(step = {}) {
  return String(step.intent || step.label || '').trim();
}

export function stepHints(step = {}) {
  const out = [];
  for (const h of [].concat(step.hints || [])) { const p = parseHint(h); if (p) out.push(p); }
  return out;
}

/** Score one candidate element for a step. 0..1. */
export function scoreCandidate(c, step = {}, total = 1) {
  const action = String(step.action || 'click').toLowerCase();
  const intent = intentOf(step);
  const hints = stepHints(step);
  let s = 0;
  for (const h of hints) {
    const w = h.confidence ?? 0.7;
    let part = 0;
    if (h.text) part += textSim(c.name, h.text) * 0.85;
    if (h.role && h.role === c.role) part += h.text ? 0.15 : 0.35;
    if (h.landmark) {
      const pos = total > 1 ? c.index / (total - 1) : 0;
      if (/header|nav|banner|top/.test(h.landmark) && pos < 0.3) part += 0.08;
      else if (/footer|bottom/.test(h.landmark) && pos > 0.75) part += 0.08;
      else if (/main|content|article|result/.test(h.landmark) && pos >= 0.15 && pos <= 0.85) part += 0.08;
    }
    s = Math.max(s, part * (0.55 + 0.45 * w));
  }
  if (intent) {
    // Intent words found in the element's name or link path separate close candidates ("latest release tag").
    const iw = words(intent);
    const cw = words(c.name + ' ' + String(c.href || '').replace(/[/_#?=&.-]+/g, ' '));
    let hits = 0;
    for (const w of iw) if (cw.some((v) => v === w || (v.length > 3 && w.length > 3 && (v.startsWith(w) || w.startsWith(v))))) hits++;
    const bonus = Math.min(0.36, 0.12 * hits);
    for (const it of INTENTS) {
      if (!it.re.test(intent)) continue;
      const roles = action === 'type' || action === 'fill' ? (it.typeRoles || []) : (it.clickRoles || []);
      let part = 0;
      if (roles.includes(c.role)) part += 0.25;
      if (it.name.test(c.name) || (c.href && it.name.test(c.href))) part += 0.45;
      s = Math.max(s, part ? part + bonus : 0);
    }
    s = Math.max(s, textSim(c.name, intent) * 0.75 + bonus * 0.5);
  }
  const typing = action === 'type' || action === 'fill';
  if (typing && !TYPE_ROLES.has(c.role)) s *= 0.15;
  if (!typing && action !== 'select' && !CLICK_ROLES.has(c.role) && !TYPE_ROLES.has(c.role)) s *= 0.5;
  if (action === 'select' && !/combobox|listbox|select/.test(c.role)) s *= 0.3;
  if (c.disabled) s *= 0.3;
  return Math.max(0, Math.min(1, s));
}

/** Resolve a step's intent/hints against live snapshot lines, in code. */
export function resolveTarget(lines, step = {}) {
  const cands = (lines || []).map((l, i) => parseLine(l, i)).filter(Boolean);
  const total = cands.length;
  const scored = cands.map((c) => ({ ...c, score: scoreCandidate(c, step, total) })).filter((c) => c.score > 0).sort((a, b) => b.score - a.score || a.index - b.index);
  const best = scored[0] || null;
  const second = scored[1] || null;
  const margin = best ? best.score - (second ? second.score : 0) : 0;
  const confident = !!best && best.score >= CONFIDENT && (margin >= MARGIN || best.score >= 0.85 || (second && second.name === best.name));
  return {
    confident,
    partial: !!best && best.score >= 0.35,
    target: best ? 'ref=' + best.ref : null,
    href: best ? best.href || '' : '',
    role: best ? best.role : null,
    score: best ? Math.round(best.score * 100) / 100 : 0,
    margin: Math.round(margin * 100) / 100,
    line: best ? best.line : null,
    candidates: scored.slice(0, 5).map((c) => ({ ref: c.ref, role: c.role, name: c.name.slice(0, 80), score: Math.round(c.score * 100) / 100 })),
  };
}

/** Find a cookie/consent or modal blocker that code can clear without the model. */
export function findBlocker(lines, step = {}, { cookieHint = false } = {}) {
  const cands = (lines || []).map((l, i) => parseLine(l, i)).filter(Boolean);
  const blob = (lines || []).join('\n');
  const wantConsent = cookieHint || [].concat((step.estimate && step.estimate.blockers) || []).some((b) => /cookie|consent|gdpr/i.test(String(b)));
  const wantModal = [].concat((step.estimate && step.estimate.blockers) || []).some((b) => /modal|dialog|popup|overlay|newsletter/i.test(String(b)));
  if (wantConsent || /cookie|consent|gdpr|privacy choices|your privacy/i.test(blob)) {
    const c = cands.find((x) => /^(button|link)$/.test(x.role) && /^(accept( all)?( cookies)?|accept and continue|agree|i agree|allow( all)?( cookies)?|got it|ok|i understand)$/i.test(x.name.trim()));
    if (c) return { kind: 'consent', target: 'ref=' + c.ref, name: c.name };
  }
  if (wantModal) {
    const c = cands.find((x) => x.role === 'button' && /^(close|dismiss|no thanks|not now|x|\u00d7|\u2715)$/i.test(x.name.trim()));
    if (c) return { kind: 'modal', target: 'ref=' + c.ref, name: c.name };
  }
  return null;
}

/** How well the driver knows a site: known (priors or cached locators), seen (visited this session), new. */
export function assessFamiliarity(host, { priors, locators, seen } = {}) {
  if (!host) return 'seen';
  try {
    if (priors && Array.isArray(priors.sites) && priors.sites.some((s) => s.domain === host && (s.flows || []).length)) return 'known';
  } catch (_) {}
  try {
    if (locators && typeof locators.hasSite === 'function' && locators.hasSite(host)) return 'known';
  } catch (_) {}
  if (seen && typeof seen.has === 'function' && seen.has(host)) return 'seen';
  return 'new';
}

const rank = (f) => Math.max(0, FAMILIARITY.indexOf(f));

/**
 * Annotate a plan's steps with familiarity and loosen the parts that land on never-seen sites:
 * structural targets (css, refs, xpath), coordinates and offsets are dropped to intent level.
 */
export function frameSteps(steps = [], { startUrl = '', priors, locators, seen } = {}) {
  let host = hostOf(startUrl);
  return steps.map((raw) => {
    const step = { ...raw };
    if ((step.action === 'navigate' || step.action === 'goto') && step.url) host = hostOf(step.url) || host;
    const computed = assessFamiliarity(host, { priors, locators, seen });
    const claimed = FAMILIARITY.includes(step.familiarity) ? step.familiarity : null;
    step.familiarity = claimed && rank(claimed) < rank(computed) ? claimed : computed;
    step.host = host || undefined;
    if (!step.intent && step.label) step.intent = step.label;
    if (step.familiarity === 'new' && TARGET_ACTIONS.has(String(step.action || '').toLowerCase())) {
      const dropped = {};
      // Positions are only dropped when something else can find the element; a coordinate-only step keeps them.
      const resolvable = step.target != null || !!step.intent || (Array.isArray(step.hints) && step.hints.length > 0);
      if (resolvable) for (const k of ['x', 'y', 'offsetX', 'offsetY']) if (step[k] != null) { dropped[k] = step[k]; delete step[k]; }
      if (step.target != null) {
        const h = parseHint(step.target, 0.5);
        if (h) step.hints = [].concat(step.hints || [], [h]);
        dropped.target = step.target;
        step.looseTarget = step.target; // only used if intent resolution fails and it is present on the live page
        delete step.target;
      }
      if (Object.keys(dropped).length) step.dropped = dropped;
    }
    return step;
  });
}

export function frameworkView(steps = [], from = 0) {
  return steps.slice(from).map((s, k) => ({
    i: from + k,
    intent: intentOf(s) || s.action,
    action: s.action,
    familiarity: s.familiarity,
    hints: stepHints(s).slice(0, 3),
    estimate: s.estimate || undefined,
  }));
}
