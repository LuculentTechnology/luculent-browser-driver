import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULTS, normalize } from '../extension/settings.js';
import { PING_SOUNDS, PING_SOUND_IDS, playPingSound } from '../extension/ping.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(join(root, 'extension', 'manifest.json'), 'utf8'));
const sw = readFileSync(join(root, 'extension', 'sw.js'), 'utf8');
const optionsHtml = readFileSync(join(root, 'extension', 'options.html'), 'utf8');
const optionsJs = readFileSync(join(root, 'extension', 'options.js'), 'utf8');
const offscreenHtml = readFileSync(join(root, 'extension', 'offscreen.html'), 'utf8');
const offscreenJs = readFileSync(join(root, 'extension', 'offscreen.js'), 'utf8');

test('pingWhenDone defaults to false, pingSound defaults to chime, and 5 peaceful ping sounds exist', () => {
  assert.equal(DEFAULTS.pingWhenDone, false);
  assert.equal(DEFAULTS.pingSound, 'chime');
  assert.equal(PING_SOUNDS.length, 5);
  assert.deepEqual(PING_SOUND_IDS, ['chime', 'bell', 'marimba', 'droplet', 'bowl']);
  assert.equal(normalize().pingWhenDone, false);
  assert.equal(normalize({ pingWhenDone: true, pingSound: 'bowl' }).pingSound, 'bowl');
  assert.equal(normalize({ pingSound: 'unknown' }).pingSound, 'chime');
});

test('playPingSound synthesizes all 5 peaceful pings via Web Audio API', async () => {
  for (const id of PING_SOUND_IDS) {
    let started = 0;
    class FakeCtx {
      constructor() { this.currentTime = 0; this.state = 'running'; this.destination = {}; }
      createOscillator() {
        return {
          type: 'sine',
          frequency: { setValueAtTime() {}, exponentialRampToValueAtTime() {} },
          connect() {},
          start() { started++; },
          stop() {},
        };
      }
      createGain() {
        return {
          gain: { setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {} },
          connect() {},
        };
      }
    }
    const ok = await playPingSound(id, FakeCtx);
    assert.equal(ok, true, `expected ${id} to play`);
    assert.ok(started >= 1, `expected oscillator start for ${id}`);
  }
});

test('manifest, offscreen, options, and sw.js wire Ping when done cleanly', () => {
  assert.ok(manifest.permissions.includes('offscreen'));
  assert.match(offscreenHtml, /offscreen\.js/);
  assert.match(offscreenJs, /offscreen\.ping/);
  assert.match(optionsHtml, /data-k="pingWhenDone"/);
  assert.match(optionsHtml, /data-k="pingSound"/);
  assert.match(optionsHtml, /id="testPing"/);
  assert.match(optionsJs, /playPingSound/);
  assert.match(sw, /playDonePing/);
  assert.match(sw, /offscreen\.ping/);
});
