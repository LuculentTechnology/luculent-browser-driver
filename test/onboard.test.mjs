import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { KeyStore } from '../src/keys.mjs';
import { setup, mergeJsonMcp, defaultPaths, keyFilePath, CLIENTS } from '../src/onboard.mjs';

function tmp() { return mkdtempSync(join(tmpdir(), 'lbd-onboard-')); }

test('setup mints a key to a file and returns the path only, never the token', async () => {
  const home = tmp();
  const userHome = tmp();
  const keys = new KeyStore(home);
  const r = await setup({
    home, keys, userHome, env: { APPDATA: join(userHome, 'AppData', 'Roaming') },
    clients: CLIENTS, cliPath: '/app/src/cli.mjs', nodePath: '/usr/bin/node', port: 47800,
    startAtLogon: true, startNow: true, dryRun: true, keyName: 'tester',
  });
  assert.ok(r.keyFile);
  assert.ok(existsSync(r.keyFile));
  assert.equal(r.keyFile, keyFilePath(home, 'tester'));
  const token = readFileSync(r.keyFile, 'utf8').trim();
  assert.match(token, /^lbd_[0-9A-Za-z]{8}_[0-9A-Za-z]{32}$/);
  const dumped = JSON.stringify(r);
  assert.doesNotMatch(dumped, /lbd_[0-9A-Za-z]{8}_/);
  assert.ok(!('token' in r));
  assert.equal(r.written.length, CLIENTS.length);
  assert.ok(r.task.dryRun);
  assert.equal(r.started, false);
});

test('MCP configs are merged without clobbering existing servers or keys', async () => {
  const home = tmp();
  const userHome = tmp();
  const appData = join(userHome, 'AppData', 'Roaming');
  const paths = defaultPaths(userHome, { APPDATA: appData });
  mkdirSync(dirname(paths['cursor']), { recursive: true });
  writeFileSync(paths['cursor'], JSON.stringify({ mcpServers: { other: { command: 'keep-me' } }, theme: 'dark' }));
  mkdirSync(dirname(paths.codex), { recursive: true });
  writeFileSync(paths.codex, 'model = "gpt-5"\n\n[mcp_servers.other]\ncommand = "keep-me"\n');
  const keys = new KeyStore(home);
  const r = await setup({
    home, keys, userHome, env: { APPDATA: appData },
    clients: ['cursor', 'claude-code', 'claude-desktop', 'gemini', 'codex'],
    cliPath: 'C:\\Luculent\\cli.mjs', nodePath: 'C:\\Node\\node.exe', dryRun: false,
  });
  const cursor = JSON.parse(readFileSync(paths.cursor, 'utf8'));
  assert.equal(cursor.theme, 'dark');
  assert.equal(cursor.mcpServers.other.command, 'keep-me');
  assert.equal(cursor.mcpServers['luculent-browser-driver'].command, 'C:\\Node\\node.exe');
  assert.equal(cursor.mcpServers['luculent-browser-driver'].env.LBD_KEY_FILE, r.keyFile);
  assert.ok(!JSON.stringify(cursor).includes(readFileSync(r.keyFile, 'utf8').trim()));
  const claude = JSON.parse(readFileSync(paths['claude-code'], 'utf8'));
  assert.ok(claude.mcpServers['luculent-browser-driver']);
  const desktop = JSON.parse(readFileSync(paths['claude-desktop'], 'utf8'));
  assert.ok(desktop.mcpServers['luculent-browser-driver']);
  const gemini = JSON.parse(readFileSync(paths.gemini, 'utf8'));
  assert.ok(gemini.mcpServers['luculent-browser-driver']);
  const toml = readFileSync(paths.codex, 'utf8');
  assert.match(toml, /model = "gpt-5"/);
  assert.match(toml, /\[mcp_servers\.other\]/);
  assert.match(toml, /command = "keep-me"/);
  assert.match(toml, /\[mcp_servers\.luculent-browser-driver\]/);
  assert.match(toml, /LBD_KEY_FILE/);
  assert.doesNotMatch(toml, /lbd_[0-9A-Za-z]{8}_[0-9A-Za-z]{32}/);
  // second setup updates our server and still keeps the other one
  await setup({ home, keys, userHome, env: { APPDATA: appData }, clients: ['cursor', 'codex'], cliPath: 'D:\\x\\cli.mjs', nodePath: 'C:\\Node\\node.exe', keyName: 'second' });
  const cursor2 = JSON.parse(readFileSync(paths.cursor, 'utf8'));
  assert.equal(cursor2.mcpServers.other.command, 'keep-me');
  assert.equal(cursor2.mcpServers['luculent-browser-driver'].args[0], 'D:\\x\\cli.mjs');
});

test('hooks start the relay and install the logon task; dry-run does not', async () => {
  const calls = [];
  const home = tmp();
  const r = await setup({
    home, keys: new KeyStore(home), userHome: tmp(), clients: [],
    startAtLogon: true, startNow: true, dryRun: false,
    hooks: {
      installTask: async (spec) => { calls.push(['task', spec.name, spec.hidden, spec.when]); return { ...spec, installed: true }; },
      startRelay: async () => { calls.push(['start']); return true; },
    },
  });
  assert.deepEqual(calls.map((c) => c[0]), ['task', 'start']);
  assert.equal(r.started, true);
  assert.equal(r.task.installed, true);
  assert.equal(r.task.name, 'Luculent Browser Driver Relay');
});

test('mergeJsonMcp refuses to overwrite a config file that did not parse', () => {
  const dir = tmp();
  const file = join(dir, 'mcp.json');
  writeFileSync(file, '{ not valid json');
  assert.throws(() => mergeJsonMcp(file, 'luculent-browser-driver', { command: 'node' }), /did not parse/);
  assert.equal(readFileSync(file, 'utf8'), '{ not valid json');
});
