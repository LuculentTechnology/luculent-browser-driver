// Recorded flows: capture driver steps and replay them with no model calls (LUC-3079).
// On a failed step, return needsModel so the agent can take over from that point.
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { redactSecrets } from './chats.mjs';

function safeName(name) {
  const s = String(name || '').trim().replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
  return s || ('flow-' + randomBytes(4).toString('hex'));
}

export function isPasswordStep(step = {}) {
  if (step.isPassword === true || step.password === true) return true;
  if (step.sensitive === 'password' || step.formSensitive === 'password') return true;
  const typ = String(step.inputType || step.fieldType || '').toLowerCase();
  if (typ === 'password') return true;
  if (String(step.type || '').toLowerCase() === 'password') return true;
  const blob = [step.target, step.name, step.what, step.label, step.placeholder, step.id, step.role, step.selector]
    .map((x) => String(x || '')).join(' ');
  return /password|passwd|pwd\b/i.test(blob);
}

export function sanitizeStep(step = {}) {
  const s = { ...step };
  if (s.text != null) s.text = redactSecrets(s.text);
  if (s.value != null && typeof s.value === 'string') s.value = redactSecrets(s.value);
  if (s.js != null) s.js = redactSecrets(s.js);
  if (isPasswordStep(s)) {
    if (s.text != null) s.text = '[redacted]';
    if (s.value != null) s.value = '[redacted]';
  }
  return s;
}

export class FlowStore {
  constructor(dir, { now } = {}) {
    this.dir = dir;
    this._now = now || (() => Date.now());
    this.recording = null; // { name, steps, startedAt }
    if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  file(name) { return join(this.dir, safeName(name) + '.json'); }
  list() {
    if (!this.dir || !existsSync(this.dir)) return [];
    return readdirSync(this.dir).filter((f) => f.endsWith('.json')).map((f) => this.get(f.slice(0, -5))).filter(Boolean);
  }
  get(name) {
    try { return JSON.parse(readFileSync(this.file(name), 'utf8')); } catch (_) { return null; }
  }
  save(name, steps, meta = {}) {
    const flow = {
      name: safeName(name),
      steps: (steps || []).map(sanitizeStep),
      createdAt: meta.createdAt || this._now(),
      updatedAt: this._now(),
      ...('id' in meta ? { id: meta.id } : {}),
    };
    const tmp = this.file(flow.name) + '.tmp';
    writeFileSync(tmp, JSON.stringify(flow, null, 2), { mode: 0o600 });
    renameSync(tmp, this.file(flow.name));
    return flow;
  }
  delete(name) {
    try { unlinkSync(this.file(name)); return true; } catch (_) { return false; }
  }
  start(name) {
    this.recording = { name: safeName(name), steps: [], startedAt: this._now() };
    return this.recording;
  }
  record(step) {
    if (!this.recording) throw new Error('No recording in progress (call flow.record first)');
    this.recording.steps.push(sanitizeStep(step));
    return this.recording.steps.length;
  }
  stop() {
    if (!this.recording) return null;
    const rec = this.recording;
    this.recording = null;
    return this.save(rec.name, rec.steps, { createdAt: rec.startedAt });
  }
  /**
   * Replay a saved flow by calling runStep(step, index) for each step.
   * On failure, stop and return needsModel so a model can continue.
   */
  async replay(name, runStep, { snapshot } = {}) {
    const flow = this.get(name);
    if (!flow) throw new Error('No saved flow named "' + name + '"');
    const results = [];
    for (let i = 0; i < flow.steps.length; i++) {
      const step = flow.steps[i];
      try {
        const value = await runStep(step, i);
        results.push({ i, ok: true, action: step.action, value });
      } catch (e) {
        const snap = snapshot ? await Promise.resolve(snapshot()).catch(() => null) : null;
        return {
          ok: false, needsModel: true, name: flow.name, failedStep: i, step, error: e.message,
          results, ...(snap ? { snapshot: snap } : {}),
        };
      }
    }
    return { ok: true, needsModel: false, name: flow.name, results };
  }
}
