import { playPingSound } from './ping.js';

chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === 'offscreen.ping') void playPingSound(msg.sound);
});
