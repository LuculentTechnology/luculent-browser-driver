import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ChatStore } from '../src/chats.mjs';
import { PanelHub, inferProvider, fallbackIdentity } from '../src/panel.mjs';

test('identify handshake prefers explicit tool, then clientInfo, then client name + key label', () => {
  const hub = new PanelHub(new ChatStore({ now: () => 1 }));
  const ctx = { key: { id: 'abc', name: 'codex-seat' } };
  const hello = hub.hello(ctx, { name: 'claude-code', version: '1.2.3' });
  assert.equal(hello.provider, 'Anthropic');
  assert.equal(hello.model, null);
  assert.match(hello.chatName, /claude-code/);
  assert.match(hello.chatName, /codex-seat/);
  const named = hub.identify(ctx, { provider: 'Anthropic', model: 'claude-opus-4.5', chatName: 'Inbox triage' });
  assert.equal(named.provider, 'Anthropic');
  assert.equal(named.model, 'claude-opus-4.5');
  assert.equal(named.chatName, 'Inbox triage');
  const again = hub.hello(ctx, { name: 'claude-code' });
  assert.equal(again.model, 'claude-opus-4.5');
  assert.equal(again.chatName, 'Inbox triage');
  assert.equal(inferProvider('gemini-cli'), 'Google');
  assert.equal(inferProvider('Codex CLI'), 'OpenAI');
  assert.equal(fallbackIdentity({ clientName: 'grok-bot', keyName: 'main' }).provider, 'xAI');
});

test('message round trip: user and agent messages are stored and readable, secrets redacted', () => {
  const hub = new PanelHub(new ChatStore({ now: () => 50 }));
  const ctx = { key: { id: 'k1', name: 'grok' } };
  hub.identify(ctx, { provider: 'xAI', model: 'grok-4', chatName: 'Browse HN' });
  hub.post(ctx, { from: 'user', text: 'open the front page' });
  hub.post(ctx, { from: 'agent', text: 'password=nope done' });
  const msgs = hub.read(ctx);
  assert.equal(msgs.length, 2);
  assert.equal(msgs[0].from, 'user');
  assert.equal(msgs[0].text, 'open the front page');
  assert.equal(msgs[1].from, 'agent');
  assert.doesNotMatch(msgs[1].text, /nope/);
  const newer = hub.read(ctx, { since: 0 });
  assert.equal(newer.length, 2);
});

test('multi-session: two keys get two chats; closing a tab moves only that chat to Closed', () => {
  const store = new ChatStore({ now: () => 99 });
  const hub = new PanelHub(store);
  const a = { key: { id: 'ka', name: 'claude' } };
  const b = { key: { id: 'kb', name: 'codex' } };
  hub.identify(a, { provider: 'Anthropic', model: 'opus', chatName: 'Mail' });
  hub.identify(b, { provider: 'OpenAI', model: 'gpt-5', chatName: 'Docs' });
  hub.post(a, { from: 'user', text: 'hi a' });
  hub.post(b, { from: 'user', text: 'hi b' });
  hub.attachTab(a, 11, 1);
  hub.attachTab(b, 22, 2);
  assert.equal(hub.sections().active.length, 2);
  hub.closeByTab(11, 'tab-closed');
  const sections = hub.sections();
  assert.equal(sections.active.length, 1);
  assert.equal(sections.closed.length, 1);
  assert.equal(sections.closed[0].chatName, 'Mail');
  assert.equal(sections.active[0].chatName, 'Docs');
  assert.equal(hub.read(b).at(-1).text, 'hi b');
  hub.save(sections.closed[0].id);
  assert.equal(hub.sections().saved[0].chatName, 'Mail');
  assert.equal(hub.sections().closed.length, 0);
});
