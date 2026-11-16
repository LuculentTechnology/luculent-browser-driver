// OpenCode Browse (@opencode/browse) on the same fixture pages and method as bench/bench.mjs.
// Browse only drives a real Chromium through its extension, so this script launches Playwright's Chromium with the
// Browse extension (Chrome Web Store build) loaded, pairs it with a one-time code, then times the `browse mcp` stdio
// server with the same MCP client. Median of --iters runs after 1 warm-up. Writes bench/results-browse.json.
//
//   node bench/browse-bench.mjs --iters 7 --browse <path to @opencode/browse dist/cli.mjs> --ext <unpacked extension> --xdg <dir>
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import { chromium } from 'playwright';
import { startFixtures } from '../test/fixtures.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = (k) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : undefined; };
const ITERS = Number(opt('iters')) || 7;
const CLI = resolve(opt('browse'));
const EXT = resolve(opt('ext'));
const XDG = resolve(opt('xdg'));
// --defaults: Browse as installed (human-like input on, agent tabs in the background of your window). Otherwise its fastest
// settings: human-like input off and --window separate (agent tabs in their own window, so Chrome doesn't throttle them).
const DEFAULTS = argv.includes('--defaults');
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : NaN; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const env = { XDG_CONFIG_HOME: join(XDG, 'config'), XDG_DATA_HOME: join(XDG, 'data'), XDG_STATE_HOME: join(XDG, 'state'), XDG_CACHE_HOME: join(XDG, 'cache'), XDG_BIN_HOME: join(XDG, 'bin'), BROWSE_NO_UPDATE: '1', ...(DEFAULTS ? {} : { OPENCODE_BROWSER_HUMAN_INPUT: 'off' }) };

class McpClient {
  constructor(cmd, args, extra) {
    this.p = spawn(cmd, args, { env: { ...process.env, ...extra }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.seq = 0; this.pending = new Map(); this.buf = ''; this.err = '';
    this.p.stdout.setEncoding('utf8');
    this.p.stdout.on('data', (c) => { this.buf += c; let i; while ((i = this.buf.indexOf('\n')) >= 0) { const l = this.buf.slice(0, i); this.buf = this.buf.slice(i + 1); if (!l.trim()) continue; let m; try { m = JSON.parse(l); } catch (_) { continue; } const p = this.pending.get(m.id); if (p) { this.pending.delete(m.id); p({ m, bytes: l.length }); } } });
    this.p.stderr.on('data', (c) => { this.err += c; });
  }
  req(method, params) { const id = ++this.seq; return new Promise((r) => { this.pending.set(id, r); this.p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); }); }
  async init() { await this.req('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'lbd-bench', version: '1' } }); this.p.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n'); }
  async call(name, args) {
    const t = performance.now();
    const { m, bytes } = await this.req('tools/call', { name, arguments: args });
    const ms = performance.now() - t;
    if (m.error) throw new Error(`${name}: ${m.error.message}`);
    const text = (m.result.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
    if (m.result.isError) throw new Error(`${name}: ${text.slice(0, 500)}`);
    return { ms, bytes, text };
  }
  close() { try { this.p.kill(); } catch (_) {} }
}

const EXPECT_FORM = 'name=Ada Lovelace;email=ada@example.com;plan=pro;tos=on;notes=';
const FORM_ONE = (u) => `await page.goto(${JSON.stringify(u + '/form')});
await page.fill('#name', 'Ada Lovelace');
await page.fill('input[name=email]', 'ada@example.com');
await page.selectOption('#plan', 'pro');
await page.check('#tos');
await Promise.all([page.waitForNavigation(), page.click('text=Create account')]);
return await page.innerText('#summary');`;
const FORM_STEPS = (u) => [
  `await page.goto(${JSON.stringify(u + '/form')}); return await snapshot();`,
  `await page.fill('#name', 'Ada Lovelace');`,
  `await page.fill('input[name=email]', 'ada@example.com');`,
  `await page.selectOption('#plan', 'pro');`,
  `await page.check('#tos');`,
  `await Promise.all([page.waitForNavigation(), page.click('text=Create account')]);`,
  `return await page.innerText('#summary');`,
];
const SEARCH_ONE = (u) => `await page.goto(${JSON.stringify(u + '/search')});
await page.fill('#q', 'luculent'); await page.press('#q', 'Enter');
await page.locator('.result').first().waitFor();
return (await page.locator('.result a').allInnerTexts()).join('|');`;
const SEARCH_STEPS = (u) => [
  `await page.goto(${JSON.stringify(u + '/search')}); return await snapshot();`,
  `await page.fill('#q', 'luculent'); await page.press('#q', 'Enter');`,
  `await page.locator('.result').first().waitFor();`,
  `return (await page.locator('.result a').allInnerTexts()).join('|');`,
];

async function pairAndLaunch() {
  mkdirSync(XDG, { recursive: true });
  rmSync(join(XDG, 'chromium-profile'), { recursive: true, force: true }); // fresh profile: pair from scratch each run
  const pair = spawn(process.execPath, [CLI, 'pair', '--wait-seconds', '120'], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let out = ''; pair.stdout.on('data', (c) => { out += c; }); pair.stderr.on('data', (c) => { out += c; });
  const done = new Promise((r) => pair.on('exit', (code) => r(code)));
  let code; for (let i = 0; i < 100 && !code; i++) { await sleep(100); code = /Pairing code: (\S+)/.exec(out)?.[1]; }
  if (!code) throw new Error('no pairing code: ' + out);
  const ctx = await chromium.launchPersistentContext(join(XDG, 'chromium-profile'), { channel: 'chromium', headless: !argv.includes('--headed'), args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`] });
  let sw = ctx.serviceWorkers()[0]; if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 20000 });
  const extId = new URL(sw.url()).host;
  // Browse's own fastest setting: human-like input (curved mouse paths, paced typing) off. Its default is on.
  if (!DEFAULTS) await sw.evaluate(([w]) => chrome.storage.local.set({ humanInput: 'off', ...(w ? { agentTabsWindow: w } : {}) }), [opt('window')]);
  const p = await ctx.newPage();
  await p.goto(`chrome-extension://${extId}/settings.html`);
  await p.getByRole('button', { name: 'Pair with a code' }).click();
  await p.locator('input[placeholder="XXXX-XXXX"]').fill(code);
  await p.getByRole('button', { name: /^connect$/i }).click();
  const exit = await Promise.race([done, sleep(90000).then(() => 'timeout')]);
  if (exit !== 0) throw new Error(`pairing failed (${exit}): ${out}`);
  return { ctx, pairLog: out.trim() };
}

async function flows(mcp, u) {
  const out = {};
  for (const [flow, one, steps, check] of [['form', FORM_ONE, FORM_STEPS, (t) => t.includes(EXPECT_FORM)], ['search', SEARCH_ONE, SEARCH_STEPS, (t) => t.includes('luculent gamma')]]) {
    const batched = [], perAction = [], perActionCalls = [], bytesB = [], bytesP = [];
    for (let i = 0; i < ITERS + 1; i++) {
      const b = await mcp.call('execute', { code: one(u) });
      if (!check(b.text)) throw new Error(`browse ${flow} batched wrong result: ${b.text.slice(0, 400)}`);
      let tot = 0, bytes = 0, last = '';
      for (const s of steps(u)) { const r = await mcp.call('execute', { code: s }); tot += r.ms; bytes += r.bytes; perActionCalls.push(r.ms); last = r.text; if (process.env.BROWSE_DEBUG && i === 1) console.error(flow, Math.round(r.ms) + 'ms', r.bytes + 'B', JSON.stringify(s.slice(0, 50)), JSON.stringify(r.text.slice(0, 300))); }
      if (!check(last)) throw new Error(`browse ${flow} per-action wrong result: ${last.slice(0, 400)}`);
      if (i === 0) continue;
      batched.push(b.ms); bytesB.push(b.bytes); perAction.push(tot); bytesP.push(bytes);
    }
    out[flow] = { batchedMs: median(batched), perActionMs: median(perAction), msPerCall: median(perActionCalls), actions: steps(u).length, bytesBatched: median(bytesB), bytesPerAction: median(bytesP), batchedSamples: batched, perActionSamples: perAction };
  }
  return out;
}

async function coldStart() {
  const samples = [];
  for (let i = 0; i < ITERS + 1; i++) {
    const t = performance.now();
    const c = new McpClient(process.execPath, [CLI, 'mcp'], env);
    await c.init();
    await c.call('execute', { code: `await page.goto('about:blank'); return page.url();`, session: undefined });
    const ms = performance.now() - t;
    c.close(); await sleep(300);
    if (i > 0) samples.push(ms);
  }
  return median(samples);
}

const fx = await startFixtures();
const { ctx, pairLog } = await pairAndLaunch();
const version = await new Promise((r) => { const p = spawn(process.execPath, [CLI, '--version'], { env: { ...process.env, ...env } }); let o = ''; p.stdout.on('data', (c) => { o += c; }); p.on('exit', () => r(o.trim())); });
const results = { tool: 'OpenCode Browse (@opencode/browse)', version, settings: DEFAULTS ? 'defaults (human-like input on, agent tabs in the background of the window)' : 'human-like input off, agent tabs in their own window (' + (opt('window') || 'current') + ')', extension: 'Chrome Web Store build, loaded in Playwright Chromium (new headless)', iters: ITERS, machine: `${os.cpus()[0]?.model?.trim()}, ${Math.round(os.totalmem() / 2 ** 30)} GB, ${process.platform}`, date: new Date().toISOString(), pairLog };
const mcp = new McpClient(process.execPath, [CLI, 'mcp'], env);
try {
  await mcp.init();
  const tl = await mcp.req('tools/list', {});
  results.tools = (tl.m.result?.tools || []).map((t) => t.name);
  results.browse = await flows(mcp, fx.url);
} finally { mcp.close(); }
results.coldStartMs = await coldStart();
await ctx.close(); await fx.close?.();
writeFileSync(resolve(here, opt('out') || 'results-browse.json'), JSON.stringify(results, null, 2) + '\n');
console.log(JSON.stringify({ browse: results.browse, coldStartMs: results.coldStartMs, version }, null, 1));
process.exit(0);
