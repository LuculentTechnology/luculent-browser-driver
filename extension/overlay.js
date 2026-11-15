// Luculent AI cursor, cowork indicator and optional input block. pointer-events stay off on the cursor so
// it never intercepts the user's mouse. "When you click in the AI's tab" (T1288):
//   cowork  (default) trusted clicks, keys and scrolls are reported so the AI holds, then continues from your state
//   pause   your input pauses the task until you press Resume
//   disable the block overlay captures input, except for Take back control (which also pauses the agent)
// The killswitch is not gated here (it lives in the popup and Alt+Shift+K).
(() => {
  if (window.__lbdOverlay) return;
  window.__lbdOverlay = true;
  const CURSOR_ID = '__lbd_ai_cursor';
  const BLOCK_ID = '__lbd_input_block';
  const PILL_ID = '__lbd_cowork';
  const FONT = '"Luculent Sans v2","Luculent Sans",Geist,Inter,ui-sans-serif,system-ui,sans-serif';
  let watching = false;
  let mode = 'cowork';
  let blockOn = false;
  let pillTimer = null;
  const lastSent = {};

  const ours = (t) => !!(t && t.closest && t.closest('#' + CURSOR_ID + ',#' + BLOCK_ID + ',#' + PILL_ID));
  const mount = (el) => (document.documentElement || document.body).appendChild(el);
  // No innerHTML anywhere: sites that enforce Trusted Types (GitHub, Google) reject string HTML even from extensions.
  const h = (tag, style, text) => { const e = document.createElement(tag); if (style) e.style.cssText = style; if (text != null) e.textContent = text; return e; };
  const svgCursor = () => {
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    for (const [k, v] of [['width', '18'], ['height', '18'], ['viewBox', '0 0 18 18'], ['fill', 'none']]) svg.setAttribute(k, v);
    const path = document.createElementNS(NS, 'path');
    for (const [k, v] of [['d', 'M2 2 L2 14 L6.2 10.8 L9.8 16.2 L12.2 14.8 L8.6 9.4 L14 9.4 Z'], ['fill', '#1a1a1a'], ['stroke', '#f4efe6'], ['stroke-width', '1.2'], ['stroke-linejoin', 'round']]) path.setAttribute(k, v);
    svg.appendChild(path);
    return svg;
  };

  const cursorEl = (label) => {
    let el = document.getElementById(CURSOR_ID);
    if (!el) {
      el = document.createElement('div');
      el.id = CURSOR_ID;
      el.setAttribute('aria-hidden', 'true');
      el.style.cssText = 'position:fixed;left:0;top:0;z-index:2147483646;pointer-events:none;width:18px;height:18px;margin-left:-2px;margin-top:-2px;transition:transform 140ms cubic-bezier(.22,1,.36,1),opacity 120ms;opacity:0;will-change:transform;';
      el.appendChild(svgCursor());
      el.appendChild(h('div', 'position:absolute;left:16px;top:14px;background:#1a1a1a;color:#f4efe6;font:11px/1.2 ui-sans-serif,system-ui,sans-serif;padding:2px 6px;border-radius:3px;white-space:nowrap;letter-spacing:.02em;'));
      mount(el);
    }
    const tag = el.querySelector('div');
    if (tag && label) tag.textContent = String(label).slice(0, 40);
    return el;
  };
  const moveCursor = (x, y, label) => {
    const el = cursorEl(label);
    el.style.opacity = '1';
    el.style.transform = 'translate(' + Number(x || 0) + 'px,' + Number(y || 0) + 'px)';
  };
  const hideCursor = () => { const el = document.getElementById(CURSOR_ID); if (el) el.style.opacity = '0'; };

  const setBlock = (on) => {
    blockOn = !!on;
    let el = document.getElementById(BLOCK_ID);
    if (!on) { if (el) el.remove(); return; }
    if (el) return;
    el = document.createElement('div');
    el.id = BLOCK_ID;
    el.style.cssText = 'position:fixed;inset:0;z-index:2147483645;background:transparent;pointer-events:auto;';
    const bar = h('div', 'position:absolute;top:0;left:0;right:0;display:flex;align-items:center;gap:12px;padding:6px 12px;background:#2a2a2e;color:#e8e6e3;font:12px/1.3 ui-sans-serif,system-ui,sans-serif;pointer-events:auto;box-shadow:0 1px 0 rgba(0,0,0,.25);');
    bar.appendChild(h('span', 'flex:1;letter-spacing:.01em;', 'Luculent is working in this tab'));
    const tb = h('button', 'appearance:none;border:1px solid #6a6a70;background:transparent;color:#e8e6e3;font:12px/1 ui-sans-serif,system-ui,sans-serif;padding:4px 10px;border-radius:3px;cursor:pointer;', 'Take back control');
    tb.type = 'button';
    tb.id = '__lbd_take_back';
    bar.appendChild(tb);
    el.appendChild(bar);
    const absorb = (e) => {
      if (e.target && e.target.closest && e.target.closest('#__lbd_take_back')) return;
      e.preventDefault();
      e.stopPropagation();
    };
    for (const ev of ['mousedown', 'mouseup', 'click', 'auxclick', 'contextmenu', 'pointerdown', 'pointerup', 'wheel', 'keydown', 'keyup', 'keypress']) el.addEventListener(ev, absorb, true);
    mount(el);
    el.querySelector('#__lbd_take_back').addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      try { chrome.runtime.sendMessage({ type: 'overlay.takeBack' }); } catch (_) {}
      setBlock(false);
      hideCursor();
    });
  };

  // Subtle Luculent-style status pill, bottom right. Graphite with a gold hairline; never red.
  const pill = (state) => {
    let el = document.getElementById(PILL_ID);
    if (pillTimer) { clearTimeout(pillTimer); pillTimer = null; }
    if (!state || state === 'off') { if (el) { el.style.opacity = '0'; setTimeout(() => { const x = document.getElementById(PILL_ID); if (x && x.style.opacity === '0') x.remove(); }, 200); } return; }
    if (!el) {
      el = document.createElement('div');
      el.id = PILL_ID;
      el.setAttribute('role', 'status');
      el.setAttribute('aria-live', 'polite');
      el.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483646;display:flex;align-items:center;gap:10px;max-width:340px;padding:8px 12px;border-radius:8px;background:#28282D;color:#FBFBFC;border:1px solid rgba(227,188,87,.38);box-shadow:0 6px 24px rgba(3,3,6,.35);font:12px/1.35 ' + FONT + ';letter-spacing:.01em;pointer-events:none;opacity:0;transition:opacity 160ms ease;';
      mount(el);
    }
    const body = (title, subText, grow) => {
      const wrap = h('span', grow ? 'flex:1;' : '');
      wrap.appendChild(h('b', 'font-weight:600;', title));
      wrap.appendChild(h('span', 'display:block;color:rgba(251,251,252,.68);font-size:11px;', subText));
      return wrap;
    };
    el.replaceChildren(h('span', 'flex:none;width:7px;height:7px;border-radius:50%;background:#E3BC57;box-shadow:0 0 0 3px rgba(227,188,87,.16);'));
    if (state === 'cowork') {
      el.appendChild(body('You\u2019re coworking', 'Luculent waits, then continues from where you leave it.'));
    } else if (state === 'resumed') {
      el.appendChild(body('Luculent picks up from here', 'Thanks for the help.'));
      pillTimer = setTimeout(() => pill('off'), 1800);
    } else if (state === 'paused') {
      el.appendChild(body('Paused', 'You clicked in the AI\u2019s tab. Resume when you\u2019re ready.', true));
      const b = h('button', 'appearance:none;pointer-events:auto;border:0;border-radius:8px;padding:5px 12px;background:radial-gradient(ellipse 125% 170% at 100% 0%,#FFE7A0 0%,#FAD56C 40%,#E3BC57 100%);color:#030306;font:600 12px/1 ' + FONT + ';cursor:pointer;', 'Resume');
      b.type = 'button';
      b.id = '__lbd_resume';
      b.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); try { chrome.runtime.sendMessage({ type: 'overlay.resumeUser' }); } catch (_) {} pill('resumed'); }, true);
      el.appendChild(b);
    }
    requestAnimationFrame(() => { el.style.opacity = '1'; });
  };

  const report = (e) => {
    if (!watching || blockOn || !e.isTrusted || ours(e.target)) return;
    if (mode !== 'cowork' && mode !== 'pause') return;
    const now = Date.now();
    const gap = e.type === 'wheel' ? 250 : 60;
    if (lastSent[e.type] && now - lastSent[e.type] < gap) return;
    lastSent[e.type] = now;
    try { chrome.runtime.sendMessage({ type: 'overlay.userInput', kind: e.type, at: now }); } catch (_) {}
  };
  for (const ev of ['pointerdown', 'keydown', 'wheel', 'touchstart']) window.addEventListener(ev, report, { capture: true, passive: true });

  chrome.runtime.onMessage.addListener((m) => {
    if (!m || !m.type) return;
    if (m.type === 'overlay.cursor') {
      if (m.on === false) hideCursor();
      else moveCursor(m.x, m.y, m.label);
    } else if (m.type === 'overlay.block') {
      setBlock(!!m.on);
    } else if (m.type === 'overlay.watch') {
      watching = m.on !== false;
      if (m.mode) mode = m.mode;
    } else if (m.type === 'overlay.interaction') {
      if (m.mode) mode = m.mode;
      pill(m.state);
    } else if (m.type === 'overlay.idle') {
      setBlock(false);
      hideCursor();
    } else if (m.type === 'overlay.end') {
      watching = false;
      setBlock(false);
      hideCursor();
      pill('off');
    }
  });
})();
