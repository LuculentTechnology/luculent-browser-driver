// Renders Web Store assets from a REAL click test: drives the fixture form through the extension in a separate
// Chromium profile, captures the page, the snapshot text, timings and the popup, then lays them out as
// 1280x800 screenshots and a 440x280 promo tile (PNG, 24-bit, no alpha). Run: node store/render-assets.mjs
import { mkdtempSync, cpSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { Relay, EXTENSION_ID } from '../src/relay.mjs';
import { KeyStore } from '../src/keys.mjs';
import { relayClient } from '../src/mcp-stdio.mjs';
import { HeadlessBrowser, findPlaywrightChromium } from '../src/headless.mjs';
import { startFixtures } from '../test/fixtures.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const outDir = join(here, 'assets');
mkdirSync(outDir, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const keys = new KeyStore(mkdtempSync(join(tmpdir(), 'lbd-assets-')));
const relay = await new Relay({ port: 0, keys, log: () => {} }).start();
const fx = await startFixtures();
const extDir = join(mkdtempSync(join(tmpdir(), 'lbd-aext-')), 'extension');
cpSync(join(root, 'extension'), extDir, { recursive: true });
writeFileSync(join(extDir, 'config.json'), JSON.stringify({ relayUrl: `ws://127.0.0.1:${relay.port}/ext`, settings: { grantMode: 'all' } }) /* capture profile: every tab granted */);
const browser = await HeadlessBrowser.launch({ chromePath: findPlaywrightChromium(), headless: true, extensionPath: extDir, args: ['--window-size=1280,800'] });
for (let i = 0; i < 300 && !relay.router.ext; i++) await sleep(50);
if (!relay.router.ext) throw new Error('extension did not connect');
const rpc = relayClient({ url: `ws://127.0.0.1:${relay.port}/v1/ws`, key: keys.mint({ name: 'assets', scopes: ['read', 'act', 'tabs'] }).token });
const tab = (await rpc('tabs.list', {})).tabs.find((t) => t.source === 'extension').tab;

// A styled demo sign-up page (same fields as the test fixture) so the screenshot reads well at store size.
const pages = new Map();
const srv = createServer((q, res) => {
  if (q.url.startsWith('/welcome')) { const u = new URL(q.url, 'http://x'); const v = (k) => esc(u.searchParams.get(k) || ''); res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end(DEMO_DONE(`name=${v('name')};email=${v('email')};plan=${v('plan')};tos=${v('tos')}`)); }
  const h = pages.get(q.url.slice(1)); res.writeHead(h ? 200 : 404, { 'content-type': 'text/html; charset=utf-8' }); res.end(h || '');
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${srv.address().port}`;
const DEMO_CSS = `body{margin:0;font-family:"Segoe UI",system-ui,sans-serif;background:#f4f4f8;color:#111827}header{background:#fff;border-bottom:1px solid #e5e7eb;padding:18px 48px;font-weight:700;font-size:20px;color:#4f46e5}main{max-width:520px;margin:48px auto;background:#fff;border-radius:16px;box-shadow:0 10px 30px rgba(0,0,0,.08);padding:36px 40px}h1{margin:0 0 6px;font-size:28px}p{color:#6b7280;margin:0 0 22px}label{display:block;font-weight:600;font-size:14px;margin:14px 0 6px}input[type=text],input[type=email],select{width:100%;box-sizing:border-box;padding:11px 12px;border:1px solid #d1d5db;border-radius:9px;font-size:15px}.cb{display:flex;gap:8px;align-items:center;font-weight:500;margin-top:18px}button{margin-top:22px;width:100%;padding:13px;border:0;border-radius:10px;background:#4f46e5;color:#fff;font-size:16px;font-weight:600}`;
pages.set('demo', `<!doctype html><html><head><meta charset="utf-8"><title>Acme — Sign up</title><style>${DEMO_CSS}</style></head><body><header>Acme Cloud</header><main><h1>Create your account</h1><p>Start your 14-day trial.</p><form action="/welcome" method="get"><label for="name">Full name</label><input type="text" id="name" name="name"><label for="email">Email</label><input type="email" id="email" name="email" placeholder="you@example.com"><label for="plan">Plan</label><select id="plan" name="plan"><option value="free">Free</option><option value="pro">Pro</option><option value="biz">Business</option></select><label class="cb"><input type="checkbox" id="tos" name="tos"> I agree to the terms</label><button type="submit">Create account</button></form></main></body></html>`);
const DEMO_DONE = (summary) => `<!doctype html><html><head><meta charset="utf-8"><title>Welcome</title><style>${DEMO_CSS}</style></head><body><header>Acme Cloud</header><main><h1>Welcome aboard</h1><p id="summary">${summary}</p></main></body></html>`;

// 1. Real batched flow through chrome.debugger on an existing tab.
await rpc('run', { tab, steps: [{ action: 'viewport', width: 1280, height: 800 }] });
const steps = [
  { action: 'navigate', url: base + '/demo' },
  { action: 'type', target: 'label=Full name', text: 'Ada Lovelace' },
  { action: 'type', target: 'label=Email', text: 'ada@example.com' },
  { action: 'select', target: '#plan', value: 'pro' },
  { action: 'check', target: '#tos' },
];
await rpc('run', { tab, steps, snapshot: 'none' }); // warm
let t0 = Date.now();
const flow = await rpc('run', { tab, steps, snapshot: 'full' });
await sleep(150); // let the caret blink settle before the capture
const flowMs = Date.now() - t0;
if (!flow.ok) throw new Error('flow failed ' + JSON.stringify(flow.results));
const pageShot = (await rpc('screenshot', { tab, format: 'png' })).data;
t0 = Date.now();
const submit = await rpc('run', { tab, snapshot: 'diff', steps: [{ action: 'click', target: 'role=button[name="Create account"]', waitNav: true }, { action: 'extract', target: '#summary' }] });
const submitMs = Date.now() - t0;
const doneShot = (await rpc('screenshot', { tab, format: 'png' })).data;
const snapText = (flow.snapshot?.lines || []).join('\n');
const diff = submit.snapshot || {};

// 2. The real popup.
const { targetId } = await browser.conn.send('Target.createTarget', { url: `chrome-extension://${EXTENSION_ID}/popup.html` });
const { sessionId } = await browser.conn.send('Target.attachToTarget', { targetId, flatten: true });
await browser.conn.send('Emulation.setDeviceMetricsOverride', { width: 340, height: 600, deviceScaleFactor: 2, mobile: false }, sessionId);
await sleep(900);
const popH = (await browser.conn.send('Runtime.evaluate', { expression: 'document.documentElement.scrollHeight', returnByValue: true }, sessionId)).result.value || 600;
await browser.conn.send('Emulation.setDeviceMetricsOverride', { width: 340, height: Math.min(640, popH), deviceScaleFactor: 2, mobile: false }, sessionId);
await sleep(300);
const popupShot = (await browser.conn.send('Page.captureScreenshot', { format: 'png' }, sessionId)).data;
// 2b. The security settings page.
const opt = await browser.conn.send('Target.createTarget', { url: `chrome-extension://${EXTENSION_ID}/options.html` });
const optS = (await browser.conn.send('Target.attachToTarget', { targetId: opt.targetId, flatten: true })).sessionId;
await browser.conn.send('Emulation.setDeviceMetricsOverride', { width: 760, height: 900, deviceScaleFactor: 1, mobile: false }, optS);
await sleep(900);
const optionsShot = (await browser.conn.send('Page.captureScreenshot', { format: 'png' }, optS)).data;

// 3. Benchmark numbers (real, from bench/results.json written by npm run bench).
const benchFile = join(root, 'bench', 'results.json');
const bench = existsSync(benchFile) ? JSON.parse(readFileSync(benchFile, 'utf8')) : null;
const icon = 'data:image/png;base64,' + readFileSync(join(root, 'extension', 'icons', 'icon-128.png')).toString('base64');

const css = `*{box-sizing:border-box}body{margin:0;width:1280px;height:800px;overflow:hidden;font-family:"Segoe UI",system-ui,sans-serif;background:radial-gradient(1200px 700px at 15% 0%,#1e1b4b 0%,#0b0b0f 60%);color:#e5e7eb}
.wrap{padding:56px 64px;height:100%;display:flex;flex-direction:column}.h{font-size:44px;font-weight:700;letter-spacing:-.5px;margin:0}.s{font-size:22px;color:#a5b4fc;margin:10px 0 28px}
.row{display:flex;gap:32px;flex:1;min-height:0}.card{background:#111118;border:1px solid #27272a;border-radius:16px;padding:18px;overflow:hidden}
pre{margin:0;font:15px/1.45 Consolas,"Cascadia Mono",monospace;color:#d4d4d8;white-space:pre-wrap}.k{color:#a5b4fc}.g{color:#4ade80}.r{color:#f87171}
img.shot{width:100%;border-radius:10px;display:block}.foot{display:flex;align-items:center;gap:12px;margin-top:22px;color:#9ca3af;font-size:17px}.foot img{width:28px;height:28px}
.bar{height:34px;border-radius:8px;display:flex;align-items:center;padding:0 12px;font-weight:600;font-size:17px;margin:8px 0 18px;white-space:nowrap}`;
const foot = `<div class="foot"><img src="${icon}">Luculent Browser Driver for AI Agents &middot; free &amp; open source &middot; Built by <b style="color:#e5e7eb">Luculent</b> &middot; luculent.dev/beta</div>`;
const page = (h, s, body) => `<!doctype html><html><head><meta charset="utf-8"><style>${css}</style></head><body><div class="wrap"><h1 class="h">${h}</h1><div class="s">${s}</div>${body}${foot}</div></body></html>`;

const req = JSON.stringify({ tool: 'browser_run', steps: steps.map((s) => { const { action, ...rest } = s; return { action, ...rest }; }) }, null, 1).replace(/\n\s*/g, ' ').replace(/\{ "action"/g, '\n  { "action"');
const slides = {
  '1-batched': page('Your agent fills the whole form in one call', `${steps.length} actions on a tab that was already open · ${flowMs} ms round trip, measured in this capture`,
    `<div class="row"><div class="card" style="flex:1.25"><img class="shot" src="data:image/png;base64,${pageShot}"></div><div class="card" style="flex:1"><pre><span class="k">agent →</span> ${esc(req)}\n\n<span class="g">← ok · ${flow.results.length} steps · ${flowMs} ms</span></pre></div></div>`),
  '2-snapshot': page('Reads the page as text, not pixels', `Compact snapshot: one line per element (${snapText.length} bytes). After a click, only the diff comes back.`,
    `<div class="row"><div class="card" style="flex:1"><pre><span class="k">browser_snapshot</span>\n${esc(snapText.slice(0, 1400))}</pre></div><div class="card" style="flex:1"><pre><span class="k">click "Create account" → diff (${submitMs} ms)</span>\n${esc(`page → ${diff.title || ''}\n`)}${(diff.added || diff.lines || []).slice(0, 14).map((l) => `<span class="g">+ ${esc(l)}</span>`).join('\n')}\n${(diff.removed || snapText.split('\n')).slice(0, 10).map((l) => `<span class="r">- ${esc(l)}</span>`).join('\n')}\n\n<span class="k">extract #summary</span>\n${esc(submit.results.at(-1).value || '')}</pre></div></div>`),
  '3-control': page('You stay in control', 'Killswitch, per-tab access, approvals and an activity log in the toolbar. Per-agent API keys you can scope and revoke.',
    `<div class="row"><div class="card" style="flex:0 0 330px;display:flex;align-items:center;justify-content:center"><img src="data:image/png;base64,${popupShot}" style="width:290px;max-height:600px;object-fit:contain;border-radius:12px"></div><div class="card" style="flex:1"><pre><span class="k">$ lbd keys mint --name grok --scopes read,act --origins *.example.com --days 30</span>\nMinted key "grok"  scopes=read,act  origins=*.example.com\n  lbd_••••••••_••••••••••••••••  (shown once)\n\n<span class="k">$ lbd keys revoke grok</span>\nrevoked 1 key(s)\n\n<span class="k">$ lbd kill</span>\n<span class="r">killswitch ON · agents disconnected · tabs detached</span>\n\nRuns on your computer. The extension only talks to 127.0.0.1.\nNo account, no analytics, nothing sent to Luculent.</pre></div></div>`),
  '5-security': page('Decide what AI agents may do', 'Safe by default: passwords, scripts, cookies and banking sites are off; uploads and logins ask you first.',
    `<div class="row"><div class="card" style="flex:1.1;padding:0"><img class="shot" src="data:image/png;base64,${optionsShot}" style="object-fit:cover;object-position:top;height:100%"></div><div class="card" style="flex:1"><pre><span class="k">Default security settings</span>
<span class="g">on </span> Only tabs you allow (agent-opened tabs too)
<span class="r">off</span> Read or type passwords
<span class="r">off</span> Run custom JavaScript
<span class="r">off</span> Read cookies / site storage
<span class="r">off</span> Banking &amp; payment sites (50+)
<span class="r">off</span> chrome:// and extension pages, file://
<span class="k">ask</span> File uploads
<span class="k">ask</span> Submitting login / payment forms
<span class="r">off</span> Incognito windows
<span class="g">on </span> Activity log, rate limit, AI badge

Read-only mode, site allow/block lists and
an approval prompt for every action.
Alt+Shift+K stops every agent instantly.</pre></div></div>`),
};
if (bench && bench.playwrightMcp && !bench.playwrightMcp.error) {
  const L = bench.lbdExtension && !bench.lbdExtension.error ? bench.lbdExtension : bench.lbdHeadless; const P = bench.playwrightMcp;
  const max = Math.max(P.form.perActionMs, L.form.batchedMs, L.form.perActionMs);
  const bar = (label, v, color) => `<div style="font-size:18px">${label}</div><div class="bar" style="width:${Math.max(18, (v / max) * 100)}%;background:${color}">${v.toFixed(0)} ms</div>`;
  slides['4-speed'] = page(`${(P.form.perActionMs / L.form.batchedMs).toFixed(1)}× faster than Playwright MCP on the same form`, `7-action sign-up form, median of ${bench.iters} runs on one PC (${bench.date.slice(0, 10)}). Method in BENCHMARK.md.`,
    `<div class="card" style="flex:1;padding:34px 40px">${bar('Luculent Browser Driver — batched (1 call)', L.form.batchedMs, '#6366f1')}${bar(`Luculent Browser Driver — one call per action (${L.form.actions} calls)`, L.form.perActionMs, '#818cf8')}${bar(`Playwright MCP — one call per action (${P.form.actions} calls)`, P.form.perActionMs, '#52525b')}<div style="font-size:18px;color:#9ca3af;margin-top:8px">Data the agent has to read: ${(L.form.bytesBatched / 1024).toFixed(1)} KB batched vs ${(P.form.bytesPerAction / 1024).toFixed(1)} KB with Playwright MCP.</div></div>`);
}
const tile = `<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0;width:440px;height:280px;overflow:hidden;font-family:"Segoe UI",system-ui,sans-serif;background:radial-gradient(500px 300px at 0% 0%,#312e81,#0b0b0f 70%);color:#fff;display:flex;flex-direction:column;justify-content:center;padding:0 34px;box-sizing:border-box}
img{width:64px;height:64px}h1{font-size:30px;margin:14px 0 6px;letter-spacing:-.3px}p{margin:0;font-size:17px;color:#c7d2fe}small{margin-top:16px;font-size:13px;color:#9ca3af}</style></head><body><img src="${icon}"><h1>Luculent Browser Driver</h1><p style="font-size:20px;color:#fff;margin:-2px 0 8px">for AI Agents</p><p>Let any AI agent drive Chrome. Fast, secure, no reconnects.</p><small>Free &amp; open source &middot; Built by Luculent</small></body></html>`;

// Render each layout in a plain tab of the same browser.
// (served over local HTTP: chrome.debugger cannot attach to file:// pages without extra user permission)
async function render(name, html, width, height) {
  pages.set(name, html);
  const r = await rpc('run', { tab, snapshot: 'none', steps: [{ action: 'viewport', width, height }, { action: 'navigate', url: `${base}/${name}` }, { action: 'wait', ms: 300 }] });
  if (!r.ok) throw new Error('render failed ' + JSON.stringify(r.results));
  const shot = await rpc('screenshot', { tab, format: 'png' });
  writeFileSync(join(outDir, name + '.png'), Buffer.from(shot.data, 'base64'));
  console.log('wrote', name + '.png');
}
for (const [n, h] of Object.entries(slides)) await render(`screenshot-${n}`, h, 1280, 800);
await render('promo-tile-440x280', tile, 440, 280);
writeFileSync(join(outDir, 'popup.png'), Buffer.from(popupShot, 'base64')); // raw popup, used by the README and luculent.dev/beta
writeFileSync(join(outDir, 'capture.json'), JSON.stringify({ date: new Date().toISOString(), flowMs, submitMs, snapshotBytes: snapText.length, summary: submit.results.at(-1).value }, null, 2));
srv.close(); rpc.close(); await browser.close(); await relay.stop(); await fx.close();
process.exit(0);
