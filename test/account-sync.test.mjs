import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyPacked, isHandoffMessage, packSettings, signInUrl } from '../extension/account-sync.js';

test('packSettings drops chats and keys and maps blocklists', () => {
  const packed = packSettings({
    readOnly: true,
    passwords: 'deny',
    blocklist: ['bank.example'],
    allowlist: [],
    apiKey: 'secret',
  }, { consented: false, setByUser: true }, { security: '2026-11-14T15:00:00.000Z' });
  assert.equal(packed.security.readOnly, true);
  assert.deepEqual(packed.blockedDomains, ['bank.example']);
  assert.equal(packed.metadataOptOut, true);
  assert.equal(packed.security.apiKey, undefined);
  assert.equal('chats' in packed, false);
  assert.equal(packed.fieldTimes.security, '2026-11-14T15:00:00.000Z');
});

test('applyPacked writes security, lists and metadata opt-out back to local shape', () => {
  const applied = applyPacked(
    { readOnly: false, passwords: 'deny', blocklist: [], allowlist: [] },
    { consented: true, setByUser: false },
    { security: { readOnly: true }, blockedDomains: ['evil.test'], metadataOptOut: true }
  );
  assert.equal(applied.settings.readOnly, true);
  assert.deepEqual(applied.settings.blocklist, ['evil.test']);
  assert.equal(applied.navMeta.consented, false);
  assert.equal(applied.navMeta.setByUser, true);
});

test('handoff messages must be the scoped type and a hex code', () => {
  assert.equal(isHandoffMessage({ type: 'luculent.browserDriver.handoff', code: 'ab'.repeat(16) }), true);
  assert.equal(isHandoffMessage({ type: 'eval', code: 'ab'.repeat(16) }), false);
  assert.equal(isHandoffMessage({ type: 'luculent.browserDriver.handoff', code: 'http://evil' }), false);
  assert.equal(isHandoffMessage({ type: 'luculent.browserDriver.handoff', code: '<script>' }), false);
});

test('sign-in URL stays on luculent.dev and includes the extension id', () => {
  const url = signInUrl('abcdefghijklmnopqrstuvwxyzabcdef', 'Chrome on Windows');
  assert.equal(url.startsWith('https://luculent.dev/beta/sign-up?'), true);
  assert.equal(url.includes('handoff=1'), true);
  assert.equal(url.includes('ext=abcdefghijklmnopqrstuvwxyzabcdef'), true);
});

test('regional default consent is not packed or forced onto another device', () => {
  const packed = packSettings({ readOnly: false }, { consented: true, setByUser: false });
  assert.equal('metadataOptOut' in packed, false);
  const applied = applyPacked(
    { readOnly: false },
    { consented: false, setByUser: false },
    { security: { readOnly: false } }
  );
  assert.equal(applied.navMeta.consented, false);
  assert.equal(applied.navMeta.setByUser, false);
});
