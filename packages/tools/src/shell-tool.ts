import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import type { ToolContext, ToolSpec } from '@grunt/core/ports/tool-provider.js';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT_MS = 120_000; // 120s
const MAX_TIMEOUT_MS = 600_000; // 600s hard cap -- a requested timeout above this is silently clamped down
const MAX_OUTPUT_BYTES = 100 * 1024; // 100KB combined stdout+stderr cap
/** Grace window between the soft ("SIGTERM") and hard ("SIGKILL") kill attempts. */
const KILL_GRACE_MS = 2000;

// ---------------------------------------------------------------------------
// Result / error shapes -- same "never reject, always resolve with either
// data or a structured error" contract as fs-tools.ts, so a misbehaving
// command or a bad argument surfaces as something the model can reason
// about rather than an uncaught exception reaching the engine.
// ---------------------------------------------------------------------------

interface ToolError {
  error: true;
  code: string;
  message: string;
}

function toolError(code: string, message: string): ToolError {
  return { error: true, code, message };
}

class ArgsError extends Error {}

/** The turn was already cancelled when the call reached us; nothing was started. */
class AlreadyAbortedError extends Error {
  constructor() {
    super('The turn was cancelled before this command started, so it was not run.');
  }
}

async function runTool<T>(fn: () => Promise<T>): Promise<T | ToolError> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof ArgsError) return toolError('bad_args', err.message);
    if (err instanceof AlreadyAbortedError) return toolError('aborted', err.message);
    const message = err instanceof Error ? err.message : String(err);
    return toolError('spawn_failed', message);
  }
}

function argsObject(args: unknown): Record<string, unknown> {
  if (typeof args !== 'object' || args === null) {
    throw new ArgsError('Expected an object of arguments.');
  }
  return args as Record<string, unknown>;
}

function requireString(args: unknown, key: string): string {
  const value = argsObject(args)[key];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ArgsError(`"${key}" must be a non-empty string.`);
  }
  return value;
}

function optionalPositiveInt(args: unknown, key: string): number | undefined {
  const value = argsObject(args)[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new ArgsError(`"${key}" must be a positive integer when present.`);
  }
  return value;
}

// ---------------------------------------------------------------------------
// Platform shell invocation
// ---------------------------------------------------------------------------
//
// Windows: cmd.exe's /S /C argument parsing has non-standard quoting rules
// (documented in cmd's own `/?` help under "If /C or /K is specified, then
// the remainder of the command line..."): the whole command must be passed
// as ONE argument wrapped in an outer pair of quotes, and Node must be told
// not to re-escape it (`windowsVerbatimArguments: true`) or the resulting
// command line breaks for anything containing nested quotes. This exact
// pattern was verified empirically against this project's Windows Node
// build (task-22-24-report.md) before being adopted here, including with a
// command containing nested double quotes.
function buildSpawnInvocation(command: string): { file: string; args: string[]; verbatim: boolean } {
  if (process.platform === 'win32') {
    return { file: 'cmd.exe', args: ['/d', '/s', '/c', `"${command}"`], verbatim: true };
  }
  return { file: '/bin/sh', args: ['-c', command], verbatim: false };
}

// ---------------------------------------------------------------------------
// Process-tree termination
// ---------------------------------------------------------------------------
//
// child.kill() alone only signals the immediate child. On Windows that
// immediate child is cmd.exe, NOT whatever command it ran -- empirically
// verified (task-22-24-report.md) that killing cmd.exe leaves a grandchild
// (e.g. a `ping`-based sleep) running, fully orphaned. On POSIX, a compound
// command ("a && b") is similarly executed by child processes /bin/sh forks,
// not by /bin/sh itself for anything beyond a single simple command.
// terminate() below kills the whole tree on both platforms: `taskkill /t`
// on Windows, and the negative-PID process-group convention on POSIX
// (requires spawning with `detached: true`, done in run_command below).
//
// Windows escalation note (also empirically verified): a bare `taskkill /t`
// (no /f) reliably FAILS for ordinary console processes -- "This process
// can only be terminated forcefully" -- so the soft attempt below is a
// best-effort courtesy for the rare process that DOES have a message loop,
// not a step this function waits confidently on before escalating.
//
// LIMIT, and it is a real one: "the whole tree" means the tree as the OS
// still relates it to our child. A process that deliberately detaches --
// `start /b` or DETACHED_PROCESS on Windows, setsid()/its own process group
// on POSIX -- is no longer in that tree and SURVIVES both branches above
// (demonstrated during review with a detached grandchild that outlived the
// timeout kill). run_command's description says so rather than promising the
// model something this function cannot deliver.
async function terminate(child: ChildProcess, graceMs: number): Promise<void> {
  if (!child.pid) return;

  if (process.platform === 'win32') {
    await execFileAsync('taskkill', ['/pid', String(child.pid), '/t']).catch(() => {});
  } else {
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      /* already gone */
    }
  }

  await Promise.race([onceExit(child), delay(graceMs)]);
  if (child.exitCode !== null || child.signalCode !== null) return;

  if (process.platform === 'win32') {
    await execFileAsync('taskkill', ['/pid', String(child.pid), '/t', '/f']).catch(() => {});
  } else {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      /* already gone */
    }
  }
}

function onceExit(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    child.once('exit', () => resolve());
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// run_command
// ---------------------------------------------------------------------------

interface RunResult {
  command: string;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  truncated: boolean;
  timeoutMsUsed: number;
  output: string;
}

export const runCommandTool: ToolSpec = {
  name: 'run_command',
  description:
    'Runs a shell command with cwd forced to the workspace root. Default timeout 120s (hard cap 600s); ' +
    'combined stdout+stderr is captured up to 100KB. On timeout the command and its process tree are killed ' +
    'on a best-effort basis, but a process that fully detaches itself (its own process group, or a Windows ' +
    'DETACHED_PROCESS/START-launched child) survives and keeps running after this tool returns.',
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'The command line to run.' },
      timeoutMs: { type: 'integer', minimum: 1, description: 'Timeout in milliseconds (default 120000, hard cap 600000).' },
    },
    required: ['command'],
  },
  risk: 'execute',
  source: 'shell',
  async execute(args: unknown, ctx: ToolContext): Promise<unknown> {
    return runTool(async () => {
      const command = requireString(args, 'command');
      const requestedTimeout = optionalPositiveInt(args, 'timeoutMs');
      const timeoutMsUsed = Math.min(requestedTimeout ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);

      if (!ctx.workspaceRoot) {
        throw new Error('run_command requires a workspace root, and none is configured for this chat.');
      }
      const cwd = ctx.workspaceRoot;

      // An AbortSignal that is ALREADY aborted never fires an 'abort' event,
      // so the listener registered inside runCommand() would never run and
      // the command would execute to completion -- side effects and all --
      // after the turn it belongs to had been cancelled. Demonstrated.
      // Checked here, before anything is spawned, and again immediately
      // after the listener is attached (see runCommand) to cover an abort
      // landing in between.
      if (ctx.signal.aborted) throw new AlreadyAbortedError();

      return runCommand(command, cwd, timeoutMsUsed, ctx);
    });
  },
};

function runCommand(command: string, cwd: string, timeoutMsUsed: number, ctx: ToolContext): Promise<RunResult> {
  const { file, args, verbatim } = buildSpawnInvocation(command);

  return new Promise((resolve, reject) => {
    // Re-checked here, not just at the call site: between the caller's check
    // and this line the turn may have been cancelled, and an already-aborted
    // signal will not fire the listener attached below.
    if (ctx.signal.aborted) {
      reject(new AlreadyAbortedError());
      return;
    }

    let child: ChildProcess;
    try {
      child = spawn(file, args, {
        cwd,
        windowsHide: true,
        windowsVerbatimArguments: verbatim,
        // detached so POSIX can kill the whole process group (see
        // terminate()); harmless on Windows, where detached only affects
        // console signal delivery and taskkill is used for cleanup instead.
        detached: process.platform !== 'win32',
      });
    } catch (err) {
      reject(err);
      return;
    }

    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let truncated = false;
    let timedOut = false;
    let settled = false;

    function onData(chunk: Buffer): void {
      if (totalBytes >= MAX_OUTPUT_BYTES) {
        truncated = true;
        return;
      }
      chunks.push(chunk);
      totalBytes += chunk.length;
      if (totalBytes > MAX_OUTPUT_BYTES) truncated = true;
    }

    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);

    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      void terminate(child, KILL_GRACE_MS);
    }, timeoutMsUsed);

    const onAbort = () => {
      void terminate(child, KILL_GRACE_MS);
    };
    ctx.signal.addEventListener('abort', onAbort);
    // Third and final check, closing the gap between spawn() and the
    // listener being attached: an abort landing in there fires an event
    // nobody is listening for yet, and `aborted` is the only durable record
    // of it.
    if (ctx.signal.aborted) onAbort();

    function cleanup(): void {
      clearTimeout(timeoutTimer);
      ctx.signal.removeEventListener('abort', onAbort);
    }

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    });

    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      cleanup();

      const rawOutput = Buffer.concat(chunks);
      const capped = truncated ? rawOutput.subarray(0, MAX_OUTPUT_BYTES) : rawOutput;
      let output = capped.toString('utf8');
      if (truncated) {
        output += `\n\n[... output truncated: combined stdout+stderr exceeded the ${MAX_OUTPUT_BYTES / 1024}KB cap ...]`;
      }
      if (timedOut) {
        output += `\n\n[... command killed after exceeding its ${timeoutMsUsed}ms timeout ...]`;
      }

      resolve({
        command,
        exitCode: code,
        signal,
        timedOut,
        truncated,
        timeoutMsUsed,
        output,
      });
    });
  });
}
