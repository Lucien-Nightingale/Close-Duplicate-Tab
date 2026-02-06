import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(new URL('..', import.meta.url).pathname);
const distDir = resolve(root, 'dist');
const extDir = resolve(root, 'extension');
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
const outZip = resolve(distDir, `close_duplicate_tabs_${pkg.version}.zip`);

mkdirSync(distDir, { recursive: true });
if (existsSync(outZip)) rmSync(outZip);

execFileSync('zip', ['-r', outZip, '.'], { cwd: extDir, stdio: 'inherit' });

console.log(`Built: ${outZip}`);
