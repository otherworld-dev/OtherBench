import { execFileSync } from 'node:child_process';

/**
 * The Windows trap this module exists to close: `child_process.spawn('npx', ...,
 * { shell: false })` fails with ENOENT on Windows, even when `npx` is genuinely
 * on PATH. `npx`/`npm`/`uvx`-style tool launchers installed via npm or a Python
 * toolchain ship as `.cmd` (npm) or `.exe` (uv/uvx, pipx) shims on Windows, never
 * as a bare extensionless executable -- and Windows' `CreateProcess` (what
 * Node's non-shell spawn ultimately calls) does not consult `PATHEXT` itself
 * the way `cmd.exe` does. Passing the bare name through with `shell: false`
 * therefore never finds it; the fix is to resolve the real, extensioned
 * executable path ourselves (via the platform's own `where`, which DOES search
 * `PATHEXT`) and hand that fully-resolved path to `spawn`, never the bare name.
 *
 * POSIX has no equivalent trap: `execvp`-style PATH search (what Node's spawn
 * uses there) resolves a bare command name on its own, and there is no
 * extension-based dispatch to get wrong -- so this function is a no-op there.
 *
 * Note this is a deliberate defense-in-depth layer, not a workaround for a gap
 * in `@modelcontextprotocol/sdk`: `StdioClientTransport` already spawns via
 * `cross-spawn`, which independently resolves `PATHEXT` via the `which`
 * package and auto-wraps a resolved `.cmd`/`.bat` target through `cmd.exe`.
 * Pre-resolving here and handing `client.ts` an already-absolute path is
 * additionally safe with that: `cross-spawn`'s own resolution step
 * (`resolveCommand` -> `which.sync`) treats an already-absolute input as a
 * direct existence/executability check rather than a fresh PATH search, so
 * nothing about its `.cmd`-wrapping behaviour changes -- verified by reading
 * cross-spawn@7's `lib/util/resolveCommand.js` and `lib/parse.js` (installed
 * as a transitive dependency of `@modelcontextprotocol/sdk`).
 */
export class ExecutableNotFoundError extends Error {
  constructor(public readonly command: string) {
    super(`Could not resolve executable "${command}" on PATH.`);
    this.name = 'ExecutableNotFoundError';
  }
}

export interface ResolveExecutableOptions {
  /** Overridable for tests; defaults to `process.platform`. */
  platform?: NodeJS.Platform;
}

/**
 * Resolves `command` to an absolute, extensioned executable path on Windows
 * (via `where`, which is PATHEXT-aware); returns it unchanged everywhere else,
 * and unchanged anywhere it already looks like a path (contains a path
 * separator) rather than a bare command name -- nothing to search for in that
 * case, `where`/PATH lookup does not apply to an explicit path.
 *
 * Throws `ExecutableNotFoundError` if `where` finds nothing (fails closed:
 * callers must not silently fall through to a bare-name spawn that would hit
 * the exact ENOENT trap this function exists to avoid).
 */
export function resolveExecutable(command: string, options: ResolveExecutableOptions = {}): string {
  const platform = options.platform ?? process.platform;
  if (platform !== 'win32') return command;
  if (/[\\/]/.test(command)) return command;

  let output: string;
  try {
    output = execFileSync('where', [command], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    throw new ExecutableNotFoundError(command);
  }

  // `where` lists one match per line, in the same priority order `cmd.exe`
  // itself would pick (PATH directory order, then PATHEXT order within a
  // directory) -- the first line is the one a shell invocation would run.
  const first = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (!first) throw new ExecutableNotFoundError(command);
  return first;
}
