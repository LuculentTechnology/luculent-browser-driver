// In-page helper injected with Runtime.evaluate. Idempotent: installs window.__lbd once per document.
// Kept dependency-free and ES2020 so it runs in any Chromium page.
export const HELPER_VERSION = 12;

export const HELPER_SRC = String.raw`(() => {
  if (window.__lbd && window.__lbd.v === ${HELPER_VERSION}) return window.__lbd;
  if (!window.__lbdDiag) {
    const diag = { console: [], errors: [], push(arr, item) { arr.push(item); if (arr.length > 100) arr.shift(); } };
    window.__lbdDiag = diag;
    addEventListener('error', (e) => { diag.push(diag.errors, { type: 'error', message: String(e.message || ''), filename: String(e.filename || '').slice(-80), lineno: e.lineno || 0, at: Date.now() }); });
    addEventListener('unhandledrejection', (e) => { diag.push(diag.errors, { type: 'unhandledrejection', message: String((e.reason && (e.reason.message || e.reason)) || 'Promise rejected'), at: Date.now() }); });
    for (const lvl of ['error', 'warn']) {
      const orig = console[lvl];
      if (typeof orig === 'function') {
        console[lvl] = function(...args) {
          try { diag.push(diag.console, { level: lvl, text: args.map((x) => (typeof x === 'string' ? x : (x && x.message) || JSON.stringify(x))).join(' ').slice(0, 400), at: Date.now() }); } catch (_) {}
          return orig.apply(this, args);
        };
      }
    }
  }
  let seq = 0;
  const refMap = new Map();
  const elRef = new WeakMap();
  const norm = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
  const refOf = (el) => {
    let r = elRef.get(el);
    if (!r) { r = 'e' + (++seq); elRef.set(el, r); refMap.set(r, new WeakRef(el)); }
    return r;
  };
  const visible = (el) => {
    if (!el || !el.isConnected) return false;
    if (el.checkVisibility) {
      if (!el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
    } else {
      const s = getComputedStyle(el);
      if (s.visibility === 'hidden' || s.display === 'none') return false;
    }
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const TAG_ROLE = { BUTTON: 'button', SELECT: 'combobox', TEXTAREA: 'textbox', H1: 'heading', H2: 'heading',
    H3: 'heading', H4: 'heading', H5: 'heading', H6: 'heading', IMG: 'img', NAV: 'navigation', MAIN: 'main',
    FORM: 'form', LI: 'listitem', UL: 'list', OL: 'list', TABLE: 'table', OPTION: 'option', DIALOG: 'dialog',
    SUMMARY: 'button', TR: 'row', TD: 'cell', TH: 'columnheader', HEADER: 'banner', FOOTER: 'contentinfo' };
  const INPUT_ROLE = { checkbox: 'checkbox', radio: 'radio', submit: 'button', button: 'button', reset: 'button',
    image: 'button', range: 'slider', search: 'searchbox', email: 'textbox', number: 'spinbutton', hidden: null };
  const role = (el) => {
    const r = el.getAttribute && el.getAttribute('role');
    if (r) return r.split(' ')[0];
    if (el.tagName === 'INPUT') {
      const t = (el.getAttribute('type') || 'text').toLowerCase();
      return t in INPUT_ROLE ? INPUT_ROLE[t] : 'textbox';
    }
    if (el.tagName === 'A') return el.hasAttribute('href') ? 'link' : null;
    if (el.isContentEditable && el.getAttribute('contenteditable') !== null) return 'textbox';
    return TAG_ROLE[el.tagName] || null;
  };
  const INTERACTIVE_ROLES = new Set(['button', 'link', 'textbox', 'searchbox', 'combobox', 'checkbox', 'radio',
    'slider', 'spinbutton', 'switch', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'option', 'listbox',
    'treeitem']);
  const INTERACTIVE_SEL = 'a[href],button,input,select,textarea,summary,[role=button],[role=link],[role=tab],[role=menuitem],[role=checkbox],[role=radio],[role=switch],[role=option],[contenteditable=""],[contenteditable=true],[onclick],[tabindex]:not([tabindex="-1"])';
  const isInteractive = (el, r) => {
    if (INTERACTIVE_ROLES.has(r)) return true;
    if (el.tagName === 'INPUT' && r !== null) return true;
    if (el.hasAttribute('onclick')) return true;
    const ti = el.getAttribute('tabindex');
    return ti !== null && ti !== '-1' && !/^(HTML|BODY|MAIN|DIV|SECTION)$/.test(el.tagName) ? true : false;
  };
  const name = (el) => {
    const a = el.getAttribute('aria-label');
    if (a) return norm(a);
    const lb = el.getAttribute('aria-labelledby');
    if (lb) {
      const t = lb.split(/\s+/).map((id) => { const n = document.getElementById(id); return n ? n.innerText || n.textContent : ''; }).join(' ');
      if (norm(t)) return norm(t);
    }
    if (el.labels && el.labels.length) { const t = norm(Array.from(el.labels).map((l) => l.innerText || l.textContent).join(' ')); if (t) return t; }
    if (el.tagName === 'IMG') return norm(el.getAttribute('alt') || el.getAttribute('title') || '');
    if (el.tagName === 'INPUT') {
      const t = (el.type || '').toLowerCase();
      if (t === 'submit' || t === 'button' || t === 'reset') return norm(el.value || t);
      return norm(el.getAttribute('placeholder') || el.getAttribute('title') || el.getAttribute('name') || '');
    }
    if (el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') return norm(el.getAttribute('placeholder') || el.getAttribute('title') || el.getAttribute('name') || '');
    const t = norm(el.innerText || el.textContent || '');
    if (t) return t;
    return norm(el.getAttribute('title') || '');
  };
  const parse = (t) => {
    if (t && typeof t === 'object') return t;
    const s = String(t == null ? '' : t).trim();
    if (/^e\d+$/.test(s)) return { ref: s };
    { const m = /^(?:\[|@|ref:\s*|\(ref[:=]\s*|ref\s+)(e\d+)[\])]?$/i.exec(s); if (m) return { ref: m[1].toLowerCase() }; } // models often copy "[e12]", "(ref: e12)", "ref e12"
    if (s.startsWith('ref=')) return { ref: s.slice(4).trim() };
    if (/^text=/i.test(s)) { const v = s.slice(5).trim(); const q = /^["'](.*)["']$/.exec(v); return q ? { text: q[1], exact: true } : { text: v }; }
    if (/^(?:css|selector)=/i.test(s)) return { css: s.replace(/^(?:css|selector)=/i, '').trim() };
    if (/^xpath=/i.test(s)) return { xpath: s.slice(6).trim() };
    if (/^(?:label|aria-label)=/i.test(s)) return { label: s.replace(/^(?:label|aria-label)=/i, '').trim().replace(/^["']|["']$/g, '') };
    if (/^placeholder=/i.test(s)) return { placeholder: s.slice(12).trim().replace(/^["']|["']$/g, '') };
    if (/^(?:testid|data-testid)=/i.test(s)) {
      const v = s.replace(/^(?:testid|data-testid)=/i, '').trim().replace(/^["']|["']$/g, '');
      return { css: '[data-testid="' + (typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(v) : v.replace(/["\\]/g, '\\$&')) + '"]' };
    }
    if (/^name=/i.test(s)) {
      const v = s.slice(5).trim().replace(/^["']|["']$/g, '');
      return { css: '[name="' + (typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(v) : v.replace(/["\\]/g, '\\$&')) + '"]' };
    }
    if (/^id=/i.test(s)) {
      const v = s.slice(3).trim().replace(/^["'#]|["']$/g, '');
      return { css: '#' + (typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(v) : v.replace(/["\\]/g, '\\$&')) };
    }
    if (/^role=/i.test(s)) {
      const m = /^role=([a-z]+)(?:\[(?:name=)?(?:"([^"]*)"|'([^']*)'|([^\]]*))\])?$/i.exec(s);
      if (m) return { role: m[1].toLowerCase(), name: m[2] ?? m[3] ?? m[4] };
    }
    // Natural-language role+name shorthand: e.g. 'button "Sign in"', "link 'Docs'", 'tab "Testing"'
    {
      const m = /^(button|link|tab|menuitem|checkbox|radio|switch|option|combobox|textbox|searchbox|heading)\s+(?:"([^"]+)"|'([^']+)'|\[name=(?:"([^"]+)"|'([^']+)'|([^\]]+))\])\s*$/i.exec(s);
      if (m) return { role: m[1].toLowerCase(), name: m[2] ?? m[3] ?? m[4] ?? m[5] ?? m[6] };
    }
    if (/^\/\//.test(s) || /^\(\/\//.test(s)) return { xpath: s };
    try { document.querySelector(s); return { css: s }; } catch (_) { return { text: s.replace(/^["']|["']$/g, '') }; }
  };
  const desc = (t) => JSON.stringify(t);
  const match = (hay, needle, exact) => {
    const rx = typeof needle === 'string' && /^\/(.+)\/([dgimsuy]*)$/.exec(needle.trim());
    if (rx) { try { return new RegExp(rx[1], rx[2].replace('g', '')).test(norm(hay)); } catch (_) {} }
    const h = norm(hay).toLowerCase(); const n = norm(needle).toLowerCase();
    return exact ? h === n : h.includes(n);
  };
  const pick = (list, nth) => {
    const arr = Array.from(list);
    if (typeof nth === 'number') return arr[nth] || null;
    return arr.find(visible) || arr[0] || null;
  };
  const deepAll = (sel, root = document) => {
    const out = Array.from(root.querySelectorAll(sel));
    const hosts = root.querySelectorAll('*');
    for (const h of hosts) if (h.shadowRoot) out.push(...deepAll(sel, h.shadowRoot));
    return out;
  };
  const byText = (needle, exact, nth) => {
    const cands = [];
    for (const el of deepAll(INTERACTIVE_SEL)) if (match(name(el), needle, exact) || (el.getAttribute('placeholder') && match(el.getAttribute('placeholder'), needle, exact)) || (el.getAttribute('title') && match(el.getAttribute('title'), needle, exact))) cands.push(el);
    if (!cands.length || (!exact && !cands.some(visible))) {
      const w = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT);
      while (w.nextNode()) {
        const n = w.currentNode;
        if (!n.nodeValue || !n.nodeValue.trim()) continue;
        const p = n.parentElement;
        if (!p || /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/.test(p.tagName)) continue;
        if (match(n.nodeValue, needle, exact) || match(p.innerText || '', needle, true)) cands.push(p.closest(INTERACTIVE_SEL) || p);
      }
    }
    if (exact) cands.sort((a, b) => (match(name(b), needle, true) ? 1 : 0) - (match(name(a), needle, true) ? 1 : 0));
    else cands.sort((a, b) => (match(name(b), needle, true) ? 1 : 0) - (match(name(a), needle, true) ? 1 : 0));
    return pick(cands, nth);
  };
  const resolveAll = (target) => {
    const t = parse(target);
    if (t.ref && !refMap.has(t.ref)) throw new Error('Ref ' + t.ref + ' is not on this page (refs reset when the page changes). Take browser_snapshot for fresh refs, or target by text=, label=, role= or css.');
    if (t.ref) { const w = refMap.get(t.ref); const el = w && w.deref(); return el && el.isConnected ? [el] : []; }
    if (t.css) return deepAll(t.css);
    if (t.xpath) { const r = document.evaluate(t.xpath, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null); const a = []; for (let i = 0; i < r.snapshotLength; i++) a.push(r.snapshotItem(i)); return a; }
    if (t.placeholder) return deepAll('input,textarea,[placeholder]').filter((el) => match(el.getAttribute('placeholder') || '', t.placeholder, !!t.exact));
    if (t.label) return deepAll('input,select,textarea,[role=textbox],[role=combobox],[role=searchbox],[role=spinbutton],[role=checkbox],[role=radio],[role=switch],[role=slider],[contenteditable=\"\"],[contenteditable=true]').filter((el) => match(name(el), t.label, !!t.exact));
    if (t.role) return deepAll('*').filter((el) => role(el) === t.role && (t.name == null || match(name(el), t.name, !!t.exact)));
    if (t.text != null) { const el = byText(t.text, !!t.exact); return el ? [el] : []; }
    return [];
  };
  const resolve = (target) => {
    const t = parse(target);
    if (t.text != null && !t.role && !t.css) return byText(t.text, !!t.exact, t.nth);
    return pick(resolveAll(t), t.nth);
  };
  const info = (el) => ({ ref: refOf(el), role: role(el) || el.tagName.toLowerCase(), name: clip(name(el), 80) });
  const waitFor = (target, timeout = 5000, state = 'visible') => new Promise((res, rej) => {
    let done = false, pending = false;
    const finish = (fn, v) => { if (done) return; done = true; mo.disconnect(); clearInterval(iv); clearTimeout(to); fn(v); };
    const check = () => {
      pending = false;
      let el = null;
      try {
        const t = parse(target);
        // With several matches (responsive layouts often render a hidden mobile copy first), "visible" means any
        // match is visible and "hidden" means none is. An explicit nth or ref still pins one element.
        if ((state === 'visible' || state === 'hidden') && t.nth == null && !t.ref && !(t.text != null && !t.role && !t.css)) {
          const all = resolveAll(t);
          el = all.find((x) => visible(x)) || (state === 'visible' ? all[0] : null) || null;
        } else el = resolve(target);
      } catch (e) { return finish(rej, e); }
      const ok = state === 'hidden' || state === 'detached' ? !el || (state === 'hidden' && !visible(el)) : state === 'attached' ? !!el : !!el && visible(el);
      if (ok) finish(res, el ? info(el) : null);
    };
    const mo = new MutationObserver(() => { if (!pending) { pending = true; Promise.resolve().then(check); } });
    mo.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
    const iv = setInterval(check, 40);
    const to = setTimeout(() => finish(rej, new Error('Timeout ' + timeout + 'ms waiting for ' + desc(parse(target)) + ' to be ' + state)), timeout);
    check();
  });
  // Wait (max ~1.5 s) until the element stops moving or fading: clicks during slide/fade-in animations often land on
  // nothing or before handlers are bound. Cheap when the element is already still (one 50 ms sample).
  const fadeOf = (el) => { let o = 1; for (let e = el; e && e.nodeType === 1; e = e.parentElement) o *= Number(getComputedStyle(e).opacity); return o; };
  const sampleOf = (el) => { const r = el.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height), Math.round(fadeOf(el) * 100)].join(','); };
  const settle = async (el) => {
    const t0 = performance.now();
    let prev = sampleOf(el);
    while (performance.now() - t0 < 1500) {
      await new Promise((r) => setTimeout(r, 50));
      const now = sampleOf(el);
      if (now === prev && !now.endsWith(',0') && Number(now.split(',').pop()) >= 99) return;
      if (now === prev && Number(now.split(',').pop()) > 0 && performance.now() - t0 > 300) return;
      prev = now;
    }
  };
  const point = async (target, timeout = 5000) => {
    const i = await waitFor(target, timeout, 'visible');
    const el = refMap.get(i.ref).deref();
    // Only scroll when the element is not fully on screen: needless scrolling moves the page under a held mouse
    // button (drag and drop) and fights sticky headers.
    { const r0 = el.getBoundingClientRect(); if (r0.top < 0 || r0.left < 0 || r0.bottom > innerHeight || r0.right > innerWidth || r0.width === 0) el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' }); }
    await settle(el);
    const r = el.getBoundingClientRect();
    const x = r.left + r.width / 2, y = r.top + r.height / 2;
    const hit = document.elementFromPoint(x, y);
    const deepContains = (a, b) => { for (let n = b; n; n = n.parentNode || n.host) if (n === a) return true; return false; };
    let hitDeep = hit; while (hitDeep && hitDeep.shadowRoot) { const inner = hitDeep.shadowRoot.elementFromPoint(x, y); if (!inner || inner === hitDeep) break; hitDeep = inner; }
    const covered = !!hitDeep && hitDeep !== el && !deepContains(el, hitDeep) && !deepContains(hitDeep, el);
    return { x, y, covered, left: r.left, top: r.top, w: r.width, h: r.height, ...i };
  };
  const focus = async (target, clear = true, timeout = 5000) => {
    const i = await waitFor(target, timeout, 'visible');
    const el = refMap.get(i.ref).deref();
    el.scrollIntoView({ block: 'center', behavior: 'instant' });
    el.focus();
    if (clear) {
      if ('value' in el && typeof el.select === 'function') { el.select(); }
      else if (el.isContentEditable) { const s = getSelection(); const rg = document.createRange(); rg.selectNodeContents(el); s.removeAllRanges(); s.addRange(rg); }
    } else if ('value' in el && typeof el.setSelectionRange === 'function') {
      try { const n = el.value.length; el.setSelectionRange(n, n); } catch (_) {}
    }
    return i;
  };
  const setNative = (el, prop, v) => {
    let cur = Object.getPrototypeOf(el);
    let d = null;
    while (cur && !d) {
      d = Object.getOwnPropertyDescriptor(cur, prop);
      cur = Object.getPrototypeOf(cur);
    }
    const prev = el[prop];
    if (d && d.set) d.set.call(el, v); else el[prop] = v;
    if (el._valueTracker && typeof el._valueTracker.setValue === 'function') {
      try { el._valueTracker.setValue(prev); } catch (_) {}
    }
  };
  const fill = async (target, value, timeout = 5000) => {
    const i = await waitFor(target, timeout, 'attached');
    const el = refMap.get(i.ref).deref();
    el.focus();
    if (el.isContentEditable && !('value' in el)) {
      el.textContent = String(value ?? '');
      el.dispatchEvent(new InputEvent('input', { bubbles: true, data: String(value ?? ''), inputType: 'insertText' }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return i;
    }
    setNative(el, 'value', value);
    el.dispatchEvent(new InputEvent('input', { bubbles: true, data: String(value ?? ''), inputType: 'insertText' }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return i;
  };
  const select = async (target, values, timeout = 5000) => {
    const i = await waitFor(target, timeout, 'attached');
    const el = refMap.get(i.ref).deref();
    const want = (Array.isArray(values) ? values : [values]).map(String);
    if (el.tagName !== 'SELECT') {
      // Custom ARIA / Radix / Headless-UI / Select2 combobox or listbox trigger
      el.scrollIntoView({ block: 'center', behavior: 'instant' });
      el.click();
      await new Promise((r) => setTimeout(r, 80));
      let picked = null;
      for (const w of want) {
        const opts = deepAll('[role="option"], [role="menuitem"], [role="menuitemradio"], [data-radix-collection-item], .select2-results__option, li[role]');
        const cand = opts.find((o) => visible(o) && (match(name(o), w, true) || o.getAttribute('data-value') === w || o.getAttribute('value') === w))
          || opts.find((o) => visible(o) && match(name(o), w, false))
          || byText(w, true) || byText(w, false);
        if (cand) {
          cand.scrollIntoView({ block: 'nearest', behavior: 'instant' });
          cand.click();
          picked = w;
        }
      }
      if (!picked) throw new Error('No custom dropdown option matching ' + JSON.stringify(want));
      return { ...i, value: picked, customSelect: true };
    }
    let hit = 0;
    for (const o of el.options) {
      const on = want.includes(o.value) || want.some((w) => match(o.label || o.text, w, true)) || want.some((w) => match(o.label || o.text, w, false));
      if (el.multiple) { o.selected = on; if (on) hit++; }
      else if (on && !hit) { setNative(el, 'value', o.value); hit++; }
    }
    if (!hit) throw new Error('No option matching ' + JSON.stringify(want));
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { ...i, value: el.value };
  };
  const check = async (target, on = true, timeout = 5000) => {
    const i = await waitFor(target, timeout, 'attached');
    const el = refMap.get(i.ref).deref();
    const cur = 'checked' in el ? el.checked : el.getAttribute('aria-checked') === 'true';
    if (cur !== !!on) el.click();
    return { ...i, checked: 'checked' in el ? el.checked : el.getAttribute('aria-checked') === 'true' };
  };
  const domClick = async (target, timeout = 5000) => {
    const i = await waitFor(target, timeout, 'visible');
    refMap.get(i.ref).deref().click();
    return i;
  };
  const extract = (target, what = 'text', attr, all = false, max = 200, redact = false) => {
    const els = target == null ? [document.body] : all ? resolveAll(target).slice(0, max) : [resolve(target)].filter(Boolean);
    if (!els.length) throw new Error('No element for ' + desc(parse(target)));
    const val = (el) => {
      const isPw = el.tagName === 'INPUT' && (el.type || '').toLowerCase() === 'password';
      if (redact && isPw && (what === 'value' || (what === 'attr' && /^value$/i.test(attr || '')))) return el.value ? '[redacted: password field]' : '';
      if (what === 'html') { const h = el.outerHTML.slice(0, 20000); return redact ? h.replace(/<input\b[^>]*>/gi, (tag) => (/type\s*=\s*["']?password/i.test(tag) ? tag.replace(/\svalue\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/i, ' value="[redacted]"') : tag)) : h; }
      if (what === 'value') return 'value' in el ? el.value : null;
      if (what === 'attr') return el.getAttribute(attr);
      if (what === 'href') return el.href || null;
      if (what === 'info') return info(el);
      return clip(norm(el.innerText || el.textContent || ''), 20000);
    };
    return all ? els.map(val) : val(els[0]);
  };
  const scroll = (target, dy = 600, dx = 0) => {
    if (target != null) { const el = resolve(target); if (!el) throw new Error('No element for ' + desc(parse(target))); el.scrollIntoView({ block: 'center', behavior: 'instant' }); return info(el); }
    window.scrollBy({ left: dx, top: dy, behavior: 'instant' });
    return { x: scrollX, y: scrollY };
  };
  const waitNetwork = (needle, timeout = 10000, fresh = false) => new Promise((res, rej) => {
    const t0 = performance.now();
    const hit = (e) => e.name.includes(needle) && e.responseEnd > 0 && (!fresh || e.startTime >= t0);
    const found = performance.getEntriesByType('resource').reverse().find(hit);
    if (found) return res({ url: found.name, ms: Math.round(found.duration), status: found.responseStatus });
    const po = new PerformanceObserver((list) => { const e = list.getEntries().find(hit); if (e) { po.disconnect(); clearTimeout(to); res({ url: e.name, ms: Math.round(e.duration), status: e.responseStatus }); } });
    po.observe({ type: 'resource', buffered: false });
    const to = setTimeout(() => { po.disconnect(); rej(new Error('Timeout ' + timeout + 'ms waiting for a network response matching ' + JSON.stringify(needle))); }, timeout);
  });
  const waitIdle = (idle = 500, timeout = 15000) => new Promise((res, rej) => {
    let last = performance.now();
    const po = new PerformanceObserver(() => { last = performance.now(); });
    po.observe({ type: 'resource', buffered: false });
    const mo = new MutationObserver(() => { last = performance.now(); });
    mo.observe(document, { subtree: true, childList: true });
    const start = performance.now();
    const iv = setInterval(() => {
      const now = performance.now();
      if (now - last >= idle) { done(); res({ idleMs: idle, waitedMs: Math.round(now - start) }); }
      else if (now - start > timeout) { done(); rej(new Error('Timeout ' + timeout + 'ms waiting for network/DOM idle')); }
    }, 25);
    const done = () => { clearInterval(iv); po.disconnect(); mo.disconnect(); };
  });
  const SKIP = /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|SVG|PATH|META|LINK|HEAD)$/;
  const snapshot = (opts) => {
    const o = Object.assign({ max: 400, text: true, viewport: false, interactive: false }, opts || {});
    const out = [];
    let truncated = false;
    const vh = innerHeight, vw = innerWidth;
    const inView = (el) => { const r = el.getBoundingClientRect(); return r.bottom >= 0 && r.right >= 0 && r.top <= vh && r.left <= vw; };
    const directText = (el) => { let s = ''; for (const n of el.childNodes) if (n.nodeType === 3) s += n.nodeValue; return norm(s); };
    const walk = (root) => {
      for (const el of root.children) {
        if (out.length >= o.max) { truncated = true; return; }
        if (SKIP.test(el.tagName.toUpperCase())) continue;
        const cssOk = el.checkVisibility ? el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) : getComputedStyle(el).display !== 'none';
        if (!cssOk) {
          if (getComputedStyle(el).display === 'contents') { walk(el); }
          continue;
        }
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) { if (el.shadowRoot) walk(el.shadowRoot); walk(el); continue; }
        if (o.viewport && !inView(el) && el.children.length === 0) continue;
        const r = role(el);
        if (isInteractive(el, r)) {
          let line = '[' + refOf(el) + '] ' + (r || el.tagName.toLowerCase()) + ' "' + clip(name(el), 80) + '"';
          if ('value' in el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) && !/^(submit|button|reset|checkbox|radio)$/i.test(el.type || '')) {
            const v = el.type === 'password' ? (el.value ? '••••' : '') : el.value;
            if (v) line += ' =' + JSON.stringify(clip(String(v), 60));
          }
          if (el.checked) line += ' checked';
          if (el.disabled) line += ' disabled';
          const ex = el.getAttribute('aria-expanded'); if (ex) line += ' expanded=' + ex;
          if (r === 'link') { const h = el.getAttribute('href') || ''; if (h && !h.startsWith('javascript')) line += ' ->' + clip(h, 50); }
          out.push(line);
          if (el.tagName === 'SELECT' || r === 'link' || r === 'button') continue;
        } else if (r === 'heading') {
          out.push('h' + (el.tagName[1] || el.getAttribute('aria-level') || '') + ' "' + clip(norm(el.innerText), 100) + '"');
          continue;
        } else if (el.tagName === 'IMG' && name(el)) {
          out.push('img "' + clip(name(el), 60) + '"');
        } else if (el.tagName === 'IFRAME') {
          out.push('[' + refOf(el) + '] iframe ' + clip(el.src || '', 60));
          continue;
        } else if (o.interactive) {
          /* compact snapshots keep interactive controls, headings, images and iframes only */
        } else if (o.text) {
          const t = directText(el);
          if (t.length > 1) out.push('"' + clip(t, 120) + '"');
        }
        if (el.shadowRoot) walk(el.shadowRoot);
        walk(el);
      }
    };
    walk(document.body || document.documentElement);
    const lines = [];
    let prev = null, skipped = 0;
    for (const line of out) {
      if (line === prev) { skipped++; continue; }
      lines.push(line);
      prev = line;
    }
    if (truncated) lines.push('truncated at ' + o.max + ' lines (pass max to raise)');
    else if (skipped) lines.push('deduped ' + skipped + ' repeated lines');
    return { url: location.href, title: document.title, lines };

  };
  const PAY = /cc-(number|csc|exp|name)|card.?num|cardnumber|cvc|cvv|security.?code|iban|routing|account.?number/i;
  const fieldInfo = (el) => {
    if (!el) return null;
    const type = (el.getAttribute && (el.getAttribute('type') || '') || '').toLowerCase();
    const ac = (el.getAttribute && el.getAttribute('autocomplete')) || '';
    const isPassword = el.tagName === 'INPUT' && type === 'password';
    const isPayment = /^(INPUT|SELECT)$/.test(el.tagName) && (PAY.test(ac) || PAY.test(el.name || '') || PAY.test(el.id || '') || PAY.test(name(el)));
    const form = el.form || (el.closest && el.closest('form'));
    const btnType = (el.getAttribute && (el.getAttribute('type') || '')).toLowerCase();
    const isSubmit = !!form && ((el.tagName === 'BUTTON' && (btnType === '' || btnType === 'submit')) || (el.tagName === 'INPUT' && (btnType === 'submit' || btnType === 'image')));
    const fs = form ? Array.from(form.querySelectorAll('input,select')) : [];
    const formSensitive = fs.some((x) => (x.type || '').toLowerCase() === 'password') ? 'password' : fs.some((x) => PAY.test(x.getAttribute('autocomplete') || '') || PAY.test(x.name || '') || PAY.test(x.id || '')) ? 'payment' : null;
    return { tag: el.tagName.toLowerCase(), type, isPassword, isPayment, isSubmit, inForm: !!form, formSensitive, isEditable: /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || !!el.isContentEditable };
  };

  const moveCursor = (x, y, label) => {
    const id = '__lbd_ai_cursor';
    let el = document.getElementById(id);
    if (!el) {
      el = document.createElement('div');
      el.id = id;
      el.setAttribute('aria-hidden', 'true');
      el.style.cssText = 'position:fixed;left:0;top:0;z-index:2147483646;pointer-events:none;width:18px;height:18px;margin-left:-2px;margin-top:-2px;transition:transform 140ms cubic-bezier(.22,1,.36,1),opacity 120ms;opacity:0;will-change:transform;';
      el.innerHTML = '<svg width="18" height="18" viewBox="0 0 18 18" fill="none"><path d="M2 2 L2 14 L6.2 10.8 L9.8 16.2 L12.2 14.8 L8.6 9.4 L14 9.4 Z" fill="#1a1a1a" stroke="#f4efe6" stroke-width="1.2" stroke-linejoin="round"/></svg><div style="position:absolute;left:16px;top:14px;background:#1a1a1a;color:#f4efe6;font:11px/1.2 ui-sans-serif,system-ui,sans-serif;padding:2px 6px;border-radius:3px;white-space:nowrap;letter-spacing:.02em;"></div>';
      (document.documentElement || document.body).appendChild(el);
    }
    const tag = el.querySelector('div');
    if (tag) tag.textContent = String(label || 'Luculent').slice(0, 40);
    el.style.opacity = '1';
    el.style.transform = 'translate(' + Number(x || 0) + 'px,' + Number(y || 0) + 'px)';
    return { x, y };
  };
  const hideCursor = () => {
    const el = document.getElementById('__lbd_ai_cursor');
    if (el) el.style.opacity = '0';
    return { hidden: true };
  };
  const exists = (target) => {
    if (target == null || target === '') return null;
    try {
      const t = parse(target);
      let el = null;
      if (t.nth == null && !t.ref) {
        const all = resolveAll(t);
        el = all.find((x) => visible(x)) || all[0] || null;
      } else el = resolve(target);
      if (!el) return null;
      return visible(el) ? info(el) : null;
    } catch (_) { return null; }
  };
  const inspect = (target) => {
    let el = null;
    if (target == null) { el = document.activeElement; while (el && el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement; }
    else el = resolve(target);
    return fieldInfo(el);
  };
  const table = (target, max = 200) => {
    const t = target == null ? document.querySelector('table') : resolve(target);
    if (!t) throw new Error('No table for ' + desc(parse(target)));
    const cells = (tr) => Array.from(tr.children).filter((c) => /^(TD|TH)$/.test(c.tagName)).map((c) => clip(norm(c.innerText || c.textContent), 300));
    const head = t.tHead && t.tHead.rows[0] ? t.tHead.rows[0] : (t.rows[0] && Array.from(t.rows[0].children).every((c) => c.tagName === 'TH') ? t.rows[0] : null);
    const body = Array.from(t.rows).filter((r) => r !== head && !(t.tHead && t.tHead.contains(r)));
    return { headers: head ? cells(head) : [], rows: body.slice(0, max).map(cells), total: body.length };
  };
  const media = async (target, op = 'info', muted) => {
    const el = target == null ? document.querySelector('video,audio') : resolve(target);
    if (!el || !('paused' in el)) throw new Error('No <video>/<audio> for ' + desc(parse(target)));
    if (muted != null) el.muted = !!muted;
    if (op === 'play') { try { await el.play(); } catch (e) { el.muted = true; await el.play(); } }
    if (op === 'pause') el.pause();
    if (op === 'seek') el.currentTime = Number(muted) || 0;
    return { currentTime: +el.currentTime.toFixed(2), duration: isFinite(el.duration) ? +el.duration.toFixed(2) : null, paused: el.paused, muted: el.muted, ended: el.ended, src: clip(el.currentSrc || '', 120) };
  };
  const html5drag = (src, dst) => {
    const a = resolve(src), b = resolve(dst);
    if (!a) throw new Error('No element for ' + desc(parse(src)));
    if (!b) throw new Error('No element for ' + desc(parse(dst)));
    const dt = new DataTransfer();
    const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
    const fire = (el, type, r) => el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, composed: true, dataTransfer: dt, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 }));
    fire(a, 'dragstart', ra); fire(b, 'dragenter', rb); fire(b, 'dragover', rb); fire(b, 'drop', rb); fire(a, 'dragend', rb);
    return { from: info(a), to: info(b) };
  };
  const isDraggable = (target) => { const el = resolve(target); return !!el && (el.draggable === true || el.getAttribute('draggable') === 'true') && !(el.tagName === 'INPUT'); };
  const scrollToFind = async (target, maxScrolls = 20, dy = 500) => {
    for (let i = 0; i <= maxScrolls; i++) {
      const hit = exists(target);
      if (hit) {
        const el = refMap.get(hit.ref)?.deref();
        if (el) el.scrollIntoView({ block: 'center', behavior: 'instant' });
        return { ...hit, scrolls: i };
      }
      if (i === maxScrolls) break;
      const scroller = deepAll('[style*="overflow"], [class*="scroll"], [class*="virtual"], main, [role="grid"], [role="listbox"], [role="table"]')
        .find((el) => el.scrollHeight > el.clientHeight + 20 && visible(el));
      if (scroller) scroller.scrollTop += dy;
      else window.scrollBy({ top: dy, behavior: 'instant' });
      await new Promise((r) => setTimeout(r, 60));
    }
    throw new Error('Could not find ' + desc(parse(target)) + ' after ' + maxScrolls + ' scroll steps');
  };
  const diagnostics = (clear = false) => {
    const d = window.__lbdDiag || { console: [], errors: [] };
    const failedResources = (performance.getEntriesByType('resource') || [])
      .filter((r) => typeof r.responseStatus === 'number' && r.responseStatus >= 400)
      .slice(-50)
      .map((r) => ({ url: clip(r.name, 140), status: r.responseStatus, initiatorType: r.initiatorType || 'other', durationMs: Math.round(r.duration || 0) }));
    const out = {
      url: location.href,
      title: document.title,
      console: d.console.slice(-50),
      errors: d.errors.slice(-50),
      failedResources,
    };
    if (clear) { d.console.length = 0; d.errors.length = 0; }
    return out;
  };
  const until = (js, timeout = 5000) => new Promise((res, rej) => {
    const f = new Function('return (' + js + ')');
    const t0 = performance.now();
    const tick = async () => { let v; try { v = await f(); } catch (_) { v = false; } if (v) return res({ waitedMs: Math.round(performance.now() - t0) }); if (performance.now() - t0 > timeout) return rej(new Error('Timeout ' + timeout + 'ms waiting for ' + clip(js, 80))); setTimeout(tick, 50); };
    tick();
  });  const api = { v: ${HELPER_VERSION}, parse, resolve, waitFor, point, focus, fill, select, check, domClick, extract, scroll, scrollToFind, diagnostics, snapshot, info, waitNetwork, waitIdle, inspect, exists, moveCursor, hideCursor, table, media, html5drag, isDraggable, until };
  Object.defineProperty(window, '__lbd', { value: api, configurable: true, enumerable: false, writable: true });
  return api;
})()`;
