// Matched transport-isolation (MCP stdio, MCP HTTP, Direct HTTP, WebSocket) & Playwright MCP replay benchmark.
import { spawn } from 'node:child_process';
import { mkdtempSync, cpSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir, cpus, totalmem } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { Relay } from '../src/relay.mjs';
import { KeyStore } from '../src/keys.mjs';
import { HeadlessBrowser, findPlaywrightChromium } from '../src/headless.mjs';
import { startFixtures } from '../test/fixtures.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : d; };
const ITERS = Number(opt('iters', 7));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pct = (a, p) => {
  const s = [...a].sort((x, y) => x - y);
  return s.length ? +s[Math.min(s.length - 1, Math.floor((s.length - 1) * p))].toFixed(1) : null;
};

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
        if (p) { this.pending.delete(m.id); p({ m, bytes: Buffer.byteLength(l) }); }
      }
    });
    this.p.stderr.on('data', (c) => { this.err += c; });
  }
  req(method, params) {
    const id = ++this.seq;
    const reqStr = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
    const outBytes = Buffer.byteLength(reqStr);
    return new Promise((r, j) => {
      const t = setTimeout(() => { this.pending.delete(id); j(new Error('timeout ' + method)); }, 30000);
      this.pending.set(id, (v) => { clearTimeout(t); r({ m: v.m, bytes: outBytes + v.bytes }); });
      this.p.stdin.write(reqStr);
    });
  }
  async init() {
    await this.req('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'lbd-compare', version: '1' } });
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

async function runTransport(label, coldMs, runBatchFn, runStepFn, u) {
  const out = { transport: label, coldStartupMs: +coldMs.toFixed(1) };
  for (const [flow, mk] of [['form', FORM_STEPS], ['search', SEARCH_STEPS]]) {
    const batched = [], perAction = [], bytesB = [], bytesP = [];
    for (let i = 0; i < ITERS + 1; i++) {
      const b = await runBatchFn(mk(u));
      if (flow === 'form' && !b.text.includes(EXPECT_FORM)) throw new Error(`${label} ${flow} wrong result: ${b.text}`);
      let tot = 0, bytes = 0;
      for (const s of mk(u)) {
        const r = await runStepFn(s);
        tot += r.ms;
        bytes += r.bytes;
      }
      if (i === 0) continue;
      batched.push(b.ms); bytesB.push(b.bytes);
      perAction.push(tot); bytesP.push(bytes);
    }
    out[flow] = {
      batchedP50Ms: pct(batched, 0.5),
      batchedP95Ms: pct(batched, 0.95),
      batchedReqs: 1,
      batchedBytes: Math.round(pct(bytesB, 0.5)),
      perActionP50Ms: pct(perAction, 0.5),
      perActionP95Ms: pct(perAction, 0.95),
      perActionReqs: mk(u).length,
      perActionBytes: Math.round(pct(bytesP, 0.5)),
    };
  }
  return out;
}

function findRef(snap, role, name) {
  const re = new RegExp(`- ${role}(?: "([^"]*)")?[^\\n]*\\[ref=((?:f\\d+)?e\\d+)\\]`, 'g');
  let m; while ((m = re.exec(snap))) if (!name || (m[1] || '').toLowerCase().includes(name.toLowerCase())) return m[2];
  throw new Error(`ref not found for ${role} "${name}"`);
}

async function runPlaywrightMcp(u) {
  const cli = resolve(here, '..', 'node_modules', '@playwright', 'mcp', 'cli.js');
  if (!existsSync(cli)) return { status: 'not_installed' };
  const tCold0 = performance.now();
  const mcp = new McpClient(process.execPath, [cli, '--headless', '--isolated', '--browser', 'chrome'], {});
  await mcp.init();
  await mcp.call('browser_navigate', { url: 'about:blank' });
  const coldStartupMs = +(performance.now() - tCold0).toFixed(1);
  const out = { transport: 'Playwright MCP 0.0.85 (stdio, headless)', coldStartupMs };
  try {
    for (const flow of ['form', 'search']) {
      const totals = [], bytesAll = [];
      let reqCount = 0;
      for (let i = 0; i < ITERS + 1; i++) {
        let tot = 0, bytes = 0, n = 0, last = '';
        const refs = async (t) => {
          if (/\[ref=(?:f\d+)?e\d+\]/.test(t)) return t;
          const m = /\(([^)]+\.yml)\)/.exec(t);
          if (m) { const f = resolve(process.cwd(), m[1].replace(/\\/g, '/')); if (existsSync(f)) { const y = readFileSync(f, 'utf8'); bytes += Buffer.byteLength(y); return t + '\n' + y; } }
          return t;
        };
        const c = async (name, args) => {
          const r = await mcp.call(name, args);
          tot += r.ms; bytes += r.bytes; n++;
          const t = await refs(r.text);
          if (/\[ref=(?:f\d+)?e\d+\]/.test(t)) last = t;
          return name === 'browser_evaluate' || name === 'browser_wait_for' ? t : (last || t);
        };
        if (flow === 'form') {
          let s = await c('browser_navigate', { url: u + '/form' });
          s = await c('browser_type', { element: 'Full name', target: findRef(s, 'textbox', 'Full name'), text: 'Ada Lovelace' });
          s = await c('browser_type', { element: 'Email', target: findRef(s, 'textbox', 'Email'), text: 'ada@example.com' });
          s = await c('browser_select_option', { element: 'Plan', target: findRef(s, 'combobox', 'Plan'), values: ['pro'] });
          s = await c('browser_click', { element: 'terms checkbox', target: findRef(s, 'checkbox', 'agree') });
          s = await c('browser_click', { element: 'Create account', target: findRef(s, 'button', 'Create account') });
          s = await c('browser_evaluate', { function: "() => document.querySelector('#summary').innerText" });
          if (!s.includes(EXPECT_FORM)) throw new Error('playwright form wrong result');
        } else {
          let s = await c('browser_navigate', { url: u + '/search' });
          s = await c('browser_type', { element: 'Search query', target: findRef(s, 'searchbox', 'Search query'), text: 'luculent', submit: true });
          await c('browser_wait_for', { text: 'luculent gamma' });
          s = await c('browser_evaluate', { function: "() => [...document.querySelectorAll('.result a')].map(a => a.innerText)" });
          if (!s.includes('luculent gamma')) throw new Error('playwright search wrong result');
        }
        reqCount = n;
        if (i === 0) continue;
        totals.push(tot); bytesAll.push(bytes);
      }
      out[flow] = {
        perActionP50Ms: pct(totals, 0.5),
        perActionP95Ms: pct(totals, 0.95),
        reqs: reqCount,
        bytes: Math.round(pct(bytesAll, 0.5)),
      };
    }
  } finally { mcp.close(); }
  return out;
}

const fx = await startFixtures();
const home = mkdtempSync(join(tmpdir(), 'lbd-compare-'));
const keys = new KeyStore(home);
const BENCH_RATE = { rateLimit: { perSecond: 1000, perMinute: 60000 } };
const relay = await new Relay({ port: 0, keys, log: () => {}, policy: BENCH_RATE }).start();
const key = keys.mint({ name: 'compare', scopes: ['read', 'act', 'tabs', 'headless'] }).token;

// Extension browser
const extCold0 = performance.now();
const extDir = join(mkdtempSync(join(tmpdir(), 'lbd-cext-')), 'extension');
cpSync(resolve(here, '..', 'extension'), extDir, { recursive: true });
writeFileSync(join(extDir, 'config.json'), JSON.stringify({ relayUrl: `ws://127.0.0.1:${relay.port}/ext`, settings: { ...BENCH_RATE, grantMode: 'all' } }));
const extBrowser = await HeadlessBrowser.launch({ chromePath: findPlaywrightChromium(), headless: true, extensionPath: extDir });
for (let i = 0; i < 200 && !relay.router.ext; i++) await sleep(50);
const extConnectMs = +(performance.now() - extCold0).toFixed(1);
const extTab = (await relay.router.tabs()).tabs.find((t) => t.source === 'extension').tab;

// 1. MCP stdio (extension tab)
const stdio0 = performance.now();
const lbdStdio = new McpClient(process.execPath, [resolve(here, '..', 'src', 'cli.mjs'), 'mcp', '--port', String(relay.port)], { LBD_KEY: key });
await lbdStdio.init();
const stdioColdMs = performance.now() - stdio0;
const resStdioExt = await runTransport(
  'Luculent MCP stdio (extension existing-tab)',
  stdioColdMs,
  (steps) => lbdStdio.call('browser_run', { tab: extTab, steps, snapshot: 'none' }),
  (s) => lbdStdio.call('browser_run', { tab: extTab, steps: [s], snapshot: 'diff' }),
  fx.url
);

// Also headless tab via MCP stdio
const headCold0 = performance.now();
const launched = await lbdStdio.call('browser_headless', { action: 'launch' });
const headColdMs = performance.now() - headCold0;
const htab = /tab (\S+)/.exec(launched.text)[1];
const resStdioHeadless = await runTransport(
  'Luculent MCP stdio (headless)',
  stdioColdMs + headColdMs,
  (steps) => lbdStdio.call('browser_run', { tab: htab, steps, snapshot: 'none' }),
  (s) => lbdStdio.call('browser_run', { tab: htab, steps: [s], snapshot: 'diff' }),
  fx.url
);
lbdStdio.close();

// 2. MCP HTTP (extension tab)
const http0 = performance.now();
await fetch(`http://127.0.0.1:${relay.port}/mcp`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'http', version: '1' } } }),
});
const httpColdMs = performance.now() - http0;
const mcpHttpCall = async (args) => {
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'browser_run', arguments: args } });
  const t = performance.now();
  const r = await fetch(`http://127.0.0.1:${relay.port}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body,
  });
  const txt = await r.text();
  return { ms: performance.now() - t, bytes: Buffer.byteLength(body) + Buffer.byteLength(txt), text: txt };
};
const resMcpHttp = await runTransport(
  'Luculent MCP HTTP (extension existing-tab)',
  httpColdMs,
  (steps) => mcpHttpCall({ tab: extTab, steps, snapshot: 'none' }),
  (s) => mcpHttpCall({ tab: extTab, steps: [s], snapshot: 'diff' }),
  fx.url
);

// 3. Direct HTTP (/v1/rpc)
const rpc0 = performance.now();
await fetch(`http://127.0.0.1:${relay.port}/v1/health`);
const rpcColdMs = performance.now() - rpc0;
const directRpcCall = async (args) => {
  const body = JSON.stringify({ method: 'run', params: args });
  const t = performance.now();
  const r = await fetch(`http://127.0.0.1:${relay.port}/v1/rpc`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body,
  });
  const txt = await r.text();
  return { ms: performance.now() - t, bytes: Buffer.byteLength(body) + Buffer.byteLength(txt), text: txt };
};
const resDirectHttp = await runTransport(
  'Luculent Direct HTTP /v1/rpc (extension existing-tab)',
  rpcColdMs,
  (steps) => directRpcCall({ tab: extTab, steps, snapshot: 'none' }),
  (s) => directRpcCall({ tab: extTab, steps: [s], snapshot: 'diff' }),
  fx.url
);

// 4. WebSocket (/v1/ws)
const ws0 = performance.now();
const ws = new WebSocket(`ws://127.0.0.1:${relay.port}/v1/ws`, { headers: { authorization: `Bearer ${key}` } });
await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
const wsColdMs = performance.now() - ws0;
let wsSeq = 1;
const wsRpcCall = async (args) => {
  const id = wsSeq++;
  const raw = JSON.stringify({ id, method: 'run', params: args });
  const t = performance.now();
  const resp = await new Promise((res) => {
    const onMsg = (buf) => {
      const txt = buf.toString('utf8');
      const m = JSON.parse(txt);
      if (m.id === id) { ws.off('message', onMsg); res(txt); }
    };
    ws.on('message', onMsg);
    ws.send(raw);
  });
  return { ms: performance.now() - t, bytes: Buffer.byteLength(raw) + Buffer.byteLength(resp), text: resp };
};
const resWs = await runTransport(
  'Luculent WebSocket /v1/ws (extension existing-tab)',
  wsColdMs,
  (steps) => wsRpcCall({ tab: extTab, steps, snapshot: 'none' }),
  (s) => wsRpcCall({ tab: extTab, steps: [s], snapshot: 'diff' }),
  fx.url
);
ws.close();

// 5. Playwright MCP
const resPw = await runPlaywrightMcp(fx.url);

const out = {
  measuredAt: new Date().toISOString(),
  machine: `${cpus()[0]?.model?.trim() || ''}, ${Math.round(totalmem() / 2 ** 30)} GB, ${process.platform}`,
  iters: ITERS,
  extensionColdConnectMs: extConnectMs,
  transports: [resStdioExt, resStdioHeadless, resMcpHttp, resDirectHttp, resWs],
  playwrightMcp: resPw,
  opencodeBrowse: { status: 'Not installed / unsupported on Windows benchmark host; ratio left blank until matched' },
  kimiBrowserExtension: { status: 'Not installed / incompatible (no MCP/CLI programmable driver interface); ratio left blank' },
};

const outFile = opt('out');
if (outFile) writeFileSync(outFile, JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));

await extBrowser.close();
await relay.stop();
await fx.close();
rmSync(home, { recursive: true, force: true });
process.exit(0);
