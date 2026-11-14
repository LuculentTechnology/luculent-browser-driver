// Build the Web Store upload zip: copies extension/, strips the dev "key" (the store assigns its own ID),
// drops test-only files, and zips to dist/luculent-browser-driver-<version>.zip.
import { cpSync, rmSync, readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'dist');
const stage = join(out, 'extension');
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
cpSync(join(root, 'extension'), stage, { recursive: true });
for (const f of ['config.json']) if (existsSync(join(stage, f))) rmSync(join(stage, f));
const manifest = JSON.parse(readFileSync(join(stage, 'manifest.json'), 'utf8'));
delete manifest.key;
writeFileSync(join(stage, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
const zip = join(out, `luculent-browser-driver-${manifest.version}.zip`);
// bsdtar (Windows 10+, macOS) writes zip with -a; fall back to `zip` on Linux.
// List top-level entries explicitly so paths are stored as manifest.json, not ./manifest.json.
const entries = readdirSync(stage);
try { execFileSync('tar', ['-a', '-c', '-f', zip, '-C', stage, ...entries], { stdio: 'inherit' }); }
catch (_) { execFileSync('zip', ['-r', zip, ...entries], { cwd: stage, stdio: 'inherit' }); }
console.log(`wrote ${zip}`);
