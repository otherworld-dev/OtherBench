// Typechecks every package's tests (and its sources with them) with
// `tsconfig.test.json`: `tsc -b` covers only `src`, so a test that no longer
// compiles was only found when vitest ran it. Run after `tsc -b`, since the
// tests import other packages through their built `dist` types.
// Checks every package, then exits non-zero if any had errors.
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const packages = readdirSync(join(root, 'packages')).filter((p) => existsSync(join(root, 'packages', p, 'tsconfig.test.json')));
const tsc = join(root, 'node_modules', 'typescript', 'bin', 'tsc');
const failed = [];
for (const p of packages) {
  const result = spawnSync(process.execPath, [tsc, '-p', join('packages', p, 'tsconfig.test.json'), '--pretty', 'false'], { cwd: root, stdio: 'inherit' });
  if (result.status !== 0) failed.push(p);
}
if (failed.length > 0) {
  console.error(`typecheck:tests failed in ${failed.join(', ')}`);
  process.exit(1);
}
console.log(`typecheck:tests: ${packages.length} packages clean`);
