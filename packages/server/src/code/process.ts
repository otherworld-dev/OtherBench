import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { withoutServerSecrets } from '@otherbench/core/domain/child-env.js';
import { ExecutableNotFoundError, resolveExecutable } from '@otherbench/tools/mcp/spawn.js';

/**
 * A small process runner for the Code tab's git service (spec
 * 2026-10-20-code-tab-design, "Constraints from the codebase"). Every process
 * is started with an argv array and `shell: false`; the caller never gets to
 * hand a string to a shell. The executable is resolved with resolveExecutable
 * (the same Windows `.cmd`/`.exe` PATHEXT fix the MCP client needs), and the
 * default environment is the server's minus its secrets (withoutServerSecrets).
 *
 * Output is decoded as UTF-8 (split multi-byte characters across chunks are
 * handled by StringDecoder), CRLF is normalised to LF, and stdout is capped so
 * a huge diff cannot exhaust the server's memory; stderr is capped likewise.
 */

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** stdout hit STDOUT_CAP_BYTES and the rest was dropped. */
  truncated: boolean;
}

export class ExecutableMissingError extends Error {
  constructor(readonly command: string) {
    super(`Could not find "${command}" on PATH.`);
    this.name = 'ExecutableMissingError';
  }
}

export const STDOUT_CAP_BYTES = 5 * 1024 * 1024;
const STDERR_CAP_BYTES = 1024 * 1024;
const TERMINATE_GRACE_MS = 1_000;

/** Collects a stream as UTF-8 text up to `cap` bytes; later bytes are dropped. */
function collector(cap: number): { push(chunk: Buffer): void; text(): string; truncated(): boolean } {
  const decoder = new StringDecoder('utf8');
  let text = '';
  let size = 0;
  let cut = false;
  return {
    push(chunk) {
      if (size >= cap) {
        if (chunk.length > 0) cut = true;
        return;
      }
      const room = cap - size;
      if (chunk.length > room) cut = true;
      const part = chunk.length > room ? chunk.subarray(0, room) : chunk;
      size += part.length;
      text += decoder.write(part);
    },
    truncated: () => cut,
    text: () => (text + decoder.end()).replace(/\r\n/g, '\n'),
  };
}

export async function runProcess(
  command: string,
  args: string[],
  opts: { cwd: string; timeoutMs?: number; env?: Record<string, string>; input?: string },
): Promise<RunResult> {
  let file: string;
  try {
    file = resolveExecutable(command);
  } catch (err) {
    if (err instanceof ExecutableNotFoundError) throw new ExecutableMissingError(command);
    throw err;
  }

  return new Promise<RunResult>((resolve, reject) => {
    const child = spawn(file, args, {
      cwd: opts.cwd,
      env: opts.env ?? withoutServerSecrets(process.env),
      shell: false,
      windowsHide: true,
      // POSIX: its own process group, so a timeout can kill the whole tree.
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const out = collector(STDOUT_CAP_BYTES);
    const err = collector(STDERR_CAP_BYTES);
    let timedOut = false;
    let settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      void terminate(child);
    }, opts.timeoutMs ?? 30_000);

    child.stdout?.on('data', (c: Buffer) => out.push(c));
    child.stderr?.on('data', (c: Buffer) => err.push(c));
    child.on('error', (e: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(e.code === 'ENOENT' ? new ExecutableMissingError(command) : e);
    });
    // 'close', not 'exit': stdio is fully drained by then.
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout: out.text(), stderr: err.text(), timedOut, truncated: out.truncated() });
    });

    // A child that exits without reading its input raises EPIPE here; the exit code tells the story.
    child.stdin?.on('error', () => {});
    child.stdin?.end(opts.input);
  });
}

/**
 * Kills the child and what it started, as shell-tool.ts's terminate() does:
 * `taskkill /t /f` on Windows (child.kill() alone leaves grandchildren), and
 * the negative-PID process-group signal on POSIX (the child was spawned
 * `detached`). SIGTERM first, SIGKILL after a short grace.
 */
async function terminate(child: ChildProcess): Promise<void> {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    await new Promise<void>((done) => execFile('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true }, () => done()));
    return;
  }
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    /* already gone */
  }
  await new Promise((r) => setTimeout(r, TERMINATE_GRACE_MS));
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    /* already gone */
  }
}
