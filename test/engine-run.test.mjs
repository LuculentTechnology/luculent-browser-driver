import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../src/engine.mjs';

test('guard denials abort the batch and are not reported as optional success', async () => {
  const engine = new Engine({
    send: async () => ({}),
    isHeadless: () => true,
  });
  const denied = Object.assign(new Error('Blocked by your Luculent security settings: no'), { denied: true });
  const r = await engine.run('h0:1', [
    { action: 'extract', target: 'h1', optional: true },
    { action: 'extract', target: 'h2' },
  ], { guard: async () => { throw denied; } });
  assert.equal(r.ok, false);
  assert.equal(r.results.length, 1);
  assert.equal(r.results[0].ok, false);
  assert.equal(r.results[0].denied, true);
});
