// MCP stdio server: newline-delimited JSON-RPC on stdin/stdout, proxied to the relay over one persistent WebSocket.
import WebSocket from 'ws';
import { existsSync, readFileSync } from 'node:fs';
import { handleMcp } from './mcp-tools.mjs';
import { DEFAULT_PORT } from './relay.mjs';

export function relayClient({ url, key }) {
  let ws = null, opening = null, seq = 0;
  const pending = new Map();
  const open = () => {
    if (ws && ws.readyState === 1) return Promise.resolve(ws);
    if (opening) return opening;
    opening = new Promise((res, rej) => {
      const s = new WebSocket(url, { headers: { authorization: `Bearer ${key}` }, perMessageDeflate: false });
      s.once('open', () => { s._socket && s._socket.setNoDelay(true); ws = s; opening = null; res(s); });
      s.once('error', (e) => { opening = null; rej(new Error(`Cannot reach the browser-driver relay at ${url} (${e.message}). Start it with: lbd start`)); });
      s.once('unexpected-response', (_req, r) => { opening = null; rej(new Error(r.statusCode === 401 ? 'Relay rejected the API key (LBD_KEY)' : r.statusCode === 423 ? 'Killswitch is engaged (lbd resume)' : `Relay refused connection: HTTP ${r.statusCode}`)); });
      s.on('message', (buf) => {
        const m = JSON.parse(buf.toString());
        const p = pending.get(m.id); if (!p) return; pending.delete(m.id);
        m.error ? p.rej(new Error(m.error.message)) : p.res(m.result);
      });
      s.on('close', (code, reason) => { if (ws === s) ws = null; for (const p of pending.values()) p.rej(new Error(`relay connection closed ${code} ${reason}`)); pending.clear(); });
    });
    return opening;
  };
  const rpc = async (method, params) => {
    const s = await open();
    const id = ++seq;
    return new Promise((res, rej) => { pending.set(id, { res, rej }); s.send(JSON.stringify({ id, method, params })); });
  };
  rpc.close = () => { if (ws) ws.close(); };
  return rpc;
}

export function resolveKey(key) {
  if (key) return key;
  const file = process.env.LBD_KEY_FILE;
  if (file && existsSync(file)) return readFileSync(file, 'utf8').trim();
  return process.env.LBD_KEY;
}

export function runStdio({ port = Number(process.env.LBD_PORT) || DEFAULT_PORT, key = resolveKey(), url } = {}) {
  if (!key) { process.stderr.write('LBD_KEY or LBD_KEY_FILE is not set. Mint one with: lbd keys mint --name my-agent\n'); process.exit(2); }
  const rpc = relayClient({ url: url || process.env.LBD_URL || `ws://127.0.0.1:${port}/v1/ws`, key });
  let buf = '';
  const out = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line) continue;
      let msg; try { msg = JSON.parse(line); } catch (_) { out({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); continue; }
      const msgs = Array.isArray(msg) ? msg : [msg];
      for (const m of msgs) handleMcp(m, rpc).then((r) => r && out(r));
    }
  });
  process.stdin.on('end', () => { rpc.close(); process.exit(0); });
}
