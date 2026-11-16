// Benchmark: Luculent Browser Driver (batched + per-action MCP) vs Playwright MCP on identical local flows.
// Usage: node bench/bench.mjs [--iters 5] [--no-playwright] [--no-extension]
import { spawn } from 'node:child_process';
import { mkdtempSync, cpSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Relay } from '../src/relay.mjs';
import { KeyStore } from '../src/keys.mjs';
import { HeadlessBrowser, findPlaywrightChromium } from '../src/headless.mjs';
import { startFixtures } from '../test/fixtures.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const ITERS = Number(argv[argv.indexOf('--iters') + 1]) || 5;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : NaN; };

class McpClient {
  constructor(cmd, args, env) {
    this.p = spawn(cmd, args, { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
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
    if (m.result.isError) throw new Error(`${name}: ${text.slice(0, 300)}`);
    return { ms, bytes, text };
  }
  close() { try { this.p.kill(); } catch (_) {} }
}

const FORM_STEPS = (u) => [
  { action: 'navigate', url: u + '/form' },
  { action: 'type', target: '#name', text: 'Ada Lovelace' },
  { action: 'type', target: 'input[name=email]', text: 'ada@example.com' },
  { action: 'select', target: '#plan', value: 'pro' },
  { action: 'check', target: '#tos' },
  { action: 'click', target: 'text=Create account', waitNav: true },
  { action: 'extract', target: '#summary' },
];
const SEARCH_STEPS = (u) => [
  { action: 'navigate', url: u + '/search' },
  { action: 'type', target: '#q', text: 'luculent', submit: true },
  { action: 'wait', target: '.result' },
  { action: 'extract', target: '.result a', all: true },
];
const EXPECT_FORM = 'name=Ada Lovelace;email=ada@example.com;plan=pro;tos=on;notes=';

async function lbdFlows(mcp, u, tab, label) {
  const out = {};
  for (const [flow, mk] of [['form', FORM_STEPS], ['search', SEARCH_STEPS]]) {
    const batched = [], perAction = [], perActionCalls = [], bytesB = [], bytesP = [];
    for (let i = 0; i < ITERS + 1; i++) {
      const b = await mcp.call('browser_run', { tab, steps: mk(u), snapshot: 'none' });
      if (!b.text.startsWith('ok')) throw new Error(`${label} ${flow} batched failed: ${b.text}`);
      if (flow === 'form' && !b.text.includes(EXPECT_FORM)) throw new Error(`${label} wrong result ${b.text}`);
      let tot = 0, bytes = 0;
      for (const s of mk(u)) { const r = await mcp.call('browser_run', { tab, steps: [s], snapshot: 'diff' }); if (!r.text.startsWith('ok')) throw new Error(`${label} ${flow} step failed: ${r.text}`); tot += r.ms; bytes += r.bytes; perActionCalls.push(r.ms); }
      if (i === 0) continue; // warm-up
      batched.push(b.ms); bytesB.push(b.bytes); perAction.push(tot); bytesP.push(bytes);
    }
    out[flow] = { batchedMs: median(batched), perActionMs: median(perAction), msPerCall: median(perActionCalls), actions: mk(u).length, bytesBatched: median(bytesB), bytesPerAction: median(bytesP) };
  }
  return out;
}

function findRef(snap, role, name) {
  const re = new RegExp(`- ${role}(?: "([^"]*)")?[^\\n]*\\[ref=((?:f\\d+)?e\\d+)\\]`, 'g');
  let m; while ((m = re.exec(snap))) if (!name || (m[1] || '').toLowerCase().includes(name.toLowerCase())) return m[2];
  throw new Error(`ref not found for ${role} "${name}" in snapshot:\n${snap.slice(0, 1500)}`);
}

async function playwrightFlows(u) {
  const cli = resolve(here, '..', 'node_modules', '@playwright', 'mcp', 'cli.js');
  if (!existsSync(cli)) return { error: 'npm i -D @playwright/mcp to include Playwright MCP' };
  const mcp = new McpClient(process.execPath, [cli, '--headless', '--isolated', '--browser', 'chrome'], {});
  await mcp.init();
  const out = {};
  try {
    for (const flow of ['form', 'search']) {
      const totals = [], calls = [], bytesAll = [];
      for (let i = 0; i < ITERS + 1; i++) {
        let tot = 0, bytes = 0, n = 0;
        // Playwright MCP 0.0.8x returns a snapshot only after some calls (e.g. not after browser_type); refs from the
        // last snapshot stay valid, so an agent keeps using them. We do the same.
        let last = '';
        const c = async (name, args) => { const r = await mcp.call(name, args); tot += r.ms; bytes += r.bytes; n++; calls.push(r.ms); const t = await refs(r.text); if (/\[ref=(?:f\d+)?e\d+\]/.test(t)) last = t; return name === 'browser_evaluate' || name === 'browser_wait_for' ? t : (last || t); };
        // Newer Playwright MCP may link the snapshot as a .yml file instead of inlining it; an agent then has to read it.
        const refs = async (t) => {
          if (/\[ref=(?:f\d+)?e\d+\]/.test(t)) return t;
          const m = /\(([^)]+\.yml)\)/.exec(t);
          if (m) { const f = resolve(process.cwd(), m[1].replace(/\\/g, '/')); if (existsSync(f)) { const y = readFileSync(f, 'utf8'); bytes += y.length; return t + '\n' + y; } }
          return t;
        };
        if (flow === 'form') {
          let s = await c('browser_navigate', { url: u + '/form' });
          s = await c('browser_type', { element: 'Full name', target: findRef(s, 'textbox', 'Full name'), text: 'Ada Lovelace' });
          s = await c('browser_type', { element: 'Email', target: findRef(s, 'textbox', 'Email'), text: 'ada@example.com' });
          s = await c('browser_select_option', { element: 'Plan', target: findRef(s, 'combobox', 'Plan'), values: ['pro'] });
          s = await c('browser_click', { element: 'terms checkbox', target: findRef(s, 'checkbox', 'agree') });
          s = await c('browser_click', { element: 'Create account', target: findRef(s, 'button', 'Create account') });
          s = await c('browser_evaluate', { function: "() => document.querySelector('#summary').innerText" });
          if (!s.includes(EXPECT_FORM)) throw new Error('playwright form wrong result: ' + s.slice(0, 400));
        } else {
          let s = await c('browser_navigate', { url: u + '/search' });
          s = await c('browser_type', { element: 'Search query', target: findRef(s, 'searchbox', 'Search query'), text: 'luculent', submit: true });
          s = await c('browser_wait_for', { text: 'luculent gamma' });
          s = await c('browser_evaluate', { function: "() => [...document.querySelectorAll('.result a')].map(a => a.innerText)" });
          if (!s.includes('luculent gamma')) throw new Error('playwright search wrong result');
        }
        if (i === 0) continue;
        totals.push(tot); bytesAll.push(bytes); out[flow + 'Actions'] = n;
      }
      out[flow] = { perActionMs: median(totals), msPerCall: median(calls), actions: out[flow + 'Actions'], bytesPerAction: median(bytesAll) };
    }
  } finally { mcp.close(); }
  return out;
}

// Cold start: spawn the MCP server, initialize, launch a fresh headless browser and load about:blank, until the first
// navigation returns. Each sample is a brand-new MCP process and browser; median of ITERS samples after 1 warm-up.
async function coldStartLbd(port, token) {
  const samples = [];
  for (let i = 0; i < ITERS + 1; i++) {
    const t = performance.now();
    const c = new McpClient(process.execPath, [resolve(here, '..', 'src', 'cli.mjs'), 'mcp', '--port', String(port)], { LBD_KEY: token });
    await c.init();
    const l = await c.call('browser_headless', { action: 'launch' });
    const tab = /tab (\S+)/.exec(l.text)[1];
    const browser = /launched (\S+?),? /.exec(l.text)?.[1];
    await c.call('browser_run', { tab, steps: [{ action: 'navigate', url: 'about:blank' }], snapshot: 'none' });
    const ms = performance.now() - t;
    try { await c.call('browser_headless', { action: 'close', browser }); } catch (_) {}
    c.close();
    await sleep(300);
    if (i > 0) samples.push(ms);
  }
  return median(samples);
}
async function coldStartPlaywright() {
  const cli = resolve(here, '..', 'node_modules', '@playwright', 'mcp', 'cli.js');
  if (!existsSync(cli)) return NaN;
  const samples = [];
  for (let i = 0; i < ITERS + 1; i++) {
    const t = performance.now();
    const c = new McpClient(process.execPath, [cli, '--headless', '--isolated', '--browser', 'chrome'], {});
    await c.init();
    await c.call('browser_navigate', { url: 'about:blank' });
    const ms = performance.now() - t;
    try { await c.call('browser_close', {}); } catch (_) {}
    c.close();
    await sleep(300);
    if (i > 0) samples.push(ms);
  }
  return median(samples);
}
const fx = await startFixtures();
const keys = new KeyStore(mkdtempSync(join(tmpdir(), 'lbd-bench-')));
// Default security settings, except the rate limit: the per-action flow fires ~7 calls in 40 ms, which no model-driven
// agent does but which trips the default 20 calls/s. Everything else (password guard, eval/cookies off, banking preset) stays on.
const BENCH_RATE = { rateLimit: { perSecond: 1000, perMinute: 60000 } };
const relay = await new Relay({ port: 0, keys, log: () => {}, policy: BENCH_RATE }).start();
const key = keys.mint({ name: 'bench', scopes: ['read', 'act', 'tabs', 'headless'] }).token;
const lbd = new McpClient(process.execPath, [resolve(here, '..', 'src', 'cli.mjs'), 'mcp', '--port', String(relay.port)], { LBD_KEY: key });
await lbd.init();
const results = { iters: ITERS, machine: `${(await import('node:os')).cpus()[0]?.model?.trim() || ''}, ${Math.round((await import('node:os')).totalmem() / 2 ** 30)} GB, ${process.platform}`, date: new Date().toISOString() };

const launched = await lbd.call('browser_headless', { action: 'launch' });
const htab = /tab (\S+)/.exec(launched.text)[1];
results.lbdHeadless = await lbdFlows(lbd, fx.url, htab, 'headless');

let extBrowser = null;
if (!argv.includes('--no-extension') && findPlaywrightChromium()) {
  const extDir = join(mkdtempSync(join(tmpdir(), 'lbd-bext-')), 'extension');
  cpSync(resolve(here, '..', 'extension'), extDir, { recursive: true });
  writeFileSync(join(extDir, 'config.json'), JSON.stringify({ relayUrl: `ws://127.0.0.1:${relay.port}/ext`, settings: { ...BENCH_RATE, grantMode: 'all' } }));
  extBrowser = await HeadlessBrowser.launch({ chromePath: findPlaywrightChromium(), headless: true, extensionPath: extDir });
  for (let i = 0; i < 200 && !relay.router.ext; i++) await sleep(50);
  if (relay.router.ext) {
    const tabs = (await relay.router.tabs()).tabs.filter((t) => t.source === 'extension');
    results.lbdExtension = await lbdFlows(lbd, fx.url, tabs[0].tab, 'extension');
  } else results.lbdExtension = { error: 'extension did not connect' };
}

if (!argv.includes('--no-cold')) {
  results.coldStart = { lbdHeadlessMs: await coldStartLbd(relay.port, key) };
  if (!argv.includes('--no-playwright')) results.coldStart.playwrightMcpMs = await coldStartPlaywright();
}
if (!argv.includes('--no-playwright')) {
  try { results.playwrightMcp = await playwrightFlows(fx.url); } catch (e) { results.playwrightMcp = { error: e.message }; }
}

lbd.close();
if (extBrowser) await extBrowser.close();
await relay.stop();
await fx.close();

const row = (name, r) => r && !r.error ? `| ${name} | ${r.form.actions} | ${r.form.batchedMs?.toFixed(0) ?? '—'} | ${r.form.perActionMs.toFixed(0)} | ${r.form.msPerCall.toFixed(1)} | ${(r.form.bytesPerAction / 1024).toFixed(1)} KB | ${r.search.batchedMs?.toFixed(0) ?? '—'} | ${r.search.perActionMs.toFixed(0)} |` : `| ${name} | ${r ? r.error : 'skipped'} |`;
console.log(JSON.stringify(results, null, 2));
if (!argv.includes('--no-save')) writeFileSync(resolve(here, 'results.json'), JSON.stringify(results, null, 2) + '\n');
console.log('\n| Driver | Form actions | Form batched ms | Form per-action ms | ms/call | Response bytes (form, per-action) | Search batched ms | Search per-action ms |');
console.log('|---|---|---|---|---|---|---|---|');
console.log(row('LBD headless (MCP stdio)', results.lbdHeadless));
console.log(row('LBD extension, real tab (MCP stdio)', results.lbdExtension));
console.log(row('Playwright MCP headless', results.playwrightMcp));
process.exit(0);
