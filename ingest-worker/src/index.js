// Scaffold ingest Worker. Do not deploy. No storage bindings are attached.
import { validateEvent, SUPPORTED_SCHEMA } from './schema.js';

async function readBody(request) {
  const encoding = (request.headers.get('content-encoding') || '').toLowerCase();
  if (encoding === 'gzip') {
    const ds = new DecompressionStream('gzip');
    const stream = request.body && request.body.pipeThrough(ds);
    return new Response(stream).text();
  }
  return request.text();
}

export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/health') {
      return Response.json({ ok: true, deploy: false, schemas: [...SUPPORTED_SCHEMA] });
    }
    if (request.method !== 'POST' || url.pathname !== '/v1/nav-meta') {
      return new Response('not found', { status: 404 });
    }
    const schema = Number(request.headers.get('x-lbd-meta-schema') || '');
    if (!SUPPORTED_SCHEMA.has(schema)) return Response.json({ ok: false, error: 'schema' }, { status: 400 });
    let body = '';
    try { body = await readBody(request); } catch (_) {
      return Response.json({ ok: false, error: 'body' }, { status: 400 });
    }
    const lines = body.split(/\n+/).map((l) => l.trim()).filter(Boolean);
    let accepted = 0, dropped = 0;
    for (const line of lines) {
      let ev;
      try { ev = JSON.parse(line); } catch (_) { dropped++; continue; }
      const v = validateEvent(ev);
      if (v.ok) accepted++; else dropped++;
    }
    // Storage is intentionally not wired. Accepted counts are returned so a future deploy can be verified.
    return Response.json({ ok: true, accepted, dropped, stored: 0, deploy: false });
  },
};
