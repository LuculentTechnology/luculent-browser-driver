// In-page extractor for "Pull page context". Used via chrome.scripting.executeScript.
export function extractInPage() {
  const textOf = (el) => (el && (el.innerText || el.textContent) || '').replace(/\s+/g, ' ').trim();
  const rawText = (el) => {
    if (!el) return '';
    try {
      const copy = el.cloneNode(true);
      copy.querySelectorAll('script,style,noscript,input[type="password"]').forEach((n) => n.remove());
      return (copy.textContent || '').replace(/\s+/g, ' ').trim();
    } catch (_) {
      return (el.textContent || '').replace(/\s+/g, ' ').trim();
    }
  };
  const roots = [document];
  const walkShadows = (root) => {
    if (!root || !root.querySelectorAll) return;
    for (const n of root.querySelectorAll('*')) {
      if (n.shadowRoot && !roots.includes(n.shadowRoot)) {
        roots.push(n.shadowRoot);
        walkShadows(n.shadowRoot);
      }
    }
  };
  walkShadows(document);
  const all = (sel) => {
    const out = [];
    for (const r of roots) {
      if (r.querySelectorAll) out.push(...r.querySelectorAll(sel));
    }
    return out;
  };
  const headings = all('h1,h2,h3,h4').map((h) => textOf(h)).filter(Boolean).slice(0, 40);
  const links = all('a[href]').map((a) => ({ text: textOf(a), href: a.href })).filter((l) => l.href && !/^(javascript:|mailto:)/i.test(l.href)).slice(0, 40);
  const tables = all('table').slice(0, 8).map((t) => [...t.querySelectorAll('tr')].slice(0, 12).map((tr) => [...tr.querySelectorAll('th,td')].map((c) => textOf(c))));

  const parts = [];
  const takeDoc = (doc) => {
    if (!doc) return;
    const body = doc.body;
    if (body) {
      const text = rawText(body);
      if (text) parts.push(text);
    }
    const shadowBits = [];
    const collect = (root) => {
      if (!root || !root.querySelectorAll) return;
      for (const n of root.querySelectorAll('*')) {
        if (n.shadowRoot) {
          const st = (n.shadowRoot.innerText || n.shadowRoot.textContent || '').replace(/\s+/g, ' ').trim();
          if (st) shadowBits.push(st);
          collect(n.shadowRoot);
        }
      }
    };
    collect(doc);
    if (shadowBits.length) parts.push(shadowBits.join(' '));
  };
  takeDoc(document);
  for (const frame of document.querySelectorAll('iframe')) {
    try { takeDoc(frame.contentDocument); } catch (_) {}
  }
  // Prefer semantic main/article text so nav/chrome does not stand in for the page.
  let mainText = '';
  const mainSel = 'main, [role="main"], article, #mw-content-text, #bodyContent, #content, #main-content, .entry-content, .post-content, #primary';
  try {
    for (const el of document.querySelectorAll(mainSel)) {
      const s = rawText(el);
      if (s.length > mainText.length) mainText = s;
    }
  } catch (_) {}
  const bodyText = parts.join('\n').replace(/\s+/g, ' ').trim();
  const text = (mainText.length >= 200 && mainText.length >= bodyText.length * 0.4 ? mainText : (bodyText.length >= mainText.length ? bodyText : mainText)).replace(/\s+/g, ' ').trim();
  const href = location.href;
  const isPdf = !!(document.querySelector('embed[type="application/pdf"], object[type="application/pdf"], embed[src*=".pdf"], iframe[src*=".pdf"]') || /\.pdf(\?|#|$)/i.test(href));
  return {
    title: document.title || '',
    url: href,
    text,
    headings, links, tables,
    selection: String(document.getSelection && document.getSelection() || ''),
    isPdf,
  };
}
