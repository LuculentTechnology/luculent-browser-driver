// Side-panel chat history: Active, Closed, Saved (LUC-3084).
// Closing a tab/group/session moves an unsaved chat to Closed. Closed chats are deleted after 30 days.
// Saved chats are kept until the user deletes them. Password values are never stored.
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';

export const CLOSED_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const STATUSES = ['active', 'closed', 'saved'];

const TOKEN_RE = /lbd_[0-9A-Za-z]{8}_[0-9A-Za-z]{32}/g;
const SECRET_LINE = /((?:password|passwd|passphrase|secret|api[_-]?key|access[_-]?token|authorization|bearer|pwd)\s*[:=]\s*)("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^\s,;]+)/gi;

export function redactSecrets(text) {
  if (text == null) return '';
  return String(text).replace(SECRET_LINE, (_, a) => a + '[redacted]').replace(TOKEN_RE, 'lbd_[redacted]');
}

export function sanitizeMessage(m = {}) {
  return {
    id: m.id || ('m_' + randomBytes(4).toString('hex')),
    from: m.from === 'user' || m.from === 'agent' ? m.from : 'system',
    text: redactSecrets(m.text ?? ''),
    at: m.at || Date.now(),
    ...(m.pauseId ? { pauseId: m.pauseId } : {}),
  };
}

export function displayName(chat) {
  return chat?.chatName || chat?.clientName || chat?.keyName || 'Agent';
}

export class ChatStore {
  /** @param {{ path?: string, now?: () => number }} [opts] */
  constructor({ path, now } = {}) {
    this.path = path || null;
    this._now = now || (() => Date.now());
    this.chats = [];
    if (path) this.load();
  }
  now() { return this._now(); }
  load() {
    try {
      const raw = JSON.parse(readFileSync(this.path, 'utf8'));
      this.chats = Array.isArray(raw) ? raw : (raw.chats || []);
    } catch (_) { this.chats = []; }
    return this;
  }
  persist() {
    if (!this.path) return;
    const dir = dirname(this.path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmp = this.path + '.tmp';
    writeFileSync(tmp, JSON.stringify({ chats: this.chats }, null, 2), { mode: 0o600 });
    renameSync(tmp, this.path);
  }
  get(id) { return this.chats.find((c) => c.id === id) || null; }
  list(status) {
    const all = this.chats.slice().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    return status ? all.filter((c) => c.status === status) : { active: this.list('active'), closed: this.list('closed'), saved: this.list('saved') };
  }
  sections() { return this.list(); }
  upsert(partial = {}) {
    const id = partial.id || ('c_' + randomBytes(6).toString('hex'));
    let c = this.get(id);
    if (!c) {
      c = {
        id, status: 'active', provider: null, model: null, chatName: null, clientName: null,
        keyName: null, keyId: null, profileId: null, profileName: null, tabIds: [], groupId: null,
        messages: [], pageContext: null, createdAt: this.now(), updatedAt: this.now(), closedAt: null, savedAt: null,
      };
      this.chats.push(c);
    }
    for (const [k, v] of Object.entries(partial)) {
      if (k === 'id' || k === 'messages' || v === undefined) continue;
      c[k] = v;
    }
    if (partial.messages) c.messages = partial.messages.map((m) => sanitizeMessage({ ...m, at: m.at || this.now() }));
    c.updatedAt = this.now();
    this.persist();
    return c;
  }
  addMessage(id, msg) {
    const c = this.get(id) || this.upsert({ id });
    const m = sanitizeMessage({ ...msg, at: msg.at || this.now() });
    c.messages.push(m);
    c.updatedAt = this.now();
    // A new message on a closed (unsaved) session reopens it as Active.
    if (c.status === 'closed') { c.status = 'active'; c.closedAt = null; }
    this.persist();
    return m;
  }
  attachTab(id, tabId, groupId) {
    const c = this.get(id) || this.upsert({ id });
    const t = String(tabId);
    if (!c.tabIds.includes(t)) c.tabIds.push(t);
    if (groupId != null) c.groupId = groupId;
    c.updatedAt = this.now();
    this.persist();
    return c;
  }
  close(id, reason = 'tab-closed') {
    const c = this.get(id);
    if (!c) return null;
    if (c.status === 'saved') return c; // saved stays saved
    if (c.status === 'closed') return c;
    c.status = 'closed';
    c.closedAt = this.now();
    c.updatedAt = c.closedAt;
    c.closeReason = reason;
    this.persist();
    return c;
  }
  closeByTab(tabId, reason = 'tab-closed') {
    const t = String(tabId);
    return this.chats.filter((c) => c.status === 'active' && (c.tabIds || []).includes(t)).map((c) => this.close(c.id, reason));
  }
  closeByGroup(groupId, reason = 'group-closed') {
    return this.chats.filter((c) => c.status === 'active' && c.groupId != null && String(c.groupId) === String(groupId)).map((c) => this.close(c.id, reason));
  }
  closeSession(id, reason = 'session-ended') { return this.close(id, reason); }
  save(id) {
    const c = this.get(id);
    if (!c) return null;
    c.status = 'saved';
    c.savedAt = this.now();
    c.updatedAt = c.savedAt;
    this.persist();
    return c;
  }
  delete(id) {
    const i = this.chats.findIndex((c) => c.id === id);
    if (i < 0) return false;
    this.chats.splice(i, 1);
    this.persist();
    return true;
  }
  purge(now, ttl = CLOSED_TTL_MS) {
    const t = now ?? this.now();
    const removed = [];
    this.chats = this.chats.filter((c) => {
      if (c.status === 'closed' && c.closedAt && (t - c.closedAt) >= ttl) { removed.push(c); return false; }
      return true;
    });
    if (removed.length) this.persist();
    return removed;
  }

  attachPageContext(id, ctx) {
    const c = this.get(id) || this.upsert({ id });
    c.pageContext = ctx;
    c.updatedAt = this.now();
    this.persist();
    return c;
  }
  clearPageContext(id) {
    const c = this.get(id);
    if (!c) return null;
    c.pageContext = null;
    c.updatedAt = this.now();
    this.persist();
    return c;
  }
}
