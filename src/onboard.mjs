// One-click setup: mint a key to a file, write MCP configs, optionally start the relay at logon.
// Setup results report file paths only — never the API key itself.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { DEFAULT_SCOPES } from './keys.mjs';

export const CLIENTS = ['claude-desktop', 'claude-code', 'cursor', 'gemini', 'codex'];
export const NATIVE_HOST = 'com.luculent.browser_driver';
export const TASK_NAME = 'Luculent Browser Driver Relay';

const here = dirname(fileURLToPath(import.meta.url));
export const defaultCliPath = () => resolve(here, 'cli.mjs');

export function defaultPaths(userHome = homedir(), env = process.env) {
  const appData = env.APPDATA || join(userHome, 'AppData', 'Roaming');
  return {
    'claude-desktop': join(appData, 'Claude', 'claude_desktop_config.json'),
    'claude-code': join(userHome, '.claude.json'),
    'cursor': join(userHome, '.cursor', 'mcp.json'),
    'gemini': join(userHome, '.gemini', 'settings.json'),
    'codex': join(userHome, '.codex', 'config.toml'),
  };
}

export function mcpStdioBlock({ nodePath, cliPath, keyFile, port }) {
  return {
    command: nodePath,
    args: [cliPath, 'mcp'],
    env: { LBD_KEY_FILE: keyFile, ...(port ? { LBD_PORT: String(port) } : {}) },
  };
}

function readJson(p) { try { return JSON.parse(readFileSync(p, 'utf8')); } catch (_) { return {}; } }
function writeJson(p, obj) {
  mkdirSync(dirname(p), { recursive: true, mode: 0o700 });
  const tmp = p + '.tmp';
  writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', { mode: 0o600 });
  renameSync(tmp, p);
}

/** Merge our MCP server into a JSON config; any other keys and servers are left alone. */
export function mergeJsonMcp(p, serverName, block) {
  const doc = readJson(p);
  const servers = { ...(doc.mcpServers || {}) };
  servers[serverName] = block;
  writeJson(p, { ...doc, mcpServers: servers });
  return p;
}

/** Minimal TOML merge for Codex: replace or append [mcp_servers.<name>] and its .env table. */
export function mergeTomlMcp(p, serverName, block) {
  let src = '';
  try { src = readFileSync(p, 'utf8'); } catch (_) { src = ''; }
  const header = '[mcp_servers.' + serverName + ']';
  const envHeader = '[mcp_servers.' + serverName + '.env]';
  const re = new RegExp('\\n?\\[mcp_servers\\.' + serverName.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&') + '(?:\\.env)?\\][\\s\\S]*?(?=\\n\\[|$)', 'g');
  let rest = src.replace(re, '').replace(/\s+$/, '');
  const args = JSON.stringify(block.args);
  let section = header + '\ncommand = ' + jsonToml(block.command) + '\nargs = ' + args + '\n';
  if (block.env && Object.keys(block.env).length) {
    section += '\n' + envHeader + '\n';
    for (const [k, v] of Object.entries(block.env)) section += k + ' = ' + jsonToml(String(v)) + '\n';
  }
  const out = (rest ? rest + '\n\n' : '') + section;
  mkdirSync(dirname(p), { recursive: true, mode: 0o700 });
  const tmp = p + '.tmp';
  writeFileSync(tmp, out, { mode: 0o600 });
  renameSync(tmp, p);
  return p;
}
function jsonToml(s) { return JSON.stringify(s); }

export function keyFilePath(home, name = 'default') { return join(home, 'keys', name + '.key'); }

/** Write the API key to a 0600 file. Returns the path only. */
export function writeKeyFile(file, token) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = file + '.tmp';
  writeFileSync(tmp, String(token).trim() + '\n', { mode: 0o600 });
  renameSync(tmp, file);
  return file;
}

export function readKeyFile(file) {
  return readFileSync(file, 'utf8').trim();
}

export function taskSpec({ nodePath, cliPath, port }) {
  return {
    name: TASK_NAME,
    command: nodePath,
    args: [cliPath, 'start', ...(port ? ['--port', String(port)] : [])],
    hidden: true,
    when: 'onlogon',
  };
}

export function nativeHostSpec({ nodePath, cliPath, extensionId }) {
  return {
    name: NATIVE_HOST,
    manifest: {
      name: NATIVE_HOST,
      description: 'Luculent Browser Driver for AI Agents',
      path: nodePath,
      type: 'stdio',
      allowed_origins: extensionId ? ['chrome-extension://' + extensionId + '/'] : [],
    },
    args: [cliPath, 'native-host'],
  };
}

/**
 * Mint a key to a file and write MCP configs for the chosen clients.
 * Returns paths only — the token is never included in the result.
 */
export async function setup({
  home, keys, userHome = homedir(), env = process.env, clients = CLIENTS,
  cliPath = defaultCliPath(), nodePath = process.execPath, port, keyName = 'default',
  scopes = DEFAULT_SCOPES, startAtLogon = false, startNow = false, dryRun = false,
  hooks = {}, serverName = 'luculent-browser-driver',
} = {}) {
  if (!keys || !home) throw new Error('setup requires keys and home');
  const minted = keys.mint({ name: keyName, scopes });
  const keyFile = writeKeyFile(keyFilePath(home, keyName), minted.token);
  const block = mcpStdioBlock({ nodePath, cliPath, keyFile, port });
  const paths = defaultPaths(userHome, env);
  const written = [];
  for (const c of clients) {
    if (!paths[c]) throw new Error('Unknown MCP client ' + c);
    const p = paths[c];
    if (!dryRun) {
      if (c === 'codex') mergeTomlMcp(p, serverName, block);
      else mergeJsonMcp(p, serverName, block);
    }
    written.push({ client: c, path: p });
  }
  const task = startAtLogon
    ? (dryRun ? { ...taskSpec({ nodePath, cliPath, port }), dryRun: true }
      : hooks.installTask ? await hooks.installTask(taskSpec({ nodePath, cliPath, port }))
      : installLogonTask(taskSpec({ nodePath, cliPath, port })))
    : null;
  let started = false;
  if (startNow && !dryRun) {
    if (hooks.startRelay) started = !!(await hooks.startRelay({ nodePath, cliPath, port }));
    else started = startRelayHidden({ nodePath, cliPath, port });
  }
  return { keyFile, written, started, task };
}

export function startRelayHidden({ nodePath, cliPath, port, cwd } = {}) {
  const args = [cliPath, 'start', ...(port ? ['--port', String(port)] : [])];
  const child = spawn(nodePath, args, { detached: true, stdio: 'ignore', windowsHide: true, cwd });
  child.unref();
  return true;
}

export function installLogonTask(spec) {
  if (process.platform !== 'win32') return { ...spec, installed: false, reason: 'not-windows' };
  // Write a small helper script so schtasks quoting stays simple, then register a per-user logon task.
  const dir = join(homedir(), '.luculent', 'browser-driver');
  mkdirSync(dir, { recursive: true });
  const script = join(dir, 'start-relay-hidden.ps1');
  const portIdx = spec.args.indexOf('--port');
  const port = portIdx >= 0 ? spec.args[portIdx + 1] : '47800';
  const body = [
    '# Starts the Luculent Browser Driver relay hidden. Used by the logon scheduled task.',
    '$node = ' + q(spec.command),
    '$cli = ' + q(spec.args[0]),
    '$port = ' + String(Number(port) || 47800),
    'try { if (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue) { exit 0 } } catch {}',
    "Start-Process -FilePath $node -ArgumentList @($cli, 'start', '--port', [string]$port) -WindowStyle Hidden",
    '',
  ].join('\n');
  writeFileSync(script, body);
  const tr = 'powershell.exe -NoProfile -WindowStyle Hidden -File "' + script + '"';
  const r = spawnSync('schtasks.exe', ['/Create', '/TN', spec.name, '/SC', 'ONLOGON', '/RL', 'LIMITED', '/F', '/TR', tr], { windowsHide: true, encoding: 'utf8' });
  return { ...spec, installed: r.status === 0, status: r.status, script, stderr: (r.stderr || '').trim() || undefined };
}
function q(s) { return "'" + String(s).replace(/'/g, "''") + "'"; }
