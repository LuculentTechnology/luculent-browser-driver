// Real-browser e2e for "When you click in the AI's tab" (T1288): Cowork, Pause and Disable window on real sites.
// The extension runs in a separate Chromium test profile (never your own Chrome). "You" are simulated by a second
// DevTools session dispatching input, which the page sees as trusted, exactly like a real click or scroll.
// Usage: node test/cowork-suite/cowork-e2e.mjs [--shots dir] [--out file.json]
import { mkdtempSync, writeFileSync, cpSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Relay } from '../../src/relay.mjs';
import { KeyStore } from '../../src/keys.mjs';
import { HeadlessBrowser, findPlaywrightChromium } from '../../src/headless.mjs';
import { DEFAULT_POLICY } from '../../src/policy.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : d; };
const SHOTS = resolve(opt('shots', join(here, 'out', 'shots')));
const OUT = resolve(opt('out', join(here, 'out', 'cowork-e2e.json')));
const ONLY = opt('only') ? opt('only').split(',') : null;
mkdirSync(SHOTS, { recursive: true });
mkdirSync(dirname(OUT), { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.error(...a);

const policy = { ...DEFAULT_POLICY, grantMode: 'all' };
const keys = new KeyStore(mkdtempSync(join(tmpdir(), 'lbd-cw-k-')));
const relay = await new Relay({ port: 0, keys, log: () => {}, policy }).start();
const ctx = { admin: true, key: null, sid: 'cowork-e2e' };
const rpc = (m, p) => relay.call(m, p, ctx);
const extDir = join(mkdtempSync(join(tmpdir(), 'lbd-cw-ext-')), 'extension');
cpSync(resolve(here, '..', '..', 'extension'), extDir, { recursive: true });
writeFileSync(join(extDir, 'config.json'), JSON.stringify({ relayUrl: `ws://127.0.0.1:${relay.port}/ext`, settings: { ...policy, clickMode: 'cowork' } }));
const browser = await HeadlessBrowser.launch({ chromePath: findPlaywrightChromium(), headless: true, extensionPath: extDir });
for (let i = 0; i < 200 && !relay.router.ext; i++) await sleep(50);
if (!relay.router.ext) throw new Error('extension did not connect to the test relay');
const extId = relay.router.extInfo && relay.router.extInfo.id;
const conn = browser.conn;
let tab = (await rpc('tabs.list', {})).tabs.find((x) => x.source === 'extension')?.tab;

// ---- "you": a separate DevTools session on the same page ----
async function userSession(urlPart) {
  for (let i = 0; i < 60; i++) {
    const { targetInfos } = await conn.send('Target.getTargets');
    const t = targetInfos.find((x) => x.type === 'page' && x.url.includes(urlPart));
    if (t) {
      const { sessionId } = await conn.send('Target.attachToTarget', { targetId: t.targetId, flatten: true });
      return sessionId;
    }
    await sleep(100);
  }
  throw new Error('no page target for ' + urlPart);
}
const evalIn = async (s, expr) => (await conn.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, s)).result.value;
async function pointOfText(s, text, sel = 'a,button,[role=button],summary') {
  return evalIn(s, `(() => { const want = ${JSON.stringify(text)}.toLowerCase(); const els = [...document.querySelectorAll(${JSON.stringify(sel)})].filter((e) => (e.innerText || e.textContent || '').trim().toLowerCase() === want || (e.innerText || '').trim().toLowerCase().startsWith(want)); const el = els.find((e) => { const r = e.getBoundingClientRect(); return r.width && r.height; }); if (!el) return null; el.scrollIntoView({ block: 'center' }); const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
}
async function userClickAt(s, p) {
  await conn.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y }, s);
  await conn.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', clickCount: 1 }, s);
  await conn.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', clickCount: 1 }, s);
}
async function userClickText(s, text, sel) {
  const p = await pointOfText(s, text, sel);
  if (!p) throw new Error('you could not find "' + text + '" to click');
  await sleep(60);
  const q = await pointOfText(s, text, sel);
  await userClickAt(s, q || p);
  return q || p;
}
async function userScroll(s, dy = 400) { await conn.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 400, y: 400, deltaX: 0, deltaY: dy }, s); }
async function shot(s, name) {
  const r = await conn.send('Page.captureScreenshot', { format: 'png' }, s);
  const f = join(SHOTS, name);
  writeFileSync(f, Buffer.from(r.data, 'base64'));
  return f;
}
async function setMode(mode) {
  await rpc('interaction.set', { mode });
  // interaction.set is a session override: the relay applies it at once, the extension only in memory.
  for (let i = 0; i < 60; i++) { if (relay.clickMode() === mode) { await sleep(150); return; } await sleep(50); }
  throw new Error('mode did not reach the extension: ' + mode);
}
async function navigate(url) {
  await rpc('run', { tab, steps: [{ action: 'navigate', url }], snapshot: 'none' });
}
async function waitFor(fn, ms = 8000, step = 100) { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(step); } return null; }

const results = [];
async function run(id, mode, site, fn) {
  if (ONLY && !ONLY.includes(id)) return;
  const t0 = Date.now();
  const row = { id, mode, site, ok: false };
  try {
    await setMode(mode);
    relay.interact.consume(); relay.interact.resume(); relay._takenBack = false;
    try { await rpc('plan.clear', { tab }); } catch (_) {}
    Object.assign(row, await fn());
    row.ok = true;
  } catch (e) {
    row.error = String(e && e.message || e).slice(0, 400);
  }
  row.ms = Date.now() - t0;
  results.push(row);
  log(`${row.ok ? 'PASS' : 'FAIL'} ${id} [${mode}] ${site} ${row.ms}ms${row.error ? ' ' + row.error : ''}`);
}
const must = (c, m) => { if (!c) throw new Error(m); };

// 1. Cowork: the AI is stuck (its intent does not resolve, it keeps retrying), you click the right link, it continues from there.
await run('cowork-stuck-books', 'cowork', 'books.toscrape.com', async () => {
  await navigate('https://books.toscrape.com/');
  const plan = {
    tab, goal: 'Find the first Travel book',
    steps: [
      { action: 'click', intent: 'open the category for trips abroad', waitNav: true, expect: { title: 'Travel' } },
      { action: 'extract', intent: 'read the first book on the list', what: 'text' },
    ],
  };
  const first = await rpc('plan.run', plan);
  must(first.event === 'adapt', 'expected the AI to be stuck first, got ' + first.event);
  const loop = await rpc('plan.run', { tab });
  must(loop.event === 'adapt', 'expected the AI to still be stuck, got ' + loop.event);
  const s = await userSession('books.toscrape.com');
  const tClick = Date.now();
  await userClickText(s, 'Travel');
  await waitFor(async () => /travel/i.test(await evalIn(s, 'location.href').catch(() => '')) || null, 8000);
  const s2 = await userSession('travel');
  await sleep(250);
  const done = await rpc('plan.run', { tab });
  const pill = await shot(s2, 'cowork-books-after-help.png').catch(() => null);
  must(done.event === 'done', 'expected the AI to finish after your help, got ' + done.event + ' ' + JSON.stringify(done.delta || ''));
  must(done.plan.steps[0].status === 'user', 'your click should count as step 1 done by you');
  const text = String(done.results.at(-1)?.run?.value || '');
  must(/Himalayas/i.test(text), 'the AI should read the first Travel book: ' + text.slice(0, 120));
  return { adaptsBeforeHelp: 2, finishedAfterHelpMs: Date.now() - tClick, stats: done.stats, lastEvent: done.plan.lastEvent && done.plan.lastEvent.event, shot: pill };
});

// 2. Cowork with a direct browser_run: you click while the AI is between steps; it does not fight you, it reports your state.
await run('cowork-run-wikipedia', 'cowork', 'en.wikipedia.org', async () => {
  await navigate('https://en.wikipedia.org/wiki/Ada_Lovelace');
  const s = await userSession('Ada_Lovelace');
  await userClickText(s, 'Charles Babbage', '#mw-content-text a');
  await waitFor(async () => /Babbage/.test(await evalIn(s, 'location.href').catch(() => '')) || null, 8000);
  const r = await rpc('run', { tab, steps: [{ action: 'click', target: 'text=Analytical Engine' }], snapshot: 'none' });
  must(r.event === 'cowork', 'expected event=cowork, got ' + r.event);
  must(r.results.length === 0, 'the AI must not click over your change');
  must(/Babbage/.test(r.cowork.url || ''), 'cowork state should be your page: ' + r.cowork.url);
  const next = await rpc('run', { tab, steps: [{ action: 'extract', what: 'text' }], snapshot: 'none' });
  must(next.ok && /Babbage/.test(String(next.results[0].value || '').slice(0, 4000)), 'AI continues from your page');
  return { coworkUrl: r.cowork.url, lines: r.cowork.lines.length };
});

// 3. Cowork hold: you scroll and click mid-plan; the AI waits until you are idle before its next action.
await run('cowork-hold-mdn', 'cowork', 'developer.mozilla.org', async () => {
  await navigate('https://developer.mozilla.org/en-US/docs/Web/API/Document');
  const s = await userSession('developer.mozilla.org');
  const p = rpc('plan.run', { tab, steps: [{ action: 'wait', ms: 1200, intent: 'let the page settle' }, { action: 'extract', intent: 'read the page heading', what: 'text' }] });
  await sleep(300);
  await userScroll(s, 500);
  await sleep(250);
  await userScroll(s, 300);
  await sleep(200);
  const coworkShown = await waitFor(async () => (await evalIn(s, '!!document.getElementById("__lbd_cowork")').catch(() => false)) || null, 1500);
  const pillShot = coworkShown ? await shot(s, 'cowork-indicator-mdn.png') : null;
  const tLast = Date.now();
  const out = await p;
  must(out.event === 'done', 'plan should finish: ' + out.event);
  const ev = out.plan.lastEvent;
  must(out.stats.cowork === 1, 'one cowork hand-off expected, got ' + out.stats.cowork);
  const held = (relay.plans.get(tab).lastEvent && true) && out.results.length === 2;
  return { coworkIndicator: !!coworkShown, indicatorShot: pillShot, tLastInput: tLast, held, stats: out.stats, lastEvent: ev && ev.event };
});

// 4. Pause: your click pauses the task; the side panel shows Paused with Resume; the AI continues on Resume.
await run('pause-panel-github', 'pause', 'github.com', async () => {
  await navigate('https://github.com/microsoft/playwright-mcp');
  const s = await userSession('github.com/microsoft/playwright-mcp');
  // You click once the page has loaded (GitHub reaches 'complete' well after navigate returns).
  await waitFor(async () => (await evalIn(s, 'document.readyState').catch(() => '')) === 'complete' || null, 15000);
  await sleep(400);
  let finished = false;
  const p = rpc('plan.run', { tab, steps: [{ action: 'wait', ms: 900, intent: 'look at the repo' }, { action: 'extract', intent: 'read the description', what: 'text' }] }).then((x) => { finished = true; return x; });
  await sleep(300);
  await userClickAt(s, { x: 700, y: 520 });
  await waitFor(() => relay.interact.paused || null, 3000);
  must(relay.interact.paused, 'your click should pause the task');
  await sleep(1800);
  must(!finished, 'the task must stay paused until Resume');
  const { targetId } = await conn.send('Target.createTarget', { url: `chrome-extension://${extId}/panel.html` });
  const { sessionId: ps } = await conn.send('Target.attachToTarget', { targetId, flatten: true });
  await conn.send('Emulation.setDeviceMetricsOverride', { width: 420, height: 760, deviceScaleFactor: 2, mobile: false }, ps).catch(() => {});
  const shown = await waitFor(async () => (await evalIn(ps, '!!document.getElementById("userResume")').catch(() => false)) || null, 6000);
  must(shown, 'side panel should show Paused with a Resume button');
  const panelShot = await shot(ps, 'panel-paused-click-mode.png');
  const modeInPanel = await evalIn(ps, 'document.getElementById("clickMode").value');
  await evalIn(ps, 'document.getElementById("userResume").click(), true');
  const out = await p;
  must(out.event === 'done', 'AI continues on Resume: ' + out.event);
  await conn.send('Target.closeTarget', { targetId }).catch(() => {});
  return { pausedVisibleInPanel: true, modeInPanel, panelShot, stats: out.stats };
});

// 5. Pause on a second site, resumed from the in-page pill.
await run('pause-pill-hn', 'pause', 'news.ycombinator.com', async () => {
  await navigate('https://news.ycombinator.com/');
  const s = await userSession('news.ycombinator.com');
  let finished = false;
  const p = rpc('plan.run', { tab, steps: [{ action: 'wait', ms: 700, intent: 'look at the front page' }, { action: 'extract', intent: 'read the top stories', what: 'text' }] }).then((x) => { finished = true; return x; });
  await sleep(250);
  await userClickAt(s, { x: 900, y: 600 });
  const pill = await waitFor(async () => (await evalIn(s, '!!document.getElementById("__lbd_resume")').catch(() => false)) || null, 4000);
  must(pill, 'in-page pill should offer Resume');
  const pauseShot = await shot(s, 'pause-pill-hn.png');
  await sleep(800);
  must(!finished, 'still paused');
  const rp = await evalIn(s, '(() => { const r = document.getElementById("__lbd_resume").getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()');
  await userClickAt(s, rp);
  const out = await p;
  must(out.event === 'done', 'AI continues after Resume: ' + out.event);
  return { pauseShot, stats: out.stats };
});

// 6/7. Disable window: your clicks are absorbed while the AI works; nothing pauses; the AI finishes.
for (const [id, url, linkText] of [['disable-quotes', 'https://quotes.toscrape.com/', 'Next'], ['disable-wikipedia', 'https://en.wikipedia.org/wiki/United_States', 'English']]) {
  await run(id, 'disable', new URL(url).host, async () => {
    await navigate(url);
    const s = await userSession(new URL(url).host);
    const before = await evalIn(s, 'location.href');
    const p = rpc('plan.run', { tab, steps: [{ action: 'wait', ms: 1200, intent: 'look' }, { action: 'extract', intent: 'read', what: 'text' }] });
    const blocked = await waitFor(async () => (await evalIn(s, '!!document.getElementById("__lbd_input_block")').catch(() => false)) || null, 1500);
    must(blocked, 'the tab should be locked while the AI works');
    const lockShot = await shot(s, id + '-locked.png');
    const pt = await pointOfText(s, linkText).catch(() => null);
    await userClickAt(s, pt || { x: 600, y: 400 });
    const out = await p;
    await sleep(400);
    const after = await evalIn(s, 'location.href');
    must(out.event === 'done', 'AI finishes: ' + out.event);
    must(after === before, 'your click must not reach the page while locked: ' + after);
    must(!relay.interact.paused && out.stats.cowork === 0, 'disable mode never pauses or coworks');
    return { lockShot, url: after };
  });
}

// Options page with the setting.
if (!ONLY) {
  try {
    await setMode('cowork');
    const { targetId } = await conn.send('Target.createTarget', { url: `chrome-extension://${extId}/options.html` });
    const { sessionId: os } = await conn.send('Target.attachToTarget', { targetId, flatten: true });
    await conn.send('Emulation.setDeviceMetricsOverride', { width: 900, height: 900, deviceScaleFactor: 1.5, mobile: false }, os).catch(() => {});
    await sleep(800);
    await evalIn(os, 'document.getElementById("clickMode").scrollIntoView({ block: "center" }), true');
    await sleep(200);
    results.push({ id: 'options-setting', ok: (await evalIn(os, 'document.getElementById("clickMode").value')) === 'cowork', shot: await shot(os, 'options-click-mode.png') });
  } catch (e) { results.push({ id: 'options-setting', ok: false, error: e.message }); }
}

const passed = results.filter((r) => r.ok).length;
writeFileSync(OUT, JSON.stringify({ at: new Date().toISOString(), passed, total: results.length, results }, null, 2));
log(`cowork e2e: ${passed}/${results.length} passed -> ${OUT}`);
try { await browser.close(); } catch (_) {}
try { await relay.stop(); } catch (_) {}
process.exit(passed === results.length ? 0 : 1);
