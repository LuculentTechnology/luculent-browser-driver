// Minimal PDF text extraction (no dependencies). Inflates FlateDecode streams, reads Tj/TJ/'/" text operators,
// decodes literal and hex strings, and maps glyph codes through each font's ToUnicode CMap (subset/CID fonts).
// Good enough for agents to read typical text PDFs; scanned (image-only) PDFs come back empty.
import { inflateSync } from 'node:zlib';

function inflate(data) {
  try { return inflateSync(data); } catch (_) {}
  try { return inflateSync(data.subarray(0, data.length - 1)); } catch (_) {}
  return null;
}

// Parse "N G obj ... endobj" into { num: { dict, data } } (data = decoded stream bytes as latin1, if any).
function objects(buf) {
  const s = buf.toString('latin1');
  const out = new Map();
  const re = /(\d+)\s+\d+\s+obj\b/g;
  let m;
  while ((m = re.exec(s))) {
    const start = m.index + m[0].length;
    const end = s.indexOf('endobj', start);
    if (end < 0) break;
    const body = s.slice(start, end);
    const si = body.indexOf('stream');
    let dict = body, data = null;
    if (si >= 0 && /^\s*<</.test(body)) {
      dict = body.slice(0, si);
      let ds = start + si + 6;
      if (s[ds] === '\r') ds++;
      if (s[ds] === '\n') ds++;
      let de = s.indexOf('endstream', ds);
      if (de < 0) de = end;
      let raw = buf.subarray(ds, de);
      if (/\/FlateDecode/.test(dict)) raw = inflate(raw);
      else if (/\/Filter/.test(dict)) raw = null; // other filters (DCT, LZW...) are not text we can read
      data = raw ? raw.toString('latin1') : null;
    }
    out.set(Number(m[1]), { dict, data });
    re.lastIndex = end + 6;
  }
  return out;
}

function hexBytes(h) { h = h.replace(/[^0-9a-fA-F]/g, ''); if (h.length % 2) h += '0'; const b = []; for (let i = 0; i < h.length; i += 2) b.push(parseInt(h.slice(i, i + 2), 16)); return b; }
function utf16(bytes) { let s = ''; for (let i = 0; i + 1 < bytes.length; i += 2) s += String.fromCharCode((bytes[i] << 8) | bytes[i + 1]); return s; }

// ToUnicode CMap -> { width (code bytes), map: Map(code -> string) }
function parseCMap(src) {
  const map = new Map();
  let width = 1;
  const cs = /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*endcodespacerange/.exec(src) || /begincodespacerange\s*<([0-9a-fA-F]+)>/.exec(src);
  if (cs) width = Math.max(1, Math.ceil(cs[1].length / 2));
  for (const blk of src.match(/beginbfchar([\s\S]*?)endbfchar/g) || []) {
    const r = /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]*)>/g; let k;
    while ((k = r.exec(blk))) { width = Math.max(width, Math.ceil(k[1].length / 2)); map.set(parseInt(k[1], 16), utf16(hexBytes(k[2]))); }
  }
  for (const blk of src.match(/beginbfrange([\s\S]*?)endbfrange/g) || []) {
    const r = /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(?:<([0-9a-fA-F]+)>|\[([^\]]*)\])/g; let k;
    while ((k = r.exec(blk))) {
      const lo = parseInt(k[1], 16), hi = parseInt(k[2], 16);
      width = Math.max(width, Math.ceil(k[1].length / 2));
      if (hi - lo > 65535) continue;
      if (k[3] != null) { const base = hexBytes(k[3]); for (let c = lo; c <= hi; c++) { const b = base.slice(); b[b.length - 1] += c - lo; map.set(c, utf16(b)); } }
      else { const list = k[4].match(/<([0-9a-fA-F]*)>/g) || []; list.forEach((x, n) => map.set(lo + n, utf16(hexBytes(x.slice(1, -1))))); }
    }
  }
  return { width, map };
}

function unescapeLiteral(str) {
  const out = [];
  for (let i = 0; i < str.length; i++) {
    const c = str[i];
    if (c !== '\\') { out.push(c.charCodeAt(0) & 255); continue; }
    const n = str[++i];
    if (n === undefined) break;
    const o = /[0-7]/.test(n) ? /^[0-7]{1,3}/.exec(str.slice(i))[0] : null;
    if (o) { out.push(parseInt(o, 8) & 255); i += o.length - 1; }
    else if (n === '\r' || n === '\n') { if (n === '\r' && str[i + 1] === '\n') i++; }
    else out.push(({ n: 10, r: 13, t: 9, b: 8, f: 12 }[n] ?? n.charCodeAt(0)) & 255);
  }
  return out;
}

function decode(bytes, cmap) {
  if (!cmap) return String.fromCharCode(...bytes);
  let s = '';
  for (let i = 0; i < bytes.length; i += cmap.width) {
    let code = 0; for (let j = 0; j < cmap.width; j++) code = (code << 8) | (bytes[i + j] ?? 0);
    s += cmap.map.get(code) ?? (cmap.width === 1 ? String.fromCharCode(code) : '');
  }
  return s;
}

const ref = (dict, key) => { const m = new RegExp('/' + key + '\\s+(\\d+)\\s+\\d+\\s+R').exec(dict); return m ? Number(m[1]) : null; };

export function pdfText(buf, max = 20000) {
  if (!buf || buf.subarray(0, 5).toString('latin1') !== '%PDF-') throw new Error('not a PDF');
  const objs = objects(buf);
  // font resource name -> cmap (resource names are usually unique enough across a simple document)
  const cmapByObj = new Map();
  for (const [n, o] of objs) {
    if (!/\/Type\s*\/Font\b/.test(o.dict)) continue;
    const t = ref(o.dict, 'ToUnicode');
    const src = t != null && objs.get(t)?.data;
    if (src) cmapByObj.set(n, parseCMap(src));
  }
  const fontNames = new Map();
  const fontDicts = [];
  for (const [, o] of objs) {
    const inl = /\/Font\s*<<([\s\S]*?)>>/.exec(o.dict); if (inl) fontDicts.push(inl[1]);
    const ind = ref(o.dict, 'Font'); if (ind != null && objs.get(ind)) fontDicts.push(objs.get(ind).dict);
  }
  for (const d of fontDicts) { const r = /\/([^\s/<>\[\]()]+)\s+(\d+)\s+\d+\s+R/g; let k; while ((k = r.exec(d))) if (cmapByObj.has(Number(k[2]))) fontNames.set(k[1], cmapByObj.get(Number(k[2]))); }

  // content streams: everything referenced as /Contents, else any stream with text operators
  const contentIds = new Set();
  for (const [, o] of objs) {
    if (!/\/Type\s*\/Page\b/.test(o.dict)) continue;
    const c = /\/Contents\s*(\[[^\]]*\]|\d+\s+\d+\s+R)/.exec(o.dict);
    if (c) for (const x of c[1].matchAll(/(\d+)\s+\d+\s+R/g)) contentIds.add(Number(x[1]));
  }
  const contents = contentIds.size ? [...contentIds].map((i) => objs.get(i)?.data).filter(Boolean) : [...objs.values()].map((o) => o.data).filter((d) => d && /\bBT\b/.test(d));

  const parts = [];
  for (const st of contents) {
    let cmap = null, line = '', lastY = null;
    const brk = () => { if (line.trim()) parts.push(line.trim()); line = ''; };
    const re = /\/([^\s/<>\[\]()]+)\s+-?[\d.]+\s+Tf|\[((?:\\.|[^\]\\])*)\]\s*TJ|\(((?:\\.|[^\\)])*)\)\s*(?:Tj|'|")|<([0-9a-fA-F\s]*)>\s*(?:Tj|'|")|(-?[\d.]+)\s+(-?[\d.]+)\s+(Td|TD)\b|(?:-?[\d.]+\s+){5}(-?[\d.]+)\s+Tm\b|(T\*|ET)\b/g;
    let m;
    while ((m = re.exec(st))) {
      if (m[1] != null) cmap = fontNames.get(m[1]) || null;
      else if (m[2] != null) {
        const r = /\(((?:\\.|[^\\)])*)\)|<([0-9a-fA-F\s]*)>|(-?\d+\.?\d*)/g; let k;
        while ((k = r.exec(m[2]))) { if (k[1] != null) line += decode(unescapeLiteral(k[1]), cmap); else if (k[2] != null) line += decode(hexBytes(k[2]), cmap); else if (Number(k[3]) < -200) line += ' '; }
      } else if (m[3] != null) line += decode(unescapeLiteral(m[3]), cmap);
      else if (m[4] != null) line += decode(hexBytes(m[4]), cmap);
      // Td/TD: relative move; only a vertical move starts a new line (kerned words are positioned glyph run by glyph run)
      else if (m[7] != null) { const dy = Number(m[6]); if (Math.abs(dy) > 0.5) brk(); }
      else if (m[8] != null) { const y = Number(m[8]); if (lastY !== null && Math.abs(y - lastY) > 0.5) brk(); lastY = y; }
      else brk();
    }
    if (line.trim()) parts.push(line.trim());
  }
  const pages = [...objs.values()].filter((o) => /\/Type\s*\/Page\b/.test(o.dict)).length || (buf.toString('latin1').match(/\/Type\s*\/Page\b/g) || []).length;
  const text = parts.map((p) => p.replace(/ {2,}/g, ' ')).join('\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffd]/g, '');
  return { pages, text: text.length > max ? text.slice(0, max) + '...' : text };
}
