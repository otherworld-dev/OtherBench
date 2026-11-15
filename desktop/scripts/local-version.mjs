// Gives a hand-built installer (`npm run app:installer`) a version that ranks
// below every beta (release/version.mjs `localVersion`), so the updater moves
// a machine installed from it on to the next beta instead of calling it up to
// date for ever. Writes src-tauri/tauri.local.conf.json (gitignored), which
// app:installer passes to `tauri build` after the bundle config. CI's
// app:release never reads it: publish.mjs writes the beta's version into
// package.json instead.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { localVersion } from './release/version.mjs';

const desktopDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const { version: packageVersion } = JSON.parse(readFileSync(join(desktopDir, 'package.json'), 'utf8'));
const version = localVersion({ packageVersion, now: new Date() });
writeFileSync(join(desktopDir, 'src-tauri', 'tauri.local.conf.json'), `${JSON.stringify({ version }, null, 2)}\n`);
console.log(`[local-version] this installer is ${version}`);
