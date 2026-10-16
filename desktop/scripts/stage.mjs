// Stages what the installer carries besides the app itself (v2 plan, Task 40):
// the bundled server (packages/server/dist-bundle/server) and the Node
// runtime that runs it -- this machine's own node, the version the tests ran
// on. Both go to src-tauri/bundle-resources/, which tauri.bundle.conf.json
// adds as resources for `npm run app:installer` only, so dev runs don't
// need them.

import { execFileSync } from 'node:child_process';
import { cp, mkdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const desktopDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = join(desktopDir, '..');
const staged = join(desktopDir, 'src-tauri', 'bundle-resources');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const run = (args) => execFileSync(npm, args, { cwd: repoRoot, stdio: 'inherit', shell: process.platform === 'win32' });

run(['run', 'build']);
run(['run', 'bundle', '-w', '@otherbench/server']);
run(['run', 'bundle:smoke', '-w', '@otherbench/server']);

await rm(staged, { recursive: true, force: true });
await cp(join(repoRoot, 'packages', 'server', 'dist-bundle', 'server'), join(staged, 'server'), { recursive: true });
await mkdir(join(staged, 'node'), { recursive: true });
await cp(process.execPath, join(staged, 'node', process.platform === 'win32' ? 'node.exe' : 'node'));
console.log(`[stage] server bundle and node ${process.version} staged in ${staged}`);
