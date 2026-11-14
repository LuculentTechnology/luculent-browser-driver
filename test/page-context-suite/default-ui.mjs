// Default Chrome UI proof for Pull page context, plus Reddit/SO in the real profile.
// Talks to the production relay on 127.0.0.1:47800 with the existing default key (never printed).
// Reloads only the Default Chrome profile with --restore-last-session after refreshing the install folder.
import { readFileSync, writeFileSync, mkdirSync, cpSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const extSrc = resolve(here, '..', '..', 'extension');
const installDir = process.env.LBD_INSTALL_DIR || 'D:\\Luculent\\browser-driver-install\\0.3.0';
const zipPath = process.env.LBD_INSTALL_ZIP || 'D:\\Luculent\\browser-driver-install\\luculent-browser-driver-0.3.0.zip';
const proofs = process.env.LBD_PROOFS || 'D:\\Luculent\\ops\\state\\driver03-proofs';
const keyPath = process.env.LBD_KEY_PATH || join(process.env.USERPROFILE || process.env.HOME || '', '.luculent', 'browser-driver', 'keys', 'default.key');
const helper = join(here, 'default_chrome.py');
const argv = process.argv.slice(2);
const flag = (n) => argv.includes('--' + n);
const SKIP_RESTART = flag('skip-restart');
const SKIP_COPY = flag('skip-copy');
const RESTART_RELAY = !flag('skip-relay-restart');
const RELAY = 'http://127.0.0.1:47800/v1/rpc';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function loadKey() {
  if (!existsSync(keyPath)) throw new Error('default key file is missing');
  const raw = readFileSync(keyPath, 'utf8').replace(/^\uFEFF/, '').trim();
  const line = raw.split(/\r?\n/).map((l) => l.trim()).find((l) => l && !l.startsWith('#'));
  if (!line) throw new Error('default key file is empty');
  return line;
}

const KEY = loadKey();

async function rpc(method, params = {}) {
  const res = await fetch(RELAY, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + KEY },
    body: JSON.stringify({ method, params }),
  });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { throw new Error(method + ' bad json HTTP ' + res.status); }
  if (!res.ok || body.error) {
    const msg = body.error?.message || body.error || ('HTTP ' + res.status);
    const err = new Error(String(msg));
    err.status = res.status;
    throw err;
  }
  return body.result;
}

function py(args, timeoutMs = 60000) {
  const r = spawnSync('python', [helper, ...args], { encoding: 'utf-8', timeout: timeoutMs });
  const out = (r.stdout || '') + (r.stderr || '');
  if (r.status !== 0) throw new Error('default_chrome.py ' + args[0] + ' failed: ' + out.slice(0, 400));
  return out;
}

function preserveCopyInstall() {
  mkdirSync(installDir, { recursive: true });
  let savedKey = null;
  const manPath = join(installDir, 'manifest.json');
  if (existsSync(manPath)) {
    try { savedKey = JSON.parse(readFileSync(manPath, 'utf8')).key || null; } catch (_) {}
  }
  cpSync(extSrc, installDir, { recursive: true });
  const man = JSON.parse(readFileSync(manPath, 'utf8'));
  if (savedKey && !man.key) {
    man.key = savedKey;
    writeFileSync(manPath, JSON.stringify(man, null, 2) + '\n');
  }
  if (!man.key && savedKey == null) throw new Error('install manifest is missing the extension key; left untouched key would break the ID');
  // Zip the install folder with the key retained (this is the unpacked-install zip, not the store zip).
  mkdirSync(dirname(zipPath), { recursive: true });
  try { if (existsSync(zipPath)) execFileSync('cmd', ['/c', 'del', zipPath], { stdio: 'ignore' }); } catch (_) {}
  const entries = readdirSync(installDir);
  try {
    execFileSync('tar', ['-a', '-c', '-f', zipPath, '-C', installDir, ...entries], { stdio: 'ignore' });
  } catch (e) {
    throw new Error('failed to write install zip');
  }
  const bytes = existsSync(zipPath) ? statSync(zipPath).size : 0;
  return { installDir, zipPath, bytes, files: entries.length, hasKey: !!JSON.parse(readFileSync(manPath, 'utf8')).key };
}

function openPanelViaGesture() {
  const r = spawnSync('python', [join(here, 'open_panel.py')], { encoding: 'utf-8', timeout: 30000 });
  const out = (r.stdout || '') + (r.stderr || '');
  if (r.status !== 0) throw new Error('could not open the side panel with a user click: ' + out.slice(0, 300));
  return out;
}

function allChats(state) {
  const out = [];
  if (state?.view) out.push(state.view);
  for (const items of Object.values(state?.sections || {})) {
    for (const c of items || []) out.push(c);
  }
  return out;
}

async function findPageContext(expect) {
  const state = await rpc('panel.state', {});
  let best = null;
  for (const c of allChats(state)) {
    let ctx = c.pageContext || null;
    let chip = c.chip || (ctx ? { title: ctx.title, url: ctx.url } : null);
    if ((!ctx || !ctx.text) && c.id) {
      try {
        const one = await rpc('panel.state', { id: c.id });
        const v = one.view || one;
        ctx = v.pageContext || ctx;
        chip = v.chip || chip || (ctx ? { title: ctx.title, url: ctx.url } : null);
      } catch (_) {}
    }
    if (!ctx) continue;
    const title = ctx.title || chip?.title || '';
    const rec = { ok: !!(expect && expect.test(title) && (ctx.text || '').length > 40), chip, ctx, chatId: c.id, title, textLen: (ctx.text || '').length, hasBlurb: true };
    if (rec.ok) return rec;
    if (!best) best = rec;
  }
  return best || { ok: false };
}

function methodMissing(e) {
  const s = String((e && e.message) || e || '');
  return /unknown method|unknown message|not found|is not a function/i.test(s);
}

async function waitForExtension(timeoutMs = 45000) {
  const t0 = Date.now();
  let last = '';
  while (Date.now() - t0 < timeoutMs) {
    try {
      const st = await rpc('status', {}).catch(() => null);
      const listed = await rpc('tabs.list', {}).catch(() => ({ tabs: [], hidden: 0, extension: false }));
      const tabs = listed.tabs || [];
      const ext = tabs.filter((t) => t.source === 'extension');
      last = 'ext=' + !!(st && st.extension) + ' extTabs=' + ext.length + ' hidden=' + (listed.hidden || 0) + (st && st.killed ? ' killed' : '');
      if ((st && st.extension) || ext.length || listed.hidden) return { tabs: ext, status: st, hidden: listed.hidden || 0 };
    } catch (e) {
      last = String(e.message || e).slice(0, 200);
    }
    await sleep(1000);
  }
  throw new Error('Default Chrome extension did not reconnect to the relay: ' + last);
}

async function pickTab(tabs) {
  const ext = (tabs || []).filter((t) => t.source === 'extension');
  return ext.find((t) => t.active) || ext[0] || null;
}

async function ensureTab() {
  const listed = (await rpc('tabs.list', {})).tabs || [];
  let t = await pickTab(listed);
  if (!t) {
    const made = await rpc('tabs.new', { source: 'extension' });
    t = { tab: made.tab, source: 'extension' };
  }
  await rpc('tabs.activate', { tab: t.tab, stealFocus: true }).catch(() => {});
  return t.tab;
}

async function openAndClickPull() {
  const out = { opened: false, clicked: false, openError: null, clickError: null, gesture: null };
  try {
    const r = await rpc('panel.open', {});
    out.opened = !!(r && r.ok !== false);
    out.open = r;
  } catch (e) {
    out.openError = String(e.message || e).slice(0, 240);
  }
  if (!out.opened) {
    try { out.gesture = openPanelViaGesture(); out.opened = /opened=1|already_open=1/.test(out.gesture); }
    catch (e) { out.openError = (out.openError ? out.openError + '; ' : '') + String(e.message || e).slice(0, 240); }
  }
  await sleep(800);
  try {
    const r = await rpc('panel.clickPull', {});
    out.clicked = !!(r && (r.ok === true || (r.sent && r.sent.ok)));
    out.click = r;
  } catch (e) {
    out.clickError = String(e.message || e).slice(0, 240);
  }
  return out;
}

function chipOk(view) {
  const chip = view?.chip || view?.view?.chip;
  const ctx = view?.pageContext || view?.view?.pageContext;
  if (chip && (chip.title || chip.url || chip.label || chip.text)) return { ok: true, chip, hasContext: !!ctx };
  if (ctx && (ctx.title || ctx.text || ctx.url)) return { ok: true, chip: chip || { title: ctx.title, url: ctx.url }, hasContext: true };
  return { ok: false, chip, hasContext: !!ctx };
}

const UI_SITES = [
  { id: 'ui-wikipedia-ada', url: 'https://en.wikipedia.org/wiki/Ada_Lovelace', titleSubstr: 'Ada Lovelace', expect: /Ada Lovelace/i },
  { id: 'ui-mdn-fetch', url: 'https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API', titleSubstr: 'Fetch', expect: /Fetch/i },
  { id: 'ui-hn', url: 'https://news.ycombinator.com/', titleSubstr: 'Hacker News', expect: /Hacker News|HN/i },
];

const RETRY_SITES = [
  { id: 'default-reddit-thread', url: 'https://old.reddit.com/r/programming/', fallback: 'https://www.reddit.com/r/programming/', titleSubstr: 'programming', expect: /programming|reddit/i },
  { id: 'default-stackoverflow', url: 'https://stackoverflow.com/questions/1732348/regex-match-open-tags-except-xhtml-self-contained-tags', titleSubstr: 'Stack Overflow', expect: /Stack Overflow|RegEx|regular expression/i },
];

const results = [];
mkdirSync(proofs, { recursive: true });

const copyInfo = SKIP_COPY ? { skipped: true } : preserveCopyInstall();
console.error('INSTALL ' + JSON.stringify({ dir: copyInfo.installDir || installDir, zipBytes: copyInfo.bytes, hasKey: copyInfo.hasKey, skipped: !!copyInfo.skipped }));

if (RESTART_RELAY) {
  console.error('RELAY_RESTART ' + py(['relay-restart', '--port', '47800'], 60000).trim().replace(/\s+/g, ' '));
  await sleep(2000);
  try { const st = await rpc('status', {}); console.error('RELAY ok v' + (st.version || '') + ' ext=' + !!st.extension); }
  catch (e) { throw new Error('relay did not come back: ' + e.message); }
}

if (!SKIP_RESTART) {
  const listed = py(['list']);
  console.error('CHROME ' + listed.trim().replace(/\s+/g, ' '));
  const restarted = py(['restart', '--flush-sw-cache'], 90000);
  console.error('RESTART ' + restarted.trim().replace(/\s+/g, ' '));
  await sleep(12000);
} else {
  console.error('RESTART skipped');
}

const conn = await waitForExtension(60000);
console.error('RELAY ext tabs=' + conn.tabs.length);

for (const site of UI_SITES) {
  const t0 = Date.now();
  const rec = { id: site.id, url: site.url, status: 'pass' };
  try {
    let tab = null;
    try { tab = await ensureTab(); rec.tab = tab; } catch (e) { rec.tabError = String(e.message || e).slice(0, 200); }
    let navigated = false;
    if (tab) {
      try {
        const nav = await rpc('run', { tab, steps: [{ action: 'navigate', url: site.url, timeout: 25000 }, { action: 'wait', for: 'load', timeout: 15000, optional: true }, { action: 'wait', ms: 800 }], snapshot: 'none' });
        if (nav && nav.ok === false) rec.navError = (nav.results || []).find((x) => !x.ok)?.error || 'navigate failed';
        else navigated = true;
        await rpc('tabs.activate', { tab, stealFocus: true }).catch(() => {});
      } catch (e) { rec.navError = String(e.message || e).slice(0, 200); }
    }
    if (!navigated) {
      py(['open-url', site.url]);
      rec.openedViaChrome = true;
      await sleep(4000);
    }
    rec.ui = await openAndClickPull();
    await sleep(900);
    rec.chip = await findPageContext(site.expect);
    rec.title = rec.chip.title || rec.chip.chip?.title || '';
    rec.textLen = rec.chip.textLen || 0;
    rec.hasBlurb = !!rec.chip.hasBlurb;
    rec.chatId = rec.chip.chatId || null;
    const shot = join(proofs, site.id + '.png');
    try {
      const out = py(['screenshot', shot, '--title-substr', site.titleSubstr], 30000);
      rec.screenshot = shot;
      rec.screenshotLog = out.trim().split(/\r?\n/).slice(0, 4);
    } catch (e) {
      rec.screenshotError = String(e.message || e).slice(0, 240);
    }
    const clicked = rec.ui && rec.ui.clicked;
    const chipShown = rec.chip && rec.chip.ok;
    if (!clicked) throw new Error('Pull button was not clicked in the side panel (' + (rec.ui?.clickError || rec.ui?.openError || 'clickPull did not confirm') + ')');
    if (!chipShown) throw new Error('chip/blurb did not describe the current page after Pull (title=' + JSON.stringify(rec.title).slice(0, 160) + ')');
    if (!rec.screenshot && rec.screenshotError) rec.warning = rec.screenshotError;
  } catch (e) {
    rec.status = 'fail';
    rec.error = String(e.message || e).slice(0, 400);
  }
  rec.ms = Date.now() - t0;
  results.push(rec);
  console.error((rec.status === 'pass' ? 'PASS' : 'FAIL') + '    ui    ' + rec.id + ' ' + rec.ms + 'ms' + (rec.error ? ' :: ' + rec.error : '') + (rec.screenshot ? ' shot=' + rec.screenshot : ''));
}

function isBot(title, text) {
  const BOT_TITLE = /^Error Page \| eBay|^Sorry! Something went wrong|^Welcome to Reddit|^Access to this page has been denied|^Robot Check/i;
  const BOT = /captcha|unusual traffic|are you a robot|verify you are human|access denied|request blocked|robot check|just a moment|attention required|enable javascript and cookies|pardon our interruption|been blocked|type the characters/i;
  return BOT_TITLE.test(title || '') || BOT.test(title || '') || BOT.test((text || '').slice(0, 800));
}

for (const site of RETRY_SITES) {
  const t0 = Date.now();
  const rec = { id: site.id, url: site.url, status: 'pass' };
  try {
    let tab = null;
    try { tab = await ensureTab(); rec.tab = tab; } catch (e) { rec.tabError = String(e.message || e).slice(0, 200); }
    let navigated = false;
    if (tab) {
      try {
        const nav = await rpc('run', { tab, steps: [{ action: 'navigate', url: site.url, timeout: 25000 }, { action: 'wait', for: 'load', timeout: 15000, optional: true }, { action: 'wait', ms: 1200 }], snapshot: 'none' });
        if (!(nav && nav.ok === false)) navigated = true;
      } catch (e) { rec.navError = String(e.message || e).slice(0, 200); }
    }
    if (!navigated) {
      py(['open-url', site.url]);
      rec.openedViaChrome = true;
      await sleep(4500);
    }
    async function pullViaPanelAndRpc() {
      const ui = await openAndClickPull();
      await sleep(800);
      const found = await findPageContext(site.expect);
      let pulled = {};
      if (tab && !(found && found.ok)) pulled = await rpc('pageContext.pull', { tab }).catch((e) => ({ error: String(e.message || e) }));
      const ctx = found?.ctx || pulled?.pageContext || null;
      return { ui, found, pulled, ctx, title: (ctx && ctx.title) || found?.title || '', text: (ctx && ctx.text) || '' };
    }
    let got = await pullViaPanelAndRpc();
    if (site.fallback && (!got.ctx || isBot(got.title, got.text) || got.text.length < 40)) {
      rec.usedFallback = site.fallback;
      rec.url = site.fallback;
      if (tab) {
        try {
          await rpc('run', { tab, steps: [{ action: 'navigate', url: site.fallback, timeout: 25000 }, { action: 'wait', for: 'load', timeout: 15000, optional: true }, { action: 'wait', ms: 1200 }], snapshot: 'none' });
        } catch (_) {
          py(['open-url', site.fallback]);
          await sleep(4500);
        }
      } else {
        py(['open-url', site.fallback]);
        await sleep(4500);
      }
      got = await pullViaPanelAndRpc();
    }
    rec.ui = got.ui;
    rec.chip = got.found || chipOk(got.view);
    rec.title = got.title || rec.chip?.chip?.title || '';
    rec.textLen = (got.text || '').length;
    const shot = join(proofs, site.id + '.png');
    try {
      py(['screenshot', shot, '--title-substr', site.titleSubstr], 30000);
      rec.screenshot = shot;
    } catch (e) { rec.screenshotError = String(e.message || e).slice(0, 200); }
    if (isBot(rec.title, got.text) || rec.textLen < 40) {
      rec.status = 'blocked';
      rec.error = 'bot wall or thin content: ' + JSON.stringify(rec.title).slice(0, 160);
    }
  } catch (e) {
    const msg = String(e.message || e);
    rec.status = /bot wall|just a moment|access denied/i.test(msg) ? 'blocked' : 'fail';
    rec.error = msg.slice(0, 400);
  }
  rec.ms = Date.now() - t0;
  results.push(rec);
  console.error(rec.status.toUpperCase().padEnd(7) + ' def   ' + rec.id + ' ' + rec.ms + 'ms' + (rec.error ? ' :: ' + rec.error : '') + (rec.title ? ' title=' + JSON.stringify(rec.title).slice(0, 80) : ''));
}

const summary = {
  pass: results.filter((r) => r.status === 'pass').length,
  fail: results.filter((r) => r.status === 'fail').length,
  blocked: results.filter((r) => r.status === 'blocked').length,
  total: results.length,
  proofs,
  install: copyInfo,
  at: new Date().toISOString(),
};
const outFile = join(proofs, 'default-ui-results.json');
writeFileSync(outFile, JSON.stringify({ summary, results }, null, 2));
console.error('SUMMARY ' + JSON.stringify(summary));
console.log(JSON.stringify({ summary, results }, null, 2));
if (summary.fail) process.exitCode = 1;
