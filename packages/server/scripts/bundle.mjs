// Builds the server the desktop app ships (v2 plan, Task 40): one ESM file,
// `dist-bundle/server/cli.js`, from the compiled `dist/cli.js` and every
// workspace package and dependency it imports, plus a `node_modules` beside
// it for the few packages that read their own files at run time and so
// can't be bundled. The installer carries this folder and a Node runtime
// (desktop/scripts/stage.mjs); the app starts `node server/cli.js serve`.
//
// Run after `npm run build`: `npm run bundle -w @grunt/server`.

import { build } from 'esbuild';
import { cp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const serverDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = join(serverDir, '..', '..');
const out = join(serverDir, 'dist-bundle', 'server');

/**
 * Left out of the bundle and copied as packages: the Claude Agent SDK starts
 * its own Claude Code runtime (a per-platform native package), and unpdf
 * loads PDF.js from its own folder.
 */
const EXTERNAL = ['@anthropic-ai/claude-agent-sdk', 'unpdf'];
const NATIVE_CLAUDE = `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`;

async function exists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

await rm(join(serverDir, 'dist-bundle'), { recursive: true, force: true });
await mkdir(out, { recursive: true });

await build({
  entryPoints: [join(serverDir, 'dist', 'cli.js')],
  outfile: join(out, 'cli.js'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  external: EXTERNAL,
  // CommonJS dependencies call require(); an ES module has none of its own.
  // node:sqlite is loaded the same way (store-sqlite/src/db.ts), unchanged.
  banner: { js: "import { createRequire as __gruntCreateRequire } from 'node:module'; globalThis.require ??= __gruntCreateRequire(import.meta.url);" },
  logLevel: 'warning',
});
await writeFile(join(out, 'package.json'), JSON.stringify({ name: 'grunt-server', private: true, type: 'module' }, null, 2) + '\n');

const copies = [...EXTERNAL, NATIVE_CLAUDE];
for (const pkg of copies) {
  const from = join(repoRoot, 'node_modules', ...pkg.split('/'));
  if (!(await exists(from))) {
    if (pkg === NATIVE_CLAUDE) {
      console.warn(`[bundle] ${pkg} isn't installed: Claude Code profiles won't run from this bundle.`);
      continue;
    }
    throw new Error(`[bundle] ${pkg} isn't installed in ${join(repoRoot, 'node_modules')}`);
  }
  await cp(from, join(out, 'node_modules', ...pkg.split('/')), { recursive: true });
}

// Grunt's copy of Mermaid for artifact diagrams (Deck #896): served from assets/ beside cli.js.
const require_ = createRequire(join(serverDir, 'package.json'));
await mkdir(join(out, 'assets'), { recursive: true });
await cp(require_.resolve('mermaid/dist/mermaid.min.js'), join(out, 'assets', 'mermaid.min.js'));

const { version } = JSON.parse(await readFile(join(serverDir, 'package.json'), 'utf8'));
console.log(`[bundle] grunt-server ${version} -> ${out} (${copies.join(', ')} alongside)`);
