export const PING_SOUNDS = [
  { id: 'chime', name: 'Soft Chime', notes: [523.25, 783.99], type: 'sine', decay: 0.75, gain: 0.14 },
  { id: 'bell', name: 'Glass Bell', notes: [880, 1760], type: 'sine', decay: 0.65, gain: 0.11 },
  { id: 'marimba', name: 'Warm Marimba', notes: [349.23, 523.25], type: 'triangle', decay: 0.45, gain: 0.16 },
  { id: 'droplet', name: 'Water Droplet', glide: [620, 980], type: 'sine', decay: 0.35, gain: 0.15 },
  { id: 'bowl', name: 'Singing Bowl', notes: [293.66, 440], type: 'sine', decay: 1.05, gain: 0.12 },
];

export const PING_SOUND_IDS = PING_SOUNDS.map((s) => s.id);

let sharedCtx = null;

export async function playPingSound(soundId = 'chime', AudioCtor = globalThis.AudioContext || globalThis.webkitAudioContext) {
  if (!AudioCtor) return false;
  const spec = PING_SOUNDS.find((s) => s.id === soundId) || PING_SOUNDS[0];
  try {
    if (!sharedCtx || sharedCtx.state === 'closed' || (AudioCtor && !(sharedCtx instanceof AudioCtor))) sharedCtx = new AudioCtor();
    if (sharedCtx.state === 'suspended' && typeof sharedCtx.resume === 'function') await sharedCtx.resume();
    const now = sharedCtx.currentTime;
    if (spec.glide) {
      const osc = sharedCtx.createOscillator();
      const gain = sharedCtx.createGain();
      osc.type = spec.type;
      osc.frequency.setValueAtTime(spec.glide[0], now);
      osc.frequency.exponentialRampToValueAtTime(spec.glide[1], now + 0.08);
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.linearRampToValueAtTime(spec.gain, now + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + spec.decay);
      osc.connect(gain);
      gain.connect(sharedCtx.destination);
      osc.start(now);
      osc.stop(now + spec.decay + 0.03);
      return true;
    }
    spec.notes.forEach((freq, idx) => {
      const start = now + idx * 0.075;
      const osc = sharedCtx.createOscillator();
      const gain = sharedCtx.createGain();
      osc.type = spec.type;
      osc.frequency.setValueAtTime(freq, start);
      const peak = idx === 0 ? spec.gain : spec.gain * 0.65;
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.linearRampToValueAtTime(peak, start + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + spec.decay);
      osc.connect(gain);
      gain.connect(sharedCtx.destination);
      osc.start(start);
      osc.stop(start + spec.decay + 0.03);
    });
    return true;
  } catch (_) {
    return false;
  }
}
