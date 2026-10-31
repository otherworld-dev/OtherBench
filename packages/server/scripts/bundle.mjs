// Builds the server the desktop app ships (v2 plan, Task 40): one ESM file,
// `dist-bundle/server/cli.js`, from the compiled `dist/cli.js` and every
// workspace package and dependency it imports, the Office file worker
// `render-worker.js` built the same way beside it, plus a `node_modules` beside
// it for the few packages that read their own files at run time and so
// can't be bundled. The installer carries this folder and a Node runtime
// (desktop/scripts/stage.mjs); the app starts `node server/cli.js serve`.
//
// Run after `npm run build`: `npm run bundle -w @otherbench/server`.

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
 * loads PDF.js from its own folder, and playwright-core reads its own files
 * at run time (the model's browser), and the Code tab's terminals run in
 * node-pty, whose prebuilt binary sits in a per-platform package of its own.
 */
const EXTERNAL = ['@anthropic-ai/claude-agent-sdk', 'unpdf', 'playwright-core', '@lydell/node-pty'];
const NATIVE_CLAUDE = `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`;
const NATIVE_PTY = `@lydell/node-pty-${process.platform}-${process.arch}`;

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

/** Settings shared by the server and the Office file worker. */
const shared = {
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  external: EXTERNAL,
  // CommonJS dependencies call require(); an ES module has none of its own.
  // node:sqlite is loaded the same way (store-sqlite/src/db.ts), unchanged.
  banner: { js: "import { createRequire as __otherBenchCreateRequire } from 'node:module'; globalThis.require ??= __otherBenchCreateRequire(import.meta.url);" },
  logLevel: 'warning',
};
await build({ ...shared, entryPoints: [join(serverDir, 'dist', 'cli.js')], outfile: join(out, 'cli.js') });
// Office files are made in a worker thread (src/office/render.ts), started from
// `./render-worker.js` beside the module that starts it: in the bundle that
// module is cli.js, so the worker goes next to it.
await build({ ...shared, entryPoints: [join(serverDir, 'dist', 'office', 'render-worker.js')], outfile: join(out, 'render-worker.js') });
await writeFile(join(out, 'package.json'), JSON.stringify({ name: 'otherbench-server', private: true, type: 'module' }, null, 2) + '\n');

const copies = [...EXTERNAL, NATIVE_CLAUDE, NATIVE_PTY];
for (const pkg of copies) {
  const from = join(repoRoot, 'node_modules', ...pkg.split('/'));
  if (!(await exists(from))) {
    if (pkg === NATIVE_CLAUDE) {
      console.warn(`[bundle] ${pkg} isn't installed: Claude Code profiles won't run from this bundle.`);
      continue;
    }
    if (pkg === NATIVE_PTY) {
      console.warn(`[bundle] ${pkg} isn't installed: this bundle has no terminals.`);
      continue;
    }
    throw new Error(`[bundle] ${pkg} isn't installed in ${join(repoRoot, 'node_modules')}`);
  }
  await cp(from, join(out, 'node_modules', ...pkg.split('/')), { recursive: true });
}

// OtherBench's copy of Mermaid for artifact diagrams (Deck #896): served from assets/ beside cli.js.
const require_ = createRequire(join(serverDir, 'package.json'));

// The rules that answer cookie boxes (tools/src/browser/consent.ts): read at run time, and only these
// three files of a 13 MB package. Without its package.json the rules' path won't resolve.
const consentFrom = join(repoRoot, 'node_modules', '@duckduckgo', 'autoconsent');
const consentTo = join(out, 'node_modules', '@duckduckgo', 'autoconsent');
for (const file of ['package.json', 'LICENSE', join('dist', 'autoconsent.playwright.js'), join('rules', 'compact-rules.json')]) {
  await mkdir(dirname(join(consentTo, file)), { recursive: true });
  await cp(join(consentFrom, file), join(consentTo, file));
}

await mkdir(join(out, 'assets'), { recursive: true });
await cp(require_.resolve('mermaid/dist/mermaid.min.js'), join(out, 'assets', 'mermaid.min.js'));

// The sandbox's in-VM files (spec 2026-10-12-sandbox-design): sandbox/ beside
// cli.js, where @otherbench/sandbox's sandboxResourcesDir() looks first.
await cp(join(repoRoot, 'packages', 'sandbox', 'resources'), join(out, 'sandbox'), { recursive: true });

const { version } = JSON.parse(await readFile(join(serverDir, 'package.json'), 'utf8'));
console.log(`[bundle] otherbench-server ${version} -> ${out} (${copies.join(', ')} alongside)`);
