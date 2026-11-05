// Runs vitest from the repository's real path, as Windows spells it.
// Started from `e:\...` when the folder is `E:\...`, vitest loads modules under
// both spellings and every vi.mock of a relative path quietly misses (each web
// test file with one fails, "mockReset is not a function"). Git Bash and
// PowerShell hand Node `E:`; a process started with a lowercase cwd doesn't.
// vitest.workspace.ts refuses such a run; this starts it in the right place.
import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = realpathSync.native(fileURLToPath(new URL('..', import.meta.url)));
const result = spawnSync(process.execPath, [join(root, 'node_modules', 'vitest', 'vitest.mjs'), ...process.argv.slice(2)], { cwd: root, stdio: 'inherit' });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
