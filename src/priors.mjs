// Client-side loader for aggregated per-site navigation priors that seed the preemptive planner.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { etld1, pathTemplate } from './meta.mjs';

export const PRIORS_VERSION = 1;
export const bundledPriorsPath = () => join(dirname(fileURLToPath(import.meta.url)), '..', 'priors', 'default.json');

export function emptyPriors() {
  return { v: PRIORS_VERSION, updatedAt: 0, sites: [] };
}

export function loadPriors(path, { fallback } = {}) {
  const tryRead = (p) => {
    if (!p || !existsSync(p)) return null;
    try {
      const doc = JSON.parse(readFileSync(p, 'utf8'));
      return normalizePriors(doc);
    } catch (_) {
      return null;
    }
  };
  return tryRead(path) || tryRead(fallback) || tryRead(bundledPriorsPath()) || emptyPriors();
}

export function normalizePriors(doc = {}) {
  const sites = Array.isArray(doc.sites) ? doc.sites : [];
  return {
    v: Number(doc.v) || PRIORS_VERSION,
    updatedAt: Number(doc.updatedAt) || 0,
    sites: sites.slice(0, 5000).map((s) => ({
      domain: String(s.domain || '').toLowerCase(),
      path: pathTemplate(s.path || '/'),
      pageType: s.pageType || 'other',
      flows: Array.isArray(s.flows) ? s.flows.slice(0, 8).map((f) => ({
        goal: typeof f.goal === 'string' ? f.goal.slice(0, 80) : '',
        weight: Number(f.weight) || 0,
        steps: Array.isArray(f.steps) ? f.steps.slice(0, 8).map((st) => ({
          action: String(st.action || 'click').slice(0, 40),
          targetPattern: typeof st.targetPattern === 'string' ? st.targetPattern.slice(0, 120) : undefined,
          expect: st.expect && typeof st.expect === 'object' ? {
            url: typeof st.expect.url === 'string' ? st.expect.url.slice(0, 160) : undefined,
            title: typeof st.expect.title === 'string' ? st.expect.title.slice(0, 80) : undefined,
            visible: typeof st.expect.visible === 'string' ? st.expect.visible.slice(0, 120) : undefined,
          } : undefined,
        })) : [],
      })) : [],
    })).filter((s) => s.domain),
  };
}

export function lookupPriors(priors, { url, domain, path } = {}) {
  let d = domain, pth = path;
  if (url) {
    try {
      const u = new URL(url);
      d = etld1(u.hostname);
      pth = pathTemplate(u.pathname);
    } catch (_) {}
  }
  d = String(d || '').toLowerCase();
  pth = pathTemplate(pth || '/');
  const sites = (priors && priors.sites) || [];
  const exact = sites.filter((s) => s.domain === d && s.path === pth);
  const domainOnly = exact.length ? exact : sites.filter((s) => s.domain === d);
  const flows = domainOnly.flatMap((s) => (s.flows || []).map((f) => ({ ...f, domain: s.domain, path: s.path, pageType: s.pageType })));
  flows.sort((a, b) => (b.weight || 0) - (a.weight || 0));
  return { domain: d, path: pth, flows: flows.slice(0, 8) };
}
