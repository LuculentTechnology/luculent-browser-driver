// Side-panel chat harness: identify the driving agent and exchange messages (LUC-3083, LUC-3084).
// Identity: explicit identify tool, else MCP clientInfo, else client name + API key label.
import { ChatStore, displayName, redactSecrets } from './chats.mjs';
import { sanitizePageContext, pageContextMessage, pageContextChip, PAGE_CONTEXT_INSTRUCTION } from './page-context.mjs';

export const PROVIDER_HINTS = [
  [/claude|anthropic/i, 'Anthropic'],
  [/gemini|google/i, 'Google'],
  [/codex|openai|chatgpt/i, 'OpenAI'],
  [/cursor/i, 'Cursor'],
  [/grok|xai/i, 'xAI'],
  [/deepseek/i, 'DeepSeek'],
];

export function inferProvider(clientName = '') {
  const n = String(clientName || '');
  for (const [re, label] of PROVIDER_HINTS) if (re.test(n)) return label;
  return n || null;
}

export function fallbackIdentity(session = {}) {
  const clientName = session.clientName || '';
  const provider = session.provider || inferProvider(clientName);
  const model = session.model || null;
  const chatName = session.chatName || [clientName || provider, session.keyName].filter(Boolean).join(' · ') || 'Agent';
  return { provider, model, chatName, label: [provider, model, chatName].filter(Boolean).join(' · ') };
}

export class PanelHub {
  constructor(store, { now } = {}) {
    this.store = store || new ChatStore({ now });
    this.byKey = new Map(); // keyId -> chat id
    this._now = now || (() => this.store.now());
  }

  sessionFor(ctx = {}, hint = {}) {
    const keyId = ctx.key?.id || ctx.keyId || hint.keyId || 'anon';
    let id = hint.id || this.byKey.get(keyId);
    let c = id ? this.store.get(id) : null;
    if (!c || (c.status !== 'active' && !hint.id)) {
      c = this.store.upsert({
        keyId, keyName: ctx.key?.name || hint.keyName || null,
        clientName: hint.clientName || null, profileId: hint.profileId || null, profileName: hint.profileName || null,
      });
      this.byKey.set(keyId, c.id);
    }
    return c;
  }

  hello(ctx, clientInfo = {}) {
    const c = this.sessionFor(ctx, { clientName: clientInfo.name, keyName: ctx.key?.name });
    const patch = { clientName: clientInfo.name || c.clientName, clientVersion: clientInfo.version || c.clientVersion };
    if (!c.provider) patch.provider = inferProvider(clientInfo.name);
    if (!c.chatName) patch.chatName = fallbackIdentity({ ...c, ...patch }).chatName;
    return fallbackIdentity(this.store.upsert({ id: c.id, ...patch }));
  }

  identify(ctx, { provider, model, chatName } = {}) {
    const c = this.sessionFor(ctx);
    const patch = {};
    if (provider) patch.provider = provider;
    if (model) patch.model = model;
    if (chatName) patch.chatName = chatName;
    const next = this.store.upsert({ id: c.id, ...patch });
    return fallbackIdentity(next);
  }

  post(ctx, { from, text, pauseId, id } = {}, hint) {
    const c = this.sessionFor(ctx, hint);
    return this.store.addMessage(c.id, { from, text: redactSecrets(text), pauseId, id });
  }

  read(ctx, { since, status } = {}, hint) {
    const c = hint?.id ? this.store.get(hint.id) : this.sessionFor(ctx, hint);
    if (!c) return [];
    const msgs = c.messages || [];
    return since ? msgs.filter((m) => m.at > since) : msgs;
  }

  sections() { return this.store.sections(); }
  get(id) { return this.store.get(id); }
  close(id, reason) { return this.store.close(id, reason); }
  closeByTab(tabId, reason) { return this.store.closeByTab(tabId, reason); }
  closeByGroup(groupId, reason) { return this.store.closeByGroup(groupId, reason); }
  closeSession(ctx, reason = 'session-ended') {
    const c = this.sessionFor(ctx);
    const keyId = ctx.key?.id || ctx.keyId;
    if (keyId) this.byKey.delete(keyId);
    return this.store.close(c.id, reason);
  }
  save(id) { return this.store.save(id); }
  delete(id) {
    const c = this.store.get(id);
    if (c?.keyId) {
      if (this.byKey.get(c.keyId) === id) this.byKey.delete(c.keyId);
    }
    return this.store.delete(id);
  }
  purge(now) { return this.store.purge(now); }
  attachTab(ctx, tabId, groupId) { return this.store.attachTab(this.sessionFor(ctx).id, tabId, groupId); }

  view(ctx, hint) {
    const c = hint?.id ? this.store.get(hint.id) : this.sessionFor(ctx, hint);
    if (!c) return null;
    return {
      id: c.id,
      status: c.status,
      ...fallbackIdentity(c),
      pageContext: c.pageContext || null,
      chip: pageContextChip(c.pageContext),
      messages: c.messages || [],
    };
  }
  pullPageContext(ctx, raw, { blockedReason, maxChars, hint } = {}) {
    const c = this.sessionFor(ctx, hint);
    const pageContext = sanitizePageContext(raw, { blockedReason, maxChars });
    this.store.attachPageContext(c.id, pageContext);
    const msg = pageContextMessage(pageContext);
    this.store.addMessage(c.id, msg);
    return { pageContext, chip: pageContextChip(pageContext), message: msg, instruction: PAGE_CONTEXT_INSTRUCTION, chat: this.view(ctx, { id: c.id }) };
  }
  refreshPageContext(ctx, raw, opts = {}) { return this.pullPageContext(ctx, raw, opts); }
  clearPageContext(ctx, hint) {
    const c = this.sessionFor(ctx, hint);
    this.store.clearPageContext(c.id);
    return this.view(ctx, { id: c.id });
  }
}
