// Action engine: one implementation of every browser action on top of a raw CDP `send`.
// The same code drives extension-attached tabs (chrome.debugger) and headless tabs (direct CDP).
import { HELPER_SRC, HELPER_VERSION } from './helper.mjs';
import { pdfText } from './pdf.mjs';
import { hasUrlScheme, urlBlocked } from './policy.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CTX_GONE = /context was destroyed|Cannot find context|Inspected target navigated|Execution context|Target closed|No frame|Object reference chain|uniqueContextId|Cannot find default execution context/i;

const KEYS = {
  Enter: { code: 'Enter', keyCode: 13, text: '\r' }, Tab: { code: 'Tab', keyCode: 9 }, Escape: { code: 'Escape', keyCode: 27 },
  Backspace: { code: 'Backspace', keyCode: 8 }, Delete: { code: 'Delete', keyCode: 46 }, Space: { code: 'Space', keyCode: 32, text: ' ', key: ' ' },
  ArrowUp: { code: 'ArrowUp', keyCode: 38 }, ArrowDown: { code: 'ArrowDown', keyCode: 40 }, ArrowLeft: { code: 'ArrowLeft', keyCode: 37 },
  ArrowRight: { code: 'ArrowRight', keyCode: 39 }, Home: { code: 'Home', keyCode: 36 }, End: { code: 'End', keyCode: 35 },
  PageUp: { code: 'PageUp', keyCode: 33 }, PageDown: { code: 'PageDown', keyCode: 34 }, Insert: { code: 'Insert', keyCode: 45 },
  ContextMenu: { code: 'ContextMenu', keyCode: 93 },
};
for (let i = 1; i <= 12; i++) KEYS['F' + i] = { code: 'F' + i, keyCode: 111 + i };
const KEY_ALIAS = { Esc: 'Escape', Return: 'Enter', Del: 'Delete', Up: 'ArrowUp', Down: 'ArrowDown', Left: 'ArrowLeft', Right: 'ArrowRight', ' ': 'Space', Spacebar: 'Space' };
const MODS = { Alt: 1, Control: 2, Ctrl: 2, Meta: 4, Cmd: 4, Command: 4, Shift: 8 };
const GEO_SHIM = (lat, lon, acc) => `(() => { const pos = { coords: { latitude: ${lat}, longitude: ${lon}, accuracy: ${acc}, altitude: null, altitudeAccuracy: null, heading: null, speed: null }, timestamp: Date.now() };
  const g = navigator.geolocation; if (!g) return; g.getCurrentPosition = (ok) => setTimeout(() => ok(pos), 0); g.watchPosition = (ok) => { setTimeout(() => ok(pos), 0); return 1; }; g.clearWatch = () => {}; })()`;

export class Engine {
  /** @param {{send:(tab:string,method:string,params?:object,session?:string)=>Promise<any>, children?:(tab:string)=>Promise<any[]>, tabs?:()=>Promise<any>}} router */
  constructor(router) {
    this.router = router;
    this.snaps = new Map();   // tab -> last snapshot lines (for diffs)
    this.frameCache = new Map(); // tab -> Map(spec -> ctx)
    this.dialogs = new Map(); // tab -> [{type,message,accepted}]
    this.dialogMode = new Map(); // tab -> accept|dismiss|manual
    this.pendingDialog = new Map(); // tab -> params (manual mode)
  }

  /** CDP events from the router (both extension and headless). */
  onEvent(tab, method, params, session) {
    if (method === 'Page.javascriptDialogOpening') {
      const mode = this.dialogMode.get(tab) || 'accept';
      if (mode === 'manual') { this.pendingDialog.set(tab, params); return; }
      const accept = mode === 'accept' || params.type === 'alert' || params.type === 'beforeunload';
      const list = this.dialogs.get(tab) || [];
      list.push({ type: params.type, message: String(params.message || '').slice(0, 300), accepted: accept });
      this.dialogs.set(tab, list.slice(-20));
      this.router.send(tab, 'Page.handleJavaScriptDialog', { accept, ...(params.type === 'prompt' ? { promptText: params.defaultPrompt || '' } : {}) }, session).catch(() => {});
    }
    if (method === 'Page.frameNavigated' && !params.frame.parentId) this.frameCache.delete(tab);
  }
  forget(tab) { this.snaps.delete(tab); this.frameCache.delete(tab); this.dialogs.delete(tab); this.dialogMode.delete(tab); this.pendingDialog.delete(tab); }

  async evaluate(tab, expression, { awaitPromise = true, timeout, ctx } = {}) {
    const r = await this.router.send(tab, 'Runtime.evaluate', {
      expression, awaitPromise, returnByValue: true, userGesture: true, ...(timeout ? { timeout } : {}), ...(ctx && ctx.contextId ? { contextId: ctx.contextId } : {}),
    }, ctx && ctx.session);
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      const msg = (d.exception && (d.exception.description || d.exception.value)) || d.text || 'evaluation failed';
      throw new Error(String(msg).split('\n')[0]);
    }
    return r.result ? r.result.value : undefined;
  }

  // ---------- frames ----------
  /** Resolve a frame spec ("#iframe-css", frame name, URL substring; chain with " >> ") to an execution context + page offset. */
  async frameCtx(tab, spec) {
    if (!spec) return null;
    let cache = this.frameCache.get(tab);
    if (!cache) { cache = new Map(); this.frameCache.set(tab, cache); }
    if (cache.has(spec)) return cache.get(spec);
    let ctx = { session: undefined, contextId: undefined, offset: { x: 0, y: 0 } };
    for (const part of String(spec).split(/\s*>>\s*/)) ctx = await this.frameStep(tab, ctx, part);
    cache.set(spec, ctx);
    return ctx;
  }

  async frameStep(tab, parent, part) {
    const send = (m, p) => this.router.send(tab, m, p, parent.session);
    // 1) Find the owner <iframe>/<frame> element by CSS, name or src substring in the parent context.
    const finder = `(() => { const s = ${JSON.stringify(part)}; let el = null;
      try { el = document.querySelector(s); } catch (_) {}
      if (!el || !/^(IFRAME|FRAME)$/.test(el.tagName)) { const all = Array.from(document.querySelectorAll('iframe,frame'));
        el = all.find((f) => f.name === s || f.id === s) || all.find((f) => (f.src || '').includes(s)) || all.find((f) => (f.title || '').toLowerCase().includes(s.toLowerCase())) || null; }
      return el; })()`;
    let deadline = Date.now() + 8000;
    let obj;
    for (;;) {
      const r = await send('Runtime.evaluate', { expression: finder, returnByValue: false, ...(parent.contextId ? { contextId: parent.contextId } : {}) });
      if (r.result && r.result.objectId) { obj = r.result.objectId; break; }
      if (Date.now() > deadline) throw new Error(`No frame matching ${JSON.stringify(part)} (use the iframe's CSS selector, name, or part of its URL)`);
      await sleep(100);
    }
    const node = await send('DOM.describeNode', { objectId: obj });
    const frameId = node.node.frameId;
    const box = await send('DOM.getBoxModel', { objectId: obj }).catch(() => null);
    const q = box && box.model && box.model.content;
    const offset = { x: parent.offset.x + (q ? q[0] : 0), y: parent.offset.y + (q ? q[1] : 0) };
    if (!frameId) throw new Error(`Frame ${JSON.stringify(part)} has not loaded yet`);
    // 2) Out-of-process (cross-site) iframe: it has its own target/session.
    deadline = Date.now() + 5000;
    for (;;) {
      const kids = this.router.children ? await this.router.children(tab) : [];
      const kid = kids.find((k) => k.targetId === frameId);
      if (kid) return { session: kid.sessionId, contextId: undefined, offset, frameId };
      // 3) Same-process frame: an isolated world in that frame.
      try {
        const w = await send('Page.createIsolatedWorld', { frameId, worldName: 'lbd', grantUniveralAccess: true });
        return { session: parent.session, contextId: w.executionContextId, offset, frameId };
      } catch (e) {
        if (Date.now() > deadline) throw new Error(`Cannot enter frame ${JSON.stringify(part)}: ${e.message}`);
        await sleep(100);
      }
    }
  }

  /** Call a helper method; ships the helper source only when the page does not have it yet. */
  async helper(tab, fn, args = [], { retryUntil, frame } = {}) {
    const a = JSON.stringify(args).slice(1, -1);
    const fast = `(window.__lbd && window.__lbd.v === ${HELPER_VERSION}) ? window.__lbd.${fn}(${a}) : '__LBD_MISSING__'`;
    const full = `${HELPER_SRC}.${fn}(${a})`;
    const deadline = retryUntil || Date.now() + 10000;
    for (;;) {
      try {
        const ctx = frame ? await this.frameCtx(tab, frame) : null;
        let v = await this.evaluate(tab, fast, { ctx });
        if (v === '__LBD_MISSING__') v = await this.evaluate(tab, full, { ctx });
        return v;
      } catch (e) {
        if (CTX_GONE.test(e.message) && Date.now() < deadline) { if (frame) { const c = this.frameCache.get(tab); if (c) c.delete(frame); } await sleep(30); continue; }
        throw e;
      }
    }
  }

  async docState(tab) {
    try {
      return await this.evaluate(tab, '[performance.timeOrigin, document.readyState, location.href, window.__lbdNav || 0]', { awaitPromise: false });
    } catch (e) {
      if (CTX_GONE.test(e.message)) return null;
      throw e;
    }
  }

  /**
   * Wait until a new document (different timeOrigin than `before`) reaches `until`.
   * startWithin: if no navigation has begun after this many ms (same document, complete, no navigate/beforeunload
   * event seen), report navigated:false instead of burning the whole timeout. A same-document URL change (SPA
   * pushState) counts as done at once. A started cross-document navigation keeps waiting however slow the server is.
   */
  async waitLoad(tab, before, until = 'domcontentloaded', timeout = 15000, startWithin = 0, beforeUrl = null) {
    const t0 = Date.now();
    const deadline = t0 + timeout;
    const okState = until === 'load' ? ['complete'] : ['interactive', 'complete'];
    let interval = 5;
    while (Date.now() < deadline) {
      const s = await this.docState(tab);
      if (s && (before == null || s[0] !== before) && okState.includes(s[1])) return { url: s[2] };
      if (s && before != null && s[0] === before && beforeUrl && s[2] !== beforeUrl && s[3] !== 1) return { url: s[2], navigated: true, sameDocument: true };
      if (startWithin && s && s[0] === before && s[1] === 'complete' && s[3] !== 1 && Date.now() - t0 > startWithin) return { url: s[2], navigated: s[2] !== beforeUrl };
      await sleep(interval);
      interval = Math.min(interval * 1.5, 50);
    }
    throw new Error(`Timeout ${timeout}ms waiting for navigation (${until})`);
  }

  async navigate(tab, { url, wait = 'domcontentloaded', timeout = 15000 }) {
    if (!url) throw new Error('navigate needs url');
    if (!hasUrlScheme(url)) url = 'https://' + url; // "example.com" or "localhost:3000" -> https://...
    const s = await this.docState(tab);
    const r = await this.router.send(tab, 'Page.navigate', { url });
    if (r.errorText && r.errorText !== 'net::ERR_ABORTED') throw new Error(`navigate failed: ${r.errorText}`);
    if (!r.loaderId || wait === 'none' || wait === 'commit') return { url };
    return this.waitLoad(tab, s ? s[0] : null, wait, timeout);
  }

  async mouse(tab, x, y, { button = 'left', clickCount = 1, modifiers = 0 } = {}) {
    if (this.cursor !== false) {
      try { await this.helper(tab, 'moveCursor', [x, y, this.cursorLabel || 'Luculent']); } catch (_) {}
    }
    await this.router.send(tab, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, modifiers });
    for (let i = 1; i <= clickCount; i++) {
      await this.router.send(tab, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, clickCount: i, modifiers });
      await this.router.send(tab, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, clickCount: i, modifiers });
    }
  }

  async key(tab, combo) {
    const parts = String(combo).split(/\+(?!$)/);
    let k = parts.pop();
    k = KEY_ALIAS[k] || k;
    let modifiers = 0;
    for (const m of parts) modifiers |= MODS[m] || MODS[m[0].toUpperCase() + m.slice(1).toLowerCase()] || 0;
    const def = KEYS[k] || (k.length === 1 ? { code: /[a-z]/i.test(k) ? 'Key' + k.toUpperCase() : /\d/.test(k) ? 'Digit' + k : '', keyCode: k.toUpperCase().charCodeAt(0), text: k } : null);
    if (!def) throw new Error(`Unknown key ${k}. Use names like Enter, Tab, Escape, ArrowDown, F2, or single characters; combos like Control+a.`);
    const key = def.key || k;
    const text = modifiers & ~8 ? undefined : def.text;
    await this.router.send(tab, 'Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', key, code: def.code, windowsVirtualKeyCode: def.keyCode, nativeVirtualKeyCode: def.keyCode, modifiers, text, unmodifiedText: text });
    await this.router.send(tab, 'Input.dispatchKeyEvent', { type: 'keyUp', key, code: def.code, windowsVirtualKeyCode: def.keyCode, nativeVirtualKeyCode: def.keyCode, modifiers });
  }

  async withNav(tab, step, fn) {
    if (!step.waitNav) return fn();
    // Mark the document so we can tell "navigation requested, server still responding" from "nothing happened".
    // The Navigation API 'navigate' event fires at the start of every navigation (form submits, links, location
    // changes), before the response arrives, so a slow server no longer looks like "nothing happened".
    const mark = `(window.__lbdNav = 0, addEventListener('beforeunload', () => { window.__lbdNav = 1; }, { once: true }),
      (window.navigation && navigation.addEventListener('navigate', (e) => { window.__lbdNav = (e.destination && e.destination.sameDocument) ? 2 : 1; }, { once: true })),
      [performance.timeOrigin, document.readyState, location.href])`;
    let s = null;
    try { s = await this.evaluate(tab, mark, { awaitPromise: false }); } catch (_) { s = await this.docState(tab); }
    const v = await fn();
    const nav = await this.waitLoad(tab, s ? s[0] : null, step.waitNav === 'load' ? 'load' : 'domcontentloaded', step.timeout && step.timeout > 15000 ? step.timeout : 30000, 1500, s ? s[2] : null);
    if (nav.sameDocument || nav.navigated === false) await this.settle(tab);
    return { ...(v || {}), url: nav.url, ...(nav.navigated === false ? { navigated: false } : {}), ...(nav.sameDocument ? { sameDocument: true } : {}) };
  }

  async snapshot(tab, { mode = 'compact', max, text, viewport = false, frame, updateBaseline = true, interactive } = {}) {
    const key = frame ? tab + '|' + frame : tab;
    const prev = this.snaps.get(key);
    const compact = interactive != null ? !!interactive
      : mode === 'full' ? false
      : mode === 'compact' ? true
      : mode === 'diff' ? (prev ? !!prev.compact : true)
      : true;
    const snap = await this.helper(tab, 'snapshot', [{
      max: max ?? (compact ? 120 : 400),
      text: text != null ? text : !compact,
      viewport,
      interactive: interactive != null ? interactive : compact,
    }], { frame });
    if (updateBaseline !== false) this.snaps.set(key, { url: snap.url, lines: snap.lines, compact });
    if ((mode === 'diff' || mode === 'compact') && prev && prev.url === snap.url) {
      const before = new Set(prev.lines);
      const now = new Set(snap.lines);
      const added = snap.lines.filter((l) => !before.has(l));
      const removed = prev.lines.filter((l) => !now.has(l));
      if (added.length + removed.length <= Math.max(8, snap.lines.length * 0.6)) {
        return { mode: 'diff', url: snap.url, title: snap.title, added, removed, unchanged: snap.lines.length - added.length, lines: snap.lines };
      }
    }
    if (compact && mode !== 'full') return { mode: 'compact', url: snap.url, title: snap.title, lines: snap.lines };
    return { mode: 'full', url: snap.url, title: snap.title, lines: snap.lines };
  }

  async screenshot(tab, { format = 'jpeg', quality = 60, fullPage = false } = {}) {
    const params = { format, ...(format === 'jpeg' ? { quality } : {}), captureBeyondViewport: !!fullPage, fromSurface: true };
    if (fullPage) {
      const m = await this.router.send(tab, 'Page.getLayoutMetrics', {});
      const c = m.cssContentSize || m.contentSize;
      params.clip = { x: 0, y: 0, width: Math.ceil(c.width), height: Math.min(Math.ceil(c.height), 16000), scale: 1 };
    }
    const r = await this.router.send(tab, 'Page.captureScreenshot', params);
    return { mime: `image/${format}`, data: r.data };
  }

  /** Element centre (or offsetX/offsetY from its top-left) in top-level viewport coordinates. */
  async currentUrl(tab) {
    try {
      const st = await this.docState(tab);
      return (st && st[2]) || '';
    } catch (_) { return ''; }
  }

  async pointOf(tab, s, t) {
    const url = this.locators ? await this.currentUrl(tab) : '';
    const targets = [];
    if (s.target != null) targets.push(s.target);
    if (this.locators && s.target != null) {
      const cached = this.locators.get(url, s.target, s);
      if (cached && cached !== s.target) targets.push(cached);
    }
    let p = null, used = s.target;
    for (const tgt of targets) {
      try {
        const hit = await this.helper(tab, 'exists', [tgt], { frame: s.frame });
        if (!hit) continue;
        p = await this.helper(tab, 'point', [tgt, Math.min(t, 400)], { retryUntil: Date.now() + Math.min(t, 400), frame: s.frame });
        used = tgt;
        break;
      } catch (_) {}
    }
    if (!p) {
      p = await this.helper(tab, 'point', [s.target, t], { retryUntil: Date.now() + t, frame: s.frame });
      used = s.target;
    }
    if (this.locators && url && used != null) this.locators.put(url, s.target, used, s);
    const ctx = s.frame ? await this.frameCtx(tab, s.frame) : null;
    const ox = ctx ? ctx.offset.x : 0, oy = ctx ? ctx.offset.y : 0;
    const x = (s.offsetX != null ? p.left + Number(s.offsetX) : p.x) + ox;
    const y = (s.offsetY != null ? p.top + Number(s.offsetY) : p.y) + oy;
    return { ...p, x, y };
  }

  async prefetch(tab, step) {
    if (!step || step.target == null) return null;
    try { return await this.helper(tab, 'exists', [step.target], { frame: step.frame }); }
    catch (_) { return null; }
  }

  /** Let frameworks finish re-rendering after Enter / client-side route changes: DOM quiet for 80 ms, max 1 s. */
  async settle(tab, opts = {}) { await this.helper(tab, 'waitIdle', [80, 400], opts).catch(() => {}); }

  async tabIds() {
    if (!this.router.tabs) return new Set();
    const { tabs } = await this.router.tabs();
    return new Set(tabs.map((t) => t.tab));
  }

  async expectPopup(tab, before, timeout = 8000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      const now = await this.tabIds();
      for (const id of now) if (!before.has(id) && id !== tab) return id;
      await sleep(60);
    }
    throw new Error('No new tab/window opened within ' + timeout + 'ms');
  }

  async fetchBytes(tab, url) {
    // Fetch inside the page first (keeps the user's cookies), fall back to a plain fetch from the relay.
    try {
      const b64 = await this.evaluate(tab, `fetch(${JSON.stringify(url)}, { credentials: 'include' }).then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.arrayBuffer(); }).then((ab) => { const u = new Uint8Array(ab); let s = ''; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); return btoa(s); })`);
      if (b64) return Buffer.from(b64, 'base64');
    } catch (_) {}
    const r = await fetch(url, { signal: AbortSignal.timeout(20000) });
    if (!r.ok) throw new Error(`HTTP ${r.status} fetching ${url}`);
    return Buffer.from(await r.arrayBuffer());
  }

  /** Execute one step. Returns the step value (JSON-serialisable). */
  async step(tab, s, opts = {}) {
    const t = s.timeout || 5000;
    const F = { frame: s.frame };
    switch (s.action) {
      case 'navigate': case 'goto': case 'open': return this.navigate(tab, s);
      case 'click': case 'dblclick': case 'rightclick': case 'tap': {
        const before = s.expectPopup ? await this.tabIds() : null;
        const v = await this.withNav(tab, s, async () => {
          const button = s.action === 'rightclick' ? 'right' : s.button || 'left';
          const clickCount = s.action === 'dblclick' ? 2 : 1;
          if (s.target == null && s.x != null && s.y != null) { await this.mouse(tab, Number(s.x), Number(s.y), { button, clickCount }); return { x: s.x, y: s.y }; }
          if (s.js || s.force) return this.helper(tab, 'domClick', [s.target, t], F);
          const p = await this.pointOf(tab, s, t);
          if (p.covered && button === 'left' && clickCount === 1) {
            await this.helper(tab, 'domClick', [p.ref || s.target, t], F);
            return { ref: p.ref, role: p.role, name: p.name, coveredFallback: true, warning: 'element was covered at click point; dispatched direct DOM click fallback' };
          }
          await this.mouse(tab, p.x, p.y, { button, clickCount });
          return { ref: p.ref, role: p.role, name: p.name, ...(p.covered ? { warning: 'element was covered at click point (an overlay, banner or dialog may have received the click)' } : {}) };
        });
        if (before) v.popup = await this.expectPopup(tab, before, s.timeout || 8000);
        return v;
      }
      case 'hover': {
        const p = await this.pointOf(tab, s, t);
        await this.router.send(tab, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y });
        return { ref: p.ref };
      }
      case 'wheel': {
        let x = s.x, y = s.y;
        if (s.target != null) { const p = await this.pointOf(tab, s, t); x = p.x; y = p.y; }
        x = x ?? 200; y = y ?? 200;
        await this.router.send(tab, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
        await this.router.send(tab, 'Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: s.dx || 0, deltaY: s.dy ?? 300 });
        return { x, y };
      }
      case 'drag': {
        if (s.to != null && !s.frame && (await this.helper(tab, 'isDraggable', [s.target]).catch(() => false)) && !s.mouse) return this.helper(tab, 'html5drag', [s.target, s.to]);
        // Pages that are still loading (ads, lazy images) shift layout between measuring and dropping, so the source is
        // re-measured right before the press and the target right before the release.
        let a = await this.pointOf(tab, s, t);
        await this.router.send(tab, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: a.x, y: a.y });
        const a2 = await this.pointOf(tab, s, t);
        if (Math.abs(a2.x - a.x) > 2 || Math.abs(a2.y - a.y) > 2) { a = a2; await this.router.send(tab, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: a.x, y: a.y }); }
        await this.router.send(tab, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: a.x, y: a.y, button: 'left', clickCount: 1 });
        const toPoint = async () => { if (s.to != null) { const p = await this.pointOf(tab, { ...s, target: s.to, offsetX: undefined, offsetY: undefined, frame: s.toFrame || s.frame }, t); return [p.x, p.y]; } return [a.x + (s.dx || 0), a.y + (s.dy || 0)]; };
        let [bx, by] = await toPoint();
        const n = s.steps || 12;
        for (let i = 1; i <= n; i++) { await this.router.send(tab, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: a.x + ((bx - a.x) * i) / n, y: a.y + ((by - a.y) * i) / n, button: 'left', buttons: 1 }); }
        if (s.to != null) { const [cx, cy] = await toPoint().catch(() => [bx, by]); if (Math.abs(cx - bx) > 2 || Math.abs(cy - by) > 2) { bx = cx; by = cy; await this.router.send(tab, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: bx, y: by, button: 'left', buttons: 1 }); } }
        await this.router.send(tab, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: bx, y: by, button: 'left', clickCount: 1 });
        return { from: { x: Math.round(a.x), y: Math.round(a.y) }, to: { x: Math.round(bx), y: Math.round(by) } };
      }
      case 'type': case 'fill': case 'input': {
        return this.withNav(tab, s, async () => {
          let i;
          if (s.action === 'fill' || s.fast) i = await this.helper(tab, 'fill', [s.target, String(s.text ?? s.value ?? ''), t], F);
          else {
            i = s.target != null ? await this.helper(tab, 'focus', [s.target, s.clear !== false, t], F) : null;
            const text = String(s.text ?? s.value ?? '');
            if (text) await this.router.send(tab, 'Input.insertText', { text });
          }
          if (s.submit) { await this.key(tab, 'Enter'); if (!s.waitNav) await this.settle(tab, F); }
          return i ? { ref: i.ref, name: i.name } : {};
        });
      }
      case 'press': {
        return this.withNav(tab, s, async () => {
          if (s.target != null) await this.helper(tab, 'focus', [s.target, false, t], F);
          for (const k of [].concat(s.key || s.keys)) await this.key(tab, k);
          return {};
        });
      }
      case 'key': return this.step(tab, { ...s, action: 'press' }, opts);
      case 'upload': {
        const files = [].concat(s.files || s.file || []);
        if (!files.length) throw new Error('upload needs files: ["C:\\path\\file.png"]');
        const ctx = s.frame ? await this.frameCtx(tab, s.frame) : null;
        const i = await this.helper(tab, 'waitFor', [s.target, t, 'attached'], { retryUntil: Date.now() + t, ...F });
        const r = await this.router.send(tab, 'Runtime.evaluate', { expression: `window.__lbd.resolve(${JSON.stringify(i.ref)})`, returnByValue: false, ...(ctx && ctx.contextId ? { contextId: ctx.contextId } : {}) }, ctx && ctx.session);
        if (!r.result || !r.result.objectId) throw new Error('could not resolve file input');
        await this.router.send(tab, 'DOM.setFileInputFiles', { files, objectId: r.result.objectId, ...(opts.approval ? { approval: opts.approval } : {}) }, ctx && ctx.session);
        await this.evaluate(tab, `(() => { const el = window.__lbd.resolve(${JSON.stringify(i.ref)}); el.dispatchEvent(new Event('input', {bubbles:true})); el.dispatchEvent(new Event('change', {bubbles:true})); return el.files.length; })()`, { ctx });
        return { ref: i.ref, files: files.length };
      }
      case 'cookies': {
        const op = s.op || 'get';
        if (op === 'get') { const r = await this.router.send(tab, 'Network.getCookies', s.urls ? { urls: [].concat(s.urls) } : {}); return r.cookies.map((c) => ({ name: c.name, value: c.value, domain: c.domain, path: c.path, expires: c.expires, httpOnly: c.httpOnly, secure: c.secure, sameSite: c.sameSite })); }
        if (op === 'set') { const st = await this.docState(tab); const r = await this.router.send(tab, 'Network.setCookie', { url: s.url || (s.domain ? undefined : st && st[2]), ...s.cookie, ...(s.name ? { name: s.name, value: String(s.value ?? '') } : {}), ...(s.domain ? { domain: s.domain } : {}), ...(s.path ? { path: s.path } : {}), ...(s.secure != null ? { secure: s.secure } : {}), ...(s.httpOnly != null ? { httpOnly: s.httpOnly } : {}), ...(s.expires ? { expires: s.expires } : {}) }); return { success: r.success !== false }; }
        if (op === 'delete') { const st = await this.docState(tab); await this.router.send(tab, 'Network.deleteCookies', { name: s.name, ...(s.domain ? { domain: s.domain } : { url: s.url || (st && st[2]) }) }); return {}; }
        if (op === 'clearAll') { await this.router.send(tab, 'Network.clearBrowserCookies', {}); return { cleared: true }; }
        throw new Error('cookies op must be get|set|delete|clearAll');
      }
      case 'storage': {
        const area = s.area === 'session' ? 'sessionStorage' : 'localStorage';
        const op = s.op || 'get';
        const k = JSON.stringify(s.key ?? null), v = JSON.stringify(s.value == null ? null : typeof s.value === 'string' ? s.value : JSON.stringify(s.value));
        const js = { get: `(${k} === null ? Object.fromEntries(Object.entries(${area})) : ${area}.getItem(${k}))`, set: `(${area}.setItem(${k}, ${v}), true)`, remove: `(${area}.removeItem(${k}), true)`, clear: `(${area}.clear(), true)` }[op];
        if (!js) throw new Error('storage op must be get|set|remove|clear');
        return this.evaluate(tab, js, { awaitPromise: false });
      }
      case 'downloads': return this.router.downloads(tab, s);
      case 'dialog': {
        const p = this.pendingDialog.get(tab);
        await this.router.send(tab, 'Page.handleJavaScriptDialog', { accept: s.accept !== false, ...(s.text != null ? { promptText: String(s.text) } : {}) });
        this.pendingDialog.delete(tab);
        return p ? { type: p.type, message: p.message } : {};
      }
      case 'viewport': await this.router.send(tab, 'Emulation.setDeviceMetricsOverride', { width: s.width || 1280, height: s.height || 800, deviceScaleFactor: s.scale || 1, mobile: !!s.mobile }); return {};
      case 'geolocation': {
        const lat = Number(s.latitude ?? s.lat), lon = Number(s.longitude ?? s.lon ?? s.lng), acc = Number(s.accuracy || 25);
        if (!isFinite(lat) || !isFinite(lon)) throw new Error('geolocation needs latitude and longitude');
        await this.router.send(tab, 'Emulation.setGeolocationOverride', { latitude: lat, longitude: lon, accuracy: acc }).catch(() => {});
        if (this.router.grantPermissions) await this.router.grantPermissions(tab, ['geolocation']).catch(() => {});
        const shim = GEO_SHIM(lat, lon, acc);
        await this.router.send(tab, 'Page.addScriptToEvaluateOnNewDocument', { source: shim }).catch(() => {});
        await this.evaluate(tab, shim, { awaitPromise: false }).catch(() => {});
        return { latitude: lat, longitude: lon };
      }
      case 'permissions': {
        if (!this.router.grantPermissions) throw new Error('permissions: not available here');
        await this.router.grantPermissions(tab, [].concat(s.grant || s.permissions || []));
        return { granted: [].concat(s.grant || s.permissions || []) };
      }
      case 'select': return this.helper(tab, 'select', [s.target, s.value ?? s.values, t], F);
      case 'check': return this.helper(tab, 'check', [s.target, s.checked !== false, t], F);
      case 'uncheck': return this.helper(tab, 'check', [s.target, false, t], F);
      case 'wait': {
        // Aliases models reach for: {for:'idle'|'load'|'network'|'networkidle'}, {until:...}, {timeout} alone = sleep.
        const alias = s.for || s.until;
        if (alias && typeof alias === 'string') { const a = alias.toLowerCase(); if (a.includes('idle')) s = { ...s, idle: true }; else if (a.includes('load') || a === 'domcontentloaded') s = { ...s, load: a === 'load' ? 'load' : 'domcontentloaded' }; else if (a.includes('network')) s = { ...s, idle: true }; }
        if (s.seconds && !s.ms) s = { ...s, ms: s.seconds * 1000 };
        if (s.ms) { await sleep(Math.min(s.ms, 30000)); return {}; }
        if (s.js) { // poll a JS condition (evaluated by CDP, so page CSP does not block it)
          const end = Date.now() + t, t0 = Date.now();
          while (Date.now() < end) { let v = false; try { v = await this.evaluate(tab, `!!(${s.js})`, { ctx: s.frame ? await this.frameCtx(tab, s.frame) : null }); } catch (_) {} if (v) return { waitedMs: Date.now() - t0 }; await sleep(60); }
          throw new Error(`Timeout ${t}ms waiting for ${String(s.js).slice(0, 80)}`);
        }
        if (s.network) return this.helper(tab, 'waitNetwork', [s.network, s.timeout || 10000, !!s.fresh], { retryUntil: Date.now() + (s.timeout || 10000) });
        if (s.idle) return this.helper(tab, 'waitIdle', [s.idle === true ? 200 : s.idle, s.timeout || 2000]);
        if (s.load) { const st = await this.docState(tab); if (st && (st[1] === 'complete' || (s.load !== 'load' && st[1] === 'interactive'))) return { url: st[2] }; return this.waitLoad(tab, null, s.load === 'load' ? 'load' : 'domcontentloaded', s.timeout || 15000); }
        if (s.url) {
          const deadline = Date.now() + t;
          while (Date.now() < deadline) {
            const st = await this.docState(tab);
            if (st && st[2].includes(s.url) && st[1] !== 'loading') return { url: st[2] };
            await sleep(20);
          }
          throw new Error(`Timeout waiting for url containing ${s.url}`);
        }
        const target = s.target ?? (s.text != null ? { text: s.text } : null);
        // Nothing specific to wait for: settle on page load (models often send {state:'visible'} alone).
        if (target == null) { const st = await this.docState(tab); if (st && st[1] !== 'loading') return { url: st[2] }; return this.waitLoad(tab, null, 'domcontentloaded', s.timeout || 15000); }
        return this.helper(tab, 'waitFor', [target, t, s.state || 'visible'], { retryUntil: Date.now() + t, ...F });
      }
      case 'extract': case 'text': case 'read':
        if (s.wait !== false && s.target != null && !s.all) await this.helper(tab, 'waitFor', [s.target, t, 'attached'], { retryUntil: Date.now() + t, ...F });
        return this.helper(tab, 'extract', [s.target ?? null, s.what || 'text', s.attr || null, !!s.all, s.max || 200, !!opts.redactPasswords], F);
      case 'table':
        if (s.target != null) await this.helper(tab, 'waitFor', [s.target, t, 'attached'], { retryUntil: Date.now() + t, ...F });
        return this.helper(tab, 'table', [s.target ?? null, s.max || 200], F);
      case 'media': return this.helper(tab, 'media', [s.target ?? null, s.op || 'info', s.op === 'seek' ? s.time : s.muted], F);
      case 'pdf': {
        const st = await this.docState(tab);
        const url = s.url || (st && st[2]);
        const buf = await this.fetchBytes(tab, url);
        return { url, ...pdfText(buf, s.max || 20000) };
      }
      case 'eval': return this.evaluate(tab, s.js ?? s.expression, { ctx: s.frame ? await this.frameCtx(tab, s.frame) : null });
      case 'scroll': {
        if (s.find != null || s.untilVisible) return this.helper(tab, 'scrollToFind', [s.find ?? s.target, s.maxScrolls || 20, s.dy ?? 500], F);
        return this.helper(tab, 'scroll', [s.target ?? null, s.dy ?? 600, s.dx ?? 0], F);
      }
      case 'diagnostics': return this.helper(tab, 'diagnostics', [!!s.clear], F);
      case 'snapshot': return this.snapshot(tab, s);
      case 'screenshot': return this.screenshot(tab, s);
      case 'back': case 'forward': {
        const st = await this.docState(tab);
        await this.evaluate(tab, s.action === 'back' ? 'history.back()' : 'history.forward()', { awaitPromise: false });
        try { return await this.waitLoad(tab, st ? st[0] : null, 'domcontentloaded', s.timeout || 8000, 1200, st ? st[2] : null); } catch (_) { return {}; }
      }
      case 'reload': {
        const st = await this.docState(tab);
        await this.router.send(tab, 'Page.reload', {});
        return this.waitLoad(tab, st ? st[0] : null, s.wait || 'domcontentloaded', s.timeout || 15000);
      }
      default: throw new Error(`Unknown action "${s.action}"`);
    }
  }

  /**
   * Run a batch of steps on one tab with per-step timings.
   * guard(step, i) runs before each step (security policy); it may throw to refuse the step, or return
   * { approval } to pass a user approval id through to the browser.
   */
  async run(tab, steps, { stopOnError = true, snapshot = 'none', snapshotMax, guard, redactPasswords = false, dialogs } = {}) {
    const t0 = performance.now();
    const results = [];
    let ok = true;
    if (dialogs) this.dialogMode.set(tab, dialogs);
    for (let i = 0; i < steps.length; i++) {
      const s = steps[i];
      const st = performance.now();
      try {
        const g = guard ? await guard(s, i) : null;
        const value = await this.step(tab, s, { redactPasswords, approval: g && g.approval });
        const r = { i, action: s.action, ok: true, ms: +(performance.now() - st).toFixed(1) };
        const dl = this.dialogs.get(tab);
        let v = value;
        if (dl && dl.length) { v = v && typeof v === 'object' && !Array.isArray(v) ? { ...v, dialogs: dl.splice(0) } : { value: v, dialogs: dl.splice(0) }; }
        if (v !== undefined && !(v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 0)) r.value = v;
        results.push(r);
      } catch (e) {
        ok = false;
        const r = { i, action: s.action, ok: false, ms: +(performance.now() - st).toFixed(1), error: e.message };
        if (e.denied) r.denied = true;
        results.push(r);
        if (e.denied || (stopOnError && !s.optional)) { if (s.optional && !e.denied) continue; break; }
      }
    }
    if (results.length && results.every((r) => r.ok || (steps[r.i].optional && !r.denied))) ok = true;
    const out = { ok, tab, results };
    // On a failed step always attach a compact snapshot so the agent can pick a valid target next turn.
    const mode = snapshot && snapshot !== 'none' ? snapshot : ok ? null : 'compact';
    if (mode) {
      try { out.snapshot = await this.snapshot(tab, { mode, ...(snapshotMax ? { max: snapshotMax } : {}) }); } catch (e) { out.snapshotError = e.message; }
    }
    out.totalMs = +(performance.now() - t0).toFixed(1);
    return out;
  }
}

export function formatSnapshot(s) {
  if (!s) return '';
  const head = `${s.title ? s.title + ' - ' : ''}${s.url}`;
  if (s.mode === 'compact') return [`${head}  [compact ${s.lines.length} lines]`, ...s.lines].join('\n');
  if (s.mode === 'diff') {
    if (!s.added.length && !s.removed.length) return `${head}\n(no change, ${s.unchanged} lines)`;
    return [`${head}  [diff: +${s.added.length} -${s.removed.length}, ${s.unchanged} unchanged]`, ...s.removed.map((l) => '- ' + l), ...s.added.map((l) => '+ ' + l)].join('\n');
  }
  return [head, ...s.lines].join('\n');
}