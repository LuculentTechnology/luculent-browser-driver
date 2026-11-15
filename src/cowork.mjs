// "When you click in the AI's tab" (T1288). Three modes:
//   cowork  (default) the AI holds its own actions while you interact, waits for a short idle,
//           then re-reads the page from the state you left and continues from there.
//   pause   your input pauses the task until you press Resume; the AI continues from the page as it is.
//   disable the tab is locked while the AI works (the original "Disable window" block).
// The AI's own CDP input is trusted by the page too, so every Input.* command the driver sends opens
// an "AI acting" window and user events inside that window (plus a short guard) are ignored.

export const CLICK_MODES = ['cowork', 'pause', 'disable'];
export const DEFAULT_CLICK_MODE = 'cowork';
export const CLICK_MODE_LABELS = { cowork: 'Cowork', pause: 'Pause', disable: 'Disable window' };
export const USER_KINDS = new Set(['pointerdown', 'mousedown', 'click', 'keydown', 'wheel', 'touchstart', 'input']);

export function normalizeClickMode(mode, legacy = {}) {
  const m = String(mode == null ? '' : mode).toLowerCase().replace(/[\s_-]+/g, '');
  if (m === 'cowork' || m === 'coworking') return 'cowork';
  if (m === 'pause') return 'pause';
  if (m === 'disable' || m === 'disablewindow' || m === 'block' || m === 'lock') return 'disable';
  if (legacy && legacy.disableWindow === true) return 'disable';
  return DEFAULT_CLICK_MODE;
}

const realSleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class InteractionTracker {
  constructor({ idleMs = 900, guardMs = 400, maxHoldMs = 300000, now = () => Date.now(), sleep = realSleep } = {}) {
    this.idleMs = idleMs;
    this.guardMs = guardMs;
    this.maxHoldMs = maxHoldMs;
    this.now = now;
    this.sleep = sleep;
    this.mode = DEFAULT_CLICK_MODE;
    this.ai = [];
    this.waiters = [];
    this.paused = false;
    this.pausedAt = 0;
    this._clear();
  }

  _clear() { this.count = 0; this.kinds = new Set(); this.firstAt = 0; this.lastAt = 0; this.firstUrl = null; }

  setMode(mode) {
    this.mode = normalizeClickMode(mode);
    if (this.mode !== 'pause' && this.paused) this.resume();
    return this.mode;
  }

  aiStart() { const w = { start: this.now(), end: null }; this.ai.push(w); if (this.ai.length > 64) this.ai.shift(); return w; }
  aiEnd(w) { if (w) w.end = this.now(); }
  isAi(at) {
    for (const w of this.ai) if (at >= w.start - 60 && at <= (w.end == null ? Infinity : w.end + this.guardMs)) return true;
    return false;
  }

  /** Record one trusted user input event from the driven tab. Returns what the driver does about it. */
  onUserInput({ at, kind, url } = {}) {
    const t = Number.isFinite(Number(at)) && Number(at) > 0 ? Number(at) : this.now();
    if (!USER_KINDS.has(kind)) return { action: 'ignored', why: 'kind' };
    if (this.isAi(t)) return { action: 'ignored', why: 'ai' };
    if (this.mode === 'disable') return { action: 'blocked' };
    const first = this.count === 0;
    if (first) { this.firstAt = t; this.firstUrl = url || null; }
    this.count += 1;
    this.lastAt = Math.max(this.lastAt, t);
    this.kinds.add(kind);
    if (this.mode === 'pause') {
      const changed = !this.paused;
      this.paused = true;
      if (changed) this.pausedAt = t;
      return { action: 'pause', changed };
    }
    return { action: 'cowork', changed: first };
  }

  userActive() { return this.count > 0 && this.now() - this.lastAt < this.idleMs; }
  hasPending() { return this.count > 0; }

  resume() {
    this.paused = false;
    const w = this.waiters; this.waiters = [];
    for (const f of w) { try { f(); } catch (_) {} }
  }

  /** The "user stepped in" record since the last consume, or null. Clears it. */
  consume() {
    if (!this.count) return null;
    const r = { userStepped: true, count: this.count, kinds: [...this.kinds], firstAt: this.firstAt, lastAt: this.lastAt, mode: this.mode, firstUrl: this.firstUrl || null };
    this._clear();
    return r;
  }

  _waitResume(ms) {
    return new Promise((resolve) => {
      let done = false;
      const fin = () => { if (done) return; done = true; resolve(); };
      this.waiters.push(fin);
      setTimeout(fin, ms);
    });
  }

  /**
   * Gate before an AI action. Cowork: wait while the user is active (idle debounce). Pause: wait for Resume.
   * Disable and no recent input: returns at once (no added latency on the happy path).
   */
  async gate({ shouldStop = () => false, maxPauseMs = 30 * 60 * 1000, onHold } = {}) {
    const t0 = this.now();
    let held = false, paused = false, notified = false;
    for (;;) {
      if (shouldStop()) return { stopped: true, held, paused, waitedMs: this.now() - t0 };
      if (this.mode === 'pause' && this.paused) {
        paused = true;
        if (!notified && onHold) { notified = true; try { onHold('paused'); } catch (_) {} }
        if (this.now() - t0 > maxPauseMs) return { timeout: true, held, paused, waitedMs: this.now() - t0 };
        await this._waitResume(250);
        continue;
      }
      if (this.mode === 'cowork' && this.userActive()) {
        held = true;
        if (!notified && onHold) { notified = true; try { onHold('cowork'); } catch (_) {} }
        if (this.now() - t0 > this.maxHoldMs) break;
        await this.sleep(Math.max(30, Math.min(250, this.idleMs - (this.now() - this.lastAt))));
        continue;
      }
      break;
    }
    return { held, paused, waitedMs: this.now() - t0 };
  }

  status() {
    return { mode: this.mode, paused: this.paused, active: this.userActive(), pending: this.count, kinds: [...this.kinds], lastAt: this.lastAt || null };
  }
}
