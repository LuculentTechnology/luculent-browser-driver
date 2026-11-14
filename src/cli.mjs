#!/usr/bin/env node
// lbd: Luculent Browser Driver for AI Agents CLI.
import { readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { KeyStore, DEFAULT_SCOPES, ALL_SCOPES } from './keys.mjs';
import { PolicyStore, DEFAULT_POLICY, BANKING_PRESET } from './policy.mjs';
import { Relay, DEFAULT_PORT } from './relay.mjs';
import { runStdio } from './mcp-stdio.mjs';
import { HeadlessBrowser, findChrome, findPlaywrightChromium } from './headless.mjs';
import { setup, CLIENTS } from './onboard.mjs';
import { resolveKey } from './mcp-stdio.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = (name, dflt) => { const i = args.indexOf('--' + name); if (i < 0) return dflt; const v = args[i + 1]; return v && !v.startsWith('--') ? v : true; };
const port = Number(flag('port', process.env.LBD_PORT || DEFAULT_PORT));
const base = `http://127.0.0.1:${port}`;
const keys = new KeyStore();

async function admin(path, body = {}) {
  const r = await fetch(base + path, { method: 'POST', headers: { 'x-lbd-admin': keys.adminToken(), 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return r.json();
}

const HELP = `lbd - Luculent Browser Driver for AI Agents
  lbd start [--port 47800]               run the relay (agents connect here)
  lbd keys mint --name grok [--scopes read,act,tabs,headless] [--origins example.com,*.github.com] [--days 30]
  lbd keys list | lbd keys revoke <id|name>
  lbd kill                                killswitch: drop all agents, detach every tab, refuse calls
  lbd resume                              release the killswitch
  lbd status                              relay + extension status
  lbd policy [get]                        show security settings (relay ceiling for every agent)
  lbd policy set key=value ...            e.g. passwords=deny eval=confirm readOnly=true blocklist=a.com,b.com
                                          values: allow | confirm (ask me) | deny; bankingPreset=false to allow banks
  lbd policy reset                        back to the safe defaults
  lbd pending                             approvals waiting for you
  lbd approve <id> | lbd deny <id>        answer an approval (headless tabs; Chrome tabs ask in the extension)
  lbd audit [--n 50]                      recent agent actions and refusals
  lbd mcp                                 MCP stdio server (needs LBD_KEY)
  lbd chrome [--profile DIR] [--headed]   open a separate Chromium profile with the extension loaded
  lbd setup [--clients claude-code,cursor,gemini,codex,claude-desktop] [--start-at-logon] [--dry-run]
                                         mint a key to a file, write MCP configs (paths only; the key is never printed)
Scopes: ${ALL_SCOPES.join(', ')} (default ${DEFAULT_SCOPES.join(',')})
  Sensitive scopes (eval, cookies, storage, upload, passwords, files, cdp) only work if the security settings allow them too.
Data dir (keys, state): ${keys.home}`;

const [cmd, sub, arg] = args;
switch (cmd) {
  case 'start': case 'relay': {
    const relay = await new Relay({ port }).start();
    if (relay.killed) console.error('[lbd] NOTE: killswitch is engaged; run `lbd resume` to allow agents.');
    const stop = async () => { await relay.stop(); process.exit(0); };
    process.on('SIGINT', stop); process.on('SIGTERM', stop);
    break;
  }
  case 'keys': {
    if (sub === 'mint') {
      const k = keys.mint({ name: flag('name', 'agent'), scopes: String(flag('scopes', DEFAULT_SCOPES.join(','))).split(',').filter(Boolean), allowOrigins: flag('origins') ? String(flag('origins')).split(',') : [], expiresDays: flag('days') ? Number(flag('days')) : undefined });
      if (flag('json')) console.log(JSON.stringify(k));
      else console.log(`Minted key "${k.name}" (${k.id}) scopes=${k.scopes.join(',')}${k.allowOrigins.length ? ' origins=' + k.allowOrigins.join(',') : ''}\n\n  ${k.token}\n\nShown once. Store it in your agent's secret store (env LBD_KEY).`);
    } else if (sub === 'revoke') {
      console.log(`revoked ${keys.revoke(arg)} key(s)`);
    } else {
      for (const k of keys.list()) console.log(`${k.id}  ${k.name.padEnd(16)} ${k.revokedAt ? 'REVOKED ' : 'active  '} ${k.scopes.join(',')}${k.allowOrigins?.length ? '  origins=' + k.allowOrigins.join(',') : ''}  created ${k.createdAt}`);
    }
    break;
  }
  case 'kill': {
    keys.setState({ killed: true, killedAt: new Date().toISOString(), reason: 'cli' });
    try { console.log(await admin('/v1/admin/kill')); } catch (_) { console.log('relay not running; killswitch saved and will apply on next start'); }
    break;
  }
  case 'resume': {
    keys.setState({ killed: false });
    try { console.log(await admin('/v1/admin/resume')); } catch (_) { console.log('killswitch released (relay not running)'); }
    break;
  }
  case 'status': {
    try { const r = await fetch(base + '/v1/rpc', { method: 'POST', headers: { 'x-lbd-admin': keys.adminToken(), 'content-type': 'application/json' }, body: JSON.stringify({ method: 'status' }) }); console.log(JSON.stringify((await r.json()).result || {}, null, 2)); }
    catch (_) { console.log(`relay not running on ${base}`); process.exitCode = 1; }
    break;
  }
  case 'policy': {
    const store = new PolicyStore(keys.home);
    const parse = (v) => v === 'true' ? true : v === 'false' ? false : /^\d+$/.test(v) ? Number(v) : v;
    let next = null;
    if (sub === 'set') {
      const patch = {};
      for (const kv of args.slice(2)) {
        const i = kv.indexOf('='); if (i < 0) continue;
        const k = kv.slice(0, i), v = kv.slice(i + 1);
        if (k === 'blocklist' || k === 'allowlist') patch[k] = v ? v.split(',').map((x) => x.trim()).filter(Boolean) : [];
        else if (k === 'perSecond' || k === 'perMinute') patch.rateLimit = { ...(patch.rateLimit || store.get().rateLimit), [k]: Number(v) };
        else patch[k] = parse(v);
      }
      next = patch;
    } else if (sub === 'reset') next = { ...DEFAULT_POLICY };
    if (next) {
      try { const r = await admin('/v1/admin/policy', next); console.log(JSON.stringify(r.policy || r, null, 2)); }
      catch (_) { console.log(JSON.stringify(store.set(next), null, 2)); }
    } else console.log(JSON.stringify(store.get(), null, 2) + '\nBanking/payment preset (' + BANKING_PRESET.length + ' entries) blocks: ' + BANKING_PRESET.slice(0, 8).join(', ') + ', ...');
    break;
  }
  case 'pending': {
    try { const r = await admin('/v1/admin/pending'); const p = (r.pending || []); console.log(p.length ? p.map((x) => `${x.id}  ${x.key} wants to ${x.summary}  (${x.url || ''})`).join('\n') : 'nothing waiting'); }
    catch (_) { console.log('relay not running'); process.exitCode = 1; }
    break;
  }
  case 'approve': case 'deny': {
    if (!sub) { console.log('usage: lbd ' + cmd + ' <id>'); break; }
    try { const r = await admin('/v1/admin/confirm', { id: sub, allow: cmd === 'approve' }); console.log(r.ok ? (cmd === 'approve' ? 'approved' : 'denied') : 'no such pending request (it may have expired)'); }
    catch (_) { console.log('relay not running'); process.exitCode = 1; }
    break;
  }
  case 'audit': {
    try { const r = await admin('/v1/admin/audit', { limit: Number(flag('n', 50)) }); for (const e of r.entries || []) console.log(`${e.at || ''}  ${(e.key || e.source || '-').padEnd(12)} ${(e.method || '').padEnd(14)} ${e.result || ''}${e.reason ? '  ' + e.reason : ''}${e.url ? '  ' + e.url : ''}`); }
    catch (_) { console.log('relay not running; the log file is ' + join(keys.home, 'audit.log')); }
    break;
  }
  case 'mcp': runStdio({ port }); break;
  case 'chrome': {
    const ext = resolve(here, '..', 'extension');
    const profile = flag('profile', join(keys.home, 'chrome-profile'));
    const chrome = flag('chrome', process.env.LBD_CHROME || findPlaywrightChromium() || findChrome());
    const b = await HeadlessBrowser.launch({ chromePath: chrome, headless: !flag('headed') ? !!flag('headless') : false, extensionPath: ext, userDataDir: profile });
    console.log(`Chromium running (profile ${profile}) with the extension loaded. Ctrl+C to close.`);
    process.on('SIGINT', async () => { await b.close(); process.exit(0); });
    break;
  }
  case 'setup': {
    const clients = flag('clients') ? String(flag('clients')).split(',').map((s) => s.trim()).filter(Boolean) : CLIENTS;
    const r = await setup({
      home: keys.home, keys, clients, port,
      startAtLogon: !!flag('start-at-logon'), startNow: !flag('no-start'), dryRun: !!flag('dry-run'),
    });
    console.log('Key file: ' + r.keyFile);
    for (const w of r.written) console.log('  ' + w.client + '  ' + w.path);
    if (r.task) console.log('Logon task: ' + (r.task.dryRun ? 'dry-run ' : '') + (r.task.name || 'Luculent Browser Driver Relay') + (r.task.installed ? ' installed' : ''));
    if (r.started) console.log('Relay start requested (hidden).');
    break;
  }
  default: console.log(HELP);
}
