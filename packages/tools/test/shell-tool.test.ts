import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ToolContext } from '@otherbench/core/ports/tool-provider.js';
import { runCommandTool } from '../src/shell-tool.js';

const execFileAsync = promisify(execFile);

let ws: string;

function ctx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    chatId: 'chat-1',
    messageId: 'msg-1',
    profileId: 'profile-1',
    workspaceRoot: ws,
    signal: new AbortController().signal,
    ...overrides,
  };
}

beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), 'otherbench-shell-tool-'));
});

afterEach(() => {
  try {
    rmSync(ws, { recursive: true, force: true });
  } catch {
    /* best-effort cleanup */
  }
});

/**
 * Confirms (or refutes) that a process whose command line contains `marker`
 * is still running -- used to prove a "killed" command's process (and any
 * children the shell spawned for it) genuinely no longer exists, not merely
 * that our own child_process handle reported closed.
 *
 * Deliberately does NOT fail-open on a tooling error: `wmic` (the obvious
 * first choice) does not exist at all on this project's Windows build --
 * verified empirically, `where wmic` finds nothing and invoking it throws
 * ENOENT -- and an earlier version of this helper silently swallowed that
 * and always returned `false`, making the assertions it backed pass
 * regardless of whether the process was actually still running. Using
 * PowerShell's `Get-CimInstance` instead (confirmed working here, and not
 * dependent on the deprecated wmic.exe binary) and letting a genuine
 * failure THROW keeps this check honest.
 */
// Each commandLineStillRunning() call cold-starts PowerShell and runs a CIM
// process query, which routinely takes several seconds on Windows while the
// full suite is running in parallel. The tests that use it get this explicit
// budget instead of vitest's 5s default, which the positive control (two
// queries plus a taskkill) overran on an ordinary full run.
const PROCESS_QUERY_TIMEOUT_MS = 30_000;

async function commandLineStillRunning(marker: string): Promise<boolean> {
  if (process.platform === 'win32') {
    const { stdout } = await execFileAsync('powershell', [
      '-NoProfile',
      '-Command',
      "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Select-Object -ExpandProperty CommandLine",
    ]);
    return stdout.includes(marker);
  }
  const { stdout } = await execFileAsync('ps', ['-ef']);
  return stdout.includes(marker);
}

describe('commandLineStillRunning (positive control)', () => {
  // Proves the detection helper itself is sound BEFORE trusting it to back
  // the "process was actually killed" assertions below: it must report
  // `true` while a marked process is genuinely alive, and `false` once it's
  // gone. Without this, a broken detector that always returns `false`
  // (exactly what happened with the first `wmic`-based version of this
  // helper, silently) would make every "was it killed" test pass vacuously.
  it('detects a live marked process, then stops detecting it once killed', async () => {
    const marker = `otherbench-shell-tool-positive-control-${randomUUID()}`;
    const child = spawn('node', ['-e', `/*${marker}*/ setTimeout(()=>{}, 30000)`], { windowsHide: true });
    try {
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(await commandLineStillRunning(marker)).toBe(true);
    } finally {
      child.kill();
      if (process.platform === 'win32' && child.pid) {
        await execFileAsync('taskkill', ['/pid', String(child.pid), '/t', '/f']).catch(() => {});
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(await commandLineStillRunning(marker)).toBe(false);
  }, PROCESS_QUERY_TIMEOUT_MS);
});

describe('run_command', () => {
  it('echoing a value succeeds', async () => {
    const result = (await runCommandTool.execute({ command: 'echo hello-otherbench' }, ctx())) as Record<string, unknown>;
    expect(result.error).toBeUndefined();
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('hello-otherbench');
  });

  it("never lets a command see the server's API token", async () => {
    const before = process.env['OTHERBENCH_TOKEN'];
    process.env['OTHERBENCH_TOKEN'] = 'leaked-token-value';
    try {
      const result = (await runCommandTool.execute(
        { command: `node -e "process.stdout.write('[' + (process.env.OTHERBENCH_TOKEN ?? 'none') + ']')"` },
        ctx()
      )) as Record<string, unknown>;
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain('[none]');
      expect(result.output).not.toContain('leaked-token-value');
    } finally {
      if (before === undefined) delete process.env['OTHERBENCH_TOKEN'];
      else process.env['OTHERBENCH_TOKEN'] = before;
    }
  });

  it('runs with cwd forced to the workspace root', async () => {
    const result = (await runCommandTool.execute(
      { command: `node -e "process.stdout.write(process.cwd())"` },
      ctx()
    )) as Record<string, unknown>;
    expect(realpathSync((result.output as string).trim())).toBe(realpathSync(ws));
  });

  it('reports a non-zero exit code as data, not as a tool error', async () => {
    const result = (await runCommandTool.execute({ command: 'node -e "process.exit(3)"' }, ctx())) as Record<string, unknown>;
    expect(result.error).toBeUndefined();
    expect(result.exitCode).toBe(3);
  });

  it('rejects missing/blank command as a structured bad_args error, not an exception', async () => {
    const result = (await runCommandTool.execute({}, ctx())) as Record<string, unknown>;
    expect(result.error).toBe(true);
    expect(result.code).toBe('bad_args');
  });

  it('clamps a requested timeout above the 600s hard cap and reports the clamped value used', async () => {
    const result = (await runCommandTool.execute({ command: 'echo hi', timeoutMs: 10_000_000 }, ctx())) as Record<
      string,
      unknown
    >;
    expect(result.timeoutMsUsed).toBe(600_000);
  });

  it(
    'kills a sleeping command (and its child process) once the timeout elapses',
    async () => {
      const marker = `otherbench-shell-tool-test-${randomUUID()}`;
      const result = (await runCommandTool.execute(
        { command: `node -e "/*${marker}*/ setTimeout(()=>{}, 30000)"`, timeoutMs: 200 },
        ctx()
      )) as Record<string, unknown>;

      expect(result.error).toBeUndefined();
      expect(result.timedOut).toBe(true);
      expect(result.output as string).toContain('timeout');

      // Prove the underlying process is genuinely gone, not merely that our
      // own handle to the shell wrapper reported closed (child.kill() alone
      // leaves the actual command orphaned -- see shell-tool.ts's terminate()
      // doc comment; this is the regression that guards against reverting to
      // that).
      expect(await commandLineStillRunning(marker)).toBe(false);
    },
    PROCESS_QUERY_TIMEOUT_MS
  );

  it(
    'kills the running command when the tool context signal aborts',
    async () => {
      const marker = `otherbench-shell-tool-abort-test-${randomUUID()}`;
      const controller = new AbortController();
      const promise = runCommandTool.execute(
        { command: `node -e "/*${marker}*/ setTimeout(()=>{}, 30000)"` },
        ctx({ signal: controller.signal })
      );
      setTimeout(() => controller.abort(), 200);

      const result = (await promise) as Record<string, unknown>;
      expect(result.error).toBeUndefined();
      expect(await commandLineStillRunning(marker)).toBe(false);
    },
    PROCESS_QUERY_TIMEOUT_MS
  );

  it('caps combined output at 100KB and appends a truncation notice', async () => {
    const result = (await runCommandTool.execute(
      { command: `node -e "process.stdout.write('x'.repeat(200000))"` },
      ctx()
    )) as Record<string, unknown>;

    expect(result.truncated).toBe(true);
    expect((result.output as string).toLowerCase()).toContain('truncated');
    // 100KB of 'x' plus the notice text -- comfortably under 200000, proving
    // it was actually capped rather than passed through whole.
    expect((result.output as string).length).toBeLessThan(150_000);
  });
});

describe('cancellation before the command starts', () => {
  it('does not run the command at all when ctx.signal is already aborted, and says so', async () => {
    // An AbortSignal that is ALREADY aborted never fires an 'abort' event, so
    // the listener the tool attaches after spawning never runs -- the command
    // executed to completion, side effects included, after the turn it
    // belonged to had been cancelled. This asserts on the SIDE EFFECT, not on
    // the return value, because that is what actually leaked.
    const marker = join(ws, `side-effect-${randomUUID()}.txt`);
    const controller = new AbortController();
    controller.abort();

    const result = (await runCommandTool.execute(
      { command: `node -e "require('fs').writeFileSync(process.argv[1], 'ran')" ${JSON.stringify(marker)}` },
      ctx({ signal: controller.signal })
    )) as Record<string, unknown>;

    expect(result).toMatchObject({ error: true, code: 'aborted' });
    // Give a command that WAS started time to finish, so this cannot pass by
    // merely checking too early.
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(existsSync(marker)).toBe(false);
  });

  it('still runs normally when the signal is live', async () => {
    const marker = join(ws, `side-effect-${randomUUID()}.txt`);
    const result = (await runCommandTool.execute(
      { command: `node -e "require('fs').writeFileSync(process.argv[1], 'ran')" ${JSON.stringify(marker)}` },
      ctx()
    )) as Record<string, unknown>;

    expect(result.error).toBeUndefined();
    expect(existsSync(marker)).toBe(true);
  });
});

describe('tool description honesty', () => {
  it('does not promise that every child is killed on timeout', async () => {
    // The description told the model "the process (and any children it
    // spawns) is killed if the timeout is reached". A fully detached
    // grandchild survives (demonstrated), and a model that believes the
    // promise will reason wrongly about what it has left running.
    const { description } = runCommandTool;
    expect(description).toMatch(/best-effort/i);
    expect(description).toMatch(/detach/i);
    expect(description).not.toMatch(/and any children it spawns\) is killed/i);
  });
});
