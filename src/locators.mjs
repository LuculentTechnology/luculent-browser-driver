// Per-site element locator cache, seeded from priors and filled in from successful hits (LUC-3085).
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import { etld1 } from './meta.mjs';

export function siteKey(url) {
  try {
    const u = new URL(url);
    return etld1(u.hostname) + (u.pathname.replace(/\/+$/, '') || '/');
  } catch (_) {
    return String(url || '');
  }
}

export function hintKey(target, extra = {}) {
  if (target && typeof target === 'object') {
    return [extra.role || target.role, extra.name || target.name, target.selector || target.css || ''].filter(Boolean).join('|');
  }
  return String(target || extra.role || '') + (extra.name ? '|' + extra.name : '');
}

export class LocatorCache {
  constructor(path, { max = 2000 } = {}) {
    this.path = path;
    this.max = max;
    this.map = new Map();
    this.dirty = false;
    this._load();
  }

  _load() {
    if (!this.path || !existsSync(this.path)) return;
    try {
      const doc = JSON.parse(readFileSync(this.path, 'utf8'));
      for (const row of doc.entries || []) {
        if (row && row.key && row.target) this.map.set(row.key, { target: row.target, hits: row.hits || 1, at: row.at || 0 });
      }
    } catch (_) {}
  }

  persist() {
    if (!this.path || !this.dirty) return;
    try {
      mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
      const entries = [...this.map.entries()]
        .sort((a, b) => (b[1].at || 0) - (a[1].at || 0))
        .slice(0, this.max)
        .map(([key, v]) => ({ key, target: v.target, hits: v.hits || 1, at: v.at || 0 }));
      const tmp = this.path + '.tmp';
      writeFileSync(tmp, JSON.stringify({ v: 1, entries }, null, 2), { mode: 0o600 });
      renameSync(tmp, this.path);
      this.dirty = false;
    } catch (_) {}
  }

  _id(url, target, extra) {
    return siteKey(url) + '::' + hintKey(target, extra);
  }

  /** True when this site (eTLD+1) has any cached locator, so the planner may use concrete targets there. */
  hasSite(domain) {
    if (!domain) return false;
    const d = String(domain).toLowerCase();
    for (const key of this.map.keys()) if (key.startsWith(d + '/')) return true;
    return false;
  }

  get(url, target, extra = {}) {
    const rec = this.map.get(this._id(url, target, extra));
    return rec && rec.target ? rec.target : null;
  }

  put(url, target, resolved, extra = {}) {
    if (!url || resolved == null || resolved === '') return;
    const id = this._id(url, target, extra);
    const prev = this.map.get(id);
    this.map.set(id, { target: String(resolved), hits: (prev && prev.hits || 0) + 1, at: Date.now() });
    this.dirty = true;
    if (this.map.size % 20 === 0) this.persist();
  }
}
