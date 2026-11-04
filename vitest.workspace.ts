import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineWorkspace, type Plugin } from 'vitest/config';

// A run started from `e:\...` when Windows spells the folder `E:\...` loads
// modules under both spellings, and every vi.mock of a relative path ('./x.js')
// then quietly misses: each web test file that has one fails with
// "mockReset is not a function". `npm test` (scripts/vitest.mjs) starts vitest
// from the folder's real spelling; this stops a direct `npx vitest` that wasn't.
if (process.platform === 'win32') {
  const cwd = process.cwd();
  const real = realpathSync.native(cwd);
  if (real !== cwd && real.toLowerCase() === cwd.toLowerCase()) {
    throw new Error(`vitest was started in ${cwd}, but Windows spells it ${real}; vi.mock misses under the wrong case. Run \`npm test\`, or cd to ${real} first.`);
  }
}

const root = dirname(fileURLToPath(import.meta.url));
const packagesDir = join(root, 'packages');

/** Each workspace package: its name (from package.json), folder, and own vite/vitest config if it has one. */
const packages = readdirSync(packagesDir)
  .filter((dir) => existsSync(join(packagesDir, dir, 'package.json')))
  .map((dir) => ({
    name: (JSON.parse(readFileSync(join(packagesDir, dir, 'package.json'), 'utf8')) as { name: string }).name,
    dir: join(packagesDir, dir),
    config: ['vitest.config.ts', 'vite.config.ts'].find((f) => existsSync(join(packagesDir, dir, f))),
  }));

/**
 * Resolves `@otherbench/<pkg>/<path>.js` to `packages/<pkg>/src/<path>.ts`
 * (or `.tsx`) for tests. Each package's `exports` point at `dist/`, which is
 * right for `tsc -b`, Node and the bundles, but under vitest it meant a test in
 * one package ran whatever another package was last built as: a test added to
 * core's store contract once silently didn't run in the SQLite suite. Every
 * package compiles `src` to `dist` with the same layout, so the source is
 * always there; a `.js` subpath without one is an error rather than a quiet
 * fall back to `dist/`.
 *
 * Only tests use this. Worker threads the server starts (the Office renderer,
 * the Claude import reader) are run by Node from `packages/server/dist`, which
 * still needs `npx tsc -b` (see their test files).
 */
function workspaceSources(): Plugin {
  const dirs = new Map(packages.map((p) => [p.name, p.dir]));
  return {
    name: 'otherbench:workspace-sources',
    enforce: 'pre',
    resolveId(source) {
      const match = /^(@otherbench\/[^/]+)\/(.+)\.js$/.exec(source);
      if (!match) return null;
      const dir = dirs.get(match[1]!);
      if (!dir) return null;
      for (const ext of ['.ts', '.tsx']) {
        const file = join(dir, 'src', `${match[2]}${ext}`);
        if (existsSync(file)) return file.replaceAll('\\', '/');
      }
      throw new Error(`${source} has no source file in ${join(dir, 'src')}: tests resolve workspace packages to their TypeScript, not dist/`);
    },
  };
}

export default defineWorkspace([
  ...packages.map((p) => ({
    ...(p.config ? { extends: join(p.dir, p.config) } : {}),
    plugins: [workspaceSources()],
    test: { name: p.name, root: p.dir },
  })),
  'desktop',
]);
