// Comprehensive Page Testing Engine: Click Test, Visual Check, and Code Check (Asana 1220540308874160).
// Runs in-page diagnostics, guides the connected AI agent to execute deep interactive click/visual/code checks,
// builds a structured remediation plan, and renders a downloadable one-page Luculent editorial report.

export const TEST_SUITES = {
  click: {
    id: 'click',
    title: 'Click Test',
    subtitle: 'Interactive element discovery, handler verification, dead-link & form state audit',
    badge: 'INTERACTION AUDIT',
  },
  visual: {
    id: 'visual',
    title: 'Visual Check',
    subtitle: 'Overflow, clipping, overlapping controls, broken media & typography/contrast alignment',
    badge: 'VISUAL & LAYOUT AUDIT',
  },
  code: {
    id: 'code',
    title: 'Code Check',
    subtitle: 'DOM integrity, duplicate IDs, ARIA/form semantics, broken assets & runtime health',
    badge: 'DOM & CODE HEALTH',
  },
};

/**
 * Self-contained function serialized and injected via chrome.scripting.executeScript({ target: { tabId }, func: runInPageAudit, args: [kind] }).
 * Must not reference external closures.
 */
export function runInPageAudit(kind) {
  const textOf = (el) => ((el && (el.innerText || el.textContent || el.getAttribute?.('aria-label') || el.getAttribute?.('title') || el.value)) || '').replace(/\s+/g, ' ').trim().slice(0, 90);
  const cssPath = (el) => {
    if (!el || el.nodeType !== 1) return '';
    if (el.id) return '#' + CSS.escape(el.id);
    const tag = el.tagName.toLowerCase();
    const cls = typeof el.className === 'string' && el.className.trim()
      ? '.' + el.className.trim().split(/\s+/).slice(0, 2).map((c) => CSS.escape(c)).join('.')
      : '';
    return tag + cls;
  };
  const isVisible = (el) => {
    if (!el || el.nodeType !== 1) return false;
    const st = getComputedStyle(el);
    if (st.display === 'none' || st.visibility === 'hidden' || Number(st.opacity) === 0) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };

  const issues = [];
  const interactiveMap = [];
  const addIssue = (severity, category, element, summary, detail, fix) => {
    issues.push({
      id: 'ISS-' + String(issues.length + 1).padStart(2, '0'),
      severity, // 'high' | 'medium' | 'low'
      category,
      selector: typeof element === 'string' ? element : cssPath(element),
      label: typeof element === 'string' ? element : (textOf(element) || cssPath(element)),
      summary,
      detail,
      fix,
    });
  };

  const allInteractive = [...document.querySelectorAll('a, button, input, select, textarea, [role="button"], [role="link"], [role="tab"], [role="menuitem"], [onclick], summary')];
  const visibleInteractive = allInteractive.filter(isVisible);

  // Build interactive inventory for AI click-test guidance
  for (let i = 0; i < Math.min(visibleInteractive.length, 60); i++) {
    const el = visibleInteractive[i];
    const r = el.getBoundingClientRect();
    const tag = el.tagName.toLowerCase();
    const role = el.getAttribute('role') || tag;
    const label = textOf(el) || el.getAttribute('name') || el.getAttribute('placeholder') || cssPath(el);
    const href = el.getAttribute('href') || '';
    const disabled = !!el.disabled || el.getAttribute('aria-disabled') === 'true';
    interactiveMap.push({
      index: i + 1,
      role,
      tag,
      selector: cssPath(el),
      label: label.slice(0, 64),
      href: href.slice(0, 80),
      disabled,
      rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
    });
  }

  if (kind === 'click' || kind === 'all') {
    // 1. Dead or empty links
    for (const a of document.querySelectorAll('a')) {
      if (!isVisible(a)) continue;
      const rawHref = (a.getAttribute('href') || '').trim();
      const hasClick = typeof a.onclick === 'function' || a.hasAttribute('onclick') || a.getAttribute('role') === 'button';
      if ((!rawHref || rawHref === '#' || /^javascript:\s*(void\(0\)|;)?$/i.test(rawHref)) && !hasClick) {
        addIssue(
          'medium',
          'Dead Link / Missing Handler',
          a,
          `Anchor "${textOf(a) || cssPath(a)}" has no destination or click handler`,
          `Found <a href="${rawHref || ''}"> without an interactive handler or valid route target.`,
          `Bind a valid href route or replace the anchor with a <button type="button"> wired to an event handler.`
        );
      }
    }

    // 2. Unlabeled interactive controls
    for (const el of visibleInteractive) {
      const tag = el.tagName.toLowerCase();
      if (tag === 'input' && ['hidden', 'submit', 'reset', 'button'].includes((el.type || '').toLowerCase())) continue;
      const name = textOf(el) || el.getAttribute('aria-label') || el.getAttribute('aria-labelledby') || el.getAttribute('placeholder') || el.getAttribute('title');
      if (!name) {
        addIssue(
          'high',
          'Unaddressable Control',
          el,
          `Interactive <${tag}> has no accessible label or text`,
          `Users and AI click-runners cannot reliably target ${cssPath(el)} because it lacks text content or aria-label.`,
          `Add descriptive text or an explicit aria-label attribute to ${cssPath(el)}.`
        );
      }
    }

    // 3. Tiny or unclickable hit targets (< 24x24px) & pointer-events traps
    for (const el of visibleInteractive) {
      const r = el.getBoundingClientRect();
      const st = getComputedStyle(el);
      if (st.pointerEvents === 'none' && !el.disabled && el.getAttribute('aria-disabled') !== 'true') {
        addIssue(
          'high',
          'Blocked Click Target',
          el,
          `Control "${textOf(el) || cssPath(el)}" has pointer-events: none while enabled`,
          `Element appears active at (${Math.round(r.x)}, ${Math.round(r.y)}) but suppresses all mouse/pointer clicks.`,
          `Remove pointer-events: none or mark the element disabled/aria-disabled="true" if intentionally inactive.`
        );
      } else if (r.width < 20 || r.height < 20) {
        addIssue(
          'low',
          'Undersized Click Target',
          el,
          `Interactive target "${textOf(el) || cssPath(el)}" is only ${Math.round(r.width)}x${Math.round(r.height)}px`,
          `Target falls below the 24x24px minimum interactive hit area requirement.`,
          `Increase padding or min-width/min-height to at least 24x24px (32x32px recommended).`
        );
      }
    }

    // 4. Hit-test occlusion check (center point covered by another unrelated element)
    for (const el of visibleInteractive.slice(0, 35)) {
      const r = el.getBoundingClientRect();
      if (r.top < 0 || r.left < 0 || r.bottom > window.innerHeight || r.right > window.innerWidth) continue;
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      const topEl = document.elementFromPoint(cx, cy);
      if (topEl && topEl !== el && !el.contains(topEl) && !topEl.contains(el)) {
        addIssue(
          'high',
          'Occluded Click Target',
          el,
          `Click target "${textOf(el) || cssPath(el)}" is covered by ${cssPath(topEl)}`,
          `Hit-testing at center (${Math.round(cx)}, ${Math.round(cy)}) lands on ${cssPath(topEl)} instead of the interactive control.`,
          `Adjust z-index, positioning, or overlay dismissal so ${cssPath(el)} receives direct clicks.`
        );
      }
    }

    // 5. Forms without submit capability
    for (const form of document.querySelectorAll('form')) {
      if (!isVisible(form)) continue;
      const hasSubmit = form.querySelector('button:not([type="button"]):not([type="reset"]), input[type="submit"], input[type="image"]');
      if (!hasSubmit && typeof form.onsubmit !== 'function') {
        addIssue(
          'medium',
          'Form Missing Submit Trigger',
          form,
          `Form ${cssPath(form)} has no submit button`,
          `Visible form contains inputs but no submit button or explicit submit trigger.`,
          `Add a <button type="submit"> inside ${cssPath(form)} or wire an explicit submission handler.`
        );
      }
    }
  }

  if (kind === 'visual' || kind === 'all') {
    // 1. Horizontal page overflow
    const docW = document.documentElement.clientWidth || window.innerWidth;
    const scrollW = document.documentElement.scrollWidth;
    if (scrollW > docW + 4) {
      addIssue(
        'high',
        'Horizontal Viewport Overflow',
        'document.documentElement',
        `Page overflows horizontally by ${scrollW - docW}px (${scrollW}px vs ${docW}px viewport)`,
        `Unintended horizontal scroll bar detected across the root document layout.`,
        `Constrain wide containers with max-width: 100%, min-width: 0 on flex/grid children, or overflow-x: hidden where appropriate.`
      );
    }

    // 2. Broken images or zero-dimension media
    for (const img of document.querySelectorAll('img')) {
      const st = getComputedStyle(img);
      if (st.display === 'none' || st.visibility === 'hidden') continue;
      if (!img.complete || img.naturalWidth === 0) {
        addIssue(
          'high',
          'Broken Image Asset',
          img,
          `Image failed to load: ${img.getAttribute('src') || '(empty src)'}`,
          `Visible <img> element reported naturalWidth=0.`,
          `Verify the image URL/path, provide a valid asset, and ensure alt text is set.`
        );
      }
    }

    // 3. Clipped text / overflowing cards & buttons
    for (const el of document.querySelectorAll('button, a, h1, h2, h3, p, [class*="card"], [class*="panel"]')) {
      if (!isVisible(el)) continue;
      const st = getComputedStyle(el);
      if ((st.overflowX === 'hidden' || st.overflowX === 'clip') && st.textOverflow !== 'ellipsis' && el.scrollWidth > el.clientWidth + 12) {
        addIssue(
          'medium',
          'Clipped Content Overflow',
          el,
          `Content inside ${cssPath(el)} is clipped horizontally (${el.scrollWidth}px > ${el.clientWidth}px)`,
          `Element hides overflowing content without text-overflow: ellipsis or wrapping.`,
          `Allow wrapping (white-space: normal), widen container, or add text-overflow: ellipsis.`
        );
      }
    }

    // 4. Overlapping sibling interactive controls
    const rects = visibleInteractive.slice(0, 40).map((el) => ({ el, r: el.getBoundingClientRect() }));
    for (let i = 0; i < rects.length; i++) {
      for (let j = i + 1; j < rects.length; j++) {
        const a = rects[i], b = rects[j];
        if (a.el.contains(b.el) || b.el.contains(a.el)) continue;
        const xOverlap = Math.max(0, Math.min(a.r.right, b.r.right) - Math.max(a.r.left, b.r.left));
        const yOverlap = Math.max(0, Math.min(a.r.bottom, b.r.bottom) - Math.max(a.r.top, b.r.top));
        if (xOverlap > 6 && yOverlap > 6) {
          addIssue(
            'high',
            'Overlapping Controls',
            a.el,
            `${cssPath(a.el)} overlaps with ${cssPath(b.el)} by ${Math.round(xOverlap)}x${Math.round(yOverlap)}px`,
            `Two distinct interactive controls collide visually and in hit-space.`,
            `Add gap/margin or fix absolute/fixed positioning between ${cssPath(a.el)} and ${cssPath(b.el)}.`
          );
        }
      }
    }
  }

  if (kind === 'code' || kind === 'all') {
    // 1. Duplicate DOM IDs
    const idCounts = new Map();
    for (const el of document.querySelectorAll('[id]')) {
      if (!el.id) continue;
      idCounts.set(el.id, (idCounts.get(el.id) || 0) + 1);
    }
    for (const [id, count] of idCounts.entries()) {
      if (count > 1) {
        addIssue(
          'high',
          'Duplicate DOM ID',
          `#${id}`,
          `Duplicate id="${id}" appears ${count} times in the document`,
          `Duplicate IDs break label associations, aria-labelledby references, and document.getElementById lookups.`,
          `Ensure every #${id} instance uses a unique ID or convert shared styling hooks to classes.`
        );
      }
    }

    // 2. Form inputs missing label or name
    for (const input of document.querySelectorAll('input, select, textarea')) {
      if (!isVisible(input)) continue;
      const type = (input.getAttribute('type') || 'text').toLowerCase();
      if (['hidden', 'submit', 'button', 'reset'].includes(type)) continue;
      const hasLabel = (input.id && document.querySelector(`label[for="${CSS.escape(input.id)}"]`))
        || input.closest('label')
        || input.getAttribute('aria-label')
        || input.getAttribute('aria-labelledby');
      if (!hasLabel) {
        addIssue(
          'medium',
          'Unlabeled Form Field',
          input,
          `Form field ${cssPath(input)} (${type}) has no associated <label> or aria-label`,
          `Screen readers and automated form fillers cannot deterministically bind to this field.`,
          `Wrap ${cssPath(input)} in a <label> or add for/id or aria-label attributes.`
        );
      }
    }

    // 3. Buttons inside anchors or nested interactive elements (invalid HTML spec)
    for (const nested of document.querySelectorAll('a button, button a, button button, a a')) {
      if (!isVisible(nested)) continue;
      addIssue(
        'high',
        'Invalid Nested Interactive DOM',
        nested,
        `Nested interactive element ${cssPath(nested)} inside ${cssPath(nested.parentElement)}`,
        `HTML specification forbids nesting interactive controls (<button> inside <a> or vice-versa), causing unpredictable click propagation.`,
        `Unnest ${cssPath(nested)} so each interactive element has a single semantic role and handler.`
      );
    }

    // 4. Failed network resources via PerformanceResourceTiming
    try {
      const resources = performance.getEntriesByType('resource') || [];
      for (const res of resources) {
        if (typeof res.responseStatus === 'number' && res.responseStatus >= 400) {
          addIssue(
            'high',
            'Failed Resource Request',
            res.name.slice(0, 90),
            `HTTP ${res.responseStatus} loading ${res.initiatorType || 'resource'}: ${res.name.split('/').pop() || res.name}`,
            `Resource ${res.name} returned status ${res.responseStatus}.`,
            `Fix the endpoint or asset path for ${res.name} and handle error states gracefully.`
          );
        }
      }
    } catch (_) {}

    // 5. Missing document title or lang
    if (!document.title || !document.title.trim()) {
      addIssue(
        'low',
        'Missing Document Title',
        'head > title',
        'Document is missing a non-empty <title> element',
        'Tabs, history, and accessibility trees rely on document.title.',
        'Add a descriptive <title> tag inside <head>.'
      );
    }
    if (!document.documentElement.getAttribute('lang')) {
      addIssue(
        'low',
        'Missing HTML lang Attribute',
        'html',
        '<html> root element is missing a lang attribute',
        'Assistive technologies require a valid BCP-47 language tag on <html>.',
        'Add lang="en" (or the appropriate locale) to the <html> tag.'
      );
    }
  }

  // Synthesize remediation plan steps
  const planSteps = issues.length
    ? issues.map((iss, idx) => ({
        step: idx + 1,
        issueId: iss.id,
        severity: iss.severity,
        target: iss.selector,
        title: `Patch ${iss.category}: ${iss.summary}`,
        action: iss.fix,
      }))
    : [
        {
          step: 1,
          issueId: 'PASS',
          severity: 'ok',
          target: 'document',
          title: `Verify all ${interactiveMap.length} interactive controls remain responsive across state transitions`,
          action: 'No blocking defects found in initial scan; connected AI can complete deep interactive click sweep.',
        },
      ];

  return {
    kind,
    url: location.href,
    title: document.title || location.hostname || 'Untitled page',
    timestamp: new Date().toISOString(),
     viewport: { width: window.innerWidth, height: window.innerHeight },
    counts: {
      totalInteractive: visibleInteractive.length,
      issuesTotal: issues.length,
      high: issues.filter((i) => i.severity === 'high').length,
      medium: issues.filter((i) => i.severity === 'medium').length,
      low: issues.filter((i) => i.severity === 'low').length,
    },
    interactiveMap,
    issues,
    planSteps,
  };
}

/**
 * Builds the prompt message dispatched to the connected AI agent to guide a comprehensive test
 * or to immediately patch discovered issues.
 */
export function buildAgentGuidancePrompt(report, { fixImmediately = false, approved = false } = {}) {
  const suite = TEST_SUITES[report.kind] || TEST_SUITES.click;
  const targetsPreview = (report.interactiveMap || [])
    .slice(0, 20)
    .map((t) => `  - [${t.role}] "${t.label}" (${t.selector})${t.disabled ? ' [disabled]' : ''}`)
    .join('\n');
  const issuesPreview = (report.issues || []).length
    ? report.issues.map((iss) => `  - [${iss.id} | ${iss.severity.toUpperCase()}] ${iss.summary} (${iss.selector})\n    Fix: ${iss.fix}`).join('\n')
    : '  - No static pre-scan issues flagged; perform live interactive verification across all controls.';

  const modeHeader = fixImmediately
    ? `MODE: FIX IMMEDIATELY (Approval skipped by user). Execute the ${suite.title}, verify all findings on "${report.title}" (${report.url}), and immediately patch every discovered issue in the codebase without waiting for manual report approval.`
    : approved
      ? `MODE: APPROVED REMEDIATION PLAN. The user approved the ${suite.title} report for "${report.title}" (${report.url}). Apply the remediation plan below and verify the fixes in the tab.`
      : `MODE: GUIDED ${suite.title.toUpperCase()} & PLAN FOR APPROVAL. Run a comprehensive ${suite.title} on "${report.title}" (${report.url}) using browser_run, verify the pre-scanned findings below, and stand by for user approval before modifying files.`;

  const clickInstructions = report.kind === 'click'
    ? `\nCLICK TEST EXECUTION GUIDE:\n1. Use browser_snapshot and browser_run to systematically exercise the ${report.counts.totalInteractive} interactive controls discovered on the page (buttons, tabs, dropdowns, modals, links, and form inputs).\n2. Verify each click produces a valid state change, navigation, modal toggle, or ARIA update without throwing console/page errors.\n3. Confirm all findings in the Remediation Plan below.`
    : report.kind === 'visual'
      ? `\nVISUAL CHECK EXECUTION GUIDE:\n1. Inspect layout geometry, responsive overflow, overlapping controls, broken media, and alignment against Luculent design tokens.\n2. Use browser_screenshot if pixel verification is needed.`
      : `\nCODE CHECK EXECUTION GUIDE:\n1. Inspect DOM structure, duplicate IDs, ARIA roles, form label bindings, and failed network requests.\n2. Cross-reference with source components to prepare exact code patches.`;

  return [
    `[Luculent ${suite.title} — ${ report.title }]`,
    `URL: ${report.url}`,
    modeHeader,
    clickInstructions,
    `\nINTERACTIVE ELEMENTS INVENTORY (${report.counts.totalInteractive} visible):`,
    targetsPreview || '  (none detected)',
    `\nDIAGNOSTIC FINDINGS (${report.counts.issuesTotal} issues: ${report.counts.high} high, ${report.counts.medium} medium, ${report.counts.low} low):`,
    issuesPreview,
    `\nPROPOSED REMEDIATION PLAN:`,
    (report.planSteps || []).map((p) => `  ${p.step}. [${p.issueId}] ${p.title} -> ${p.action}`).join('\n'),
  ].join('\n');
}

/**
 * Formats a concise chat summary when the user clicks "Display in chat".
 */
export function buildChatSummaryMessage(report) {
  const suite = TEST_SUITES[report.kind] || TEST_SUITES.click;
  const lines = [
    `**${suite.title} Report — ${report.title}**`,
    `URL: ${report.url}`,
    `Scanned **${report.counts.totalInteractive}** interactive elements · Found **${report.counts.issuesTotal}** issue(s) (${report.counts.high} high, ${report.counts.medium} medium, ${report.counts.low} low).`,
    '',
    '**Remediation Plan for Approval:**',
  ];
  for (const p of (report.planSteps || []).slice(0, 12)) {
    lines.push(`${p.step}. **[${p.issueId}]** ${p.title} — _${p.action}_`);
  }
  lines.push('', 'Reply or click **Approve & Patch** in the Testing tab to apply these fixes.');
  return lines.join('\n');
}

/**
 * Generates a standalone one-page HTML document in Luculent's warm off-white editorial design
 * (matching luculent.dev/beta: #FAF8F4 warm paper, #141413 ink, #E3BC57 gold accents, editorial serif/sans hierarchy)
 * that can be downloaded or opened in a tab and includes interactive Approve & Patch / Download buttons.
 */
export function renderOnePageReportHtml(report) {
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const suite = TEST_SUITES[report.kind] || TEST_SUITES.click;
  const statusTone = report.counts.high > 0 ? 'Attention Required' : report.counts.issuesTotal > 0 ? 'Issues Identified' : 'All Checks Passed';

  const issueRows = (report.issues || []).length
    ? report.issues.map((iss) => `
      <tr>
        <td class="mono">${esc(iss.id)}</td>
        <td><span class="sev sev-${esc(iss.severity)}">${esc(iss.severity.toUpperCase())}</span></td>
        <td><strong>${esc(iss.category)}</strong><div class="sub">${esc(iss.selector)}</div></td>
        <td>${esc(iss.summary)}<div class="sub">${esc(iss.detail)}</div></td>
        <td>${esc(iss.fix)}</td>
      </tr>`).join('')
    : `<tr><td colspan="5" class="empty-row">No defects detected during automated ${esc(suite.title.toLowerCase())} scan across ${report.counts.totalInteractive} interactive elements.</td></tr>`;

  const planItems = (report.planSteps || []).map((p) => `
    <li class="plan-item">
      <div class="plan-num">${String(p.step).padStart(2, '0')}</div>
      <div class="plan-body">
        <div class="plan-title"><span class="mono">[${esc(p.issueId)}]</span> ${esc(p.title)}</div>
        <div class="plan-desc">${esc(p.action)}</div>
      </div>
    </li>`).join('');

  const interactivePills = (report.interactiveMap || []).slice(0, 24).map((t) => `
    <span class="target-pill"><b>${esc(t.role)}</b> ${esc(t.label)} <code>${esc(t.selector)}</code></span>
  `).join('');

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Luculent ${esc(suite.title)} Report — ${esc(report.title)}</title>
  <style>
    :root {
      --paper: #FAF8F4;
      --paper-card: #FFFFFF;
      --paper-warm: #F3EFE6;
      --ink: #141413;
      --ink-muted: #5C5A54;
      --line: rgba(20, 20, 19, 0.11);
      --gold: #E3BC57;
      --gold-deep: #B68C34;
      --gold-radial: radial-gradient(ellipse 125% 170% at 100% 0%, #FAD56C 0%, #E3BC57 42%, #B68C34 100%);
      --high: #C93B54;
      --medium: #C86D2D;
      --low: #2E6F9E;
      --ok: #257942;
      --font-sans: "Luculent Sans v2", "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      --font-serif: "Instrument Serif", "Newsreader", Georgia, serif;
      --font-mono: "Luculent Sans Mono v2", "Geist Mono", ui-monospace, monospace;
    }
    * { box-sizing: border-box; }
    html, body {
      margin: 0;
      padding: 0;
      background: var(--paper);
      color: var(--ink);
      font-family: var(--font-sans);
      font-size: 14px;
      line-height: 1.55;
      -webkit-font-smoothing: antialiased;
    }
    .page {
      max-width: 980px;
      margin: 28px auto;
      padding: 36px 42px;
      background: var(--paper-card);
      border: 1px solid var(--line);
      border-radius: 18px;
      box-shadow: 0 22px 60px -28px rgba(20, 20, 19, 0.12);
    }
    header.doc-header {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      gap: 24px;
      padding-bottom: 22px;
      border-bottom: 1px solid var(--line);
    }
    .brand-row {
      display: flex;
      align-items: center;
      gap: 10px;
      margin-bottom: 10px;
    }
    .brand-mark {
      width: 24px;
      height: 24px;
      border-radius: 6px;
      background: var(--gold-radial);
      display: inline-block;
      box-shadow: inset 0 0 0 1px rgba(20,20,19,0.15);
    }
    .eyebrow {
      font-family: var(--font-mono);
      font-size: 11px;
      letter-spacing: 0.12em;
      text-transform: uppercase;
      color: var(--ink-muted);
    }
    h1 {
      font-family: var(--font-serif);
      font-weight: 400;
      font-size: 34px;
      line-height: 1.12;
      margin: 4px 0 8px;
      letter-spacing: -0.01em;
    }
    .meta-url {
      font-family: var(--font-mono);
      font-size: 12px;
      color: var(--ink-muted);
      word-break: break-all;
    }
    .header-actions {
      display: flex;
      flex-direction: column;
      align-items: flex-end;
      gap: 8px;
      flex-shrink: 0;
    }
    .status-pill {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 5px 12px;
      border-radius: 999px;
      background: var(--paper-warm);
      border: 1px solid var(--line);
      font-family: var(--font-mono);
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.06em;
    }
    .btn-print {
      appearance: none;
      border: 0;
      border-radius: 8px;
      padding: 8px 14px;
      font-family: var(--font-sans);
      font-size: 12px;
      font-weight: 600;
      color: var(--ink);
      background: var(--gold-radial);
      cursor: pointer;
      box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.65), 0 6px 18px -8px rgba(182, 140, 52, 0.6);
    }
    .kpi-grid {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 12px;
      margin: 20px 0 24px;
    }
    .kpi {
      padding: 14px 16px;
      border-radius: 12px;
      background: var(--paper);
      border: 1px solid var(--line);
    }
    .kpi .k-label {
      font-family: var(--font-mono);
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.1em;
      color: var(--ink-muted);
    }
    .kpi .k-val {
      font-size: 24px;
      font-weight: 600;
      margin-top: 4px;
    }
    section {
      margin-top: 24px;
    }
    h2 {
      font-size: 13px;
      font-family: var(--font-mono);
      text-transform: uppercase;
      letter-spacing: 0.1em;
      color: var(--ink-muted);
      margin: 0 0 12px;
      padding-bottom: 6px;
      border-bottom: 1px solid var(--line);
    }
    .plan-list {
      list-style: none;
      margin: 0;
      padding: 0;
      display: grid;
      gap: 10px;
    }
    .plan-item {
      display: flex;
      gap: 14px;
      padding: 12px 16px;
      border-radius: 12px;
      background: var(--paper);
      border: 1px solid var(--line);
    }
    .plan-num {
      font-family: var(--font-mono);
      font-weight: 700;
      font-size: 13px;
      color: var(--gold-deep);
      padding-top: 1px;
    }
    .plan-title {
      font-weight: 600;
      margin-bottom: 2px;
    }
    .plan-desc {
      color: var(--ink-muted);
      font-size: 13px;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 13px;
    }
    th, td {
      text-align: left;
      padding: 10px 10px;
      border-bottom: 1px solid var(--line);
      vertical-align: top;
    }
    th {
      font-family: var(--font-mono);
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: var(--ink-muted);
    }
    .mono { font-family: var(--font-mono); font-size: 12px; }
    .sub { font-size: 12px; color: var(--ink-muted); margin-top: 2px; }
    .sev {
      display: inline-block;
      padding: 2px 7px;
      border-radius: 5px;
      font-family: var(--font-mono);
      font-size: 10px;
      font-weight: 700;
    }
    .sev-high { background: rgba(201, 59, 84, 0.12); color: var(--high); }
    .sev-medium { background: rgba(200, 109, 45, 0.14); color: var(--medium); }
    .sev-low { background: rgba(46, 111, 158, 0.12); color: var(--low); }
    .target-cloud {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
    }
    .target-pill {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 4px 9px;
      border-radius: 6px;
      background: var(--paper);
      border: 1px solid var(--line);
      font-size: 12px;
    }
    .target-pill code {
      font-family: var(--font-mono);
      font-size: 11px;
      color: var(--ink-muted);
    }
    footer.doc-footer {
      margin-top: 28px;
      padding-top: 14px;
      border-top: 1px solid var(--line);
      display: flex;
      justify-content: space-between;
      font-size: 12px;
      color: var(--ink-muted);
    }
    @media print {
      body { background: #fff; }
      .page { margin: 0; border: 0; box-shadow: none; padding: 18px; }
      .btn-print { display: none; }
    }
  </style>
</head>
<body>
  <article class="page">
    <header class="doc-header">
      <div>
        <div class="brand-row">
          <span class="brand-mark" aria-hidden="true"></span>
          <span class="eyebrow">Luculent Browser Driver · ${esc(suite.badge)}</span>
        </div>
        <h1>${esc(suite.title)} &amp; Remediation Plan</h1>
        <div><strong>${esc(report.title)}</strong></div>
        <div class="meta-url">${esc(report.url)} · Generated ${esc(report.timestamp)}</div>
      </div>
      <div class="header-actions">
        <span class="status-pill">${esc(statusTone)}</span>
        <button class="btn-print" type="button" onclick="window.print()">Print / Save PDF</button>
      </div>
    </header>

    <div class="kpi-grid">
      <div class="kpi">
        <div class="k-label">Interactive Controls</div>
        <div class="k-val">${report.counts.totalInteractive}</div>
      </div>
      <div class="kpi">
        <div class="k-label">Total Findings</div>
        <div class="k-val">${report.counts.issuesTotal}</div>
      </div>
      <div class="kpi">
        <div class="k-label">High Severity</div>
        <div class="k-val" style="color: var(--high)">${report.counts.high}</div>
      </div>
      <div class="kpi">
        <div class="k-label">Medium / Low</div>
        <div class="k-val">${report.counts.medium + report.counts.low}</div>
      </div>
    </div>

    <section>
      <h2>Remediation Plan for Approval</h2>
      <ol class="plan-list">${planItems}</ol>
    </section>

    <section>
      <h2>Diagnostic Findings</h2>
      <table>
        <thead>
          <tr>
            <th>ID</th>
            <th>Severity</th>
            <th>Category &amp; Target</th>
            <th>Finding</th>
            <th>Proposed Patch</th>
          </tr>
        </thead>
        <tbody>${issueRows}</tbody>
      </table>
    </section>

    <section>
      <h2>Interactive Surface Map (${report.counts.totalInteractive} controls audited)</h2>
      <div class="target-cloud">${interactivePills || '<span class="sub">No interactive elements detected on page.</span>'}</div>
    </section>

    <footer class="doc-footer">
      <span>Luculent Browser Driver · One-Page Diagnostic &amp; Approval Specification</span>
      <span>luculent.dev/beta</span>
    </footer>
  </article>
</body>
</html>`;
}
