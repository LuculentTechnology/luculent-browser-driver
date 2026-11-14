// Pull page context for the side-panel chat.
// Extracted from the active tab, sanitized, size-capped, and attached to a chat so follow-ups carry it.
import { redactSecrets } from './chats.mjs';

export const PAGE_CONTEXT_MAX = 20000;
export const PAGE_CONTEXT_INSTRUCTION = "Here is the current page context. Reply with a quick blurb of what this page is, then ask what you can answer about the page's content.";
export const PULL_BUTTON_LABEL = "Pull page context";

const BLOCK_PREFIX = "Blocked by your Luculent security settings";

export function pageContextChip(ctx) {
  if (!ctx) return null;
  return { title: ctx.title || ctx.url || "Page", url: ctx.url || "", truncated: !!ctx.truncated };
}

function stripTags(html) {
  return String(html || "").replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<noscript[\s\S]*?<\/noscript>/gi, " ");
}

function textOf(html) {
  return stripTags(html).replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/\s+/g, " ").trim();
}

/** Pull a structured snapshot out of an HTML string (used by tests and as a fallback). */
export function extractPageContext({ title, url, html = "", text, selection = "", extractedAt } = {}) {
  const src = stripTags(html);
  const headings = [];
  const headingRe = /<h([1-4])\b[^>]*>([\s\S]*?)<\/h\1>/gi;
  let m;
  while ((m = headingRe.exec(src)) && headings.length < 40) {
    const t = textOf(m[2]);
    if (t) headings.push(t);
  }
  const links = [];
  const linkRe = /<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  while ((m = linkRe.exec(src)) && links.length < 40) {
    const href = m[1];
    if (/^(javascript:|mailto:|#$)/i.test(href)) continue;
    const label = textOf(m[2]);
    if (label || href) links.push({ text: label, href });
  }
  const tables = [];
  const tableRe = /<table\b[^>]*>([\s\S]*?)<\/table>/gi;
  while ((m = tableRe.exec(src)) && tables.length < 8) {
    const rows = [];
    const rowRe = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
    let r;
    while ((r = rowRe.exec(m[1])) && rows.length < 12) {
      const cells = [];
      const cellRe = /<t[hd]\b[^>]*>([\s\S]*?)<\/t[hd]>/gi;
      let c;
      while ((c = cellRe.exec(r[1]))) cells.push(textOf(c[1]));
      if (cells.length) rows.push(cells);
    }
    if (rows.length) tables.push(rows);
  }
  // Readable text: provided text, else body-like HTML, never include password field values.
  const cleanedHtml = src.replace(/<input\b[^>]*type\s*=\s*["']password["'][^>]*>/gi, "");
  const readable = (text != null ? String(text) : textOf(cleanedHtml)).trim();
  return {
    title: title || "",
    url: url || "",
    text: readable,
    headings,
    links,
    tables,
    selection: selection ? String(selection) : "",
    extractedAt: extractedAt || Date.now(),
  };
}

function capList(list, maxItems, budget) {
  const out = [];
  let used = 0;
  for (const item of list.slice(0, maxItems)) {
    const n = JSON.stringify(item).length;
    if (used + n > budget) break;
    out.push(item);
    used += n;
  }
  return { items: out, used, truncated: out.length < Math.min(list.length, maxItems) || list.length > maxItems };
}

/** Apply security guards and a size cap. Throws on a blocked site. */
export function sanitizePageContext(raw = {}, { maxChars = PAGE_CONTEXT_MAX, blockedReason = null } = {}) {
  if (blockedReason) {
    const err = new Error(BLOCK_PREFIX + ": " + blockedReason);
    err.denied = true;
    err.status = 403;
    throw err;
  }
  const src = raw.html && !raw.text && !raw.headings ? extractPageContext(raw) : raw;
  const ctx = {
    title: redactSecrets(src.title || ""),
    url: String(src.url || ""),
    headings: (src.headings || []).map((h) => redactSecrets(h)).filter(Boolean).slice(0, 40),
    links: (src.links || []).slice(0, 40).map((l) => ({ text: redactSecrets(l.text || l.label || ""), href: String(l.href || "") })),
    tables: (src.tables || []).slice(0, 8).map((rows) => (rows || []).slice(0, 12).map((row) => (row || []).map((cell) => redactSecrets(cell)))),
    selection: src.selection ? redactSecrets(src.selection) : "",
    text: redactSecrets(src.text || ""),
    extractedAt: src.extractedAt || Date.now(),
    truncated: false,
  };
  // Reserve most of the budget for main text. Shrink links/tables/headings first so a long article
  // is not reduced to a 500-character stub because the nav metadata filled the cap.
  const reserve = Math.max(8000, Math.floor(maxChars * 0.6));
  const metaOf = (c) => JSON.stringify({ title: c.title, url: c.url, headings: c.headings, links: c.links, tables: c.tables, selection: c.selection }).length;
  while (metaOf(ctx) > maxChars - reserve) {
    const links = ctx.links.length, tables = ctx.tables.length, heads = ctx.headings.length;
    if (links > 8) ctx.links = ctx.links.slice(0, Math.max(8, Math.ceil(links / 2)));
    else if (tables > 2) ctx.tables = ctx.tables.slice(0, Math.max(2, tables - 2));
    else if (heads > 16) ctx.headings = ctx.headings.slice(0, 16);
    else if (links > 0) ctx.links = ctx.links.slice(0, Math.max(0, links - 2));
    else if (tables > 0) ctx.tables = ctx.tables.slice(0, tables - 1);
    else if (heads > 8) ctx.headings = ctx.headings.slice(0, 8);
    else break;
    ctx.truncated = true;
  }
  let budget = Math.max(reserve, maxChars - metaOf(ctx));
  if (ctx.text.length > budget) {
    ctx.text = ctx.text.slice(0, budget) + "…";
    ctx.truncated = true;
  }
  const total = JSON.stringify(ctx).length;
  if (total > maxChars + 2048) {
    ctx.links = capList(ctx.links, 8, 800).items;
    ctx.tables = capList(ctx.tables, 2, 800).items;
    ctx.headings = ctx.headings.slice(0, 16);
    ctx.truncated = true;
    const used = JSON.stringify({ title: ctx.title, url: ctx.url, headings: ctx.headings, links: ctx.links, tables: ctx.tables, selection: ctx.selection }).length;
    const keep = Math.max(reserve, maxChars - used);
    if (ctx.text.length > keep) ctx.text = ctx.text.slice(0, keep) + "…";
  }
  return ctx;
}

export function pageContextMessage(ctx) {
  const chip = pageContextChip(ctx);
  const lines = [
    PAGE_CONTEXT_INSTRUCTION,
    "",
    "Page: " + (ctx.title || "(untitled)") + (ctx.url ? " — " + ctx.url : ""),
  ];
  if (ctx.headings?.length) lines.push("Headings: " + ctx.headings.slice(0, 12).join(" | "));
  if (ctx.selection) lines.push("Selection: " + ctx.selection);
  if (ctx.text) lines.push("", ctx.text);
  return { from: "user", text: lines.join("\n"), kind: "page-context", pageTitle: chip?.title };
}
