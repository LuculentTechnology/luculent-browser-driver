import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FlowStore, sanitizeStep } from '../src/flows.mjs';

test('recorded steps redact secrets and password fields', () => {
  const s = sanitizeStep({ action: 'type', target: 'password', text: 'hunter2' });
  assert.equal(s.text, '[redacted]');
  const s2 = sanitizeStep({ action: 'type', target: 'email', text: 'password=hunter2' });
  assert.doesNotMatch(s2.text, /hunter2/);
});

test('record and replay a flow with no model calls; failure returns needsModel', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lbd-flows-'));
  const store = new FlowStore(dir, { now: () => 100 });
  store.start('signup');
  store.record({ action: 'navigate', url: 'https://example.com/form' });
  store.record({ action: 'fill', target: 'e1', text: 'Ada' });
  store.record({ action: 'click', target: 'e2' });
  const saved = store.stop();
  assert.equal(saved.name, 'signup');
  assert.equal(store.list().length, 1);
  const ran = [];
  const ok = await store.replay('signup', async (step, i) => { ran.push(i + ':' + step.action); return { i }; });
  assert.equal(ok.ok, true);
  assert.equal(ok.needsModel, false);
  assert.deepEqual(ran, ['0:navigate', '1:fill', '2:click']);
  const fail = await store.replay('signup', async (step, i) => {
    if (i === 1) throw new Error('element e1 not found');
    return {};
  }, { snapshot: async () => ({ text: 'page' }) });
  assert.equal(fail.ok, false);
  assert.equal(fail.needsModel, true);
  assert.equal(fail.failedStep, 1);
  assert.equal(fail.step.action, 'fill');
  assert.match(fail.error, /e1 not found/);
  assert.equal(fail.snapshot.text, 'page');
  assert.equal(fail.results.length, 1);
});
