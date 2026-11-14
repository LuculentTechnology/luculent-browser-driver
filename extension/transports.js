// Outbound transports. The service worker talks to exactly one transport at a time.
// Today: "local" = the Luculent relay on this machine. Later: "cloud" = a Luculent cloud endpoint (e.g. for
// Markup submissions), authenticated with a Master API key or a scoped sub-key from auth.js.
// A transport returns a WebSocket-like object: { readyState, send(str), close(), onopen, onmessage, onclose, onerror }.
import { getCredential } from './auth.js';

export const DEFAULT_RELAY = 'ws://127.0.0.1:47800/ext';

async function localUrl() {
  const s = await chrome.storage.local.get(['relayUrl']);
  if (s.relayUrl) return s.relayUrl;
  try {
    const r = await fetch(chrome.runtime.getURL('config.json'));
    if (r.ok) { const c = await r.json(); if (c.relayUrl) return c.relayUrl; }
  } catch (_) {}
  return DEFAULT_RELAY;
}

export const TRANSPORTS = {
  local: {
    label: 'Local relay',
    // The local relay trusts the extension by its chrome-extension:// Origin; no key is sent.
    async open() { return new WebSocket(await localUrl()); },
    async hello() { return {}; },
  },
  cloud: {
    label: 'Luculent cloud (not enabled yet)',
    async open() { throw new Error('cloud transport is not enabled in this build'); },
    async hello() { const c = await getCredential(); return c.kind === 'none' ? {} : { auth: c.kind }; },
  },
};

export async function activeTransport() {
  const { transport } = await chrome.storage.local.get(['transport']);
  return TRANSPORTS[transport] && transport !== 'cloud' ? TRANSPORTS[transport] : TRANSPORTS.local;
}
