import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

const [sourceArg, outputArg, licenseArg] = process.argv.slice(2);
if (!sourceArg || !outputArg || !licenseArg || process.platform !== 'win32') {
  throw new Error('Usage on Windows: node package-local-relay.mjs <driver checkout> <new output folder> <Node.js license>');
}
const source = resolve(sourceArg);
const output = resolve(outputArg);
const license = resolve(licenseArg);
const manifest = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'));
if (existsSync(output)) throw new Error('Output folder already exists');
if (!readFileSync(license, 'utf8').includes('Node.js contributors')) throw new Error('The Node.js license is missing');

const installedWs = join(source, 'node_modules', 'ws');
const ws = JSON.parse(readFileSync(join(installedWs, 'package.json'), 'utf8'));
const lock = JSON.parse(readFileSync(join(source, 'package-lock.json'), 'utf8'));
if (ws.version !== lock.packages['node_modules/ws'].version) throw new Error('Installed ws differs from the lockfile');

const driver = join(output, 'driver');
const runtime = join(output, 'runtime');
mkdirSync(runtime, { recursive: true });
copyFileSync(process.execPath, join(runtime, 'node.exe'));
copyFileSync(license, join(runtime, 'LICENSE.txt'));

function copy(relative, from = source) {
  const target = join(driver, relative);
  mkdirSync(dirname(target), { recursive: true });
  if (relative === 'extension') {
    cpSync(join(from, relative), target, { recursive: true, filter: path => basename(path) !== 'config.json' });
  } else {
    cpSync(join(from, relative), target, { recursive: true });
  }
}

for (const relative of ['package.json', 'LICENSE', 'src', 'priors', 'extension']) copy(relative);
for (const name of ['package.json', 'LICENSE', 'index.js', 'browser.js', 'wrapper.mjs', 'lib']) {
  const target = join(driver, 'node_modules', 'ws', name);
  mkdirSync(dirname(target), { recursive: true });
  cpSync(join(installedWs, name), target, { recursive: true });
}

writeFileSync(join(output, 'lbd.cmd'), [
  '@echo off',
  'setlocal',
  'set "NODE_OPTIONS="',
  'set "NODE_PATH="',
  'set "LBD_META_INGEST_URL="',
  String.raw`"%~dp0runtime\node.exe" "%~dp0driver\src\cli.mjs" %*`,
  'exit /b %errorlevel%',
  '',
].join('\r\n'));
writeFileSync(join(output, 'README.md'), `# Luculent Browser Driver ${manifest.version} (Windows ${process.arch})

This is a release candidate for the optional fully local relay. The supplied Node runtime is ${process.version}. Running the relay does not require an installed Node runtime or npm.

1. From this folder, run \`.\\lbd.cmd start\` in PowerShell and leave it open while you use the driver.
2. In Chrome, open \`chrome://extensions\`, turn on Developer mode, and load the unpacked \`driver/extension\` folder. Pin Luculent Driver and use the extension to grant a test tab.
3. In a second PowerShell window, run \`.\\lbd.cmd keys mint --name my-agent --scopes read,act,tabs\`. Keep the key private.
4. Set up your MCP client with \`http://127.0.0.1:47800/mcp\` and the key as its bearer token. Run \`.\\lbd.cmd status\` to check the relay and extension connection.

The relay accepts connections on loopback and retains the Browser Driver’s per-tab grants and approval controls. This launcher clears the optional remote telemetry ingest URL. Use \`.\\lbd.cmd keys revoke my-agent\` to revoke the client key. Stop the relay with Ctrl+C in its window.

This candidate includes an unpacked extension for acceptance testing. Chrome Web Store pairing and Luculent Desktop installer integration require release verification.
`);

console.log(`Staged ${manifest.version} (${process.arch}) with ${process.version}: ${readdirSync(output).join(', ')}`);
