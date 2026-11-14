import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const sw = readFileSync(join(root, 'extension', 'sw.js'), 'utf8');
const manifest = JSON.parse(readFileSync(join(root, 'extension', 'manifest.json'), 'utf8'));
const relay = readFileSync(join(root, 'src', 'relay.mjs'), 'utf8');

test('BD20 persistence: grants restore, auto-reattach, attach-refused fallback, sticky origins', () => {
  assert.match(sw, /restoreStickyGrants/);
  assert.match(sw, /stickyGrants|grantedOrigins|restoreSticky/);
  assert.match(sw, /chrome\.debugger\.onDetach/);
  assert.match(sw, /reattach|ensureAttached/);
  assert.match(sw, /attachFailed|attach refused|Attach refused|password-manager|pageEval/);
  assert.match(sw, /chrome\.storage\.local/);
  assert.match(relay, /tabClosed/);
});

test('BD24 named tab groups and multi-profile hello fields', () => {
  assert.ok(manifest.permissions.includes('tabGroups'));
  assert.match(sw, /chrome\.tabGroups/);
  assert.match(sw, /profileId|profileName/);
  assert.match(relay, /profiles\.list|listProfiles|profileId/);
});

test('BD25 no focus steal by default and no always-on all-tab content scripts', () => {
  assert.match(sw, /stealFocus/);
  assert.match(relay, /stealFocus/);
  assert.ok(!manifest.content_scripts, 'idle CPU: no always-injected content_scripts');
  const km = sw.match(/setInterval\([^,]+,\s*(\d+)\)/);
  if (km) assert.ok(Number(km[1]) >= 20000, 'ping interval must be >= 20s, got ' + km[1]);
});

test('side panel, page context, and chat-purge wiring exist in the extension', () => {
  assert.ok(manifest.permissions.includes('sidePanel'));
  assert.equal(manifest.side_panel.default_path, 'panel.html');
  assert.match(sw, /async function pullPageContext/);
  assert.match(sw, /function panelCall/);
  assert.match(sw, /extract\.js/);
  assert.match(sw, /chat-purge|chats\.purge/);
});
