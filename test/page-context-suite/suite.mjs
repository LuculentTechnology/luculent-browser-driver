// Pull page context suite: extract through the real extension/relay path across real sites and edge cases.
// Usage: node test/page-context-suite/suite.mjs [--source extension|headless] [--only id1,id2] [--live 0|1] [--local 0|1] [--live-llm 0|1] [--out file.json]
import { mkdtempSync, writeFileSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Relay } from '../../src/relay.mjs';
import { KeyStore } from '../../src/keys.mjs';
import { HeadlessBrowser, findPlaywrightChromium } from '../../src/headless.mjs';
import { DEFAULT_POLICY } from '../../src/policy.mjs';
import { PAGE_CONTEXT_MAX as CTX_MAX, PAGE_CONTEXT_INSTRUCTION } from '../../src/page-context.mjs';
import { startSuiteFixtures } from './fixtures.mjs';
import { casesFor, PANEL_SITES, LLM_SITES, DUMMY_PASSWORD } from './cases.mjs';
import { llmAvailable, llmSource, llmComplete, blurbPrompt, followUpPrompt } from './llm.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : d; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ONLY = opt('only') ? opt('only').split(',') : null;
const LIVE = opt('live', '1') !== '0';
const LOCAL = opt('local', '1') !== '0';
const SOURCE = opt('source', 'extension');
const LIVE_LLM = opt('live-llm', '0') === '1' || process.env.LBD_LIVE_LLM === '1';
const BOT_TITLE = /^Error Page \| eBay|^Sorry! Something went wrong|^Welcome to Reddit|^Access to this page has been denied|^Robot Check/i;
const BOT = /captcha|unusual traffic|are you a robot|verify you are human|access denied|request blocked|robot check|just a moment|attention required|enable javascript and cookies|pardon our interruption|been blocked|type the characters|sorry, we just need to make sure|blocked by network security/i;
const NAV = /skip to (main )?content|sign in|log in|subscribe|cookie|privacy policy|accept all|all rights reserved/i;
class Blocked extends Error {}

function sameSite(a, b) {
  const n = (h) => String(h || '').replace(/^www\./, '').toLowerCase();
  a = n(a); b = n(b);
  if (a === b) return true;
  const sld = (h) => {
    const p = h.split('.');
    if (p.length <= 2) return p[0];
    return (p[p.length - 2] === 'co' || p[p.length - 2] === 'com' || p[p.length - 2] === 'ne') ? p[p.length - 3] : p[p.length - 2];
  };
  return sld(a) === sld(b);
}



const policy = { ...DEFAULT_POLICY, grantMode: 'all', passwords: 'allow' };
const fx = await startSuiteFixtures();
const keys = new KeyStore(mkdtempSync(join(tmpdir(), 'lbd-pcs-k-')));
const relay = await new Relay({ port: 0, keys, log: () => {}, policy }).start();
const ctx = { admin: true, key: null, sid: 'page-context-suite' };
const rpc = (m, p) => relay.call(m, p, ctx);
let browser = null;
let tab;

if (SOURCE === 'extension') {
  const extDir = join(mkdtempSync(join(tmpdir(), 'lbd-pcs-ext-')), 'extension');
  cpSync(resolve(here, '..', '..', 'extension'), extDir, { recursive: true });
  writeFileSync(join(extDir, 'config.json'), JSON.stringify({ relayUrl: `ws://127.0.0.1:${relay.port}/ext`, settings: { ...policy } }));
  browser = await HeadlessBrowser.launch({ chromePath: findPlaywrightChromium(), headless: true, extensionPath: extDir });
  for (let i = 0; i < 200 && !relay.router.ext; i++) await sleep(50);
  if (!relay.router.ext) throw new Error('extension did not connect to the test relay');
  tab = (await rpc('tabs.list', {})).tabs.find((x) => x.source === 'extension')?.tab;
} else {
  tab = (await rpc('headless.launch', {})).tab;
}

async function ensureTab() {
  const prev = tab;
  try { tab = (await rpc('tabs.new', { source: SOURCE === 'extension' ? 'extension' : 'headless' })).tab; } catch (e) { console.error('tabs.new failed ' + e.message); }
  if (prev && prev !== tab) relay.router.closeTab(prev).catch(() => {});
  return tab;
}

function errText(e) {
  return String((e && e.message) || e || '');
}

function isRefuse(e) {
  const s = errText(e);
  return e?.denied || e?.status === 403 || /Blocked by your Luculent security settings/i.test(s);
}

function assertExtract(c, pulled, ms) {
  const ctxp = pulled?.pageContext || pulled;
  if (!ctxp) throw new Error('no pageContext returned');
  const title = ctxp.title || '';
  const url = ctxp.url || '';
  const text = ctxp.text || '';
  const headings = (ctxp.headings || []).join(' | ');
  const blob = title + '\n' + text + '\n' + headings;
  const ex = c.expect || {};
  if (ex.title && !ex.title.test(title)) throw new Error(`title mismatch: ${JSON.stringify(title).slice(0, 200)}`);
  if (c.url && url && !c.action) {
    try {
      const got = new URL(url);
      const want = new URL(c.url);
      if (!sameSite(got.hostname, want.hostname)) throw new Error(`url host mismatch: ${url}`);
    } catch (e) { if (e.message.startsWith('url host')) throw e; }
  }
  if (ex.heading && !ex.heading.test(headings)) throw new Error(`headings missing expected content: ${headings.slice(0, 200)}`);
  if (ex.text && !ex.text.test(blob)) throw new Error(`main content missing: ${JSON.stringify(blob).slice(0, 400)}`);
  if (ex.minText && text.length < ex.minText) throw new Error(`text too short (${text.length} < ${ex.minText}): ${JSON.stringify(text).slice(0, 200)}`);
  if (ex.forbid && ex.forbid.test(JSON.stringify(ctxp))) throw new Error('secret or forbidden value leaked into page context');
  if (ex.truncated && !ctxp.truncated) throw new Error('expected truncation on a very large page');
  const cap = CTX_MAX || 20000;
  if (JSON.stringify(ctxp).length > cap + 9000) throw new Error('page context exceeded size cap');
  // Boilerplate-only guard: if we asked for real content, nav-only text should not be the whole story.
  if (ex.minText && ex.minText >= 200) {
    const withoutNav = text.replace(NAV, ' ').replace(/\s+/g, ' ').trim();
    if (withoutNav.length < Math.min(80, ex.minText / 4)) throw new Error('extracted text looks like nav/boilerplate only');
  }
  if (/password\s*=\s*[^\s\[,]+/i.test(text) && !/\[redacted\]/.test(text)) throw new Error('password-like value was not redacted');
  return { title, url, textLen: text.length, truncated: !!ctxp.truncated, ms };
}

const CASES = casesFor(fx.origin);
const lastHost = new Map();
const results = [];

for (const c of CASES) {
  if (ONLY && !ONLY.includes(c.id)) continue;
  if ((c.kind === 'live' && !LIVE) || (c.kind === 'local' && !LOCAL)) continue;
  await ensureTab();
  if (c.kind === 'live' || c.url.startsWith('http')) {
    try {
      const host = new URL(c.url).host;
      const prev = lastHost.get(host) || 0;
      const wait = 1500 - (Date.now() - prev);
      if (wait > 0) await sleep(wait);
      lastHost.set(host, Date.now());
    } catch (_) {}
  }
  const t0 = performance.now();
  let status = 'pass', error = null, meta = {};
  try {
    await Promise.race([
      (async () => {
        if (c.action === 'refuse') {
          try {
            const nav = await rpc('run', { tab, steps: [{ action: 'navigate', url: c.url, timeout: 20000 }], snapshot: 'none' });
            if (nav && nav.ok === false) {
              const bad = (nav.results || []).find((x) => !x.ok);
              const msg = bad?.error || 'navigate failed';
              if (!(c.expect?.refuse || /Blocked by your Luculent security settings/i).test(msg)) {
                // navigate may fail for other reasons; still try pull, which must refuse
                const pulled = await rpc('pageContext.pull', { tab });
                throw new Error('expected refuse, pull succeeded: ' + JSON.stringify(pulled?.pageContext || pulled).slice(0, 200));
              }
              meta.refusedAt = 'navigate';
              meta.reason = msg.slice(0, 240);
              return;
            }
            try {
              const pulled = await rpc('pageContext.pull', { tab });
              throw new Error('expected refuse, pull succeeded: ' + JSON.stringify(pulled?.pageContext || pulled).slice(0, 200));
            } catch (e) {
              if (!isRefuse(e) && !(c.expect?.refuse || /Blocked/).test(errText(e))) throw e;
              meta.refusedAt = 'pull';
              meta.reason = errText(e).slice(0, 240);
            }
          } catch (e) {
            if (isRefuse(e) || (c.expect?.refuse && c.expect.refuse.test(errText(e)))) {
              meta.refusedAt = 'error';
              meta.reason = errText(e).slice(0, 240);
              return;
            }
            throw e;
          }
          return;
        }
        const nav = await rpc('run', { tab, steps: [{ action: 'navigate', url: c.url, timeout: 25000 }, { action: 'wait', for: 'load', timeout: 15000, optional: true }], snapshot: 'none', dialogs: 'accept' });
        if (c.kind === 'live') await rpc('run', { tab, steps: [{ action: 'wait', ms: 800 }], snapshot: 'none' }).catch(() => {});
        if (c.typePassword) {
          const steps = [];
          if (c.usernameSelector && c.usernameValue) steps.push({ action: 'type', target: c.usernameSelector, text: c.usernameValue, timeout: 8000, optional: true });
          steps.push({ action: 'type', target: c.passwordSelector || 'input[type=password]', text: DUMMY_PASSWORD, timeout: 8000 });
          const typed = await rpc('run', { tab, steps, snapshot: 'none' });
          if (!typed.ok) {
            const bad = (typed.results || []).find((x) => !x.ok);
            const msg = 'could not type dummy password: ' + (bad?.error || 'type failed');
            if (c.action === 'maybe-blocked') throw new Blocked(msg);
            throw new Error(msg);
          }
        }
        if (c.scroll) {
          await rpc('run', { tab, steps: [{ action: 'scroll', dy: 4000 }, { action: 'wait', ms: 400 }, { action: 'scroll', dy: 4000 }], snapshot: 'none' }).catch(() => {});
        }
        if (c.moreLink) {
          await rpc('run', { tab, steps: [{ action: 'click', target: 'text=More', optional: true, timeout: 3000, waitNav: true }], snapshot: 'none' }).catch(() => {});
        }
        const pulled = await rpc('pageContext.pull', { tab });
        const title = pulled?.pageContext?.title || '';
        const text = pulled?.pageContext?.text || '';
        if (BOT_TITLE.test(title) || BOT.test(title) || BOT.test(text.slice(0, 800))) {
          throw new Blocked('bot wall: ' + title);
        }
        if (c.typePassword) {
          const view = await rpc('panel.state', {}).catch(() => null);
          const audit = await rpc('audit.list', { limit: 80 }).catch(() => null);
          const blob = JSON.stringify({ pulled, view, audit });
          if (blob.includes(DUMMY_PASSWORD)) throw new Error('typed dummy password leaked into page context, chip, panel message, or audit log');
        }
        meta = assertExtract(c, pulled, 0);
        if (c.action === 'maybe-blocked' && meta.textLen < (c.expect?.minText || 40)) throw new Blocked('thin or blocked content');
        if (c.scrollAgain) {
          const before = (pulled.pageContext?.text || '').length;
          await rpc('run', { tab, steps: [{ action: 'scroll', dy: 6000 }, { action: 'wait', ms: 800 }, { action: 'scroll', dy: 6000 }], snapshot: 'none' }).catch(() => {});
          const again = await rpc('pageContext.pull', { tab });
          if (c.typePassword && JSON.stringify(again).includes(DUMMY_PASSWORD)) throw new Error('typed dummy password leaked after re-pull');
          const after = (again.pageContext?.text || '').length;
          meta.rePullTextLen = after;
          meta.firstPullTextLen = before;
          if (after < Math.min(before, 20)) throw new Error('re-pull after scroll lost page context');
        }
      })(),
      sleep(60000).then(() => { throw new Error('case timeout 60s'); }),
    ]);
  } catch (e) {
    if (e instanceof Blocked) status = 'blocked';
    else status = 'fail';
    error = errText(e).slice(0, 400);
  }
  const ms = Math.round(performance.now() - t0);
  results.push({ id: c.id, cat: c.cat, kind: c.kind, action: c.action || 'extract', status, error, ...meta, ms });
  console.error(`${status.toUpperCase().padEnd(7)} ${(c.kind || '').padEnd(5)} ${c.id} ${ms}ms${error ? ' :: ' + error : ''}`);
  try {
    const { tabs } = await relay.router.tabs();
    for (const x of tabs) if (x.tab !== tab && (SOURCE === 'extension' ? x.source === 'extension' : x.source !== 'extension')) await relay.router.closeTab(x.tab).catch(() => {});
  } catch (_) {}
}

// Panel end-to-end on several sites: pull, blurb, follow-up, chip refresh/remove, tab switch.
const panelResults = [];
if (!ONLY || ONLY.includes('panel-e2e')) {
  const panelIds = PANEL_SITES.filter((id) => CASES.some((c) => c.id === id));
  const byId = Object.fromEntries(CASES.map((c) => [c.id, c]));
  try {
    await rpc('panel.identify', { provider: 'xAI', model: 'Grok', chatName: 'Page context suite' }).catch(() => rpc('panel.identify', { provider: 'xAI', model: 'Grok' }));
  } catch (e) {
    panelResults.push({ id: 'panel-identify', status: 'fail', error: errText(e) });
  }

  const runPanelOn = async (id, existingTab) => {
    const c = byId[id];
    if (!c) throw new Error('missing case ' + id);
    if (!existingTab) {
      await ensureTab();
      if (c.kind === 'live') {
        const host = new URL(c.url).host;
        const wait = 1500 - (Date.now() - (lastHost.get(host) || 0));
        if (wait > 0) await sleep(wait);
        lastHost.set(host, Date.now());
      }
      const nav = await rpc('run', { tab, steps: [{ action: 'navigate', url: c.url, timeout: 25000 }, { action: 'wait', for: 'load', timeout: 15000, optional: true }], snapshot: 'none' });
      if (nav && nav.ok === false && c.kind === 'live') throw new Blocked('navigate failed for panel: ' + JSON.stringify(nav.results).slice(0, 200));
    }
    const pulled = await rpc('pageContext.pull', { tab });
    const ctxp = pulled.pageContext;
    if (!ctxp) throw new Error('pull did not attach context');
    if (pulled.instruction !== PAGE_CONTEXT_INSTRUCTION && !String(pulled.message?.text || '').includes('quick blurb')) {
      throw new Error('missing blurb instruction');
    }
    const chip = pulled.chip || (await rpc('panel.state', {})).view?.chip;
    if (!chip || !chip.title) throw new Error('chip missing after pull');
    const blurb = `This page is "${ctxp.title}". I can answer questions about its content, including: ${(ctxp.text || '').slice(0, 180)}`;
    await rpc('panel.post', { from: 'agent', text: blurb });
    const phrase = (ctxp.text || ctxp.title || '').split(/\s+/).filter((w) => w.length > 5).slice(3, 8).join(' ') || ctxp.title;
    await rpc('panel.post', { from: 'user', text: 'What is this page about? Quote a short phrase from it.' });
    const answer = `It is about ${ctxp.title}. A phrase from the page: ${phrase}`;
    await rpc('panel.post', { from: 'agent', text: answer });
    const view = (await rpc('panel.state', {})).view || {};
    if (!view.pageContext) throw new Error('follow-up dropped page context');
    if (!view.chip) throw new Error('chip missing after follow-up');
    if (!(view.messages || []).some((m) => m.text === answer)) throw new Error('follow-up answer not in the log');
    return { tab, title: ctxp.title, phrase, view };
  };

  // Primary site
  const t0 = performance.now();
  try {
    const firstId = panelIds[0] || 'local-login-password';
    const first = await runPanelOn(firstId);
    const refreshed = await rpc('pageContext.pull', { tab: first.tab });
    if (!refreshed.chip?.title) throw new Error('refresh did not keep a chip');
    const cleared = await rpc('panel.clearContext', {});
    if (cleared.pageContext || cleared.chip) throw new Error('remove did not clear the chip');
    panelResults.push({ id: 'panel-flow-' + firstId, status: 'pass', ms: Math.round(performance.now() - t0) });
    console.error(`PASS    panel panel-flow-${firstId} ${Math.round(performance.now() - t0)}ms`);
  } catch (e) {
    const status = e instanceof Blocked ? 'blocked' : 'fail';
    panelResults.push({ id: 'panel-flow-primary', status, error: errText(e).slice(0, 400), ms: Math.round(performance.now() - t0) });
    console.error(`${status.toUpperCase().padEnd(7)} panel panel-flow-primary :: ${errText(e).slice(0, 300)}`);
  }

  // Tab switch: two tabs, context must follow the pull of the second tab
  const t1 = performance.now();
  try {
    const aId = panelIds[0] || 'local-login-password';
    const bId = panelIds[1] || 'local-shadow';
    const a = await runPanelOn(aId);
    const tabA = a.tab;
    const tabB = (await rpc('tabs.new', { source: SOURCE === 'extension' ? 'extension' : 'headless' })).tab;
    tab = tabB;
    const bCase = byId[bId];
    await rpc('run', { tab: tabB, steps: [{ action: 'navigate', url: bCase.url, timeout: 25000 }, { action: 'wait', for: 'load', timeout: 15000, optional: true }], snapshot: 'none' });
    const b = await runPanelOn(bId, tabB);
    const view = (await rpc('panel.state', {})).view || {};
    if (!view.pageContext) throw new Error('no context after second tab pull');
    if (view.pageContext.url && bCase.url) {
      const got = new URL(view.pageContext.url).hostname;
      const want = new URL(bCase.url).hostname;
      if (got !== want) throw new Error(`context did not switch to tab B (still ${view.pageContext.url})`);
    }
    await rpc('panel.clearContext', {});
    await relay.router.closeTab(tabA).catch(() => {});
    panelResults.push({ id: 'panel-tab-switch', status: 'pass', ms: Math.round(performance.now() - t1) });
    console.error(`PASS    panel panel-tab-switch ${Math.round(performance.now() - t1)}ms`);
  } catch (e) {
    const status = e instanceof Blocked ? 'blocked' : 'fail';
    panelResults.push({ id: 'panel-tab-switch', status, error: errText(e).slice(0, 400), ms: Math.round(performance.now() - t1) });
    console.error(`${status.toUpperCase().padEnd(7)} panel panel-tab-switch :: ${errText(e).slice(0, 300)}`);
  }

  // Remaining panel sites (blurb + follow-up only)
  for (const id of panelIds.slice(1)) {
    const t2 = performance.now();
    try {
      await runPanelOn(id);
      await rpc('panel.clearContext', {});
      panelResults.push({ id: 'panel-flow-' + id, status: 'pass', ms: Math.round(performance.now() - t2) });
      console.error(`PASS    panel panel-flow-${id} ${Math.round(performance.now() - t2)}ms`);
    } catch (e) {
      const status = e instanceof Blocked ? 'blocked' : 'fail';
      panelResults.push({ id: 'panel-flow-' + id, status, error: errText(e).slice(0, 400), ms: Math.round(performance.now() - t2) });
      console.error(`${status.toUpperCase().padEnd(7)} panel panel-flow-${id} :: ${errText(e).slice(0, 300)}`);
    }
  }
}


// Opt-in live LLM blurb + follow-up on diverse sites (skipped unless --live-llm 1).
const llmResults = [];
if (LIVE_LLM && (!ONLY || ONLY.includes('live-llm'))) {
  if (!llmAvailable()) {
    llmResults.push({ id: 'live-llm-config', status: 'fail', error: 'no Gemini or OpenRouter key configured' });
    console.error('FAIL    llm   live-llm-config :: no Gemini or OpenRouter key configured');
  } else {
    const src = llmSource();
    console.error('INFO    llm   using ' + src.provider + ' via ' + src.source);
    const byId = Object.fromEntries(CASES.map((c) => [c.id, c]));
    for (const id of LLM_SITES) {
      const c = byId[id];
      if (!c) continue;
      if ((c.kind === 'live' && !LIVE) || (c.kind === 'local' && !LOCAL)) continue;
      const t0 = performance.now();
      try {
        await ensureTab();
        if (c.kind === 'live') {
          const host = new URL(c.url).host;
          const wait = 1500 - (Date.now() - (lastHost.get(host) || 0));
          if (wait > 0) await sleep(wait);
          lastHost.set(host, Date.now());
        }
        await rpc('run', { tab, steps: [{ action: 'navigate', url: c.url, timeout: 25000 }, { action: 'wait', for: 'load', timeout: 15000, optional: true }], snapshot: 'none' });
        if (c.kind === 'live') await rpc('run', { tab, steps: [{ action: 'wait', ms: 800 }], snapshot: 'none' }).catch(() => {});
        const pulled = await rpc('pageContext.pull', { tab });
        const ctxp = pulled.pageContext;
        if (!ctxp) throw new Error('no page context for LLM');
        const title = ctxp.title || '';
        const text = ctxp.text || '';
        if (BOT_TITLE.test(title) || BOT.test(title) || BOT.test(text.slice(0, 800))) throw new Blocked('bot wall: ' + title);
        await rpc('panel.identify', { provider: 'suite', model: 'live-llm', chatName: 'Live LLM ' + id }).catch(() => {});
        const blurb = await llmComplete(blurbPrompt(ctxp));
        await rpc('panel.post', { from: 'agent', text: blurb.text });
        const tokens = (title + ' ' + (ctxp.headings || []).join(' ') + ' ' + text)
          .split(/[^A-Za-z0-9\u00C0-\u024F]+/)
          .filter((w) => w.length > 4);
        const distinctive = [...new Set(tokens)].slice(0, 12);
        const hit = distinctive.filter((w) => new RegExp(w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(blurb.text));
        if (hit.length < 1 && !new RegExp((title.split(/\s+/)[0] || 'page').replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(blurb.text)) {
          throw new Error('blurb did not describe the page: ' + JSON.stringify(blurb.text).slice(0, 240));
        }
        const question = 'What is this page about? Quote a short phrase from the page.';
        await rpc('panel.post', { from: 'user', text: question });
        const follow = await llmComplete(followUpPrompt(ctxp, blurb.text, question));
        await rpc('panel.post', { from: 'agent', text: follow.text });
        const quoted = distinctive.filter((w) => new RegExp(w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(follow.text));
        if (quoted.length < 1) throw new Error('follow-up did not use page content: ' + JSON.stringify(follow.text).slice(0, 240));
        llmResults.push({ id: 'live-llm-' + id, status: 'pass', ms: Math.round(performance.now() - t0), model: follow.model || blurb.model, provider: blurb.provider, blurbHits: hit.length, followHits: quoted.length });
        console.error(`PASS    llm   live-llm-${id} ${Math.round(performance.now() - t0)}ms model=${blurb.provider}/${blurb.model}`);
      } catch (e) {
        const status = e instanceof Blocked ? 'blocked' : 'fail';
        llmResults.push({ id: 'live-llm-' + id, status, error: errText(e).slice(0, 400), ms: Math.round(performance.now() - t0) });
        console.error(`${status.toUpperCase().padEnd(7)} llm   live-llm-${id} :: ${errText(e).slice(0, 300)}`);
      }
    }
  }
}

const times = results.filter((r) => r.status === 'pass').map((r) => r.ms).sort((a, b) => a - b);
const median = times.length ? times[Math.floor(times.length / 2)] : null;
const sum = (arr, k) => arr.filter((r) => r.status === k).length;
const summary = {
  total: results.length,
  pass: sum(results, 'pass'),
  fail: sum(results, 'fail'),
  blocked: sum(results, 'blocked'),
  panel: { total: panelResults.length, pass: sum(panelResults, 'pass'), fail: sum(panelResults, 'fail'), blocked: sum(panelResults, 'blocked'), results: panelResults },
  liveLlm: { enabled: LIVE_LLM, total: llmResults.length, pass: sum(llmResults, 'pass'), fail: sum(llmResults, 'fail'), blocked: sum(llmResults, 'blocked'), source: LIVE_LLM ? (llmSource() && { provider: llmSource().provider, source: llmSource().source }) : null, results: llmResults },
  medianMs: median,
  source: SOURCE,
  at: new Date().toISOString(),
};
console.error(JSON.stringify(summary));
if (opt('out')) writeFileSync(opt('out'), JSON.stringify({ summary, results, panelResults, llmResults }, null, 2));

if (browser) await browser.close();
await relay.stop();
await fx.close();
process.exit(0);
