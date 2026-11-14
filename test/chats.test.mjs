import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChatStore, CLOSED_TTL_MS, redactSecrets } from '../src/chats.mjs';

const day = 24 * 60 * 60 * 1000;

test('redactSecrets strips password values and API tokens, leaves ordinary text', () => {
  assert.equal(redactSecrets('hello'), 'hello');
  assert.match(redactSecrets('password: hunter2'), /password: \[redacted\]/);
  assert.match(redactSecrets('Password=super-secret'), /\[redacted\]/);
  assert.doesNotMatch(redactSecrets('password: hunter2'), /hunter2/);
  const tok = 'lbd_Ab12Cd34_' + 'x'.repeat(32);
  assert.equal(redactSecrets('key ' + tok), 'key lbd_[redacted]');
});

test('messages never store password values', () => {
  const s = new ChatStore({ now: () => 1000 });
  const c = s.upsert({ chatName: 'Test', provider: 'Anthropic', model: 'claude-opus' });
  s.addMessage(c.id, { from: 'user', text: 'the password is swordfish' });
  // "the password is swordfish" has no key=value form; still store the line, but key=value is stripped
  s.addMessage(c.id, { from: 'agent', text: 'password=swordfish use this' });
  const last = s.get(c.id).messages.at(-1).text;
  assert.doesNotMatch(last, /swordfish/);
  assert.match(last, /\[redacted\]/);
});

test('closing a tab moves an unsaved chat to Closed with closedAt', () => {
  let now = 5_000;
  const s = new ChatStore({ now: () => now });
  const c = s.upsert({ chatName: 'Gmail work', provider: 'OpenAI', model: 'gpt-5', keyName: 'codex' });
  s.attachTab(c.id, 42, 7);
  s.addMessage(c.id, { from: 'user', text: 'open inbox' });
  const closed = s.closeByTab(42, 'tab-closed');
  assert.equal(closed.length, 1);
  assert.equal(closed[0].status, 'closed');
  assert.equal(closed[0].closedAt, 5_000);
  assert.equal(closed[0].closeReason, 'tab-closed');
  assert.equal(s.list('active').length, 0);
  assert.equal(s.list('closed').length, 1);
  assert.equal(s.list('closed')[0].provider, 'OpenAI');
  assert.equal(s.list('closed')[0].model, 'gpt-5');
  assert.equal(s.list('closed')[0].chatName, 'Gmail work');
});

test('closing a tab group or ending a session also moves the chat to Closed', () => {
  const s = new ChatStore({ now: () => 9_000 });
  const a = s.upsert({ chatName: 'A' }); s.attachTab(a.id, 1, 11);
  const b = s.upsert({ chatName: 'B' }); s.attachTab(b.id, 2, 12);
  s.closeByGroup(11, 'group-closed');
  assert.equal(s.get(a.id).status, 'closed');
  assert.equal(s.get(b.id).status, 'active');
  s.closeSession(b.id, 'session-ended');
  assert.equal(s.get(b.id).status, 'closed');
  assert.equal(s.get(b.id).closeReason, 'session-ended');
});

test('Save from Active or Closed keeps the chat until manual delete; tab close does not unsaved it', () => {
  const s = new ChatStore({ now: () => 10_000 });
  const a = s.upsert({ chatName: 'Keep me' });
  s.attachTab(a.id, 5);
  s.save(a.id);
  assert.equal(s.get(a.id).status, 'saved');
  assert.equal(s.get(a.id).savedAt, 10_000);
  s.closeByTab(5, 'tab-closed');
  assert.equal(s.get(a.id).status, 'saved');
  const b = s.upsert({ chatName: 'Close then save' });
  s.close(b.id, 'tab-closed');
  s.save(b.id);
  assert.equal(s.get(b.id).status, 'saved');
  assert.ok(s.get(b.id).closedAt);
  assert.ok(s.delete(b.id));
  assert.equal(s.get(b.id), null);
  assert.equal(s.list('saved').length, 1);
});

test('Closed chats auto-delete after 30 days; Saved and Active are kept (time-mocked)', () => {
  let now = Date.parse('2026-11-14T09:00:00Z');
  const path = join(mkdtempSync(join(tmpdir(), 'lbd-chats-')), 'chats.json');
  const s = new ChatStore({ path, now: () => now });
  const stale = s.upsert({ chatName: 'stale' });
  const recent = s.upsert({ chatName: 'recent' });
  const keptSaved = s.upsert({ chatName: 'treasure' });
  const live = s.upsert({ chatName: 'live' });
  s.close(stale.id); s.close(recent.id); s.save(keptSaved.id);
  now += 10 * day;
  s.close(recent.id); // already closed; closedAt stays the original? close() is no-op if already closed
  // recent was closed at t0, so it is also 10 days old. Recreate a recent closed chat:
  const fresh = s.upsert({ chatName: 'fresh-closed' });
  s.close(fresh.id);
  now += 20 * day; // total +30d from t0; fresh-closed is 20d old; stale is 30d old
  const removed = s.purge();
  assert.equal(removed.length, 2); // stale + recent (both closed at t0)
  assert.equal(s.get(stale.id), null);
  assert.equal(s.get(recent.id), null);
  assert.equal(s.get(fresh.id).status, 'closed'); // 20 days < 30
  assert.equal(s.get(keptSaved.id).status, 'saved');
  assert.equal(s.get(live.id).status, 'active');
  now += 10 * day;
  const removed2 = s.purge();
  assert.equal(removed2.map((c) => c.id).join(), fresh.id);
  assert.equal(s.get(fresh.id), null);
  assert.equal(CLOSED_TTL_MS, 30 * day);
  // persists across load
  const s2 = new ChatStore({ path, now: () => now });
  assert.equal(s2.get(keptSaved.id).chatName, 'treasure');
  assert.equal(s2.get(live.id).status, 'active');
  assert.equal(s2.get(stale.id), null);
});
