// Broad real-world suite: scripted direct tests through the relay API against live public sites (read-only:
// no logins, no posting, no purchases, one page load per case, >=1.5 s between requests to the same host) and
// local fixtures for risky flows. Records pass/fail per case.
// Usage: node harness/broad.mjs [--only id1,id2] [--live 0|1] [--local 0|1] [--source headless|extension] [--out file.json]
import { mkdtempSync, writeFileSync, cpSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Relay } from '../src/relay.mjs';
import { KeyStore } from '../src/keys.mjs';
import { HeadlessBrowser, findPlaywrightChromium } from '../src/headless.mjs';
import { startBroadFixtures } from '../test/fixtures-broad.mjs';
import { OPEN_POLICY } from '../src/policy.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : d; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ONLY = opt('only') ? opt('only').split(',') : null;
const LIVE = opt('live', '1') !== '0', LOCAL = opt('local', '1') !== '0';
const SOURCE = opt('source', 'headless');

const CASES = [];
const add = (id, cat, kind, fn, url) => CASES.push({ id, cat, kind, fn, url });
class Blocked extends Error {}
// Pages sites serve to automated/unknown browsers instead of content (bot walls without a captcha keyword).
const BOT_TITLE = /^Error Page \| eBay|^Sorry! Something went wrong|^Welcome to Reddit|^Access to this page has been denied|^Robot Check/i;
const BOT = /captcha|unusual traffic|are you a robot|verify you are human|access denied|request blocked|robot check|just a moment|attention required|enable javascript and cookies|pardon our interruption|been blocked|type the characters|sorry, we just need to make sure|blocked by network security/i;

// ---------- local fixtures (risky / hard flows) ----------
add('iframe-same', 'iframes', 'local', async (t) => { const r = await t.run([{ action: 'navigate', url: t.a + '/iframes' }, { action: 'type', frame: '#same', target: 'label=Frame input', text: 'one' }, { action: 'click', frame: '#same', target: 'text=Frame button' }, { action: 'extract', frame: '#same', target: '#fo' }]); t.eq(t.last(r), 'frame clicked one'); });
add('iframe-cross-origin', 'iframes', 'local', async (t) => { const r = await t.run([{ action: 'navigate', url: t.a + '/iframes' }, { action: 'type', frame: '#cross', target: 'label=Frame input', text: 'two' }, { action: 'click', frame: '#cross', target: 'text=Frame button' }, { action: 'extract', frame: '#cross', target: '#fo' }]); t.eq(t.last(r), 'frame clicked two'); });
add('contenteditable', 'editors', 'local', async (t) => { const r = await t.run([{ action: 'navigate', url: t.a + '/editor' }, { action: 'type', target: 'label=Rich editor', text: 'Hello ' }, { action: 'press', key: 'Control+b' }, { action: 'type', target: 'label=Rich editor', text: 'bold', clear: false }, { action: 'extract', target: '#html' }]); t.ok(/Hello/.test(t.last(r)) && /<b>bold<\/b>/.test(t.last(r)), t.last(r)); });
add('html5-drag', 'drag', 'local', async (t) => { const r = await t.run([{ action: 'navigate', url: t.a + '/dnd' }, { action: 'drag', target: '#src', to: '#dst' }, { action: 'extract', target: '#dst' }]); t.eq(t.last(r), 'Dropped src'); });
add('mouse-drag-slider', 'drag', 'local', async (t) => { const r = await t.run([{ action: 'navigate', url: t.a + '/dnd' }, { action: 'drag', target: '#knob', dx: 150 }, { action: 'extract', target: '#kv' }]); t.ok(Number(t.last(r)) >= 120, t.last(r)); });
add('hover-menu', 'hover', 'local', async (t) => { const r = await t.run([{ action: 'navigate', url: t.a + '/hover' }, { action: 'hover', target: 'text=Products' }, { action: 'click', target: 'text=Laptops', waitNav: true }, { action: 'extract', target: 'h1' }]); t.eq(t.last(r), 'Item hovered'); });
add('date-native', 'datepicker', 'local', async (t) => { const r = await t.run([{ action: 'navigate', url: t.a + '/date' }, { action: 'fill', target: '#native', text: '2026-12-24' }, { action: 'extract', target: '#out' }]); t.eq(t.last(r), 'native 2026-12-24'); });
add('date-custom', 'datepicker', 'local', async (t) => { const r = await t.run([{ action: 'navigate', url: t.a + '/date' }, { action: 'click', target: 'label=Custom' }, { action: 'click', target: 'role=gridcell[name="15"]' }, { action: 'extract', target: '#out' }]); t.eq(t.last(r), 'picked 2026-11-15'); });
add('combobox', 'select', 'local', async (t) => { const r = await t.run([{ action: 'navigate', url: t.a + '/combo' }, { action: 'type', target: 'role=combobox[name=Country]', text: 'Ch' }, { action: 'click', target: 'role=option[name=Chile]' }, { action: 'extract', target: '#out' }]); t.eq(t.last(r), 'chose Chile'); });
add('cookie-banner-modal', 'modals', 'local', async (t) => { const r = await t.run([{ action: 'navigate', url: t.a + '/modal' }, { action: 'click', target: 'text=Accept all' }, { action: 'click', target: 'text=Open dialog' }, { action: 'click', target: 'text=Yes' }, { action: 'extract', target: '#out' }]); t.eq(t.last(r), 'confirmed'); });
add('covered-click-warns', 'modals', 'local', async (t) => { const r = await t.run([{ action: 'navigate', url: t.a + '/modal' }, { action: 'click', target: 'text=Open dialog', timeout: 1500 }], { allowFail: true }); const c = r.results[1]; t.ok(!c.ok || (c.value && c.value.warning), 'click under the cookie overlay must fail or warn: ' + JSON.stringify(c)); });
add('window-open-popup', 'tabs', 'local', async (t) => { const r = await t.run([{ action: 'navigate', url: t.a + '/popup' }, { action: 'click', target: 'text=Open window', expectPopup: true }]); const pt = r.results[1].value && r.results[1].value.popup; t.ok(pt, 'popup tab id: ' + JSON.stringify(r.results[1])); const r2 = await t.run([{ action: 'wait', text: 'Item popup' }, { action: 'extract', target: 'h1' }], { tab: pt }); t.eq(t.last(r2), 'Item popup'); await t.rpc('tabs.close', { tab: pt }); });
add('target-blank-link', 'tabs', 'local', async (t) => { const r = await t.run([{ action: 'navigate', url: t.a + '/popup' }, { action: 'click', target: 'text=New tab link', expectPopup: true }]); const pt = r.results[1].value && r.results[1].value.popup; t.ok(pt, JSON.stringify(r.results[1])); const r2 = await t.run([{ action: 'wait', text: 'Item blank' }], { tab: pt }); t.ok(r2.ok); await t.rpc('tabs.close', { tab: pt }); });
add('multi-tab-parallel', 'tabs', 'local', async (t) => { const r = await t.rpc('runParallel', { source: t.source, jobs: [1, 2, 3, 4].map((i) => ({ steps: [{ action: 'navigate', url: `${t.a}/item/p${i}` }, { action: 'extract', target: 'h1' }] })) }); t.ok(r.ok, JSON.stringify(r)); for (const x of r.results) await t.rpc('tabs.close', { tab: x.tab }).catch(() => {}); });
add('auth-form-local', 'auth', 'local', async (t) => { const r = await t.run([{ action: 'navigate', url: t.a + '/login' }, { action: 'type', target: 'label=Username', text: 'tester' }, { action: 'type', target: 'label=Password', text: 'not-a-real-pass' }, { action: 'click', target: 'text=Sign in', waitNav: true }, { action: 'extract', target: 'h1' }]); t.eq(t.last(r), 'Welcome tester'); });
add('slow-form-submit-2.6s', 'navigation', 'local', async (t) => { const r = await t.run([{ action: 'navigate', url: t.a + '/slow-form' }, { action: 'type', target: 'label=Query', text: 'zzz' }, { action: 'click', target: 'text=Send', waitNav: true }, { action: 'extract', target: 'h1', wait: false }]); t.eq(t.last(r), 'Slow done zzz'); });
add('slow-link-3s', 'navigation', 'local', async (t) => { const r = await t.run([{ action: 'navigate', url: t.a + '/slow-form' }, { action: 'click', target: 'text=Slow link', waitNav: true }, { action: 'extract', target: 'h1', wait: false }]); t.eq(t.last(r), 'Slow done link'); });
add('slow-enter-submit', 'navigation', 'local', async (t) => { const r = await t.run([{ action: 'navigate', url: t.a + '/slow-form' }, { action: 'type', target: 'label=Query', text: 'ent', submit: true, waitNav: true }, { action: 'extract', target: 'h1', wait: false }]); t.eq(t.last(r), 'Slow done ent'); });
add('lazy-element-1.8s', 'navigation', 'local', async (t) => { const r = await t.run([{ action: 'navigate', url: t.a + '/lazy' }, { action: 'click', target: 'text=Late button' }, { action: 'extract', target: '#res' }]); t.eq(t.last(r), 'late clicked'); });
add('canvas-xy-click', 'canvas', 'local', async (t) => { const r = await t.run([{ action: 'navigate', url: t.a + '/canvas' }, { action: 'click', target: '#cv', offsetX: 50, offsetY: 40 }, { action: 'extract', target: '#out' }]); t.ok(/^hit (49|50|51),(39|40|41)$/.test(t.last(r)), t.last(r)); });
add('canvas-wheel', 'canvas', 'local', async (t) => { const r = await t.run([{ action: 'navigate', url: t.a + '/canvas' }, { action: 'wheel', target: '#cv', dy: 300 }, { action: 'extract', target: '#out' }]); t.eq(t.last(r), 'wheel down'); });
add('video-play-pause', 'video', 'local', async (t) => { const r = await t.run([{ action: 'navigate', url: t.a + '/video' }, { action: 'click', target: 'text=Play' }, { action: 'wait', ms: 600 }, { action: 'click', target: 'text=Pause' }, { action: 'media', target: '#v' }]); const v = t.last(r); t.ok(v && v.currentTime > 0.2 && v.paused === true, JSON.stringify(v)); });
add('keyboard-shortcuts', 'keyboard', 'local', async (t) => { const r = await t.run([{ action: 'navigate', url: t.a + '/keys' }, { action: 'press', key: 'Control+k' }, { action: 'wait', target: 'role=dialog', state: 'visible' }, { action: 'press', key: 'Escape' }, { action: 'wait', target: 'role=dialog', state: 'hidden' }, { action: 'press', key: 'F2' }, { action: 'extract', target: '#last' }]); t.eq(t.last(r), 'F2'); });
add('long-table-extract', 'tables', 'local', async (t) => { const r = await t.run([{ action: 'navigate', url: t.a + '/table' }, { action: 'extract', target: 'tr:nth-child(1234) td:nth-child(3)' }, { action: 'table', target: '#t', max: 5 }]); t.eq(r.results[1].value, '$1542.50'); const tb = t.last(r); t.ok(tb && tb.headers && tb.headers[1] === 'Name' && tb.rows.length === 5 && tb.total === 1500, JSON.stringify(tb).slice(0, 200)); });
add('long-page-scroll-end', 'tables', 'local', async (t) => { const r = await t.run([{ action: 'navigate', url: t.a + '/table' }, { action: 'scroll', target: '#end' }, { action: 'snapshot', viewport: true }]); t.ok(t.last(r).lines.some((l) => l.includes('End of table')), 'viewport snapshot should show the footer'); });
add('infinite-scroll', 'scroll', 'local', async (t) => { const r = await t.run([{ action: 'navigate', url: t.a + '/infinite' }, { action: 'scroll', dy: 5000 }, { action: 'wait', text: 'Post 40' }, { action: 'scroll', dy: 5000 }, { action: 'wait', text: 'Post 60' }, { action: 'extract', target: '.post', all: true, max: 500 }]); t.ok(t.last(r).length >= 60, String(t.last(r).length)); });
add('form-validation', 'forms', 'local', async (t) => { const r = await t.run([{ action: 'navigate', url: t.a + '/validate' }, { action: 'type', target: 'label=Email', text: 'nope' }, { action: 'click', target: 'text=Register', waitNav: true }, { action: 'extract', target: '.err', all: true }]); t.ok(r.results[2].value.navigated === false && t.last(r).length === 2, JSON.stringify(r.results.slice(2))); const r2 = await t.run([{ action: 'type', target: 'label=Email', text: 'a@b.co' }, { action: 'type', target: 'label=Age', text: '30' }, { action: 'click', target: 'text=Register', waitNav: true }, { action: 'extract', target: 'h1' }]); t.eq(t.last(r2), 'Registered a@b.co'); });
add('file-download', 'files', 'local', async (t) => { const r = await t.run([{ action: 'navigate', url: t.a + '/download' }, { action: 'click', target: 'text=Get CSV' }, { action: 'downloads', op: 'wait', timeout: 8000 }]); t.ok(/lbd-test.*\.csv$/.test(t.last(r).filename || ''), JSON.stringify(t.last(r))); });
add('file-upload', 'files', 'local', async (t) => { const r = await t.run([{ action: 'navigate', url: t.a + '/download' }, { action: 'eval', js: "document.body.insertAdjacentHTML('beforeend','<input type=file id=up><p id=upn></p>');document.getElementById('up').onchange=e=>document.getElementById('upn').textContent=e.target.files[0].name;1" }, { action: 'upload', target: '#up', files: [t.uploadFile] }, { action: 'extract', target: '#upn' }]); t.eq(t.last(r), 'broad-upload.txt'); });
add('pdf-open', 'pdf', 'local', async (t) => { const r = await t.run([{ action: 'navigate', url: t.a + '/doc.pdf', timeout: 8000 }, { action: 'pdf' }]); t.ok(/LBD fixture PDF/.test(t.last(r).text || ''), JSON.stringify(t.last(r)).slice(0, 200)); });
add('geolocation-permission', 'permissions', 'local', async (t) => { const r = await t.run([{ action: 'navigate', url: t.a + '/geo' }, { action: 'geolocation', latitude: 47.6062, longitude: -122.3321 }, { action: 'click', target: 'text=Locate me' }, { action: 'wait', js: "/^(at|geo)/.test(document.querySelector('#out').textContent)", timeout: 6000 }, { action: 'extract', target: '#out' }]); t.eq(t.last(r), 'at 47.606,-122.332'); });
add('spa-pushstate-nav', 'spa', 'local', async (t) => { const r = await t.run([{ action: 'navigate', url: t.a + '/spa/home' }, { action: 'click', target: 'text=About', waitNav: true }, { action: 'extract', target: 'h1' }]); t.eq(t.last(r), 'About view'); t.ok(/\/spa\/about$/.test(r.results[1].value.url || ''), JSON.stringify(r.results[1])); });
add('back-forward', 'history', 'local', async (t) => { const r = await t.run([{ action: 'navigate', url: t.a + '/item/one' }, { action: 'navigate', url: t.a + '/item/two' }, { action: 'back' }, { action: 'extract', target: 'h1' }, { action: 'forward' }, { action: 'extract', target: 'h1' }]); t.eq(r.results[3].value, 'Item one'); t.eq(t.last(r), 'Item two'); });
add('spa-back-forward', 'history', 'local', async (t) => { const r = await t.run([{ action: 'navigate', url: t.a + '/spa/home' }, { action: 'click', target: 'text=Contact', waitNav: true }, { action: 'back' }, { action: 'extract', target: 'h1' }]); t.eq(t.last(r), 'Home view'); });
add('js-dialogs', 'dialogs', 'local', async (t) => { const r = await t.run([{ action: 'navigate', url: t.a + '/dialogs' }, { action: 'click', target: 'text=Alert', timeout: 4000 }, { action: 'extract', target: '#out' }, { action: 'click', target: 'text=Confirm', timeout: 4000 }, { action: 'extract', target: '#out' }]); t.eq(r.results[2].value, 'after alert'); t.eq(t.last(r), 'confirm true'); });
add('nested-shadow', 'shadow-dom', 'local', async (t) => { const r = await t.run([{ action: 'navigate', url: t.a + '/shadow-deep' }, { action: 'type', target: 'label=Deep input', text: 'abc' }, { action: 'click', target: 'text=Deep go' }, { action: 'extract', target: '#deepo' }]); t.eq(t.last(r), 'deep abc'); });
add('right-click', 'mouse', 'local', async (t) => { const r = await t.run([{ action: 'navigate', url: t.a + '/context' }, { action: 'rightclick', target: 'text=Right click me' }, { action: 'extract', target: '#out' }]); t.eq(t.last(r), 'context menu'); });

// ---------- live public sites (read-only) ----------
const L = (id, cat, url, fn) => add(id, cat, 'live', async (t) => { const r = await t.run([{ action: 'navigate', url, timeout: 25000 }, { action: 'wait', for: 'load', timeout: 15000, optional: true }], { allowFail: true }); const title = await t.title(); if (BOT.test(title) || BOT.test(await t.bodyText(800))) throw new Blocked('bot wall: ' + title); if (!r.results[0].ok) throw new Error(r.results[0].error); return fn(t); }, url);
L('wikipedia-search', 'search+extract', 'https://en.wikipedia.org/wiki/Main_Page', async (t) => { const r = await t.run([{ action: 'type', target: 'input[name=search]', text: 'Ada Lovelace', submit: true, waitNav: true, timeout: 20000 }, { action: 'extract', target: 'h1' }]); t.ok(/Ada Lovelace/.test(t.last(r)), t.last(r)); });
L('wikipedia-table', 'tables', 'https://en.wikipedia.org/wiki/List_of_largest_cities', async (t) => { const r = await t.run([{ action: 'table', target: 'table.wikitable', max: 3 }]); t.ok(t.last(r).rows.length === 3 && t.last(r).total > 20, JSON.stringify(t.last(r)).slice(0, 200)); });
L('github-repo', 'search+extract', 'https://github.com/microsoft/playwright-mcp', async (t) => { const r = await t.run([{ action: 'extract', target: 'strong[itemprop=name] a, [itemprop=name] a' }, { action: 'wait', text: 'Playwright MCP', timeout: 15000 }]); t.ok(/playwright-mcp/i.test(r.results[0].value), JSON.stringify(r.results)); });
L('github-tree-spa', 'spa', 'https://github.com/microsoft/playwright-mcp', async (t) => { const r = await t.run([{ action: 'click', target: 'role=link[name="package.json"]', waitNav: true, timeout: 15000 }, { action: 'wait', url: 'package.json', timeout: 10000 }, { action: 'wait', text: '"name"', timeout: 15000 }]); t.ok(r.ok); });
L('mdn-search', 'spa', 'https://developer.mozilla.org/en-US/', async (t) => { const r = await t.run([{ action: 'click', target: 'role=button[name=/search/i]', optional: true, timeout: 3000 }, { action: 'type', target: 'input[type=search], #hp-search-input, input[name=q]', text: 'fetch api', submit: true, waitNav: true, timeout: 20000 }, { action: 'wait', text: 'Fetch API', timeout: 15000 }, { action: 'extract', target: 'a[href*="/docs/Web/API/Fetch"]', all: true, max: 5 }]); t.ok(r.ok && t.last(r).length > 0, JSON.stringify(r.results.map((x) => x.error || 'ok'))); });
L('mdn-doc-extract', 'search+extract', 'https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API', async (t) => { const r = await t.run([{ action: 'extract', target: 'h1' }]); t.eq(t.last(r), 'Fetch API'); });
L('hn-front-new', 'navigation', 'https://news.ycombinator.com/', async (t) => { const r = await t.run([{ action: 'extract', target: '.titleline > a', all: true, max: 30 }, { action: 'click', target: 'text="new"', waitNav: true }, { action: 'extract', target: '.titleline > a', all: true, max: 5 }, { action: 'back' }, { action: 'wait', url: 'news.ycombinator.com', timeout: 8000 }]); t.ok(r.results[0].value.length >= 20 && r.results[2].value.length >= 3, JSON.stringify(r.results.map((x) => x.ok))); });
L('reddit-old', 'search+extract', 'https://old.reddit.com/r/programming/', async (t) => { const r = await t.run([{ action: 'extract', target: 'a.title', all: true, max: 10 }]); t.ok(t.last(r).length >= 5, JSON.stringify(t.last(r))); });
L('ebay-browse', 'e-commerce', 'https://www.ebay.com/sch/i.html?_nkw=usb+c+cable', async (t) => { const r = await t.run([{ action: 'extract', target: '.s-item__title, .s-card__title, [role=heading]', all: true, max: 10 }]); t.ok(t.last(r).length >= 3, JSON.stringify(t.last(r))); });
L('amazon-browse', 'e-commerce', 'https://www.amazon.com/s?k=usb+c+cable', async (t) => { const r = await t.run([{ action: 'extract', target: 'h2 span, [data-cy=title-recipe] span', all: true, max: 10 }]); t.ok(t.last(r).length >= 3, JSON.stringify(t.last(r))); });
L('google-maps', 'canvas', 'https://www.google.com/maps/search/coffee/@47.6062,-122.3321,14z', async (t) => { const r = await t.run([{ action: 'click', target: 'role=button[name=/Accept all|Reject all/]', optional: true, timeout: 1500 }, { action: 'wait', target: 'canvas', timeout: 20000 }, { action: 'wheel', target: 'canvas', dy: -300 }, { action: 'wait', target: '[role=feed] a[aria-label], a.hfpxzc', timeout: 20000 }, { action: 'extract', target: 'a.hfpxzc', what: 'attr', attr: 'aria-label', all: true, max: 5 }]); t.ok(t.last(r).length >= 1, JSON.stringify(r.results)); });
L('youtube-video', 'video', 'https://www.youtube.com/watch?v=jNQXAC9IVRw', async (t) => { const r = await t.run([{ action: 'click', target: 'role=button[name=/Accept all|Reject all/]', optional: true, timeout: 1500 }, { action: 'wait', target: 'video', state: 'attached', timeout: 20000 }, { action: 'media', target: 'video', op: 'play', muted: true }, { action: 'wait', ms: 1500 }, { action: 'media', target: 'video', op: 'pause' }]); t.ok(t.last(r).currentTime > 0.3, JSON.stringify(t.last(r))); });
L('codepen-editor-iframe', 'editors', 'https://codepen.io/pen/', async (t) => { const r = await t.run([{ action: 'wait', target: '#box-html .CodeMirror, #box-html .cm-content', timeout: 20000 }, { action: 'click', target: '#box-html .CodeMirror, #box-html .cm-content' }, { action: 'type', text: '<h1 id=lbd>lbd preview</h1>' }, { action: 'extract', target: '#box-html .CodeMirror, #box-html .cm-content' }, { action: 'extract', frame: 'iframe#result', target: 'body' }]); t.ok(/lbd preview/.test(r.results[3].value) && r.results[4].ok, JSON.stringify(r.results.map((x) => x.ok))); }); // code editor typing + cross-origin preview frame access (anonymous previews stay empty)
const TI = 'https://the-internet.herokuapp.com';
L('ti-hovers', 'hover', TI + '/hovers', async (t) => { const r = await t.run([{ action: 'hover', target: 'css=.figure:nth-of-type(2) img' }, { action: 'wait', text: 'name: user2' }]); t.ok(r.ok); });
L('ti-drag-drop', 'drag', TI + '/drag_and_drop', async (t) => { const r = await t.run([{ action: 'drag', target: '#column-a', to: '#column-b' }, { action: 'extract', target: '#column-a header' }]); t.eq(t.last(r), 'B'); });
L('ti-iframe-tinymce', 'iframes', TI + '/iframe', async (t) => { const r = await t.run([{ action: 'extract', frame: '#mce_0_ifr', target: 'body' }]); t.ok(/content/i.test(t.last(r)), t.last(r)); });
L('ti-nested-frames', 'iframes', TI + '/nested_frames', async (t) => { const r = await t.run([{ action: 'extract', frame: 'frame-bottom', target: 'body' }]); t.eq(t.last(r), 'BOTTOM'); });
L('ti-js-alerts', 'dialogs', TI + '/javascript_alerts', async (t) => { const r = await t.run([{ action: 'click', target: 'text=Click for JS Confirm', timeout: 4000 }, { action: 'extract', target: '#result' }]); t.eq(t.last(r), 'You clicked: Ok'); });
L('ti-dynamic-loading', 'navigation', TI + '/dynamic_loading/2', async (t) => { const r = await t.run([{ action: 'click', target: 'text=Start' }, { action: 'wait', text: 'Hello World!', timeout: 15000 }]); t.ok(r.ok); });
L('ti-infinite-scroll', 'scroll', TI + '/infinite_scroll', async (t) => { const r = await t.run([{ action: 'scroll', dy: 4000 }, { action: 'wait', ms: 1500 }, { action: 'scroll', dy: 4000 }, { action: 'wait', ms: 1500 }, { action: 'scroll', dy: 4000 }, { action: 'wait', ms: 1500 }, { action: 'extract', target: '.jscroll-added', all: true }]); t.ok(t.last(r).length >= 3, String(t.last(r).length)); });
L('ti-shadowdom', 'shadow-dom', TI + '/shadowdom', async (t) => { const r = await t.run([{ action: 'extract', target: 'text=Let\'s have some different text!' }]); t.ok(/different text/.test(t.last(r)), t.last(r)); });
L('ti-context-menu', 'mouse', TI + '/context_menu', async (t) => { const r = await t.run([{ action: 'rightclick', target: '#hot-spot', timeout: 4000 }]); t.ok(r.ok && (r.results[0].value.dialogs || []).some((d) => /context menu/i.test(d.message)), JSON.stringify(r.results[0])); });
L('ti-key-presses', 'keyboard', TI + '/key_presses', async (t) => { const r = await t.run([{ action: 'press', target: '#target', key: 'Tab' }, { action: 'extract', target: '#result' }]); t.eq(t.last(r), 'You entered: TAB'); });
L('ti-tables', 'tables', TI + '/tables', async (t) => { const r = await t.run([{ action: 'table', target: '#table1' }]); t.ok(t.last(r).headers[0] === 'Last Name' && t.last(r).rows.length === 4, JSON.stringify(t.last(r)).slice(0, 200)); });
L('ti-windows', 'tabs', TI + '/windows', async (t) => { const r = await t.run([{ action: 'click', target: 'text=Click Here', expectPopup: true }]); const pt = r.results[0].value.popup; t.ok(pt); const r2 = await t.run([{ action: 'extract', target: 'h3' }], { tab: pt }); t.eq(t.last(r2), 'New Window'); await t.rpc('tabs.close', { tab: pt }); });
L('ti-dropdown', 'select', TI + '/dropdown', async (t) => { const r = await t.run([{ action: 'select', target: '#dropdown', value: 'Option 2' }]); t.eq(t.last(r).value, '2'); });
L('ti-checkboxes', 'forms', TI + '/checkboxes', async (t) => { const r = await t.run([{ action: 'check', target: 'css=#checkboxes input:nth-of-type(1)' }, { action: 'extract', target: 'css=#checkboxes input:nth-of-type(1)', what: 'info' }]); t.ok(r.results[0].value.checked === true); });
L('ti-entry-ad-modal', 'modals', TI + '/entry_ad', async (t) => { const r = await t.run([{ action: 'wait', target: '.modal', timeout: 6000 }, { action: 'click', target: 'text=Close' }, { action: 'wait', target: '.modal', state: 'hidden' }]); t.ok(r.ok); });
L('ti-slider', 'drag', TI + '/horizontal_slider', async (t) => { const r = await t.run([{ action: 'drag', target: 'input[type=range]', dx: 40 }, { action: 'extract', target: '#range' }]); t.ok(Number(t.last(r)) > 2.5, t.last(r)); });
L('ti-jqueryui-menu', 'hover', TI + '/jqueryui/menu', async (t) => { const r = await t.run([{ action: 'hover', target: 'text=Enabled' }, { action: 'hover', target: 'text=Downloads' }, { action: 'wait', text: 'PDF' }]); t.ok(r.ok); });
L('ti-geolocation', 'permissions', TI + '/geolocation', async (t) => { const r = await t.run([{ action: 'geolocation', latitude: 40.7128, longitude: -74.006 }, { action: 'click', target: 'text=Where am I?' }, { action: 'wait', target: '#lat-value', timeout: 8000 }, { action: 'extract', target: '#lat-value' }]); t.eq(t.last(r), '40.7128'); });
L('ti-large-dom', 'tables', TI + '/large', async (t) => { const r = await t.run([{ action: 'extract', target: '#large-table tr:nth-child(40) td:nth-child(40)' }]); t.eq(t.last(r), '40.40'); });
L('ti-upload', 'files', TI + '/upload', async (t) => { const r = await t.run([{ action: 'upload', target: '#file-upload', files: [t.uploadFile] }, { action: 'extract', target: '#file-upload', what: 'value' }]); t.ok(/broad-upload\.txt/.test(t.last(r)), t.last(r)); });
const DQ = 'https://demoqa.com';
L('demoqa-date-picker', 'datepicker', DQ + '/date-picker', async (t) => { const r = await t.run([{ action: 'click', target: '#datePickerMonthYearInput' }, { action: 'wait', target: '.react-datepicker' }, { action: 'click', target: '.react-datepicker__day--015:not(.react-datepicker__day--outside-month)' }, { action: 'extract', target: '#datePickerMonthYearInput', what: 'value' }]); t.ok(/\/15\//.test(t.last(r)), t.last(r)); });
L('demoqa-react-select', 'select', DQ + '/select-menu', async (t) => { const r = await t.run([{ action: 'click', target: '#withOptGroup' }, { action: 'click', target: 'text=Group 2, option 1' }, { action: 'extract', target: '#withOptGroup' }]); t.ok(/Group 2, option 1/.test(t.last(r)), t.last(r)); });
L('demoqa-droppable', 'drag', DQ + '/droppable', async (t) => { const r = await t.run([{ action: 'wait', idle: 800, timeout: 8000, optional: true }, { action: 'drag', target: '#draggable', to: '#simpleDropContainer #droppable' }, { action: 'extract', target: '#simpleDropContainer #droppable' }]); t.ok(/Dropped/.test(t.last(r)), t.last(r)); });
L('demoqa-modal', 'modals', DQ + '/modal-dialogs', async (t) => { const r = await t.run([{ action: 'click', target: '#showSmallModal' }, { action: 'wait', target: '.modal-content' }, { action: 'click', target: '#closeSmallModal' }, { action: 'wait', target: '.modal-content', state: 'hidden' }]); t.ok(r.ok); });
L('demoqa-text-box', 'forms', DQ + '/text-box', async (t) => { const r = await t.run([{ action: 'type', target: '#userName', text: 'Test User' }, { action: 'type', target: '#userEmail', text: 'test@example.com' }, { action: 'click', target: '#submit' }, { action: 'extract', target: '#output #name' }]); t.ok(/Test User/.test(t.last(r)), t.last(r)); });
L('demoqa-form-validation', 'forms', DQ + '/automation-practice-form', async (t) => { const r = await t.run([{ action: 'click', target: '#submit', js: true }, { action: 'eval', js: "document.querySelector('#userForm').classList.contains('was-validated')" }]); t.eq(t.last(r), true); });
const UP = 'http://uitestingplayground.com';
L('uitp-dynamicid', 'locators', UP + '/dynamicid', async (t) => { const r = await t.run([{ action: 'click', target: 'text=Button with Dynamic ID' }]); t.ok(r.ok); });
L('uitp-loaddelay', 'navigation', UP + '/', async (t) => { const r = await t.run([{ action: 'click', target: 'text=Load Delay', waitNav: true }, { action: 'click', target: 'text=Button Appearing After Delay', timeout: 15000 }]); t.ok(r.ok); });
L('uitp-ajax', 'navigation', UP + '/ajax', async (t) => { const r = await t.run([{ action: 'click', target: '#ajaxButton' }, { action: 'wait', target: '.bg-success', timeout: 25000 }, { action: 'extract', target: '.bg-success' }]); t.ok(/Data loaded/.test(t.last(r)), t.last(r)); });
L('uitp-clientdelay', 'navigation', UP + '/clientdelay', async (t) => { const r = await t.run([{ action: 'click', target: '#ajaxButton' }, { action: 'wait', target: '.bg-success', timeout: 25000 }]); t.ok(r.ok); });
L('uitp-textinput', 'forms', UP + '/textinput', async (t) => { const r = await t.run([{ action: 'type', target: '#newButtonName', text: 'LBD rocks' }, { action: 'click', target: '#updatingButton' }, { action: 'extract', target: '#updatingButton' }]); t.eq(t.last(r), 'LBD rocks'); });
L('uitp-scrollbars', 'scroll', UP + '/scrollbars', async (t) => { const r = await t.run([{ action: 'click', target: '#hidingButton' }]); t.ok(r.ok && !r.results[0].value.warning, JSON.stringify(r.results[0])); });
L('uitp-overlapped', 'forms', UP + '/overlapped', async (t) => { const r = await t.run([{ action: 'type', target: '#name', text: 'overlap-ok' }, { action: 'extract', target: '#name', what: 'value' }]); t.eq(t.last(r), 'overlap-ok'); });
L('uitp-hiddenlayers', 'modals', UP + '/hiddenlayers', async (t) => { const r = await t.run([{ action: 'click', target: '#greenButton' }, { action: 'click', target: '#greenButton', timeout: 1500 }], { allowFail: true }); const c = r.results[1]; t.ok(!c.ok || c.value.warning, 'second click must be refused or warned: ' + JSON.stringify(c)); });
L('uitp-shadowdom', 'shadow-dom', UP + '/shadowdom', async (t) => { const r = await t.run([{ action: 'click', target: '#buttonGenerate' }, { action: 'extract', target: '#editField', what: 'value' }]); t.ok(/-/.test(t.last(r)), t.last(r)); });
L('uitp-progressbar', 'navigation', UP + '/progressbar', async (t) => { const r = await t.run([{ action: 'click', target: '#startButton' }, { action: 'wait', js: "Number(document.querySelector('#progressBar').getAttribute('aria-valuenow'))>=75", timeout: 20000 }, { action: 'click', target: '#stopButton' }]); t.ok(r.ok, JSON.stringify(r.results)); });
L('uitp-nbsp', 'locators', UP + '/nbsp', async (t) => { const r = await t.run([{ action: 'click', target: 'text=My Button' }]); t.ok(r.ok); });
L('uitp-mouseover', 'hover', UP + '/mouseover', async (t) => { const r = await t.run([{ action: 'click', target: 'text=Click me' }, { action: 'click', target: 'text=Click me' }, { action: 'extract', target: '#clickCount' }]); t.eq(t.last(r), '2'); });
const todo = (id, url) => L(id, 'spa', url, async (t) => { const r = await t.run([{ action: 'type', target: '.new-todo, input.new-todo, #todo-input, [placeholder*="What needs" i]', text: 'alpha', submit: true }, { action: 'type', target: '.new-todo, input.new-todo, #todo-input, [placeholder*="What needs" i]', text: 'beta', submit: true }, { action: 'type', target: '.new-todo, input.new-todo, #todo-input, [placeholder*="What needs" i]', text: 'gamma', submit: true }, { action: 'check', target: '.todo-list app-todo-item:nth-child(2) .toggle, .todo-list > li:nth-child(2) .toggle' }, { action: 'click', target: 'role=link[name=Active]', waitNav: true }, { action: 'extract', target: '.todo-list li label', all: true }]); t.ok(t.last(r).length === 2 && !t.last(r).join(' ').includes('beta'), JSON.stringify(t.last(r))); });
todo('todomvc-react', 'https://demo.playwright.dev/todomvc/');
todo('todomvc-vue', 'https://todomvc.com/examples/vue/dist/');
todo('todomvc-angular', 'https://todomvc.com/examples/angular/dist/browser/');
L('pdf-live', 'pdf', 'https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf', async (t) => { const r = await t.run([{ action: 'pdf' }]); t.ok(/Dummy PDF/i.test(t.last(r).text || ''), JSON.stringify(t.last(r)).slice(0, 200)); });

// ---------- runner ----------
const uploadDir = mkdtempSync(join(tmpdir(), 'lbd-broad-'));
const uploadFile = join(uploadDir, 'broad-upload.txt');
writeFileSync(uploadFile, 'broad');
const fx = await startBroadFixtures();
const keys = new KeyStore(mkdtempSync(join(tmpdir(), 'lbd-broadk-')));
const relay = await new Relay({ port: 0, keys, log: () => {}, policy: { preset: 'open' } }).start();
const ctx = { admin: true, key: null, sid: 'broad' };
const rpc = (m, p) => relay.call(m, p, ctx);
let browser = null;
let tab;
if (SOURCE === 'extension') {
  const extDir = join(mkdtempSync(join(tmpdir(), 'lbd-bext-')), 'extension');
  cpSync(resolve(here, '..', 'extension'), extDir, { recursive: true });
  writeFileSync(join(extDir, 'config.json'), JSON.stringify({ relayUrl: `ws://127.0.0.1:${relay.port}/ext`, settings: { ...OPEN_POLICY, fileUrls: 'allow' } })); // test sites only: the safe defaults are covered by test/*security*.test.mjs
  browser = await HeadlessBrowser.launch({ chromePath: findPlaywrightChromium(), headless: true, extensionPath: extDir });
  for (let i = 0; i < 200 && !relay.router.ext; i++) await sleep(50);
  tab = (await rpc('tabs.list', {})).tabs.find((x) => x.source === 'extension').tab;
} else {
  tab = (await rpc('headless.launch', {})).tab;
}
const lastHost = new Map();
const results = [];
for (const c of CASES) {
  if (ONLY && !ONLY.includes(c.id)) continue;
  if ((c.kind === 'live' && !LIVE) || (c.kind === 'local' && !LOCAL)) continue;
  const t = {
    a: fx.a, b: fx.b, rpc, uploadFile, source: SOURCE,
    async run(steps, o = {}) { const r = await rpc('run', { tab: o.tab || tab, steps, snapshot: 'none', dialogs: 'accept' }); if (!r.ok && !o.allowFail) { const bad = r.results.find((x) => !x.ok); throw new Error(`step ${bad && bad.i} ${bad && bad.action}: ${bad && bad.error}`); } return r; },
    last: (r) => r.results.at(-1).value,
    eq(a, b) { if (a !== b) throw new Error(`expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); },
    ok(v, m) { if (!v) throw new Error('assert: ' + (m || '')); },
    async title() { try { const r = await rpc('run', { tab, steps: [{ action: 'eval', js: 'document.title' }] }); return String(r.results[0].value || ''); } catch (_) { return ''; } },
    async bodyText(n) { try { const r = await rpc('run', { tab, steps: [{ action: 'eval', js: `(document.body && document.body.innerText || '').slice(0, ${n})` }] }); return String(r.results[0].value || ''); } catch (_) { return ''; } },
  };
  if (c.kind === 'live') { const host = new URL(c.url).host; lastHost.set(host, Date.now() + 0); const wait = 1500 - (Date.now() - (lastHost.get(host) || 0)); if (wait > 0) await sleep(wait); }
  const prevTab = tab; try { tab = (await rpc('tabs.new', { source: SOURCE === 'extension' ? 'extension' : 'headless' })).tab; } catch (e) { console.error('tabs.new failed ' + e.message); }
  if (prevTab !== tab) relay.router.closeTab(prevTab).catch(() => {});
  const t0 = performance.now();
  let status = 'pass', error = null;
  try {
    await Promise.race([c.fn(t), sleep(60000).then(() => { throw new Error('case timeout 60s'); })]);
  } catch (e) { status = e instanceof Blocked ? 'blocked' : 'fail'; if (status === 'fail' && c.kind === 'live' && BOT_TITLE.test(await t.title().catch(() => ''))) status = 'blocked'; error = String(e.message).slice(0, 300); if (c.kind === 'live' && status === 'fail') error += ' [title: ' + (await t.title()).slice(0, 60) + ']'; }
  const ms = Math.round(performance.now() - t0);
  results.push({ id: c.id, cat: c.cat, kind: c.kind, status, ms, error });
  console.error(`${status.toUpperCase().padEnd(7)} ${c.kind.padEnd(5)} ${c.id} ${ms}ms${error ? ' :: ' + error : ''}`);
  // keep one working tab: close stray tabs, reset dialogs
  try { const { tabs } = await relay.router.tabs(); for (const x of tabs) if (x.tab !== tab && (SOURCE === 'extension' ? x.source === 'extension' : x.source !== 'extension')) await relay.router.closeTab(x.tab).catch(() => {}); } catch (_) {}
}
const sum = (k) => results.filter((r) => k(r)).length;
const summary = { total: results.length, pass: sum((r) => r.status === 'pass'), fail: sum((r) => r.status === 'fail'), blocked: sum((r) => r.status === 'blocked'), source: SOURCE, at: new Date().toISOString() };
console.error(JSON.stringify(summary));
if (opt('out')) writeFileSync(opt('out'), JSON.stringify({ summary, results }, null, 2));
if (browser) await browser.close();
await relay.stop();
await fx.close();
process.exit(0);