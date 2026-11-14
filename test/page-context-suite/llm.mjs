// Opt-in live LLM helper for the page-context suite. Never logs key material.
// Tries Gemini API keys (env or known slot files), then OpenRouter.
import { readFileSync, existsSync } from 'node:fs';

const GEMINI_FILES = [
  process.env.GEMINI_API_KEY_FILE,
  process.env.GEMINI_KEY_FILE,
].filter(Boolean);

function readKeyFile(p) {
  if (!p || !existsSync(p)) return null;
  const raw = readFileSync(p, 'utf8').replace(/^\uFEFF/, '').trim();
  if (!raw) return null;
  if (raw.startsWith('{')) {
    try {
      const o = JSON.parse(raw);
      return o.key || o.apiKey || o.api_key || o.token || o.GEMINI_API_KEY || o.OPENROUTER_API_KEY || null;
    } catch (_) { return null; }
  }
  const line = raw.split(/\r?\n/).map((l) => l.trim()).find((l) => l && !l.startsWith('#') && !l.includes('='));
  const kv = raw.split(/\r?\n/).map((l) => l.trim()).find((l) => /^(GEMINI_API_KEY|GOOGLE_API_KEY|OPENROUTER_API_KEY|API_KEY)\s*=/.test(l));
  if (kv) return kv.split('=').slice(1).join('=').trim().replace(/^["']|["']$/g, '');
  return line || raw;
}

function firstEnv(names) {
  for (const n of names) {
    const v = process.env[n];
    if (v && String(v).trim()) return { name: n, value: String(v).trim(), source: 'env:' + n };
  }
  return null;
}

function loadProvider() {
  const geminiEnv = firstEnv(['GEMINI_API_KEY', 'GEMINI_API_KEY_1', 'GOOGLE_API_KEY', 'GOOGLE_AI_API_KEY']);
  if (geminiEnv) return { provider: 'gemini', ...geminiEnv };
  for (const f of GEMINI_FILES) {
    const v = readKeyFile(f);
    if (v) return { provider: 'gemini', value: v, source: 'file', name: 'file' };
  }
  // Optional numbered slot files used by builder seats (path only; contents never logged).
  const slots = [];
  const dir = process.env.GEMINI_KEYS_DIR || process.env.LBD_GEMINI_KEYS_DIR;
  if (dir) {
    for (const n of ['1', '2', '3', '4', '5', 'g1', 'g2', 'g3', 'g4', 'g5']) {
      for (const name of [n, n + '.key', n + '.txt', 'gemini-' + n + '.key', 'key-' + n]) {
        slots.push(dir.replace(/[\\/]$/, '') + '/' + name);
      }
    }
  }
  for (const f of slots) {
    const v = readKeyFile(f);
    if (v) return { provider: 'gemini', value: v, source: 'file', name: 'slot' };
  }
  const or = firstEnv(['OPENROUTER_API_KEY', 'OR_API_KEY']);
  if (or) return { provider: 'openrouter', ...or };
  return null;
}

async function geminiComplete(key, prompt, model) {
  const models = [model, 'gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-flash-latest', 'gemini-2.5-flash-lite'].filter(Boolean);
  let last = null;
  for (const m of [...new Set(models)]) {
    const url = 'https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(m) + ':generateContent';
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig: { temperature: 0.2, maxOutputTokens: 800 } }),
    });
    const text = await res.text();
    if (!res.ok) { last = 'gemini ' + m + ' HTTP ' + res.status; continue; }
    let data;
    try { data = JSON.parse(text); } catch { last = 'gemini ' + m + ' bad json'; continue; }
    const out = (data.candidates || []).map((c) => (c.content?.parts || []).map((p) => p.text || '').join('')).join('\n').trim();
    if (out) return { text: out, model: m, provider: 'Google' };
    last = 'gemini ' + m + ' empty';
  }
  throw new Error(last || 'gemini failed');
}

async function openrouterModels(key) {
  try {
    const res = await fetch('https://openrouter.ai/api/v1/models', { headers: { authorization: 'Bearer ' + key } });
    if (!res.ok) return [];
    const data = await res.json();
    return (data.data || []).map((x) => x.id).filter(Boolean);
  } catch (_) { return []; }
}

function shortErr(status, text) {
  let msg = '';
  try { const j = JSON.parse(text); msg = j.error?.message || j.error?.code || ''; } catch (_) {}
  msg = String(msg).replace(/sk-[A-Za-z0-9_\-]{8,}/g, '[redacted]').replace(/or-[A-Za-z0-9_\-]{8,}/g, '[redacted]').replace(/Bearer\s+\S+/g, 'Bearer [redacted]');
  // Keep the first line, drop policy essays
  msg = msg.split('\n')[0].slice(0, 160);
  return 'HTTP ' + status + (msg ? ' ' + msg : '');
}

async function openrouterComplete(key, prompt, model) {
  const preferred = [model, 'deepseek/deepseek-v4.1-flash-1017', 'openrouter/auto', 'google/gemini-2.5-flash', 'nvidia/nemotron-3.5-super-vl:free'].filter(Boolean);
  const available = await openrouterModels(key);
  const models = [...new Set([...preferred, ...available.slice(0, 5)])];
  const errors = [];
  for (const m of models) {
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key, 'HTTP-Referer': 'https://luculent.dev', 'X-Title': 'Luculent Browser Driver suite' },
      body: JSON.stringify({ model: m, temperature: 0.2, max_tokens: 800, messages: [{ role: 'user', content: prompt }] }),
    });
    const text = await res.text();
    if (!res.ok) { errors.push(m + ' ' + shortErr(res.status, text)); continue; }
    let data;
    try { data = JSON.parse(text); } catch { errors.push(m + ' bad json'); continue; }
    const out = (data.choices || []).map((c) => c.message?.content || '').join('\n').trim();
    if (out) return { text: out, model: data.model || m, provider: 'OpenRouter' };
    errors.push(m + ' empty');
  }
  throw new Error('openrouter failed: ' + errors.slice(0, 4).join('; '));
}

export function llmAvailable() {
  return !!loadProvider();
}

export function llmSource() {
  const p = loadProvider();
  if (!p) return null;
  return { provider: p.provider, source: p.source, name: p.name };
}

export async function llmComplete(prompt, { model } = {}) {
  const p = loadProvider();
  if (!p) throw new Error('no Gemini or OpenRouter key configured');
  if (p.provider === 'gemini') return geminiComplete(p.value, prompt, model);
  return openrouterComplete(p.value, prompt, model);
}

export function blurbPrompt(ctx) {
  const body = [
    'Here is the current page context. Reply with a quick blurb of what this page is, then ask what you can answer about the page\'s content.',
    '',
    'Page: ' + (ctx.title || '(untitled)') + (ctx.url ? ' - ' + ctx.url : ''),
    ctx.headings?.length ? 'Headings: ' + ctx.headings.slice(0, 12).join(' | ') : '',
    '',
    (ctx.text || '').slice(0, 8000),
  ].filter(Boolean).join('\n');
  return body;
}

export function followUpPrompt(ctx, blurb, question) {
  return [
    'You already summarized this page as:',
    blurb,
    '',
    'Page title: ' + (ctx.title || ''),
    'Page URL: ' + (ctx.url || ''),
    'Headings: ' + (ctx.headings || []).slice(0, 8).join(' | '),
    'Page text:',
    (ctx.text || '').slice(0, 8000),
    '',
    'Answer the user question using the page content. Quote a short phrase that actually appears on the page.',
    'Question: ' + question,
  ].join('\n');
}
