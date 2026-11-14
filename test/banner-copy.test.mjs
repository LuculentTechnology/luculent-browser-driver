import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BANNER_Q, BANNER_TEXT } from '../src/banner-copy.mjs';
import { BANNER_Q as Q2, BANNER_TEXT as T2 } from '../extension/banner.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const files = ['README.md', 'QUICKSTART.md', 'store/LISTING.md', 'extension/popup.html', 'extension/options.html'];

test('banner copy is the same in the extension and src, and appears in the FAQ, listing, popup and options', () => {
  assert.equal(BANNER_Q, 'What is this banner?');
  assert.equal(Q2, BANNER_Q);
  assert.equal(T2, BANNER_TEXT);
  assert.match(BANNER_TEXT, /cannot be hidden/i);
  assert.match(BANNER_TEXT, /not that your computer is being hacked/i);
  assert.match(BANNER_TEXT, /killswitch/i);
  assert.match(BANNER_TEXT, /Cancel on the banner/);
  for (const f of files) {
    const t = readFileSync(join(root, f), 'utf8');
    assert.match(t, /What is this banner/, f);
    if (f.endsWith('.md') || f.endsWith('options.html')) {
      assert.match(t, /cannot be hidden/, f);
      assert.match(t, /not that your computer is being hacked/, f);
    }
  }
  const popup = readFileSync(join(root, 'extension/popup.html'), 'utf8');
  assert.match(popup, /id="bannerHelp"/);
});
