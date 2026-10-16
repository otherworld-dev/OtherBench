import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from 'node:child_process';
import { win32 } from 'node:path';
import { withoutServerSecrets } from '@otherbench/core/domain/child-env.js';

/**
 * A thin runner for `wsl.exe` (spec 2026-10-12-sandbox-design §2). Every
 * in-distro command goes as `wsl.exe -d otherbench-sandbox -u <user> --exec
 * <program> <args...>`: `--exec` hands the arguments to the program as they
 * are. The live probe found that `wsl.exe ... -- <cmd>` goes through a Linux
 * shell, which ate the backslashes of `C:\...` paths. The spawn function is
 * injected, so tests never start wsl.exe.
 */

/** The WSL distro OtherBench owns. */
export const DISTRO = 'otherbench-sandbox';

export type WslUser = 'root' | 'otherbench';

export interface WslResult {
  /** null when wsl.exe couldn't start, was killed or timed out. */
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface WslRunOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

export type SpawnFn = (file: string, args: readonly string[], options: SpawnOptionsWithoutStdio) => ChildProcessWithoutNullStreams;

export interface WslRunner {
  /** `wsl.exe <args>`. Resolves when it exits; never rejects. */
  wsl(args: string[], opts?: WslRunOptions): Promise<WslResult>;
  /** A program in the distro as `user`, its arguments passed as they are. */
  exec(user: WslUser, argv: string[], opts?: WslRunOptions): Promise<WslResult>;
  /** A long-lived program in the distro with piped stdio (the agent). Unlike wsl()/exec(), this can throw synchronously if wsl.exe can't start. */
  spawn(user: WslUser, argv: string[]): ChildProcessWithoutNullStreams;
}

/**
 * wsl.exe prints its own messages (`--install`, `--list`, `--version`,
 * errors) as UTF-16LE; programs inside the distro print UTF-8. A buffer whose
 * odd bytes are mostly zero is UTF-16LE text.
 */
export function decodeWslOutput(buf: Buffer): string {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString('utf16le');
  let zeros = 0;
  for (let i = 1; i < buf.length; i += 2) if (buf[i] === 0) zeros += 1;
  const odd = Math.floor(buf.length / 2);
  return odd > 0 && zeros * 2 > odd ? buf.toString('utf16le') : buf.toString('utf8');
}

/** `%SystemRoot%\System32\wsl.exe`. */
export function wslExePath(env: NodeJS.ProcessEnv = process.env): string {
  return win32.join(env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'wsl.exe');
}

/** The wsl.exe arguments that run `argv` in the distro as `user`. */
export function execArgs(user: WslUser, argv: string[]): string[] {
  return ['-d', DISTRO, '-u', user, '--exec', ...argv];
}

export function createWslRunner(spawn: SpawnFn = nodeSpawn as SpawnFn, exe: string = wslExePath()): WslRunner {
  // WSL_UTF8 asks newer wsl.exe for UTF-8; decodeWslOutput copes either way.
  // The server's own API token never reaches wsl.exe (core/domain/child-env.ts).
  const env = { ...withoutServerSecrets(process.env), WSL_UTF8: '1' };

  const wsl = (args: string[], opts: WslRunOptions = {}): Promise<WslResult> =>
    new Promise((resolve) => {
      // An already-aborted signal never fires 'abort' again, so don't start the command at all.
      if (opts.signal?.aborted) {
        resolve({ code: null, stdout: '', stderr: '', timedOut: false });
        return;
      }
      let child: ChildProcessWithoutNullStreams;
      try {
        child = spawn(exe, args, { windowsHide: true, env });
      } catch (err) {
        resolve({ code: null, stdout: '', stderr: err instanceof Error ? err.message : String(err), timedOut: false });
        return;
      }
      const out: Buffer[] = [];
      const errs: Buffer[] = [];
      let timedOut = false;
      let settled = false;
      child.stdout.on('data', (d: Buffer) => out.push(d));
      child.stderr.on('data', (d: Buffer) => errs.push(d));
      const timer =
        opts.timeoutMs === undefined
          ? undefined
          : setTimeout(() => {
              timedOut = true;
              child.kill();
            }, opts.timeoutMs);
      const onAbort = (): void => {
        child.kill();
      };
      opts.signal?.addEventListener('abort', onAbort, { once: true });
      const finish = (code: number | null, extra = ''): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        opts.signal?.removeEventListener('abort', onAbort);
        resolve({ code, stdout: decodeWslOutput(Buffer.concat(out)), stderr: decodeWslOutput(Buffer.concat(errs)) + extra, timedOut });
      };
      child.on('error', (e) => finish(null, e.message));
      child.on('close', (code: number | null) => finish(code));
    });

  return {
    wsl,
    exec: (user, argv, opts) => wsl(execArgs(user, argv), opts),
    spawn: (user, argv) => spawn(exe, execArgs(user, argv), { windowsHide: true, env }),
  };
}
