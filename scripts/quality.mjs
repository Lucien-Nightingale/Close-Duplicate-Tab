import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

const root = resolve(new URL('..', import.meta.url).pathname);
const manifestPath = resolve(root, 'extension', 'manifest.json');
const closeTabsPath = resolve(root, 'extension', 'close_tabs.js');
const optionsPath = resolve(root, 'extension', 'options.js');
const pkgPath = resolve(root, 'package.json');

function nodeCheck(p) {
  execFileSync(process.execPath, ['--check', p], { stdio: 'inherit' });
}

nodeCheck(closeTabsPath);
nodeCheck(optionsPath);

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));

if (!manifest.version) throw new Error('manifest.json missing version');
if (!pkg.version) throw new Error('package.json missing version');

// allow manifest "4.0" vs package "4.0.0"
if (!pkg.version.startsWith(manifest.version)) {
  throw new Error(`Version mismatch: manifest=${manifest.version} package=${pkg.version}`);
}

console.log('Quality checks passed.');
