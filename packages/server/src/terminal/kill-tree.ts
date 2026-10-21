import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { withoutServerSecrets } from '@otherbench/core/domain/child-env.js';

/**
 * Ends a terminal's shell and everything it started, so a dev server doesn't
 * keep its port after its terminal closes (spec 2026-10-21-code-terminal-design,
 * "Killing"). Windows: `taskkill /T /F` from System32 (closing the ConPTY alone
 * leaves detached grandchildren). POSIX: the shell leads its own process group,
 * so the whole group goes. Never rejects: a process that's already gone is fine.
 */
export function killTree(pid: number): Promise<void> {
  if (!Number.isInteger(pid) || pid <= 0) return Promise.resolve();
  if (process.platform === 'win32') {
    const taskkill = join(process.env['SystemRoot'] || 'C:\\Windows', 'System32', 'taskkill.exe');
    return new Promise((resolve) => {
      execFile(taskkill, ['/PID', String(pid), '/T', '/F'], { windowsHide: true, env: withoutServerSecrets(process.env) }, () => resolve());
    });
  }
  for (const target of [-pid, pid]) {
    try {
      process.kill(target, 'SIGKILL');
    } catch {
      // not there (any more)
    }
  }
  return Promise.resolve();
}
