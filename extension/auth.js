// Credential slot. The local relay needs no credential (it checks the extension Origin, and agents use their own
// relay API keys). Planned: a Luculent Master API key, or a scoped sub-key minted from it, used by the cloud
// transport and the Markup mode. Stored only in chrome.storage.local on this device, never synced or logged.
export async function getCredential() {
  const { auth } = await chrome.storage.local.get(['auth']);
  if (auth && auth.kind === 'master' && auth.key) return { kind: 'master', key: auth.key };
  if (auth && auth.kind === 'subkey' && auth.key) return { kind: 'subkey', key: auth.key, scopes: auth.scopes || [] };
  return { kind: 'none' };
}
export async function setCredential(c) { await chrome.storage.local.set({ auth: c && c.key ? c : null }); }
export async function clearCredential() { await chrome.storage.local.remove('auth'); }
