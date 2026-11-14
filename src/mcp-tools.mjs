// MCP tool definitions shared by the stdio server and the relay's HTTP /mcp endpoint.
import { formatSnapshot } from './engine.mjs';

const TARGET_DOC = 'Element target. Shorthands: "e12" (ref from the latest snapshot of this page; "[e12]" also accepted), "text=Sign in", "role=button[name=Search]", "label=Email", "css=#id", or plain CSS. Objects {ref|css|text|role,name|label, exact, nth} also work.';
// Schemas stick to the JSON-Schema subset every major model API accepts (no type unions, no empty schemas).
const tab = { type: 'string', description: 'Tab id from browser_tabs (e.g. "1234" for a Chrome tab, "h1:1" for a headless tab). Omit to use the tab you used last, else the active tab.' };
const target = { type: 'string', description: TARGET_DOC };
const STEP = {
  type: 'object',
  description: 'One step. "action" picks the operation; set only the fields that action uses.',
  properties: {
    action: { type: 'string', enum: ['navigate', 'click', 'dblclick', 'rightclick', 'hover', 'type', 'fill', 'press', 'select', 'check', 'uncheck', 'wait', 'extract', 'eval', 'scroll', 'upload', 'cookies', 'storage', 'downloads', 'dialog', 'viewport', 'snapshot', 'screenshot', 'back', 'forward', 'reload', 'drag', 'wheel', 'table', 'media', 'pdf', 'geolocation', 'permissions'] },
    url: { type: 'string', description: 'navigate: URL. wait: URL substring to wait for.' },
    target,
    text: { type: 'string', description: 'type/fill: text to enter. wait: visible text to wait for.' },
    for: { type: 'string', description: 'wait: "load", "idle" or "network" shorthand.' },
    value: { type: 'string', description: 'select: option value or label. storage: value to set.' },
    key: { type: 'string', description: 'press: key or combo, e.g. Enter, Tab, Control+a. storage/cookies: key/name.' },
    submit: { type: 'boolean', description: 'type: press Enter after typing.' },
    clear: { type: 'boolean', description: 'type: replace existing text (default true).' },
    waitNav: { type: 'boolean', description: 'click/press/type: also wait for the page load this triggers.' },
    checked: { type: 'boolean' },
    what: { type: 'string', enum: ['text', 'html', 'value', 'attr', 'href', 'info'], description: 'extract: what to read (default text).' },
    attr: { type: 'string' },
    all: { type: 'boolean', description: 'extract: return every match as an array.' },
    js: { type: 'string', description: 'eval: JavaScript expression; promises are awaited (needs the user to allow eval). wait: JS condition to poll until truthy.' },
    ms: { type: 'number', description: 'wait: fixed milliseconds.' },
    network: { type: 'string', description: 'wait: URL substring of a network response.' },
    idle: { type: 'number', description: 'wait: ms of network/DOM quiet.' },
    state: { type: 'string', enum: ['visible', 'hidden', 'attached', 'detached'] },
    timeout: { type: 'number', description: 'ms (default 5000 for element waits).' },
    files: { type: 'array', items: { type: 'string' }, description: 'upload: absolute file paths.' },
    op: { type: 'string', description: 'cookies/storage/downloads operation.' },
    name: { type: 'string' },
    dy: { type: 'number' },
    mode: { type: 'string', enum: ['full', 'diff'] },
    frame: { type: 'string', description: 'Run this step inside an iframe (same- or cross-origin): CSS selector of the <iframe>, e.g. "#editor" or "iframe[title=Preview]". Chain nested frames with " >> ".' },
    expectPopup: { type: 'boolean', description: 'click: the click opens a new tab/window; its tab id is returned as value.popup.' },
    x: { type: 'number', description: 'click/wheel: viewport x when there is no target (canvas, maps).' },
    y: { type: 'number', description: 'click/wheel: viewport y when there is no target.' },
    offsetX: { type: 'number', description: 'click/drag: x offset from the element\'s left edge instead of its center (sliders, canvas).' },
    offsetY: { type: 'number', description: 'click/drag: y offset from the element\'s top edge.' },
    to: { type: 'string', description: 'drag: drop target (same shorthands as target). Or use dx/dy to drag by pixels.' },
    dx: { type: 'number', description: 'drag/wheel/scroll: horizontal pixels.' },
    max: { type: 'number', description: 'table: max rows; pdf: max characters; snapshot: max lines.' },
    time: { type: 'number', description: 'media op seek: seconds.' },
    muted: { type: 'boolean', description: 'media op mute.' },
    latitude: { type: 'number' },
    longitude: { type: 'number' },
    grant: { type: 'array', items: { type: 'string' }, description: 'permissions: e.g. ["geolocation","notifications","clipboard-read"] (headless only).' },
    optional: { type: 'boolean', description: 'A failure of this step does not stop the run (e.g. closing a cookie banner that may not appear).' },
  },
  required: ['action'],
};
const snap = { type: 'string', enum: ['none', 'diff', 'full'], description: 'Page snapshot to return after the call. "diff" (default) returns only changed lines since your last snapshot of this tab.' };

export const TOOLS = [
  {
    name: 'browser_run',
    description: 'FASTEST WAY TO DRIVE THE BROWSER. Runs a whole sequence of steps in one call on one tab and returns per-step results and timings plus an optional compact snapshot diff (a snapshot is always attached when a step fails, so you can retry with a valid target). Step actions: navigate{url,wait?}, click{target,waitNav?}, dblclick, hover, type{target,text,clear?,submit?}, fill{target,text} (instant value set), press{key|keys,target?}, select{target,value}, check{target,checked?}, wait{target|text|url|network|idle|load|ms,state?,timeout?}, extract{target?,what?:text|html|value|attr|href|info,attr?,all?}, eval{js}, scroll{target?|dy?}, upload{target,files}, cookies{op:get|set|delete|clearAll,...}, storage{op:get|set|remove|clear,area?,key?,value?}, downloads{op:list|wait}, dialog{accept?,text?}, viewport{width,height,mobile?}, snapshot{mode?}, screenshot, back, forward, reload, drag{target,to|dx,dy}, wheel{dy,dx?,target?|x,y}, table{target?,max?} (rows as arrays), media{target?,op:info|play|pause|seek|mute,time?}, pdf{url?} (text of the open PDF), geolocation{latitude,longitude}, permissions{grant}. Any step takes frame:"iframe selector" to act inside an iframe and optional:true to keep going if it fails. JS alerts/confirms are handled automatically (run param dialogs: accept|dismiss|manual). If a step is refused with "Blocked by your Luculent security settings", the user has turned that off: do not retry it another way; tell the user what you needed. ' + TARGET_DOC,
    inputSchema: { type: 'object', properties: { tab, steps: { type: 'array', items: STEP }, snapshot: snap, stopOnError: { type: 'boolean' }, dialogs: { type: 'string', enum: ['accept', 'dismiss', 'manual'], description: 'How to answer JS alert/confirm/prompt dialogs during this run (default accept).' } }, required: ['steps'] },
  },
  {
    name: 'browser_tabs',
    description: 'List, open, close or focus tabs. list shows every tab in the connected Chrome (via the Luculent extension) and in headless browsers. new opens a tab (source "extension" = your real Chrome, "headless" = background Chrome). Attaching to an existing tab needs no new tab: just pass its id to any tool.',
    inputSchema: { type: 'object', properties: { action: { type: 'string', enum: ['list', 'new', 'close', 'activate'] }, tab, tabs: { type: 'array', items: { type: 'string' }, description: 'Several tab ids for close' }, url: { type: 'string' }, source: { type: 'string', enum: ['extension', 'headless'] }, active: { type: 'boolean' } }, required: ['action'] },
  },
  { name: 'browser_snapshot', description: 'Compact accessibility-style snapshot of the page: one line per interactive element with a ref like [e12], headings and short text. mode "diff" returns only what changed since your last snapshot of this tab.', inputSchema: { type: 'object', properties: { tab, mode: { type: 'string', enum: ['full', 'diff'] }, max: { type: 'number' }, text: { type: 'boolean', description: 'Include plain text lines (default true)' }, viewport: { type: 'boolean', description: 'Only elements in the viewport' } } } },
  { name: 'browser_navigate', description: 'Go to a URL in a tab and wait for DOMContentLoaded (or wait:"load"/"none").', inputSchema: { type: 'object', properties: { tab, url: { type: 'string' }, wait: { type: 'string', enum: ['domcontentloaded', 'load', 'none'] }, snapshot: snap }, required: ['url'] } },
  { name: 'browser_click', description: 'Click an element with real mouse events. waitNav:true also waits for the resulting page load.', inputSchema: { type: 'object', properties: { tab, target, waitNav: { type: 'boolean' }, snapshot: snap }, required: ['target'] } },
  { name: 'browser_type', description: 'Focus an element, replace its text (clear:false to append) and optionally press Enter (submit:true).', inputSchema: { type: 'object', properties: { tab, target, text: { type: 'string' }, clear: { type: 'boolean' }, submit: { type: 'boolean' }, waitNav: { type: 'boolean' }, snapshot: snap }, required: ['target', 'text'] } },
  { name: 'browser_extract', description: 'Read text, html, value, an attribute or href from one element (or all matches with all:true). Omit target for the whole page text.', inputSchema: { type: 'object', properties: { tab, target, what: { type: 'string', enum: ['text', 'html', 'value', 'attr', 'href', 'info'] }, attr: { type: 'string' }, all: { type: 'boolean' } } } },
  { name: 'browser_screenshot', description: 'JPEG screenshot of the tab (only when you really need pixels; snapshots are much faster).', inputSchema: { type: 'object', properties: { tab, fullPage: { type: 'boolean' }, quality: { type: 'number' } } } },
  { name: 'browser_parallel', description: 'Run several browser_run jobs at the same time. Each job: {tab?, source?, steps, snapshot?}. A job WITHOUT tab opens a NEW tab (start its steps with navigate); pass tab to reuse an open tab. close:true closes the tabs this call opened when done.', inputSchema: { type: 'object', properties: { jobs: { type: 'array', items: { type: 'object', properties: { tab, newTab: { type: 'boolean' }, source: { type: 'string', enum: ['extension', 'headless'] }, steps: { type: 'array', items: STEP }, snapshot: snap }, required: ['steps'] } }, close: { type: 'boolean', description: 'Close the tabs this call opened after the jobs finish' } }, required: ['jobs'] } },
  { name: 'browser_press', description: 'Press a key or key combo (Enter, Tab, Escape, ArrowDown, Backspace, Control+a, Shift+Tab, single characters). Optional target is focused first.', inputSchema: { type: 'object', properties: { tab, key: { type: 'string' }, keys: { type: 'array', items: { type: 'string' } }, target, waitNav: { type: 'boolean' }, snapshot: snap } } },
  { name: 'browser_hover', description: 'Move the mouse over an element (opens hover menus/tooltips).', inputSchema: { type: 'object', properties: { tab, target, snapshot: snap }, required: ['target'] } },
  { name: 'browser_scroll', description: 'Scroll an element into view (target) or scroll the page by dy/dx pixels (default dy 600; negative scrolls up).', inputSchema: { type: 'object', properties: { tab, target, dy: { type: 'number' }, dx: { type: 'number' }, snapshot: snap } } },
  { name: 'browser_select', description: 'Choose option(s) in a <select> by value or visible label.', inputSchema: { type: 'object', properties: { tab, target, value: { type: 'string', description: 'Option value or visible label' }, values: { type: 'array', items: { type: 'string' }, description: 'Several options (multi-select)' }, snapshot: snap }, required: ['target'] } },
  { name: 'browser_check', description: 'Set a checkbox/radio/switch to checked (checked:true, default) or unchecked.', inputSchema: { type: 'object', properties: { tab, target, checked: { type: 'boolean' }, snapshot: snap }, required: ['target'] } },
  { name: 'browser_upload', description: 'Attach local files (absolute paths on the machine running Chrome) to a file input.', inputSchema: { type: 'object', properties: { tab, target, files: { type: 'array', items: { type: 'string' } } }, required: ['target', 'files'] } },
  { name: 'browser_eval', description: 'Run JavaScript in the page and return the JSON result. Promises are awaited. Example js: "document.title" or "[...document.querySelectorAll(\'a\')].map(a=>a.href)".', inputSchema: { type: 'object', properties: { tab, js: { type: 'string' } }, required: ['js'] } },
  { name: 'browser_wait', description: 'Wait for an element/text to appear (or state:"hidden" to disappear), a URL substring, a network response whose URL contains a string, network+DOM idle (idle: ms), page load (load:"load"), or a fixed ms.', inputSchema: { type: 'object', properties: { tab, target, text: { type: 'string' }, state: { type: 'string', enum: ['visible', 'hidden', 'attached', 'detached'] }, url: { type: 'string' }, network: { type: 'string' }, fresh: { type: 'boolean' }, idle: { type: 'number' }, load: { type: 'string', enum: ['domcontentloaded', 'load'] }, ms: { type: 'number' }, timeout: { type: 'number' } } } },
  { name: 'browser_cookies', description: 'Read or change cookies for the tab: op get (optionally urls), set (name, value, url/domain, or cookie object), delete (name, url/domain), clearAll (every cookie in this browser profile).', inputSchema: { type: 'object', properties: { tab, op: { type: 'string', enum: ['get', 'set', 'delete', 'clearAll'] }, urls: { type: 'array', items: { type: 'string' } }, name: { type: 'string' }, value: { type: 'string' }, url: { type: 'string' }, domain: { type: 'string' }, path: { type: 'string' }, secure: { type: 'boolean' }, httpOnly: { type: 'boolean' }, expires: { type: 'number', description: 'Unix seconds' } }, required: ['op'] } },
  { name: 'browser_storage', description: 'Read or change localStorage (area "local", default) or sessionStorage ("session") of the current page: op get (all or one key), set, remove, clear.', inputSchema: { type: 'object', properties: { tab, op: { type: 'string', enum: ['get', 'set', 'remove', 'clear'] }, area: { type: 'string', enum: ['local', 'session'] }, key: { type: 'string' }, value: { type: 'string' } }, required: ['op'] } },
  { name: 'browser_downloads', description: 'List recent downloads (op list) or wait for the next download to finish (op wait, after clicking a download link). Returns file paths.', inputSchema: { type: 'object', properties: { tab, op: { type: 'string', enum: ['list', 'wait'] }, limit: { type: 'number' }, timeout: { type: 'number' } } } },
  { name: 'browser_history', description: 'Go back, forward, or reload the tab.', inputSchema: { type: 'object', properties: { tab, action: { type: 'string', enum: ['back', 'forward', 'reload'] }, snapshot: snap }, required: ['action'] } },
  { name: 'browser_dialog', description: 'Accept or dismiss a JavaScript alert/confirm/prompt that is open (text fills a prompt).', inputSchema: { type: 'object', properties: { tab, accept: { type: 'boolean' }, text: { type: 'string' } } } },
  { name: 'browser_headless', description: 'Launch or close a headless Chrome for background automation (separate clean profile). launch returns a tab id.', inputSchema: { type: 'object', properties: { action: { type: 'string', enum: ['launch', 'close', 'list'] }, browser: { type: 'string' }, headed: { type: 'boolean' } }, required: ['action'] } },
  { name: 'panel_identify', description: 'Tell the Luculent side-panel chat who you are so the user can see provider, model, and chat name.', inputSchema: { type: 'object', properties: { provider: { type: 'string' }, model: { type: 'string' }, chatName: { type: 'string', description: 'Name of this chat or session, so the user can recognize it.' } } } },
  { name: 'panel_read_messages', description: 'Read messages from the user in the Luculent side-panel chat, plus any attached page context. Follow-up replies should use the attached page context when present.', inputSchema: { type: 'object', properties: { since: { type: 'number', description: 'Only messages after this unix ms timestamp.' }, id: { type: 'string' } } } },
  { name: 'panel_send_message', description: 'Post a message to the Luculent side-panel chat so the user can read it. This is a chat message, not a privileged command, and does not bypass security guards.', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
  { name: 'panel_page_context', description: 'Get the page context the user pulled into this chat (title, URL, text, headings, links, tables, selection), if any. Also used when the user clicks Pull page context; treat that as a request to blurb the page and ask what you can answer about it.', inputSchema: { type: 'object', properties: { id: { type: 'string' } } } },
  { name: 'browser_pause_for_human', description: 'Pause and notify the user to finish a CAPTCHA, 2FA, or other step in the real tab. Resumes when they confirm in the side panel or popup, or when the timeout elapses. Does not steal OS focus.', inputSchema: { type: 'object', properties: { reason: { type: 'string' }, message: { type: 'string' }, tab, timeout: { type: 'number', description: 'Milliseconds to wait (default 300000).' } } } },
  { name: 'browser_flow_record', description: 'Start recording a named flow of browser steps (no model calls on replay).', inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } },
  { name: 'browser_flow_stop', description: 'Stop recording and save the flow.', inputSchema: { type: 'object', properties: {} } },
  { name: 'browser_flow_list', description: 'List saved recorded flows.', inputSchema: { type: 'object', properties: {} } },
  { name: 'browser_flow_replay', description: 'Replay a saved flow with no model calls. If a step fails, returns needsModel so you can take over.', inputSchema: { type: 'object', properties: { name: { type: 'string' }, tab }, required: ['name'] } },
  { name: 'browser_profiles', description: 'List Chrome profiles connected to this relay.', inputSchema: { type: 'object', properties: {} } },
  { name: 'browser_plan', description: 'File a short plan (typically the next 3 clicks/moves) with an expected state after each step. op=run executes the plan: after each action a cheap confirm (URL/title, visibility, short accessibility snapshot) is checked against that step\'s expect. A match runs the next planned move immediately, without a full page re-analysis. A miss returns event=replan with the confirmed state so you can op=adjust the remaining steps. op=get/clear/confirm/set inspect, drop, or preview the plan shown in the side panel. A screenshot is used only when the cheap check is inconclusive or failed.',
    inputSchema: { type: 'object', properties: {
      tab,
      op: { type: 'string', enum: ['run', 'set', 'get', 'clear', 'confirm', 'adjust', 'next'], description: 'Default run when steps are provided, otherwise get.' },
      goal: { type: 'string', description: 'What this plan is trying to accomplish (shown in the side panel).' },
      autoConfirm: { type: 'boolean', description: 'Confirm expected state after each step (default true).' },
      visionWhenNeeded: { type: 'boolean', description: 'Fall back to a cheap screenshot only if the DOM/accessibility confirm is inconclusive or failed (default true).' },
      reason: { type: 'string', description: 'adjust: why the remaining plan is being rewritten.' },
      fromIndex: { type: 'number', description: 'adjust: replace steps starting at this index (default: current).' },
      steps: { type: 'array', items: { type: 'object', description: 'A planned action plus expect. Use the same action fields as browser_run steps.', properties: {
        action: { type: 'string' },
        url: { type: 'string' },
        target: { type: 'string' },
        text: { type: 'string' },
        label: { type: 'string' },
        waitNav: { type: 'boolean' },
        submit: { type: 'boolean' },
        ms: { type: 'number' },
        expect: { type: 'object', description: 'Assertions about the page after this step. Strings are case-insensitive substrings, or regex if they start with ^ or are /pattern/.', properties: {
          url: { type: 'string' },
          title: { type: 'string' },
          text: { type: 'string' },
          heading: { type: 'string' },
          visible: { type: 'string', description: 'A target that should be visible (text=, css=, role=, or a snapshot ref).' },
          snapshotIncludes: { type: 'string' },
        } },
      } } },
    } } },
];

function fmtValue(v) {
  if (v === undefined) return '';
  const s = typeof v === 'string' ? JSON.stringify(v) : JSON.stringify(v);
  return s.length > 4000 ? s.slice(0, 4000) + '…' : s;
}

export function formatRun(r) {
  const lines = [`${r.ok ? 'ok' : 'FAILED'} tab=${r.tab} ${r.results.length} step(s) ${r.totalMs}ms`];
  for (const s of r.results) {
    if (s.action === 'snapshot' && s.value) { lines.push(`#${s.i} snapshot ${s.ms}ms`); lines.push(formatSnapshot(s.value)); continue; }
    if (s.action === 'screenshot' && s.value) { lines.push(`#${s.i} screenshot ${s.ms}ms (${Math.round(s.value.data.length * 0.75 / 1024)} KB, use browser_screenshot to view)`); continue; }
    lines.push(`#${s.i} ${s.action} ${s.ok ? 'ok' : 'ERROR'} ${s.ms}ms${s.ok ? (s.value !== undefined ? ' => ' + fmtValue(s.value) : '') : ': ' + s.error}`);
  }
  if (r.dialogs && r.dialogs.length) lines.push('dialogs: ' + r.dialogs.map((d) => `${d.type} "${String(d.message).slice(0, 120)}" -> ${d.handled}`).join('; '));
  if (r.snapshot) lines.push('--- snapshot ---', formatSnapshot(r.snapshot));
  if (r.snapshotError) lines.push(`(snapshot failed: ${r.snapshotError})`);
  return lines.join('\n');
}

const text = (t, isError = false) => ({ content: [{ type: 'text', text: t }], ...(isError ? { isError: true } : {}) });

/** Execute an MCP tool via an rpc(method, params) function that talks to the relay API. */
export async function callTool(name, a, rpc) {
  a = a || {};
  const runOne = async (step) => {
    const r = await rpc('run', { tab: a.tab, steps: [step], snapshot: a.snapshot || 'diff' });
    return text(formatRun(r), !r.ok);
  };
  switch (name) {
    case 'browser_run': {
      const r = await rpc('run', { tab: a.tab, steps: a.steps, snapshot: a.snapshot || 'diff', stopOnError: a.stopOnError !== false, dialogs: a.dialogs });
      return text(formatRun(r), !r.ok);
    }
    case 'browser_tabs': {
      if (a.action === 'list' || !a.action) {
        const r = await rpc('tabs.list', {});
        return text([`extension: ${r.extension ? 'connected' : 'not connected'}${r.killed ? ' (KILLSWITCH ON)' : ''}`, ...r.tabs.map((t) => `${t.tab}${t.active ? ' *' : ''} [${t.source}] ${t.title || ''} — ${t.url}`)].join('\n'));
      }
      if (a.action === 'new') { const r = await rpc('tabs.new', { url: a.url, source: a.source, active: a.active }); return text(`opened tab ${r.tab}${r.url ? ' ' + r.url : ''}`); }
      if (a.action === 'close') { const ids = [...(a.tabs || []), ...(a.tab != null ? [a.tab] : [])]; for (const t of ids) await rpc('tabs.close', { tab: t }); return text(`closed ${ids.join(', ')}`); }
      if (a.action === 'activate') { await rpc('tabs.activate', { tab: a.tab }); return text(`activated ${a.tab}`); }
      return text(`unknown action ${a.action}`, true);
    }
    case 'browser_snapshot': {
      const r = await rpc('snapshot', a);
      return text(formatSnapshot(r));
    }
    case 'browser_navigate': return runOne({ action: 'navigate', url: a.url, wait: a.wait });
    case 'browser_click': return runOne({ action: 'click', target: a.target, waitNav: a.waitNav });
    case 'browser_type': return runOne({ action: 'type', target: a.target, text: a.text, clear: a.clear, submit: a.submit, waitNav: a.waitNav });
    case 'browser_press': return runOne({ action: 'press', key: a.key, keys: a.keys, target: a.target, waitNav: a.waitNav });
    case 'browser_hover': return runOne({ action: 'hover', target: a.target });
    case 'browser_scroll': return runOne({ action: 'scroll', target: a.target, dy: a.dy, dx: a.dx });
    case 'browser_select': return runOne({ action: 'select', target: a.target, value: a.values && a.values.length ? a.values : a.value });
    case 'browser_check': return runOne({ action: 'check', target: a.target, checked: a.checked });
    case 'browser_upload': return runOne({ action: 'upload', target: a.target, files: a.files });
    case 'browser_history': return runOne({ action: a.action });
    case 'browser_dialog': return runOne({ action: 'dialog', accept: a.accept, text: a.text });
    case 'browser_wait': { const { tab: _t, ...w } = a; return runOne({ action: 'wait', ...w }); }
    case 'browser_eval': case 'browser_cookies': case 'browser_storage': case 'browser_downloads': {
      const step = name === 'browser_eval' ? { action: 'eval', js: a.js } : { ...a, action: name.slice(8) };
      delete step.tab;
      const r = await rpc('run', { tab: a.tab, steps: [step] });
      const s = r.results[0];
      return s.ok ? text(s.value === undefined ? 'undefined' : typeof s.value === 'string' ? s.value : JSON.stringify(s.value, null, 1).slice(0, 20000)) : text(s.error, true);
    }
    case 'browser_extract': {
      const r = await rpc('run', { tab: a.tab, steps: [{ action: 'extract', target: a.target, what: a.what, attr: a.attr, all: a.all }] });
      const s = r.results[0];
      return s.ok ? text(typeof s.value === 'string' ? s.value : JSON.stringify(s.value)) : text(s.error, true);
    }
    case 'browser_screenshot': {
      const r = await rpc('screenshot', { tab: a.tab, fullPage: a.fullPage, quality: a.quality });
      return { content: [{ type: 'image', data: r.data, mimeType: r.mime }] };
    }
    case 'browser_parallel': {
      const r = await rpc('runParallel', { jobs: a.jobs });
      let closed = '';
      if (a.close) {
        const opened = r.results.filter((x, i) => x.tab != null && (a.jobs[i] || {}).tab == null).map((x) => x.tab);
        for (const t of opened) await rpc('tabs.close', { tab: t }).catch(() => {});
        if (opened.length) closed = `\nclosed ${opened.join(', ')}`;
      }
      return text(r.results.map((x) => (x.error ? `job error: ${x.error}` : formatRun(x))).join('\n\n') + `\n(total ${r.totalMs}ms)` + closed, !r.ok);
    }
    case 'browser_headless': {
      if (a.action === 'launch') { const r = await rpc('headless.launch', { headed: a.headed }); return text(`launched ${r.browser}${r.headed ? ' (headed)' : ''}, tab ${r.tab}`); }
      if (a.action === 'close') { await rpc('headless.close', { browser: a.browser }); return text('closed'); }
      const r = await rpc('tabs.list', {});
      return text(r.tabs.filter((t) => t.source !== 'extension').map((t) => `${t.tab} ${t.url}`).join('\n') || 'no headless browsers');
    }
    
    case 'panel_identify': return text(JSON.stringify(await rpc('panel.identify', { provider: a.provider, model: a.model, chatName: a.chatName }), null, 2));
    case 'panel_read_messages': {
      const r = await rpc('panel.state', { since: a.since, id: a.id });
      return text(JSON.stringify({ messages: r.view?.messages || [], pageContext: r.view?.pageContext || null, identity: { provider: r.view?.provider, model: r.view?.model, chatName: r.view?.chatName }, pause: r.pause || null }, null, 2));
    }
    case 'panel_send_message': {
      const r = await rpc('panel.post', { from: 'agent', text: a.text });
      return text('sent');
    }
    case 'panel_page_context': {
      const r = await rpc('panel.state', { id: a.id });
      const ctx = r.view?.pageContext;
      if (!ctx) return text('No page context is attached to this chat. The user can click Pull page context in the side panel.');
      return text(JSON.stringify({ instruction: 'Reply with a quick blurb of what this page is, then ask what you can answer about the page\'s content.', pageContext: ctx, chip: r.view?.chip }, null, 2));
    }
    case 'browser_pause_for_human': return text(JSON.stringify(await rpc('pause_for_human', { reason: a.reason, message: a.message, tab: a.tab, timeout: a.timeout }), null, 2));
    case 'browser_flow_record': return text(JSON.stringify(await rpc('flow.record', { name: a.name }), null, 2));
    case 'browser_flow_stop': return text(JSON.stringify(await rpc('flow.stop', {}), null, 2));
    case 'browser_flow_list': return text(JSON.stringify(await rpc('flow.list', {}), null, 2));
    case 'browser_flow_replay': return text(JSON.stringify(await rpc('flow.replay', { name: a.name, tab: a.tab }), null, 2));
    case 'browser_profiles': return text(JSON.stringify(await rpc('profiles.list', {}), null, 2));
    case 'browser_plan': {
      const op = a.op || (a.steps && a.steps.length ? 'run' : 'get');
      const method = op === 'start' ? 'plan.set' : ('plan.' + op);
      const params = { tab: a.tab, goal: a.goal, steps: a.steps, autoConfirm: a.autoConfirm, visionWhenNeeded: a.visionWhenNeeded, expect: a.expect, reason: a.reason, fromIndex: a.fromIndex };
      const r = await rpc(method, params);
      return text(JSON.stringify(r, null, 2), r && r.ok === false && r.event === 'step-failed');
    }
    default: return text(`Unknown tool ${name}`, true);

  }
}

export const SUPPORTED_PROTOCOLS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

/** Handle one MCP JSON-RPC message. Returns a response object or null for notifications. */
export async function handleMcp(msg, rpc, serverInfo = { name: 'luculent-browser-driver', title: 'Luculent Browser Driver for AI Agents', version: '0.3.0' }) {
  const { id, method, params } = msg;
  const reply = (result) => ({ jsonrpc: '2.0', id, result });
  const fail = (code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });
  if (id === undefined || id === null) return null; // notification
  try {
    switch (method) {
      case 'initialize': {
        try { if (params && params.clientInfo) await rpc('panel.hello', { clientInfo: params.clientInfo }); } catch (_) {}

        const want = params && params.protocolVersion;
        return reply({ protocolVersion: SUPPORTED_PROTOCOLS.includes(want) ? want : SUPPORTED_PROTOCOLS[1], capabilities: { tools: { listChanged: false } }, serverInfo, instructions: 'Luculent Browser Driver for AI Agents: prefer browser_run to batch many steps in one call; use snapshot refs like e12 as targets; snapshots default to diffs. The user controls what agents may do (tabs, passwords, eval, uploads, sites); a refusal starting "Blocked by your Luculent security settings" is final, so ask the user instead of working around it.' });
      }
      case 'ping': return reply({});
      case 'tools/list': return reply({ tools: TOOLS });
      case 'tools/call': {
        try { return reply(await callTool(params.name, params.arguments, rpc)); } catch (e) { return reply(text(`Error: ${e.message}`, true)); }
      }
      case 'resources/list': return reply({ resources: [] });
      case 'prompts/list': return reply({ prompts: [] });
      default: return fail(-32601, `Method not found: ${method}`);
    }
  } catch (e) {
    return fail(-32603, e.message);
  }
}
