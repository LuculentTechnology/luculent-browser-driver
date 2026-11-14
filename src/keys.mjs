// API keys, killswitch state and admin token. Stored outside the repo (default ~/.luculent/browser-driver).
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// read/act/tabs/headless: core. eval, cookies, storage, upload, passwords, files: sensitive powers a key only gets when
// minted with them (and the global security settings also allow them). cdp: raw DevTools protocol. admin: settings.
export const ALL_SCOPES = ['read', 'act', 'tabs', 'headless', 'eval', 'cookies', 'storage', 'upload', 'passwords', 'files', 'cdp', 'admin'];
export const DEFAULT_SCOPES = ['read', 'act', 'tabs', 'headless'];

export function lbdHome() {
  const h = process.env.LBD_HOME || join(homedir(), '.luculent', 'browser-driver');
  if (!existsSync(h)) mkdirSync(h, { recursive: true, mode: 0o700 });
  return h;
}

const sha = (s) => createHash('sha256').update(s).digest();
const B62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const rand62 = (n) => { const b = randomBytes(n); let s = ''; for (const x of b) s += B62[x % 62]; return s; };

function readJson(p, dflt) { try { return JSON.parse(readFileSync(p, 'utf8')); } catch (_) { return dflt; } }
function writeJson(p, v) { const tmp = p + '.tmp'; writeFileSync(tmp, JSON.stringify(v, null, 2), { mode: 0o600 }); renameSync(tmp, p); }

export class KeyStore {
  constructor(home = lbdHome()) {
    this.home = home;
    this.keysPath = join(home, 'keys.json');
    this.statePath = join(home, 'state.json');
    this.adminPath = join(home, 'admin.token');
    this._mtime = 0;
    this._data = { keys: [] };
  }
  load() {
    let m = 0; try { m = statSync(this.keysPath).mtimeMs; } catch (_) {}
    if (m !== this._mtime) { this._mtime = m; this._data = readJson(this.keysPath, { keys: [] }); }
    return this._data;
  }
  save(d) { writeJson(this.keysPath, d); this._mtime = 0; this.load(); }

  mint({ name = 'agent', scopes = DEFAULT_SCOPES, allowOrigins = [], expiresDays, policy } = {}) {
    for (const s of scopes) if (!ALL_SCOPES.includes(s)) throw new Error(`Unknown scope ${s}. Valid: ${ALL_SCOPES.join(',')}`);
    const d = this.load();
    const id = rand62(8);
    const token = `lbd_${id}_${rand62(32)}`;
    d.keys.push({ id, name, hash: sha(token).toString('hex'), scopes, allowOrigins, ...(policy ? { policy } : {}), createdAt: new Date().toISOString(), expiresAt: expiresDays ? new Date(Date.now() + expiresDays * 864e5).toISOString() : null, revokedAt: null });
    this.save(d);
    return { id, name, scopes, allowOrigins, token };
  }
  list() { return this.load().keys.map(({ hash, ...k }) => k); }
  revoke(idOrName) {
    const d = this.load();
    let n = 0;
    for (const k of d.keys) if ((k.id === idOrName || k.name === idOrName) && !k.revokedAt) { k.revokedAt = new Date().toISOString(); n++; }
    this.save(d);
    return n;
  }
  verify(token) {
    if (!token || typeof token !== 'string') return null;
    const m = /^lbd_([0-9A-Za-z]{8})_[0-9A-Za-z]{32}$/.exec(token.trim());
    if (!m) return null;
    const k = this.load().keys.find((x) => x.id === m[1]);
    if (!k || k.revokedAt) return null;
    if (k.expiresAt && Date.parse(k.expiresAt) < Date.now()) return null;
    const a = Buffer.from(k.hash, 'hex');
    const b = sha(token.trim());
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    return { id: k.id, name: k.name, scopes: k.scopes, allowOrigins: k.allowOrigins || [], policy: k.policy || null };
  }

  state() { return readJson(this.statePath, { killed: false, pinnedExtensions: [] }); }
  setState(patch) { const s = { ...this.state(), ...patch }; writeJson(this.statePath, s); return s; }

  adminToken() {
    if (!existsSync(this.adminPath)) writeFileSync(this.adminPath, rand62(40), { mode: 0o600 });
    return readFileSync(this.adminPath, 'utf8').trim();
  }
  isAdminToken(t) {
    const a = Buffer.from(this.adminToken()); const b = Buffer.from(String(t || ''));
    return a.length === b.length && timingSafeEqual(a, b);
  }
}

/** Host allowlist check. Patterns: "example.com", "*.example.com", "*". */
export function originAllowed(allow, url) {
  if (!allow || !allow.length) return true;
  let host;
  try { const u = new URL(url); if (u.protocol === 'about:' || u.protocol === 'data:') return true; host = u.hostname; } catch (_) { return false; }
  return allow.some((p) => p === '*' || p === host || (p.startsWith('*.') && (host === p.slice(2) || host.endsWith(p.slice(1)))));
}
