// T1274 speed analysis: Luculent Browser Driver vs Playwright MCP (driver-only on real sites)
// plus end-to-end Gemini timing (time-to-first-action and per-step model vs driver split).
// Never prints API keys or key file contents.
// Usage:
//   node bench/speed-analysis.mjs --phase all
//   node bench/speed-analysis.mjs --phase driver|pw|e2e|confirm
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir, cpus, totalmem } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Relay } from '../src/relay.mjs';
import { KeyStore } from '../src/keys.mjs';
import { TOOLS, handleMcp } from '../src/mcp-tools.mjs';
import { HeadlessBrowser, findPlaywrightChromium } from '../src/headless.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : d; };
const PHASE = opt('phase', 'all');
const want = (n) => PHASE === 'all' || PHASE.split(',').includes(n);
const ITERS = Number(opt('iters', '3'));
const OUT_DIR = resolve(here, 'out');
mkdirSync(OUT_DIR, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const median = (a) => { const s = [...a].filter((x) => Number.isFinite(x)).sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : null; };
const mean = (a) => { const s = a.filter((x) => Number.isFinite(x)); return s.length ? s.reduce((x, y) => x + y, 0) / s.length : null; };
const fmt = (n, d = 1) => (n == null || !Number.isFinite(n) ? 'n/a' : (+n).toFixed(d));
const log = (...a) => console.error(...a);

const SITES = [
  { id: 'wikipedia-ada', url: 'https://en.wikipedia.org/wiki/Ada_Lovelace' },
  { id: 'wikipedia-us', url: 'https://en.wikipedia.org/wiki/United_States' },
  { id: 'wikipedia-home', url: 'https://www.wikipedia.org/' },
  { id: 'mdn-document', url: 'https://developer.mozilla.org/en-US/docs/Web/API/Document' },
  { id: 'github-playwright-mcp', url: 'https://github.com/microsoft/playwright-mcp' },
  { id: 'hacker-news', url: 'https://news.ycombinator.com/' },
  { id: 'nodejs-fs', url: 'https://nodejs.org/docs/latest/api/fs.html' },
  { id: 'python-os', url: 'https://docs.python.org/3/library/os.html' },
  { id: 'w3-aria', url: 'https://www.w3.org/TR/wai-aria-1.2/' },
  { id: 'todomvc-react', url: 'https://todomvc.com/examples/react/dist/' },
  { id: 'quotes', url: 'https://quotes.toscrape.com/' },
  { id: 'the-internet-login', url: 'https://the-internet.herokuapp.com/login' },
  { id: 'httpbin-html', url: 'https://httpbin.org/html' },
  { id: 'example', url: 'https://example.com/' },
];

class McpClient {
  constructor(cmd, args, env) {
    this.p = spawn(cmd, args, { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.seq = 0; this.pending = new Map(); this.buf = ''; this.err = '';
    this.p.stdout.setEncoding('utf8');
    this.p.stdout.on('data', (c) => {
      this.buf += c;
      let i;
      while ((i = this.buf.indexOf('\n')) >= 0) {
        const l = this.buf.slice(0, i);
        this.buf = this.buf.slice(i + 1);
        if (!l.trim()) continue;
        let m;
        try { m = JSON.parse(l); } catch (_) { continue; }
        const p = this.pending.get(m.id);
        if (p) { this.pending.delete(m.id); p({ m, bytes: l.length }); }
      }
    });
    this.p.stderr.on('data', (c) => { this.err += c; });
  }
  req(method, params) {
    const id = ++this.seq;
    return new Promise((r, j) => {
      const t = setTimeout(() => { this.pending.delete(id); j(new Error('timeout ' + method)); }, 60000);
      this.pending.set(id, (v) => { clearTimeout(t); r(v); });
      this.p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }
  async init() {
    await this.req('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'lbd-speed-analysis', version: '1' } });
    this.p.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  }
  async call(name, args) {
    const t = performance.now();
    const { m, bytes } = await this.req('tools/call', { name, arguments: args });
    const ms = performance.now() - t;
    if (m.error) throw new Error(`${name}: ${m.error.message}`);
    const text = (m.result.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
    if (m.result.isError) throw new Error(`${name}: ${text.slice(0, 300)}`);
    return { ms, bytes, text };
  }
  close() { try { this.p.kill(); } catch (_) {} }
}

function parseRunTimings(text) {
  const total = / (\d+(?:\.\d+)?)ms\s*$/m.exec(text.split('\n')[0] || '');
  const steps = [];
  for (const line of text.split('\n')) {
    const m = /^#(\d+) (\S+) (ok|ERROR) (\d+(?:\.\d+)?)ms/.exec(line.trim());
    if (m) steps.push({ i: +m[1], action: m[2], ok: m[3] === 'ok', ms: +m[4] });
  }
  return { internalMs: total ? +total[1] : steps.reduce((s, x) => s + x.ms, 0), steps };
}

async function startLbd() {
  const keys = new KeyStore(mkdtempSync(join(tmpdir(), 'lbd-speed-')));
  const relay = await new Relay({ port: 0, keys, log: () => {}, policy: { rateLimit: { perSecond: 1000, perMinute: 60000 } } }).start();
  const token = keys.mint({ name: 'speed', scopes: ['read', 'act', 'tabs', 'headless'] }).token;
  const mcp = new McpClient(process.execPath, [resolve(here, '..', 'src', 'cli.mjs'), 'mcp', '--port', String(relay.port)], { LBD_KEY: token });
  await mcp.init();
  const launched = await mcp.call('browser_headless', { action: 'launch' });
  const tab = /tab (\S+)/.exec(launched.text)?.[1];
  if (!tab) throw new Error('no headless tab: ' + launched.text.slice(0, 200));
  return { relay, mcp, tab, stop: async () => { mcp.close(); await relay.stop(); } };
}

async function measureSiteLbd(mcp, tab, site, iters) {
  const rows = [];
  for (let i = 0; i < iters + 1; i++) {
    const row = { i, warm: i === 0, url: site.url };
    try {
      const nav = await mcp.call('browser_run', { tab, steps: [{ action: 'navigate', url: site.url, wait: 'domcontentloaded' }], snapshot: 'none' });
      const navT = parseRunTimings(nav.text);
      row.navigateCallMs = nav.ms;
      row.navigateInternalMs = navT.internalMs;
      row.navigateTransportMs = nav.ms - navT.internalMs;
      const rtt = await mcp.call('browser_tabs', { action: 'list' });
      row.relayRttMs = rtt.ms;
      const snap = await mcp.call('browser_snapshot', { tab, mode: 'full' });
      row.snapshotCallMs = snap.ms;
      row.snapshotBytes = snap.bytes;
      const shot = await mcp.call('browser_screenshot', { tab, quality: 40 });
      row.screenshotCallMs = shot.ms;
      row.screenshotBytes = shot.bytes;
      const act = await mcp.call('browser_run', { tab, steps: [{ action: 'extract', what: 'text', target: 'css=h1, title, h2' }, { action: 'scroll', dy: 400 }], snapshot: 'none' });
      const actT = parseRunTimings(act.text);
      row.actionCallMs = act.ms;
      row.actionInternalMs = actT.internalMs;
      row.actionTransportMs = act.ms - actT.internalMs;
      const rec = await mcp.call('browser_snapshot', { tab, mode: 'full' });
      row.reperceiveSnapshotMs = rec.ms;
      row.ok = true;
    } catch (e) {
      row.ok = false;
      row.error = String(e.message || e).slice(0, 300);
    }
    if (i > 0) rows.push(row);
    log(`  lbd ${site.id} iter=${i} ok=${row.ok} nav=${fmt(row.navigateCallMs)} snap=${fmt(row.snapshotCallMs)} shot=${fmt(row.screenshotCallMs)} act=${fmt(row.actionCallMs)} rtt=${fmt(row.relayRttMs)}${row.error ? ' ERR ' + row.error : ''}`);
  }
  const nums = (k) => rows.filter((r) => r.ok).map((r) => r[k]);
  return {
    id: site.id, url: site.url, iters: rows.length,
    passed: rows.filter((r) => r.ok).length, failed: rows.filter((r) => !r.ok).length,
    errors: rows.filter((r) => r.error).map((r) => r.error),
    median: {
      navigateCallMs: median(nums('navigateCallMs')),
      navigateInternalMs: median(nums('navigateInternalMs')),
      snapshotCallMs: median(nums('snapshotCallMs')),
      snapshotBytes: median(nums('snapshotBytes')),
      screenshotCallMs: median(nums('screenshotCallMs')),
      screenshotBytes: median(nums('screenshotBytes')),
      actionCallMs: median(nums('actionCallMs')),
      actionInternalMs: median(nums('actionInternalMs')),
      relayRttMs: median(nums('relayRttMs')),
      reperceiveSnapshotMs: median(nums('reperceiveSnapshotMs')),
      transportMs: median([...nums('navigateTransportMs'), ...nums('actionTransportMs')]),
    },
    rows,
  };
}

function summarizeDriver(sites) {
  const ok = sites.filter((s) => s.passed > 0).map((s) => s.median);
  const pick = (k) => ok.map((m) => m[k]);
  return {
    sites: sites.length,
    sitesPassed: sites.filter((s) => s.passed > 0).length,
    sitesFailed: sites.filter((s) => s.passed === 0).length,
    medianAcrossSites: {
      snapshotCallMs: median(pick('snapshotCallMs')),
      screenshotCallMs: median(pick('screenshotCallMs')),
      actionCallMs: median(pick('actionCallMs')),
      relayRttMs: median(pick('relayRttMs')),
      reperceiveSnapshotMs: median(pick('reperceiveSnapshotMs')),
      navigateCallMs: median(pick('navigateCallMs')),
      transportMs: median(pick('transportMs')),
    },
    meanAcrossSites: {
      snapshotCallMs: mean(pick('snapshotCallMs')),
      screenshotCallMs: mean(pick('screenshotCallMs')),
      actionCallMs: mean(pick('actionCallMs')),
      relayRttMs: mean(pick('relayRttMs')),
      reperceiveSnapshotMs: mean(pick('reperceiveSnapshotMs')),
    },
  };
}

async function playwrightTools(mcp) {
  const { m } = await mcp.req('tools/list', {});
  const names = (m.result?.tools || []).map((t) => t.name);
  return {
    names,
    snapshot: names.find((n) => /snapshot/i.test(n)),
    screenshot: names.find((n) => /screenshot/i.test(n)),
    navigate: names.find((n) => /navigate/i.test(n)),
    tabs: names.find((n) => /tab/i.test(n)),
    eval: names.find((n) => /evaluate|eval/i.test(n)),
  };
}

async function measureSitePw(mcp, tools, site, iters) {
  const rows = [];
  for (let i = 0; i < iters + 1; i++) {
    const row = { i, warm: i === 0, url: site.url };
    try {
      const nav = await mcp.call(tools.navigate, { url: site.url });
      row.navigateCallMs = nav.ms;
      if (tools.tabs) {
        try { const rtt = await mcp.call(tools.tabs, tools.tabs.includes('list') || true ? { action: 'list' } : {}); row.relayRttMs = rtt.ms; } catch (_) { const rtt = await mcp.call(tools.tabs, {}); row.relayRttMs = rtt.ms; }
      }
      const snap = await mcp.call(tools.snapshot, {});
      row.snapshotCallMs = snap.ms;
      row.snapshotBytes = snap.bytes;
      if (tools.screenshot) {
        const shot = await mcp.call(tools.screenshot, {});
        row.screenshotCallMs = shot.ms;
        row.screenshotBytes = shot.bytes;
      }
      if (tools.eval) {
        const act = await mcp.call(tools.eval, { function: "() => document.title" });
        row.actionCallMs = act.ms;
      }
      const rec = await mcp.call(tools.snapshot, {});
      row.reperceiveSnapshotMs = rec.ms;
      row.ok = true;
    } catch (e) {
      row.ok = false;
      row.error = String(e.message || e).slice(0, 300);
    }
    if (i > 0) rows.push(row);
    log(`  pw  ${site.id} iter=${i} ok=${row.ok} nav=${fmt(row.navigateCallMs)} snap=${fmt(row.snapshotCallMs)} shot=${fmt(row.screenshotCallMs)} act=${fmt(row.actionCallMs)}${row.error ? ' ERR ' + row.error : ''}`);
  }
  const nums = (k) => rows.filter((r) => r.ok).map((r) => r[k]);
  return {
    id: site.id, url: site.url, iters: rows.length,
    passed: rows.filter((r) => r.ok).length, failed: rows.filter((r) => !r.ok).length,
    errors: rows.filter((r) => r.error).map((r) => r.error),
    median: {
      navigateCallMs: median(nums('navigateCallMs')),
      snapshotCallMs: median(nums('snapshotCallMs')),
      snapshotBytes: median(nums('snapshotBytes')),
      screenshotCallMs: median(nums('screenshotCallMs')),
      screenshotBytes: median(nums('screenshotBytes')),
      actionCallMs: median(nums('actionCallMs')),
      relayRttMs: median(nums('relayRttMs')),
      reperceiveSnapshotMs: median(nums('reperceiveSnapshotMs')),
    },
    rows,
  };
}

const E2E_TASKS = [
  {
    id: 'wikipedia-ada-birth',
    prompt: 'Using the browser tools, open https://en.wikipedia.org/wiki/Ada_Lovelace and tell me her date of birth exactly as it appears in the infobox. Prefer browser_run and snapshots over screenshots.',
    check: (a) => /10 December 1815|December 10, 1815|1815-12-10/i.test(a),
  },
  {
    id: 'quotes-first',
    prompt: 'Using the browser tools, open https://quotes.toscrape.com/ and tell me the exact text of the first quote and its author. Prefer browser_run and snapshots over screenshots.',
    check: (a) => /Einstein/i.test(a) && /thinking/i.test(a),
  },
  {
    id: 'github-playwright-mcp',
    prompt: 'Using the browser tools, open https://github.com/microsoft/playwright-mcp and tell me the repository description as shown near the top of the page, and the latest release tag if one is visible. Prefer browser_run and snapshots over screenshots. Do not sign in.',
    check: (a) => /playwright/i.test(a) && a.trim().length > 20,
  },
  // T1289: more real multi-step tasks on varied sites. books.toscrape.com has no priors and no cached locators (never seen).
  {
    id: 'books-travel-new-site',
    prompt: 'Using the browser tools, open https://books.toscrape.com/, open the Travel category from the sidebar, and tell me the title and price of the first book listed there. Prefer snapshots over screenshots.',
    check: (a) => /Himalayas/i.test(a) && /45\.17/.test(a),
  },
  {
    id: 'quotes-next-page',
    prompt: 'Using the browser tools, open https://quotes.toscrape.com/, go to the next page of quotes, and tell me the author of the first quote on that page. Prefer snapshots over screenshots.',
    check: (a) => /Marilyn Monroe/i.test(a),
  },
  {
    id: 'wikipedia-search',
    prompt: 'Using the browser tools, open https://en.wikipedia.org/wiki/Main_Page, use the site search box to search for Grace Hopper, open her article, and tell me her date of birth. Prefer snapshots over screenshots.',
    check: (a) => /December 9, 1906|9 December 1906|1906-12-09/i.test(a),
  },
];
const E2E_ITERS = Math.max(1, Number(opt('e2e-iters', '1')));
const TASK_FILTER = (opt('tasks', '') || '').split(',').map((x) => x.trim()).filter(Boolean);
const E2E_ARMS = opt('e2e-arms', 'both');

const SYSTEM_NOPLAN = 'You control a real Chrome browser through the browser_* tools. Be fast: prefer browser_run to batch several steps in one call, and use element refs (e12) from snapshots as targets. Prefer accessibility snapshots over screenshots unless you truly need pixels. Do not use browser_plan. When the task is done, reply with the answer in plain text.';
const SYSTEM_PLAN = 'You control a real Chrome browser through the browser_* tools. For any task with more than one page action, file one browser_plan up front with op=run covering the next set of actions. The plan is a loose framework, not a script: give each step an action and an intent in plain words, optional hints (likely link or button text, role, landmark, with a confidence), an estimate (likely page type, likely next 2-3 actions, likely blockers such as a cookie banner), and a soft expect (url/path/title words). For pages you have not seen, do not guess selectors, refs or positions; the driver resolves the intent on the live page in code. End the plan with an extract step that reads what you need. Only if the result is event=adapt, use its compact delta, candidates and framework to adjust the remaining steps (plan.adjust or a new short plan); do not replan from scratch. Prefer compact snapshots, avoid screenshots. When the task is done, reply with the answer in plain text.';
const SYSTEM = SYSTEM_NOPLAN;
const STEWARD = process.env.LBD_STEWARD || '';
const GEMINI_ENV_FILE = process.env.LBD_GEMINI_ENV_FILE || '';
const PY = process.env.LBD_PYTHON || 'python';
const GEMINI_MODELS = (opt('gemini-models', '') || 'gemini-flash-lite-latest,gemini-3.1-flash-lite,gemini-flash-latest,gemini-3.5-flash').split(',');
const geminiBadKeys = new Set();
const geminiSkip = new Set();

function geminiEnv() {
  if (!GEMINI_ENV_FILE) throw new Error('set LBD_GEMINI_ENV_FILE');
  const env = {};
  for (const ln of readFileSync(GEMINI_ENV_FILE, 'utf8').split(/\r?\n/)) {
    const m = /^(GEMINI_API_KEY_\d)=(.+)$/.exec(ln.trim());
    if (m) env[m[1]] = m[2];
  }
  return env;
}
function py(code) {
  return new Promise((res) => {
    const p = spawn(PY, ['-c', code], { cwd: STEWARD ? join(STEWARD, 'scripts') : undefined, windowsHide: true });
    let out = '', err = '';
    p.stdout.on('data', (c) => (out += c));
    p.stderr.on('data', (c) => (err += c));
    p.on('error', (e) => { log('  rotation helper failed to start: ' + e.message); res(''); });
    p.on('close', (code) => { if (code) log('  rotation helper exit ' + code + ': ' + err.trim().split(/\r?\n/).slice(-2).join(' | ')); res(out.trim()); });
  });
}
async function geminiPick() {
  if (!STEWARD) return { label: '1', model: GEMINI_MODELS[0] };
  const out = await py(`import json,gemini_rotate as gr,fallback_route as fr
st=fr._cool_state()
labels=fr.LABELS
ms=${JSON.stringify(GEMINI_MODELS)}
ms=list(dict.fromkeys(ms))
bad=set(${JSON.stringify([...geminiBadKeys])})
skip=set(${JSON.stringify([...geminiSkip])})
for l in labels:
    if l in bad: continue
    for m in gr.order_models(ms, st, l):
        if l+'|'+m not in skip and not gr.blocked(st,l,m):
            print(json.dumps({"label":l,"model":m})); raise SystemExit
print("{}")`);
  log('  gemini pick ' + out.replace(/AIza[^\s"]+/g, '[redacted]'));
  return JSON.parse(out || '{}');
}
async function geminiMark(label, model, status, body) {
  geminiSkip.add(label + '|' + model);
  if (status === 400 || !STEWARD) return;
  const b = JSON.stringify(String(body).slice(0, 2000));
  await py(`import json,gemini_rotate as gr,fallback_route as fr
c=gr.classify(${status}, json.loads(${JSON.stringify(b)}))
fr.mark_cool(${JSON.stringify(label)}, ${JSON.stringify(model)}, c.get("seconds") or getattr(gr,"COOL_RATE_S",300), "lbd-speed HTTP ${status}", c.get("kind"))`);
}

async function timedChat({ url, headers, model, prompt, mcpCall, system }) {
  const FUNCS = TOOLS.filter((t) => t && t.name && t.inputSchema).map((t) => ({ type: 'function', function: { name: t.name, description: t.description || '', parameters: t.inputSchema } }));
  const messages = [{ role: 'system', content: system || SYSTEM }, { role: 'user', content: prompt }];
  const promptSent = performance.now();
  const steps = [];
  let firstToolAt = null, tokens = 0, cost = 0, usedModel = model();
  for (let turn = 0; turn < 16; turn++) {
    const thinkStart = performance.now();
    let data, lastStatus = 0;
    for (let attempt = 0; ; attempt++) {
      let r, body;
      try {
        r = await fetch(url, {
          method: 'POST',
          signal: AbortSignal.timeout(120000),
          headers: { 'content-type': 'application/json', ...headers() },
          body: JSON.stringify({ model: model(), messages, tools: FUNCS, tool_choice: 'auto', temperature: 0 }),
        });
        body = await r.text();
        lastStatus = r.status;
      } catch (e) {
        log(`  turn ${turn} fetch error ${e.message}`);
        if (attempt > 3) throw e;
        continue;
      }
      log(`  turn ${turn} ${model()} HTTP ${r.status} ${Math.round(performance.now() - thinkStart)}ms`);
      if (r.ok) { data = JSON.parse(body); usedModel = model(); break; }
      if ((r.status === 429 || r.status >= 500) && attempt < 3) { await sleep(800 * (attempt + 1)); continue; }
      throw new Error(`HTTP ${r.status}: ${String(body).slice(0, 240)}`);
    }
    const thinkMs = performance.now() - thinkStart;
    if (data.usage) { tokens += data.usage.total_tokens || 0; cost += Number(data.usage.cost || 0); }
    const msg = data.choices[0].message;
    messages.push({ role: 'assistant', content: msg.content || '', ...(msg.tool_calls ? { tool_calls: msg.tool_calls } : {}) });
    if (!msg.tool_calls || !msg.tool_calls.length) {
      return {
        answer: msg.content || '',
        turns: turn + 1,
        tokens,
        cost,
        model: usedModel,
        ttfaMs: firstToolAt == null ? performance.now() - promptSent : firstToolAt - promptSent,
        noTool: firstToolAt == null,
        steps,
        totalMs: performance.now() - promptSent,
      };
    }
    for (const tc of msg.tool_calls) {
      if (firstToolAt == null) firstToolAt = performance.now();
      let args = {};
      try { args = tc.function.arguments ? JSON.parse(tc.function.arguments) : {}; } catch (_) {}
      const t0 = performance.now();
      let out, ok = true;
      try { out = await mcpCall(tc.function.name, args); } catch (e) { out = 'Error: ' + e.message; ok = false; }
      const driverMs = performance.now() - t0;
      steps.push({
        turn,
        tool: tc.function.name,
        thinkMs,
        driverMs,
        ok,
        preview: String(out).split('\n')[0].slice(0, 160),
        ...(tc.function.name === 'browser_plan' ? { args, out: String(out).slice(0, 4000) } : {}),
      });
      log(`    ${tc.function.name} driver=${fmt(driverMs)} think=${fmt(thinkMs)} -> ${String(out).split('\n')[0].slice(0, 140)}`);
      messages.push({ role: 'tool', tool_call_id: tc.id, name: tc.function.name, content: String(out).slice(0, 24000) });
    }
    void lastStatus;
  }
  return { answer: '(turn limit)', turns: 16, tokens, cost, model: usedModel, ttfaMs: firstToolAt == null ? null : firstToolAt - promptSent, steps, totalMs: performance.now() - promptSent };
}

async function runE2E(input = {}) {
  const keys = new KeyStore(mkdtempSync(join(tmpdir(), 'lbd-speed-e2e-')));
  const relay = await new Relay({ port: 0, keys, log: () => {}, policy: { rateLimit: { perSecond: 50, perMinute: 2000 } } }).start();
  const token = keys.mint({ name: 'speed-e2e', scopes: ['read', 'act', 'tabs', 'headless'] }).token;
  const ctx = { admin: false, key: keys.verify(token), sid: 'speed-e2e' };
  const rpc = (m, p) => relay.call(m, p, ctx);
  async function mcpCall(name, args) {
    const r = await handleMcp({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, rpc);
    const res = r.result;
    if (res?.isError) throw new Error((res.content || []).map((c) => c.text).join('\n').slice(0, 300));
    const outText = (res.content || []).map((c) => (c.type === 'text' ? c.text : `[${c.type} omitted]`)).join('\n');
    if (name === 'browser_plan' && planAgg) {
      try {
        const j = JSON.parse(outText);
        planAgg.calls += 1;
        if (j && j.event) planAgg.events.push(j.event);
        if (j && j.stats) for (const k of ['given', 'code', 'model', 'cowork', 'userDone', 'soft', 'blockers']) planAgg[k] += Number(j.stats[k] || 0);
        if (j && j.plan && Array.isArray(j.plan.steps)) for (const st of j.plan.steps) if (st.familiarity) planAgg.familiarity[st.familiarity] = (planAgg.familiarity[st.familiarity] || 0) + 1;
      } catch (_) {}
    }
    return outText;
  }
  let planAgg = null;
  const launched = await mcpCall('browser_headless', { action: 'launch' });
  log('  e2e launch ' + launched.split('\n')[0]);
  const planning = input.planning === true;
  const system = planning ? SYSTEM_PLAN : SYSTEM_NOPLAN;
  // T1284: e2e is DeepSeek Flash on OpenRouter (same model as the T1274 fallback).
  const forceOpenRouter = opt('e2e-provider', 'openrouter') !== 'gemini';
  let env = {};
  if (!forceOpenRouter) {
    try { env = geminiEnv(); } catch (e) { log('  gemini env missing, using OpenRouter'); }
  }
  if ((forceOpenRouter || !GEMINI_ENV_FILE) && !process.env.OPENROUTER_API_KEY) throw new Error('OPENROUTER_API_KEY is not set for DeepSeek Flash e2e');
  const results = [];
  const queue = E2E_TASKS.filter((t) => !TASK_FILTER.length || TASK_FILTER.includes(t.id)).flatMap((t) => Array.from({ length: E2E_ITERS }, (_, k) => ({ ...t, iter: k })));
  for (const task of queue) {
    let pick = forceOpenRouter ? { label: '', model: '' } : await geminiPick();
    log(`  e2e task ${task.id} iter ${task.iter}`);
    // Each run starts cold: no sites seen this session and no cached locators.
    try { relay.seenHosts.clear(); relay.locators.map.clear(); } catch (_) {}
    planAgg = { calls: 0, given: 0, code: 0, model: 0, cowork: 0, userDone: 0, soft: 0, blockers: 0, events: [], familiarity: {} };
    let r = null;
    if (forceOpenRouter || !pick.label) {
      try {
        r = await timedChat({
          url: 'https://openrouter.ai/api/v1/chat/completions',
          headers: () => ({ authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`, 'x-title': 'Luculent Browser Driver speed analysis' }),
          model: () => opt('openrouter-model', 'deepseek/deepseek-v4.1-flash-1017'),
          prompt: task.prompt,
          mcpCall,
          system,
        });
        r.fallback = 'openrouter';
      } catch (e) {
        r = { error: String(e.message).slice(0, 300), steps: [], ttfaMs: null, totalMs: null, answer: '' };
      }
    }
    for (let attempt = 0; attempt < 6 && !r; attempt++) {
      try {
        r = await timedChat({
          url: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
          headers: () => ({ authorization: `Bearer ${env['GEMINI_API_KEY_' + String(pick.label).split('-').pop()]}` }),
          model: () => pick.model,
          prompt: task.prompt,
          mcpCall,
          system,
        });
      } catch (e) {
        const status = /HTTP (\d+)/.exec(e.message);
        log(`  e2e ${task.id} attempt ${attempt} failed: ${String(e.message).slice(0, 180)}`);
        if (status) {
          if (+status[1] === 401) geminiBadKeys.add(pick.label);
          await geminiMark(pick.label, pick.model, +status[1], e.message);
        }
        pick = await geminiPick();
        if (!pick.label || attempt === 5) {
          // Last resort: OpenRouter if present (key is read from the environment, never printed).
          if (process.env.OPENROUTER_API_KEY) {
            try {
              r = await timedChat({
                url: 'https://openrouter.ai/api/v1/chat/completions',
                headers: () => ({ authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`, 'x-title': 'Luculent Browser Driver speed analysis' }),
                model: () => opt('openrouter-model', 'deepseek/deepseek-v4.1-flash-1017'),
                prompt: task.prompt,
                mcpCall,
              });
              r.fallback = 'openrouter';
            } catch (e2) {
              r = { error: String(e2.message || e.message).slice(0, 300), steps: [], ttfaMs: null, totalMs: null, answer: '' };
            }
          } else {
            r = { error: String(e.message).slice(0, 300), steps: [], ttfaMs: null, totalMs: null, answer: '' };
          }
        }
      }
    }
    const pass = !r.error && task.check(r.answer || '');
    const driverMs = (r.steps || []).reduce((s, x) => s + (x.driverMs || 0), 0);
    const thinkMs = (r.steps || []).reduce((s, x, i, a) => s + (i === 0 || a[i - 1].turn !== x.turn ? (x.thinkMs || 0) : 0), 0);
    const later = (r.steps || []).filter((x, i, a) => i > 0 && a[i - 1].turn !== x.turn);
    const recals = [];
    for (let i = 1; i < (r.steps || []).length; i++) {
      if (r.steps[i].turn !== r.steps[i - 1].turn) recals.push({ thinkMs: r.steps[i].thinkMs, driverMs: r.steps[i].driverMs, tool: r.steps[i].tool });
    }
    const row = {
      id: task.id,
      iter: task.iter,
      planStats: planning ? planAgg : null,
      pass,
      model: r.model || (pick && pick.model),
      keyLabel: pick && pick.label,
      ttfaMs: r.ttfaMs,
      totalMs: r.totalMs,
      tokens: r.tokens || 0,
      turns: r.turns,
      planning,
      toolCalls: (r.steps || []).length,
      driverMs,
      thinkMs,
      afterFirstAction: {
        count: recals.length,
        medianThinkMs: median(recals.map((x) => x.thinkMs)),
        medianDriverMs: median(recals.map((x) => x.driverMs)),
        medianRecalibrateMs: median(recals.map((x) => (x.thinkMs || 0) + (x.driverMs || 0))),
      },
      steps: r.steps,
      answer: (r.answer || '').slice(0, 400),
      error: r.error || null,
      unusedLater: later.length,
    };
    results.push(row);
    log(`  ${pass ? 'PASS' : 'FAIL'} ${task.id} plan=${planning} ttfa=${fmt(row.ttfaMs, 0)}ms total=${fmt(row.totalMs, 0)}ms tools=${row.toolCalls} tokens=${row.tokens || 0} think=${fmt(thinkMs, 0)} driver=${fmt(driverMs, 0)}${row.error ? ' ERR ' + row.error : ''}`);
    try { await mcpCall('browser_navigate', { url: 'about:blank', wait: 'none' }); } catch (_) {}
  }
  await relay.stop();
  return results;
}

async function runConfirmMicrobench() {
  const keys = new KeyStore(mkdtempSync(join(tmpdir(), 'lbd-speed-cf-')));
  const relay = await new Relay({ port: 0, keys, log: () => {}, policy: { rateLimit: { perSecond: 50, perMinute: 2000 } } }).start();
  const token = keys.mint({ name: 'speed-cf', scopes: ['read', 'act', 'tabs', 'headless'] }).token;
  const ctx = { admin: false, key: keys.verify(token), sid: 'speed-cf' };
  const rpc = (m, p) => relay.call(m, p, ctx);
  async function mcpCall(name, args) {
    const r = await handleMcp({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, rpc);
    const res = r.result;
    return (res.content || []).map((c) => (c.type === 'text' ? c.text : `[${c.type} omitted]`)).join('\n');
  }
  await mcpCall('browser_headless', { action: 'launch' });
  await mcpCall('browser_navigate', { url: 'https://en.wikipedia.org/wiki/Ada_Lovelace', wait: 'domcontentloaded' });
  const tSnap0 = performance.now();
  const fullSnap = await mcpCall('browser_snapshot', { mode: 'full' });
  const fullSnapMs = performance.now() - tSnap0;
  const tDiff0 = performance.now();
  await mcpCall('browser_snapshot', { mode: 'diff' });
  const diffSnapMs = performance.now() - tDiff0;
  let env = {};
  let pick = { label: 'openrouter', model: opt('openrouter-model', 'deepseek/deepseek-v4.1-flash-1017') };
  let confirmUrl = 'https://openrouter.ai/api/v1/chat/completions';
  let confirmHeaders = () => ({ authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`, 'x-title': 'Luculent Browser Driver speed analysis' });
  try {
    env = geminiEnv();
    const g = await geminiPick();
    if (g.label) {
      pick = g;
      confirmUrl = 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions';
      confirmHeaders = () => ({ authorization: `Bearer ${env['GEMINI_API_KEY_' + String(pick.label).split('-').pop()]}` });
    } else log('  confirm: Gemini cooling, using OpenRouter');
  } catch (e) { log('  confirm: ' + e.message + '; using OpenRouter'); }
  const ask = async (prompt) => {
    const t0 = performance.now();
    const r = await fetch(confirmUrl, {
      method: 'POST',
      signal: AbortSignal.timeout(120000),
      headers: { 'content-type': 'application/json', ...confirmHeaders() },
      body: JSON.stringify({ model: pick.model, messages: [{ role: 'user', content: prompt }], temperature: 0 }),
    });
    const body = await r.text();
    if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + body.slice(0, 200));
    const data = JSON.parse(body);
    return { ms: performance.now() - t0, text: data.choices?.[0]?.message?.content || '', tokens: data.usage?.total_tokens || 0 };
  };
  const shortSnap = fullSnap.slice(0, 2500);
  const expect = 'The page is Ada Lovelace on English Wikipedia. Next planned move: extract the birth date from the infobox.';
  const confirm = await ask(`Confirm or adjust this plan. Expected state: ${expect}\nHere is a short page snapshot:\n${shortSnap}\nReply with only JSON {"match":true|false,"adjust":""}.`);
  const replan = await ask(`You are driving a browser. Look at this page snapshot and decide the next action to get Ada Lovelace's date of birth from the infobox. Snapshot:\n${fullSnap.slice(0, 12000)}\nReply with the next browser_run step as JSON.`);
  await relay.stop();
  return {
    model: pick.model,
    keyLabel: pick.label,
    fullSnapshotMs: fullSnapMs,
    diffSnapshotMs: diffSnapMs,
    confirmThinkMs: confirm.ms,
    replanThinkMs: replan.ms,
    confirmTokens: confirm.tokens,
    replanTokens: replan.tokens,
    confirmPreview: confirm.text.slice(0, 200),
    replanPreview: replan.text.slice(0, 200),
  };
}

function projectPreemptive(driver, e2e, confirm) {
  const snap = driver?.medianAcrossSites?.reperceiveSnapshotMs ?? driver?.medianAcrossSites?.snapshotCallMs;
  const action = driver?.medianAcrossSites?.actionCallMs;
  const ttfa = median((e2e || []).map((t) => t.ttfaMs));
  const recalcThink = median((e2e || []).flatMap((t) => t.afterFirstAction?.medianThinkMs != null ? [t.afterFirstAction.medianThinkMs] : []));
  const recalcDriver = median((e2e || []).flatMap((t) => t.afterFirstAction?.medianDriverMs != null ? [t.afterFirstAction.medianDriverMs] : []));
  const n = 7;
  const missRate = 0.25;
  const fullStep = (recalcThink || 0) + (recalcDriver || 0);
  const confirmThink = confirm?.confirmThinkMs ?? (recalcThink != null ? recalcThink * 0.4 : null);
  const confirmDriver = confirm?.diffSnapshotMs ?? snap;
  const confirmStep = (confirmThink || 0) + (confirmDriver || 0) + (action || 0);
  const baseline = (ttfa || 0) + (n - 1) * fullStep;
  const planned = (ttfa || 0) + (n - 1) * ((1 - missRate) * confirmStep + missRate * (fullStep + (confirm?.replanThinkMs || recalcThink || 0)));
  return {
    assumptions: {
      steps: n,
      missRate,
      confirmThinkMeasured: !!confirm?.confirmThinkMs,
      notes: 'Projection for a 7-step task. missRate=0.25 is an assumption (plan wrong 1 in 4 screens), marked as such. Confirm cost uses the measured confirm-vs-replan microbench when present, otherwise 40% of full per-step think plus a snapshot diff. This is not a measured end-to-end of browser_plan.',
    },
    inputs: { ttfaMs: ttfa, fullRecalcThinkMs: recalcThink, fullRecalcDriverMs: recalcDriver, confirmThinkMs: confirmThink, confirmDriverMs: confirmDriver, actionMs: action, snapshotMs: snap },
    baseline7StepMs: baseline,
    preemptive7StepMs: planned,
    projectedSavingsMs: baseline - planned,
    projectedSavingsPct: baseline > 0 ? (baseline - planned) / baseline : null,
  };
}

const MERGE_FROM = opt('merge-from', '');
const results = MERGE_FROM && existsSync(MERGE_FROM) ? JSON.parse(readFileSync(MERGE_FROM, 'utf8')) : {
  meta: {
    date: new Date().toISOString(),
    machine: `${cpus()[0]?.model?.trim() || ''}, ${Math.round(totalmem() / 2 ** 30)} GB, ${process.platform}`,
    phase: PHASE,
    iters: ITERS,
    branch: 'feat/browser-driver-bench',
    note: 'Driver-only numbers exclude model time. Navigate includes page-load network. E2E uses Gemini keys 1-5 via rotation; key material is never written to this file.',
  },
};

if (MERGE_FROM) { delete results.fatal; results.meta = { ...results.meta, date: new Date().toISOString(), phase: PHASE, mergedFrom: MERGE_FROM }; }
try {
  if (want('driver')) {
    log('== driver-only LBD ==');
    const lbd = await startLbd();
    const sites = [];
    for (const site of SITES) sites.push(await measureSiteLbd(lbd.mcp, lbd.tab, site, ITERS));
    await lbd.stop();
    results.lbdDriver = { summary: summarizeDriver(sites), sites };
  }
  if (want('pw')) {
    log('== driver-only Playwright MCP ==');
    const cli = resolve(here, '..', 'node_modules', '@playwright', 'mcp', 'cli.js');
    if (!existsSync(cli)) {
      results.playwrightMcp = { error: 'npm i -D @playwright/mcp' };
    } else {
      const mcp = new McpClient(process.execPath, [cli, '--headless', '--isolated', '--browser', 'chrome'], {});
      try {
        await mcp.init();
        const tools = await playwrightTools(mcp);
        results.playwrightMcpTools = tools.names;
        const sites = [];
        for (const site of SITES) sites.push(await measureSitePw(mcp, tools, site, ITERS));
        results.playwrightMcp = { summary: summarizeDriver(sites), sites };
      } catch (e) {
        results.playwrightMcp = { error: e.message.slice(0, 400) };
      } finally { mcp.close(); }
    }
  }
  if (want('e2e')) {
    log('== e2e DeepSeek Flash without planned branches ==');
    if (E2E_ARMS !== 'plan') results.e2e = await runE2E({ planning: false });
    log('== e2e DeepSeek Flash with the loose plan framework ==');
    if (E2E_ARMS !== 'noplan') results.e2ePlan = await runE2E({ planning: true });
  }
  if (want('confirm')) {
    log('== confirm vs replan microbench ==');
    results.confirm = await runConfirmMicrobench();
  }
  if (results.lbdDriver || results.e2e || results.confirm) {
    results.preemptiveProjection = projectPreemptive(results.lbdDriver?.summary, results.e2e, results.confirm);
  }
} catch (e) {
  results.fatal = String(e && e.stack || e).slice(0, 1500);
  log('FATAL', results.fatal);
}

const outJson = resolve(OUT_DIR, opt('out-name', 'speed-analysis') + '.json');
writeFileSync(outJson, JSON.stringify(results, null, 2) + '\n');
log('wrote ' + outJson);

const lines = [];
lines.push('# Luculent Browser Driver speed analysis (T1284)');
lines.push('');
lines.push(`Measured: ${results.meta.date} on ${results.meta.machine}.`);
lines.push('Driver-only numbers exclude model think time. Navigate includes page-load network time.');
lines.push('');
if (results.lbdDriver?.summary) {
  const s = results.lbdDriver.summary.medianAcrossSites;
  lines.push('## Luculent driver-only (headless, MCP stdio, 14 real sites, median of site medians)');
  lines.push(`- Accessibility snapshot: ${fmt(s.snapshotCallMs, 0)} ms`);
  lines.push(`- Re-perceive snapshot after an action: ${fmt(s.reperceiveSnapshotMs, 0)} ms`);
  lines.push(`- Screenshot (JPEG q40): ${fmt(s.screenshotCallMs, 0)} ms`);
  lines.push(`- Action (extract + scroll): ${fmt(s.actionCallMs, 0)} ms`);
  lines.push(`- Relay round trip (tabs list): ${fmt(s.relayRttMs, 0)} ms`);
  lines.push(`- Transport residual (call minus internal step time): ${fmt(s.transportMs, 0)} ms`);
  lines.push(`- Navigate (includes network): ${fmt(s.navigateCallMs, 0)} ms`);
  lines.push(`- Sites with at least one successful iter: ${results.lbdDriver.summary.sitesPassed}/${results.lbdDriver.summary.sites}`);
  lines.push('');
  lines.push('| Site | Snap ms | Shot ms | Action ms | Re-perceive ms | RTT ms | Nav ms (w/ network) |');
  lines.push('|---|---:|---:|---:|---:|---:|---:|');
  for (const site of results.lbdDriver.sites) {
    const m = site.median;
    lines.push(`| ${site.id} | ${fmt(m.snapshotCallMs, 0)} | ${fmt(m.screenshotCallMs, 0)} | ${fmt(m.actionCallMs, 0)} | ${fmt(m.reperceiveSnapshotMs, 0)} | ${fmt(m.relayRttMs, 0)} | ${fmt(m.navigateCallMs, 0)} |`);
  }
  lines.push('');
}
if (results.playwrightMcp?.summary) {
  const s = results.playwrightMcp.summary.medianAcrossSites;
  lines.push('## Playwright MCP 0.0.85 driver-only (same sites, same machine)');
  lines.push(`- Snapshot: ${fmt(s.snapshotCallMs, 0)} ms`);
  lines.push(`- Re-perceive snapshot: ${fmt(s.reperceiveSnapshotMs, 0)} ms`);
  lines.push(`- Screenshot: ${fmt(s.screenshotCallMs, 0)} ms`);
  lines.push(`- Action (evaluate title): ${fmt(s.actionCallMs, 0)} ms`);
  lines.push(`- Navigate (includes network): ${fmt(s.navigateCallMs, 0)} ms`);
  lines.push(`- Sites passed: ${results.playwrightMcp.summary.sitesPassed}/${results.playwrightMcp.summary.sites}`);
  lines.push('');
} else if (results.playwrightMcp?.error) {
  lines.push(`## Playwright MCP: ${results.playwrightMcp.error}`);
  lines.push('');
}
function e2eSection(title, rows) {
  if (!rows) return;
  lines.push('## ' + title);
  lines.push('| Task | Pass | Model | TTFA ms | Total ms | Tool calls | Tokens | Median recalibrate think ms | Median recalibrate driver ms |');
  lines.push('|---|---|---|---:|---:|---:|---:|---:|---:|');
  for (const t of rows) {
    lines.push(`| ${t.id} | ${t.pass ? 'PASS' : 'FAIL'} | ${t.model || ''} | ${fmt(t.ttfaMs, 0)} | ${fmt(t.totalMs, 0)} | ${t.toolCalls} | ${t.tokens || 0} | ${fmt(t.afterFirstAction?.medianThinkMs, 0)} | ${fmt(t.afterFirstAction?.medianDriverMs, 0)} |`);
  }
  lines.push('');
  const ttfa = median(rows.map((t) => t.ttfaMs));
  const think = median(rows.map((t) => t.afterFirstAction?.medianThinkMs));
  const drv = median(rows.map((t) => t.afterFirstAction?.medianDriverMs));
  const tot = median(rows.map((t) => t.totalMs));
  const tok = median(rows.map((t) => t.tokens));
  lines.push(`Headline medians: TTFA ${fmt(ttfa, 0)} ms; total ${fmt(tot, 0)} ms; tokens ${fmt(tok, 0)}; per-step think ${fmt(think, 0)} ms; per-step driver ${fmt(drv, 0)} ms.`);
  lines.push('');
}
e2eSection('End-to-end with DeepSeek Flash, without planned branches', results.e2e);
e2eSection('End-to-end with DeepSeek Flash, with planned branches', results.e2ePlan);
if (results.e2e && results.e2ePlan) {
  lines.push('## Planning before / after (same tasks, DeepSeek Flash)');
  lines.push('| Task | TTFA no-plan | TTFA plan | Total no-plan | Total plan | Tools no-plan | Tools plan | Tokens no-plan | Tokens plan |');
  lines.push('|---|---:|---:|---:|---:|---:|---:|---:|---:|');
  for (const a of results.e2e) {
    const b = results.e2ePlan.find((x) => x.id === a.id) || {};
    lines.push(`| ${a.id} | ${fmt(a.ttfaMs, 0)} | ${fmt(b.ttfaMs, 0)} | ${fmt(a.totalMs, 0)} | ${fmt(b.totalMs, 0)} | ${a.toolCalls} | ${b.toolCalls} | ${a.tokens || 0} | ${b.tokens || 0} |`);
  }
  lines.push('');
}
if (results.confirm) {
  const c = results.confirm;
  lines.push('## Confirm-vs-replan microbench (Ada Lovelace page, same model)');
  lines.push(`- Full snapshot: ${fmt(c.fullSnapshotMs, 0)} ms`);
  lines.push(`- Diff snapshot: ${fmt(c.diffSnapshotMs, 0)} ms`);
  lines.push(`- Confirm-plan think: ${fmt(c.confirmThinkMs, 0)} ms (${c.confirmTokens} tokens)`);
  lines.push(`- Full replan think: ${fmt(c.replanThinkMs, 0)} ms (${c.replanTokens} tokens)`);
  lines.push('');
}
if (results.preemptiveProjection) {
  const p = results.preemptiveProjection;
  lines.push('## Preemptive 3-move planning (projection, not a measured end-to-end)');
  lines.push(`Assumptions: ${p.assumptions.steps}-step task, miss rate ${p.assumptions.missRate} (assumed, not measured). ${p.assumptions.notes}`);
  lines.push(`- Baseline: ${fmt(p.baseline7StepMs, 0)} ms`);
  lines.push(`- With preemptive confirm-or-adjust: ${fmt(p.preemptive7StepMs, 0)} ms`);
  lines.push(`- Projected savings: ${fmt(p.projectedSavingsMs, 0)} ms (${fmt((p.projectedSavingsPct || 0) * 100, 0)}%)`);
  lines.push('');
}
if (results.fatal) lines.push('FATAL: ' + results.fatal);
const outMd = resolve(OUT_DIR, opt('out-name', 'speed-analysis') + '.md');
writeFileSync(outMd, lines.join('\n'));
console.log(lines.join('\n'));
process.exit(results.fatal ? 1 : 0);
