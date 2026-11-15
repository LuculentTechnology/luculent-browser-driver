import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Relay, Router } from '../src/relay.mjs';
import { KeyStore } from '../src/keys.mjs';
import { handleMcp } from '../src/mcp-tools.mjs';
import { resolveKey } from '../src/mcp-stdio.mjs';

async function boot() {
  const home = mkdtempSync(join(tmpdir(), 'lbd-feat-'));
  const keys = new KeyStore(home);
  const relay = await new Relay({ port: 0, keys, log: () => {} }).start();
  const token = keys.mint({ name: 'agent', scopes: ['read', 'act', 'tabs', 'admin'] }).token;
  const ctx = { key: keys.verify(token), sid: 't1' };
  return { relay, keys, home, token, ctx };
}

test('identify handshake, message round trip, and multi-session via the relay', async () => {
  const { relay, keys, ctx } = await boot();
  try {
    const hello = await relay.call('panel.hello', { clientInfo: { name: 'claude-code', version: '9' } }, ctx);
    assert.equal(hello.provider, 'Anthropic');
    const id = await relay.call('panel.identify', { provider: 'Anthropic', model: 'opus', chatName: 'Mail' }, ctx);
    assert.equal(id.chatName, 'Mail');
    await relay.call('panel.post', { from: 'user', text: 'hello there' }, ctx);
    const st = await relay.call('panel.state', {}, ctx);
    assert.equal(st.view.chatName, 'Mail');
    assert.equal(st.view.model, 'opus');
    assert.ok(st.view.messages.some((m) => m.text === 'hello there'));
    const ctx2 = { key: keys.verify(keys.mint({ name: 'codex' }).token), sid: 't2' };
    await relay.call('panel.identify', { provider: 'OpenAI', model: 'gpt-5', chatName: 'Docs' }, ctx2);
    const sections = (await relay.call('panel.state', {}, ctx)).sections;
    assert.ok(sections.active.length >= 2);
    const names = sections.active.map((c) => c.chatName);
    assert.ok(names.includes('Mail') && names.includes('Docs'));
  } finally { await relay.stop(); }
});

test('pull page context attaches to the chat, follow-ups keep it, blocked sites refused', async () => {
  const { relay, ctx } = await boot();
  try {
    const pulled = await relay.call('panel.pull', { raw: { title: 'Ada', url: 'https://example.com/ada', text: 'Ada Lovelace was a mathematician.', headings: ['Ada'], links: [], tables: [] } }, ctx);
    assert.equal(pulled.chip.title, 'Ada');
    assert.match(pulled.message.text, /quick blurb/);
    await relay.call('panel.post', { from: 'user', text: 'when was she born?' }, ctx);
    const st = await relay.call('panel.state', {}, ctx);
    assert.equal(st.view.pageContext.title, 'Ada');
    assert.ok(st.view.messages.some((m) => m.text === 'when was she born?'));
    await assert.rejects(() => relay.call('panel.pull', { raw: { title: 'Bank', url: 'https://stripe.com', text: 'pay' } }, ctx), /Blocked by your Luculent security settings/);
    const mcp = await handleMcp({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'panel_page_context', arguments: {} } }, (m, p) => relay.call(m, p, ctx));
    assert.match(mcp.result.content[0].text, /Ada/);
  } finally { await relay.stop(); }
});

test('pause_for_human resumes from the panel and times out otherwise', async () => {
  const { relay, ctx } = await boot();
  try {
    const pending = relay.call('pause_for_human', { reason: 'CAPTCHA', message: 'please solve', timeout: 2000 }, ctx);
    await new Promise((r) => setTimeout(r, 50));
    const st = await relay.call('panel.state', {}, ctx);
    assert.ok(st.pause && st.pause.reason === 'CAPTCHA');
    await relay.call('panel.resume', { id: st.pause.id, text: 'done' }, ctx);
    const r = await pending;
    assert.equal(r.resumed, true);
    assert.equal(r.reply, 'done');
    const timed = await relay.call('pause_for_human', { reason: '2FA', timeout: 80 }, ctx);
    assert.equal(timed.timedOut, true);
  } finally { await relay.stop(); }
});

test('recorded flow record and list via the relay', async () => {
  const { relay, ctx } = await boot();
  try {
    const rec = await relay.call('flow.record', { name: 'signup' }, ctx);
    assert.equal(rec.recording, true);
    await relay.call('flow.step', { action: 'navigate', url: 'https://example.com' }, ctx);
    await relay.call('flow.step', { action: 'click', target: 'e1' }, ctx);
    const saved = await relay.call('flow.stop', {}, ctx);
    assert.equal(saved.name, 'signup');
    const list = await relay.call('flow.list', {}, ctx);
    assert.equal(list.flows.length, 1);
  } finally { await relay.stop(); }
});

test('setup writes a key file path only, and MCP tools/list includes the new tools', async () => {
  const { relay, ctx, home } = await boot();
  const userHome = mkdtempSync(join(tmpdir(), 'lbd-user-'));
  try {
    const r = await relay.call('setup', { clients: ['cursor'], startAtLogon: false, startNow: false, dryRun: false, userHome, hooks: {} }, ctx);
    assert.ok(r.keyFile.startsWith(home));
    assert.ok(existsSync(r.keyFile));
    assert.ok(!('token' in r));
    assert.doesNotMatch(JSON.stringify(r), /lbd_[0-9A-Za-z]{8}_/);
    const listed = await handleMcp({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, (m, p) => relay.call(m, p, ctx));
    const names = listed.result.tools.map((t) => t.name);
    for (const n of ['panel_identify', 'panel_read_messages', 'panel_send_message', 'panel_page_context', 'browser_pause_for_human', 'browser_flow_record', 'browser_flow_replay']) {
      assert.ok(names.includes(n), 'missing ' + n);
    }
  } finally { await relay.stop(); }
});

test('resolveKey reads LBD_KEY_FILE and does not require LBD_KEY', () => {
  const home = mkdtempSync(join(tmpdir(), 'lbd-kf-'));
  const file = join(home, 'k.key');
  const tok = 'lbd_ABCDEF12_' + 'z'.repeat(32);
  writeFileSync(file, tok + '\n');
  const prev = process.env.LBD_KEY_FILE;
  const prevK = process.env.LBD_KEY;
  process.env.LBD_KEY_FILE = file;
  delete process.env.LBD_KEY;
  try { assert.equal(resolveKey(), tok); }
  finally {
    if (prev === undefined) delete process.env.LBD_KEY_FILE; else process.env.LBD_KEY_FILE = prev;
    if (prevK === undefined) delete process.env.LBD_KEY; else process.env.LBD_KEY = prevK;
  }
});

test('two Chrome profiles stay connected; listProfiles returns both; one disconnect does not drop the other', () => {
  const router = new Router();
  const mk = (name) => ({ readyState: 1, closed: null, send() {}, close(code, reason) { this.readyState = 3; this.closed = { code, reason }; } });
  const a = mk('work');
  const b = mk('personal');
  router.attachExtension(a, { id: 'ext-a', profileId: 'work', profileName: 'Work' });
  router.attachExtension(b, { id: 'ext-b', profileId: 'personal', profileName: 'Personal' });
  assert.equal(a.readyState, 1);
  assert.equal(b.readyState, 1);
  assert.equal(a.closed, null);
  assert.equal(b.closed, null);
  const names = router.listProfiles().map((p) => p.profileName).sort();
  assert.deepEqual(names, ['Personal', 'Work']);
  router.detachExtension(a);
  assert.equal(router.listProfiles().length, 1);
  assert.equal(router.listProfiles()[0].profileId, 'personal');
  assert.equal(router.ext, b);
});

test('killswitch detaches every connected Chrome profile, not just the primary', async () => {
  const home = mkdtempSync(join(tmpdir(), 'lbd-kill-'));
  const keys = new KeyStore(home);
  const relay = await new Relay({ port: 0, keys, log: () => {} }).start();
  try {
    const sent = [];
    const mk = (profileId) => ({
      readyState: 1,
      sent: [],
      send(raw) {
        const msg = JSON.parse(raw);
        this.sent.push(msg);
        sent.push({ profileId, type: msg.type });
        queueMicrotask(() => relay.router.onExtMessage({ id: msg.id, result: { ok: true } }));
      },
      close() { this.readyState = 3; },
    });
    const work = mk('work');
    const personal = mk('personal');
    relay.router.attachExtension(work, { id: 'ext-a', profileId: 'work', profileName: 'Work' });
    relay.router.attachExtension(personal, { id: 'ext-b', profileId: 'personal', profileName: 'Personal' });
    const r = await relay.kill('test');
    assert.equal(r.killed, true);
    const detached = sent.filter((x) => x.type === 'detachAll').map((x) => x.profileId).sort();
    assert.deepEqual(detached, ['personal', 'work']);
    await relay.resume();
  } finally { await relay.stop(); }
});

test('regional default navMeta on connect does not overwrite a saved user consent choice', async () => {
  const { relay, home } = await boot();
  try {
    relay.meta.setConsent({ consented: false, setByUser: true });
    assert.equal(relay.meta.status().consented, false);
    assert.equal(relay.meta.status().setByUser, true);
    const after = relay.applyNavMeta({ consented: true, setByUser: false, region: 'other', defaultOn: true });
    assert.equal(after.consented, false);
    assert.equal(after.setByUser, true);
    const { existsSync, readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const saved = JSON.parse(readFileSync(join(home, 'nav-meta-consent.json'), 'utf8'));
    assert.equal(saved.consented, false);
    assert.equal(saved.setByUser, true);
    // A real user choice from the extension still applies and is persisted.
    const user = relay.applyNavMeta({ consented: true, setByUser: true });
    assert.equal(user.consented, true);
    assert.equal(user.setByUser, true);
  } finally { await relay.stop(); }
});
