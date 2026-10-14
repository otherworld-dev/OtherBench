import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { BASH, hasBash } from './helpers.js';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'resources', 'interop-check.sh');

/**
 * The real interop-check.sh. Off Windows it runs under /bin/sh as in the distro (dash on Ubuntu: the accepted
 * "Exec format error" is dash's wording, which bash words differently). On Windows, Git Bash (never
 * System32\bash.exe), which is enough for the early refusals.
 */
const SHELL = process.platform === 'win32' ? BASH : '/bin/sh';
function check(env: NodeJS.ProcessEnv): { code: number | null; out: string } {
  const r = spawnSync(SHELL, [SCRIPT], { env: { ...process.env, ...env }, encoding: 'utf8' });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

describe.skipIf(!hasBash)('interop-check.sh', () => {
  it('says interop is on (exit 3) when Windows folders are on PATH, before trying anything', () => {
    const r = check({ PATH: '/usr/bin:/mnt/c/WINDOWS/system32:/bin' });
    expect(r.code).toBe(3);
    expect(r.out).toContain('INTEROP-REACHED: Windows folders are on PATH');
    expect(r.out).not.toMatch(/^interop-off$/m);
  });

  it('says interop is on (exit 3) when WSL_INTEROP is set', () => {
    const r = check({ WSL_INTEROP: '/run/WSL/2_interop' });
    expect(r.code).toBe(3);
    expect(r.out).toContain('INTEROP-REACHED: WSL_INTEROP is set');
  });

  // Off Windows (a Linux runner has no WSL interop), the program is refused by the kernel: interop-off, with the note
  // that nothing beyond the kernel was exercised. Not on Windows, where Git Bash would hand the file to Windows itself,
  // nor where a binfmt handler takes MZ files (mono's `cli` on some images), which the script rightly can't classify.
  const mzHandler = existsSync('/proc/sys/fs/binfmt_misc/cli');
  it.skipIf(process.platform === 'win32' || mzHandler)('says interop-off, noting that only the kernel refused, where there is no interop at all', () => {
    const r = check({ PATH: '/usr/bin:/bin', WSL_INTEROP: '' });
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/^interop-off$/m);
    expect(r.out).toContain('note: no-registration');
  });
});
