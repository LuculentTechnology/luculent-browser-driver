// Planner rework: locator cache, same-tab reuse, overlay/settings, helper cursor APIs (LUC-3085).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LocatorCache, siteKey, hintKey } from '../src/locators.mjs';
import { resolveExistingTab } from '../src/relay.mjs';
import { HELPER_VERSION, HELPER_SRC } from '../src/helper.mjs';
import { DEFAULTS } from '../extension/settings.js';

const ext = dirname(fileURLToPath(new URL('../extension/settings.js', import.meta.url)));

test('LocatorCache remembers a resolved target per site and reloads from disk', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lbd-loc-'));
  const path = join(dir, 'locators.json');
  const a = new LocatorCache(path);
  const url = 'https://github.com/dProFoSho/luculent/actions';
  assert.equal(a.get(url, 'text=Actions'), null);
  a.put(url, 'text=Actions', 'css=#actions-tab');
  assert.equal(a.get(url, 'text=Actions'), 'css=#actions-tab');
  a.persist();
  const b = new LocatorCache(path);
  assert.equal(b.get(url, 'text=Actions'), 'css=#actions-tab');
  assert.ok(siteKey(url).includes('github.com'));
  assert.ok(hintKey({ role: 'button', name: 'Run workflow' }).includes('button'));
});

test('resolveExistingTab reuses the last tab, then a tab in the same group', () => {
  const tabs = [
    { tab: '11', url: 'https://github.com/a', groupId: 7 },
    { tab: '22', url: 'https://github.com/b', groupId: 8 },
  ];
  assert.equal(resolveExistingTab({ lastTab: '11', groupId: 8 }, tabs).tab, '11');
  assert.equal(resolveExistingTab({ lastTab: '99', groupId: 8 }, tabs).tab, '22');
  assert.equal(resolveExistingTab({ lastTab: '99', groupId: 1 }, tabs), null);
  assert.equal(resolveExistingTab(null, tabs), null);
  assert.equal(resolveExistingTab({ lastTab: '11' }, [{ tab: '11', granted: false, groupId: 7 }]), null);
});

test('settings default to an on AI cursor, Cowork click mode and an off input block', () => {
  assert.equal(DEFAULTS.aiCursor, true);
  assert.equal(DEFAULTS.disableWindow, false);
  assert.equal(DEFAULTS.clickMode, 'cowork');
  const opt = readFileSync(join(ext, 'options.html'), 'utf8');
  assert.match(opt, /data-k="aiCursor"/);
  assert.match(opt, /data-k="clickMode"/);
  assert.match(opt, /When you click in the AI's tab/);
  assert.match(opt, /value="disable">Disable window</);
  assert.match(opt, /While an agent is working/);
  const overlay = readFileSync(join(ext, 'overlay.js'), 'utf8');
  assert.match(overlay, /Luculent is working in this tab/);
  assert.match(overlay, /Take back control/);
  assert.match(overlay, /pointer-events:none/);
  const man = JSON.parse(readFileSync(join(ext, 'manifest.json'), 'utf8'));
  assert.ok(!man.content_scripts, 'no always-on content_scripts (inject overlay on driveStart only)');
  const sw = readFileSync(join(ext, 'sw.js'), 'utf8');
  assert.match(sw, /case 'driveStart'/);
  assert.match(sw, /case 'driveEnd'/);
  assert.match(sw, /case 'warm'/);
  assert.match(sw, /overlay\.takeBack/);
  assert.match(sw, /executeScript\(\{ target: \{ tabId \}, files: \['overlay\.js'\](, injectImmediately: true)? \}/);
  const panel = readFileSync(join(ext, 'panel.html'), 'utf8');
  assert.match(panel, /id="clickMode"/);
  assert.match(panel, /<option value="cowork">Cowork<\/option>/);
  assert.match(panel, /<option value="pause">Pause<\/option>/);
});

test('helper v11+ exposes exists and a non-intercepting AI cursor', () => {
  assert.ok(HELPER_VERSION >= 11);
  assert.match(HELPER_SRC, /const exists = \(target\)/);
  assert.match(HELPER_SRC, /const moveCursor = /);
  assert.match(HELPER_SRC, /const hideCursor = /);
  assert.match(HELPER_SRC, /pointer-events:\s*none/);
});
