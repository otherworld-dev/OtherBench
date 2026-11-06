// Fails if any tracked file still holds merge-conflict markers. A bare
// `=======` isn't checked: it's also a Markdown heading underline, and a
// real conflict always has the `<<<<<<<` and `>>>>>>>` lines around it.
// `|||||||` is the base section diff3-style conflicts add.
import { spawnSync } from 'node:child_process';

const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const result = spawnSync('git', ['grep', '-n', '-I', '-E', '^(<{7}|>{7}|\\|{7})( |$)'], { cwd: root, encoding: 'utf8' });
// git grep exits 1 when nothing matches and above 1 on an error.
if (result.status === 1) process.exit(0);
if (result.status !== 0) {
  console.error(result.stderr || `git grep failed (${result.status})`);
  process.exit(2);
}
console.error('Merge-conflict markers found:\n' + result.stdout);
process.exit(1);
