// Model validation harness: runs the same click-test tasks through different model clients that use the
// Luculent Browser Driver MCP tools, and records pass/fail + timings + cost.
// Usage: node harness/models.mjs --models gemini,deepseek,codex [--tasks form,search] [--out results.json]
import { spawn, execFileSync } from 'node:child_process';
const require_ = () => ({ execFileSync });
import { mkdtempSync, cpSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Relay } from '../src/relay.mjs';
import { KeyStore } from '../src/keys.mjs';
import { TOOLS, handleMcp } from '../src/mcp-tools.mjs';
import { HeadlessBrowser, findPlaywrightChromium } from '../src/headless.mjs';
import { startFixtures } from '../test/fixtures.mjs';
import { startBroadFixtures } from '../test/fixtures-broad.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : d; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => { if (!argv.includes('--quiet')) console.error(...a); };
// Model runs use the Gemini 1-5 free keys (rotation) instead of OpenRouter; deepseek stays available on request.
const MODELS = opt('models', 'gemini,codex').split(',');
const STEWARD = process.env.LBD_STEWARD || ''; // dir with scripts/gemini_rotate.py + fallback_route.py (optional)
const GEMINI_ENV_FILE = process.env.LBD_GEMINI_ENV_FILE || ''; // KEY=value file with GEMINI_API_KEY_1..5 (never printed)
const PY = process.env.LBD_PYTHON || 'python';

// ---------- tasks ----------
const uploadFile = join(mkdtempSync(join(tmpdir(), 'lbd-up-')), 'hello-lbd.txt');
writeFileSync(uploadFile, 'driver-ok');
const TASKS = {
  form: {
    prompt: (u) => `Using the browser tools, open ${u}/form and sign up with full name "Ada Lovelace", email "ada@example.com", plan "Pro", tick the terms checkbox, and submit. Then tell me the exact text of the summary line on the result page.`,
    check: (fx, answer) => { const s = fx.submissions.at(-1) || {}; return s.name === 'Ada Lovelace' && s.email === 'ada@example.com' && s.plan === 'pro' && s.tos === 'on' && /name=Ada Lovelace/.test(answer); },
  },
  search: {
    prompt: (u) => `Using the browser tools, go to ${u}/search, search for "luculent" and list the titles of all results.`,
    check: (_fx, a) => ['luculent alpha', 'luculent beta', 'luculent gamma'].every((x) => a.toLowerCase().includes(x)),
  },
  multitab: {
    prompt: (u) => `Using the browser tools, open ${u}/item/7, ${u}/item/8 and ${u}/item/9 in three separate new tabs and tell me the main heading of each page. Close the three tabs when done.`,
    check: (_fx, a) => ['Item 7', 'Item 8', 'Item 9'].every((x) => a.includes(x)),
  },
  dynamic: {
    prompt: (u) => `Using the browser tools, open ${u}/dynamic, click the "Load" button, wait for new content to appear, and tell me exactly what text appeared.`,
    check: (_fx, a) => /Loaded late/i.test(a),
  },
  upload: {
    prompt: (u) => `Using the browser tools, open ${u}/upload and attach the local file ${uploadFile} to the file input, then tell me what the page says was picked.`,
    check: (_fx, a) => /hello-lbd\.txt/.test(a) && /driver-ok/.test(a),
  },
  // Broad use cases (fixtures-broad, second origin for cross-origin frames).
  iframe: {
    prompt: () => `Using the browser tools, open ${fxb.a}/iframes. Inside the cross-origin iframe (#cross), type "hi" into "Frame input" and click "Frame button". Tell me the text that appears inside that frame.`,
    check: (_fx, a) => /frame clicked hi/i.test(a),
  },
  hover: {
    prompt: () => `Using the browser tools, open ${fxb.a}/hover, open the "Products" hover menu, click "Laptops" and tell me the main heading of the page you land on.`,
    check: (_fx, a) => /Item hovered/i.test(a),
  },
  drag: {
    prompt: () => `Using the browser tools, open ${fxb.a}/dnd, drag the source box onto the drop zone and tell me what the drop zone says afterwards.`,
    check: (_fx, a) => /Dropped src/i.test(a),
  },
  popup: {
    prompt: () => `Using the browser tools, open ${fxb.a}/popup, click "Open window" and tell me the main heading of the window that opens.`,
    check: (_fx, a) => /Item popup/i.test(a),
  },
  guard: {
    prompt: () => `Using the browser tools, open ${fxb.a}/login and sign in with username "ada" and password "not-a-real-pass". Tell me what happened.`,
    check: (_fx, a) => !fxb.submissions.some((x) => x.path === '/welcome' && /not-a-real-pass/.test(JSON.stringify(x))) && /block|security|not allowed|refus|denied|password/i.test(a),
    note: 'Expected outcome: the password field is blocked by the default security settings and nothing is submitted.',
  },
};
const TASK_LIST = opt('tasks', Object.keys(TASKS).join(',')).split(',');
const SYSTEM = 'You control a real Chrome browser through the browser_* tools. Be fast: prefer browser_run to batch several steps in one call, and use element refs (e12) from snapshots as targets. When the task is done, reply with the answer in plain text.';

// ---------- environment ----------
const fx = await startFixtures();
const fxb = await startBroadFixtures();
const keys = new KeyStore(mkdtempSync(join(tmpdir(), 'lbd-models-')));
const relay = await new Relay({ port: Number(opt('port', 0)), keys, log: () => {} }).start();
// Default (safe) security policy, except uploads are pre-approved for the upload task (no human to click Allow).
relay.policy.set({ uploads: 'allow', rateLimit: { perSecond: 50, perMinute: 2000 } });
const key = keys.mint({ name: 'models', scopes: ['read', 'act', 'tabs', 'headless', 'upload'] }).token;
const extDir = join(mkdtempSync(join(tmpdir(), 'lbd-mext-')), 'extension');
cpSync(resolve(here, '..', 'extension'), extDir, { recursive: true });
// Extension side: same safe defaults, every tab of this throwaway profile granted (as a user would grant the tab),
// uploads pre-approved like the relay above.
writeFileSync(join(extDir, 'config.json'), JSON.stringify({ relayUrl: `ws://127.0.0.1:${relay.port}/ext`, settings: { grantMode: 'all', uploads: 'allow', rateLimit: { perSecond: 50, perMinute: 2000 } } }));
const browser = await HeadlessBrowser.launch({ chromePath: findPlaywrightChromium(), headless: true, extensionPath: extDir });
for (let i = 0; i < 200 && !relay.router.ext; i++) await sleep(50);
if (!relay.router.ext) throw new Error('extension did not connect');
const ctx = { admin: false, key: keys.verify(key), sid: 'harness' };
let toolCalls = 0;
let firstActionAt = 0;
function markFirstAction() { if (!firstActionAt) firstActionAt = performance.now(); }
const rpc = (m, p) => relay.call(m, p, ctx);
async function mcpCall(name, args) {
  markFirstAction();
  toolCalls++;
  const r = await handleMcp({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, rpc);
  const res = r.result;
  return (res.content || []).map((c) => (c.type === 'text' ? c.text : `[${c.type} omitted, ${Math.round((c.data || '').length * 0.75 / 1024)} KB]`)).join('\n');
}
async function resetBrowser() {
  const { tabs } = await relay.router.tabs();
  const ext = tabs.filter((t) => t.source === 'extension');
  for (const t of ext.slice(1)) await relay.router.closeTab(t.tab).catch(() => {});
  if (ext[0]) await relay.engine.navigate(ext[0].tab, { url: 'about:blank', wait: 'none' }).catch(() => {});
  relay.sessions.clear();
}

// ---------- OpenAI-compatible chat loop (Gemini, DeepSeek/OpenRouter) ----------
const FUNCS = TOOLS.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.inputSchema } }));
async function chatLoop({ url, headers, model, prompt, extra = {}, onError }) {
  const messages = [{ role: 'system', content: SYSTEM }, { role: 'user', content: prompt }];
  let cost = 0, tokens = 0, provider = null, resolvedModel = null;
  for (let turn = 0; turn < 25; turn++) {
    let data;
    for (let attempt = 0; ; attempt++) {
      const t0 = Date.now();
      let r, body;
      try {
        r = await fetch(url, { method: 'POST', signal: AbortSignal.timeout(120000), headers: { 'content-type': 'application/json', ...headers() }, body: JSON.stringify({ model: model(), messages, tools: FUNCS, tool_choice: 'auto', temperature: 0, ...extra }) });
        body = await r.text();
      } catch (e) { log(`  turn ${turn} ${model()} fetch error ${e.message}`); if (attempt > 3) throw e; continue; }
      log(`  turn ${turn} ${model()} HTTP ${r.status} ${Date.now() - t0}ms`);
      if (r.ok) { data = JSON.parse(body); break; }
      const next = onError ? await onError(r.status, body, r.headers) : false;
      if (!next || attempt > 24) throw new Error(`HTTP ${r.status}: ${body.slice(0, 300)}`);
    }
    if (data.usage) { tokens += data.usage.total_tokens || 0; cost += Number(data.usage.cost || 0); }
    if (data.provider) provider = data.provider;
    if (data.model) resolvedModel = data.model;
    const msg = data.choices[0].message;
    messages.push({ role: 'assistant', content: msg.content || '', ...(msg.tool_calls ? { tool_calls: msg.tool_calls } : {}) });
    if (!msg.tool_calls || !msg.tool_calls.length) return { answer: msg.content || '', turns: turn + 1, cost, tokens, provider, resolvedModel };
    for (const tc of msg.tool_calls) {
      let args = {};
      try { args = tc.function.arguments ? JSON.parse(tc.function.arguments) : {}; } catch (_) {}
      let out;
      try { out = await mcpCall(tc.function.name, args); } catch (e) { out = 'Error: ' + e.message; }
      log(`    ${tc.function.name} ${JSON.stringify(args).slice(0, 300)} -> ${out.split('\n')[0].slice(0, 160)}`);
      messages.push({ role: 'tool', tool_call_id: tc.id, name: tc.function.name, content: out.slice(0, 30000) });
    }
  }
  return { answer: '(turn limit)', turns: 25, cost, tokens, provider, resolvedModel };
}

// Gemini keys + rotation through the existing steward rotation (gemini_rotate.py via fallback_route.py).
function geminiEnv() {
  const p = GEMINI_ENV_FILE;
  if (!p) throw new Error('set LBD_GEMINI_ENV_FILE to the file holding GEMINI_API_KEY_1..5');
  const env = {};
  for (const ln of readFileSync(p, 'utf8').split(/\r?\n/)) { const m = /^(GEMINI_API_KEY_\d)=(.+)$/.exec(ln.trim()); if (m) env[m[1]] = m[2]; }
  return env;
}
function py(code) {
  return new Promise((res) => {
    const p = spawn(PY, ['-c', code], { cwd: join(STEWARD, 'scripts'), windowsHide: true });
    let out = '', err = ''; p.stdout.on('data', (c) => (out += c)); p.stderr.on('data', (c) => (err += c));
    p.on('error', (e) => { log('  rotation helper failed to start: ' + e.message); res(''); });
    p.on('close', (code) => { if (code) log('  rotation helper exit ' + code + ': ' + err.trim().split(/\r?\n/).slice(-2).join(' | ')); res(out.trim()); });
  });
}
// Default: the steward's free-pool order (PREFERRED_HEAD, incl. Gemma) plus these; --gemini-models pins an exact list.
const GEMINI_PINNED = !!opt('gemini-models', '');
const GEMINI_MODELS = (opt('gemini-models', '') || 'gemini-flash-latest,gemini-3.5-flash,gemini-flash-lite-latest,gemini-3.1-flash-lite').split(',');
const geminiBadKeys = new Set(); // labels that returned 401 in this run
const geminiSkip = new Set(); // label|model that failed in this run (never re-picked, even if the shared cooldown lapses)
async function geminiPick() {
  const out = await py(`import json,gemini_rotate as gr,fallback_route as fr
st=fr._cool_state()
labels=fr.LABELS
ms=${JSON.stringify(GEMINI_MODELS)}
if not ${GEMINI_PINNED ? 'True' : 'False'}: ms=list(dict.fromkeys(list(getattr(gr,'PREFERRED_HEAD',()))+ms))
bad=set(${JSON.stringify([...geminiBadKeys])})
skip=set(${JSON.stringify([...geminiSkip])})
for l in labels:
    if l in bad: continue
    for m in gr.order_models(ms, st, l):
        if l+'|'+m not in skip and not gr.blocked(st,l,m):
            print(json.dumps({"label":l,"model":m})); raise SystemExit
print("{}")`);
  log('  gemini pick ' + out);
  return JSON.parse(out || '{}');
}
async function geminiMark(label, model, status, body) {
  geminiSkip.add(label + '|' + model);
  // 400 is usually this harness's request (e.g. a model without tool calling), not the key's quota: skip it locally only,
  // so the shared steward cooldowns other jobs use stay clean.
  if (status === 400) return;
  const b = JSON.stringify(body.slice(0, 2000));
  await py(`import json,gemini_rotate as gr,fallback_route as fr
c=gr.classify(${status}, json.loads(${JSON.stringify(b)}))
fr.mark_cool(${JSON.stringify(label)}, ${JSON.stringify(model)}, c.get("seconds") or getattr(gr,"COOL_RATE_S",300), "lbd-harness HTTP ${status}", c.get("kind"))`);
}

function codexCwd() { const d = resolve(here, 'out', 'codex-cwd'); mkdirSync(d, { recursive: true }); return d; }
function codexEntry() {
  if (process.env.LBD_CODEX_JS) return process.env.LBD_CODEX_JS;
  const { execFileSync } = require_();
  const which = execFileSync(process.platform === 'win32' ? 'where' : 'which', ['codex'], { encoding: 'utf8' }).split(/\r?\n/).find(Boolean).trim();
  for (const c of [join(dirname(which), 'node_modules', '@openai', 'codex', 'bin', 'codex.js'), resolve(dirname(which), '..', 'lib', 'node_modules', '@openai', 'codex', 'bin', 'codex.js')]) if (existsSync(c)) return c;
  throw new Error('cannot find codex.js next to ' + which + ' (set LBD_CODEX_JS)');
}
const openrouterMaxTokens = Number(opt('max-tokens', 2000));
function openrouterRunner(defaultModel, optName) {
  return async (prompt) => {
    const model = opt(optName, defaultModel);
    const r = await chatLoop({
      url: 'https://openrouter.ai/api/v1/chat/completions',
      headers: () => ({ authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`, 'x-title': 'Luculent Browser Driver harness' }),
      model: () => model,
      prompt,
      extra: { usage: { include: true }, max_tokens: openrouterMaxTokens, provider: { sort: 'price' } },
      onError: async (status) => { if (status === 429 || status >= 500) { await sleep(2000); return true; } return false; },
    });
    return { ...r, model: r.resolvedModel || model };
  };
}

const runners = {
  async gemini(prompt) {
    const env = geminiEnv();
    let pick = await geminiPick();
    if (!pick.label) throw new Error('all Gemini keys/models are cooling down');
    const r = await chatLoop({
      url: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
      headers: () => ({ authorization: `Bearer ${env['GEMINI_API_KEY_' + pick.label.split('-').pop()]}` }),
      model: () => pick.model,
      prompt,
      onError: async (status, body) => {
        // Any key/model-level failure (429 quota incl. limit 0, 403 not allowed, 404 retired, 400 unsupported model,
        // 5xx) cools that key+model and moves on to the next available one in the free pool instead of dying.
        if (status === 413) return false; // request too large: same on every key
        if (status === 401 || /API_KEY_INVALID|API key not valid|API key expired/i.test(String(body))) geminiBadKeys.add(pick.label); // bad key: skip all its models
        await geminiMark(pick.label, pick.model, status, body);
        const prev = pick.label + '|' + pick.model;
        pick = await geminiPick();
        if (pick.label) log(`  gemini rotate ${prev} (HTTP ${status}) -> ${pick.label}|${pick.model}`);
        return !!pick.label;
      },
    });
    return { ...r, model: `${pick.model} (${pick.label})` };
  },
  async deepseek(prompt) { return openrouterRunner('deepseek/deepseek-v4.1-flash-1017', 'deepseek-model')(prompt); },
  async opus(prompt) { return openrouterRunner('anthropic/claude-opus-4.8', 'opus-model')(prompt); },
  async sonnet(prompt) { return openrouterRunner('anthropic/claude-sonnet-4.6', 'sonnet-model')(prompt); },
  async grok(prompt) { return openrouterRunner('x-ai/grok-4.3', 'grok-model')(prompt); },
  async codex(prompt) {
    // Codex connects to the relay's MCP-over-HTTP endpoint with the API key from an env var.
    const outFile = join(mkdtempSync(join(tmpdir(), 'lbd-codex-')), 'last.txt');
    const args = ['exec', '--skip-git-repo-check', '--sandbox', opt('codex-sandbox', 'read-only'), '-c', 'approval_policy="never"',
      '-c', `mcp_servers.lbd.url="http://127.0.0.1:${relay.port}/mcp"`, '-c', 'mcp_servers.lbd.bearer_token_env_var="LBD_KEY"',
      '-c', 'mcp_servers.lbd.tool_timeout_sec=120',
      '-c', 'mcp_servers.lbd.default_tools_approval_mode="approve"', // exec has no human to approve; the API key already scopes access
      // Codex Desktop ships its own browser/computer-use plugins; switch them off so the run uses only our MCP server.
      '-c', 'plugins."browser@openai-bundled".enabled=false', '-c', 'plugins."unified-computer-use@openai-bundled".enabled=false',
      // codex-cli 0.164.0 from npm on Windows lacks codex-code-mode-host.exe; run tools directly instead.
      ...(opt('codex-model') ? ['-m', opt('codex-model')] : []),
      ...TOOLS.flatMap((t) => ['-c', `mcp_servers.lbd.tools.${t.name}.approval_mode="approve"`]),
      ...(argv.includes('--codex-approve-for-me') ? ['--approve-for-me'] : []),
      ...(opt('codex-extra') ? JSON.parse(opt('codex-extra')) : []),
      '--output-last-message', outFile, '-'];
    const before = toolCalls;
    const res = await new Promise((resolveP) => {
      // Spawn codex's JS entry with node directly: no shell, so quotes in -c values and the prompt survive on Windows.
      // --codex-bin / LBD_CODEX_BIN: run the native codex.exe from a short path. The npm install path on Windows
      // is 263 chars to codex-code-mode-host.exe (> MAX_PATH), so Codex can't spawn its tool host from there.
      const bin = opt('codex-bin') || process.env.LBD_CODEX_BIN;
      const p = bin ? spawn(bin, args, { env: { ...process.env, LBD_KEY: key }, windowsHide: true, cwd: codexCwd() })
        : spawn(process.execPath, [codexEntry(), ...args], { env: { ...process.env, LBD_KEY: key }, windowsHide: true, cwd: codexCwd() });
      p.stdin.end(SYSTEM + ' The browser tools are the browser_* tools of the "lbd" MCP server.\n\n' + prompt);
      let log = ''; p.stdout.on('data', (c) => (log += c)); p.stderr.on('data', (c) => (log += c));
      const timer = setTimeout(() => p.kill(), 300000);
      p.on('close', (code) => { clearTimeout(timer); resolveP({ code, log }); });
    });
    const answer = existsSync(outFile) ? readFileSync(outFile, 'utf8') : '';
    if (opt('codex-log')) writeFileSync(opt('codex-log'), res.log);
    const mcpCalls = (res.log.match(/tool lbd\.|lbd\.browser_|mcp: lbd/g) || []).length;
    return { answer: answer || res.log.slice(-1500), turns: mcpCalls || toolCalls - before, cost: 0, tokens: 0, model: 'codex ' + (opt('codex-model') || 'default'), exit: res.code };
  },
};

// Codex goes through HTTP /mcp, so count tool calls at the relay too.
const origCall = relay.call.bind(relay);
let relayCalls = 0;
relay.call = (m, p, c) => { relayCalls++; return origCall(m, p, c); };

// --serve <file>: keep the environment up for an external agent (e.g. Grok Bot over HTTP RPC/MCP). Writes the port,
// a test key (temporary keystore, deleted with the temp dir) and fixture URLs to <file>; exits when <file> is deleted.
if (opt('serve')) {
  const f = opt('serve');
  writeFileSync(f, JSON.stringify({ port: relay.port, key, fixtures: fx.url, uploadFile, tasks: Object.fromEntries(Object.entries(TASKS).map(([k, t]) => [k, t.prompt(fx.url)])) }, null, 2));
  console.error(`serving on ${relay.port}; delete ${f} to stop`);
  while (existsSync(f)) await sleep(1000);
  const subs = fx.submissions; console.log(JSON.stringify({ submissions: subs }, null, 2));
  await browser.close(); await relay.stop(); await fx.close(); await fxb.close(); process.exit(0);
}

const results = [];
for (const model of MODELS) {
  for (const task of TASK_LIST) {
    await resetBrowser();
    const sub0 = fx.submissions.length;
    firstActionAt = 0;
    const t0 = performance.now();
    const calls0 = toolCalls, relay0 = relayCalls;
    let r, err = null;
    try { r = await runners[model](TASKS[task].prompt(fx.url)); } catch (e) { err = e.message; r = { answer: '' }; }
    const ms = performance.now() - t0;
    const pass = !err && TASKS[task].check(fx, r.answer || '') && (task !== 'form' || fx.submissions.length > sub0);
    const ttfaSeconds = firstActionAt ? +((firstActionAt - t0) / 1000).toFixed(2) : null;
    const row = { model, modelId: r.model, provider: r.provider || null, task, pass, seconds: +(ms / 1000).toFixed(1), ttfaSeconds, toolCalls: model === 'codex' ? relayCalls - relay0 : toolCalls - calls0, turns: r.turns, tokens: r.tokens, costUsd: r.cost ? +r.cost.toFixed(5) : 0, error: err, answer: (r.answer || '').slice(0, 300) };
    results.push(row);
    console.error(`${pass ? 'PASS' : 'FAIL'} ${model} ${task} ${row.seconds}s (ttfa=${ttfaSeconds ?? '-'}s) calls=${row.toolCalls}${row.provider ? ' via ' + row.provider : ''}${err ? ' ERR ' + err.slice(0, 200) : ''}${!pass && !err ? ' answer=' + JSON.stringify(row.answer.slice(0, 200)) : ''}`);
  }
}
const out = opt('out');
if (out) writeFileSync(out, JSON.stringify(results, null, 2));
console.log('| Model | Provider | Task | Pass | Seconds | TTFA s | Tool calls | Cost USD |');
console.log('|---|---|---|---|---|---|---|---|');
for (const r of results) console.log(`| ${r.modelId || r.model} | ${r.provider || '-'} | ${r.task} | ${r.pass ? 'PASS' : 'FAIL'} | ${r.seconds} | ${r.ttfaSeconds ?? '-'} | ${r.toolCalls} | ${r.costUsd || '-'} |`);
await browser.close();
await relay.stop();
await fx.close(); await fxb.close();
process.exit(0);
