import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HELPER_SRC, HELPER_VERSION } from '../src/helper.mjs';

test('injected helper version matches HELPER_VERSION so the fast path can hit', () => {
  assert.equal(typeof HELPER_VERSION, 'number');
  assert.match(HELPER_SRC, new RegExp(`window\\.__lbd\\.v === ${HELPER_VERSION}`));
  assert.match(HELPER_SRC, new RegExp(`v: ${HELPER_VERSION}`));
  assert.equal(HELPER_SRC.includes(`v: 6}`) || /v: 6,/.test(HELPER_SRC) && HELPER_VERSION !== 6, false);
});
