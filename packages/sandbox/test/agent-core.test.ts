import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// Plain ESM that ships into the VM; vitest loads it as it is.
import { createAgent, DENY_READ, MAX_OUTPUT_BYTES } from '../resources/agent-core.mjs';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'grunt-agent-core-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

type Sent = { type: string; [key: string]: unknown };
type HostPattern = { host: string; port?: number };
type Wrapped = { argv: string[]; env: NodeJS.ProcessEnv };

/**
 * The agent with a fake sandbox runtime whose "sandbox" runs the command as a
 * Node script, so a test's command is JavaScript. The runtime also records the
 * agent's environment where the real one reads it: TMPDIR when it starts,
 * CLAUDE_CODE_TMPDIR each time it wraps a command.
 */
function harness(over: Partial<Record<'initialize' | 'wrapWithSandboxArgv' | 'annotateStderrWithSandboxFailures', unknown>> = {}) {
  const sent: Sent[] = [];
  const exits: number[] = [];
  const env: Record<string, string | undefined> = {};
  const tmpdirAtInitialize: Array<string | undefined> = [];
  const tmpdirAtWrap: Array<string | undefined> = [];
  let ask: ((p: HostPattern) => Promise<boolean>) | null = null;
  const runtime = {
    initialize: vi.fn(async (_config: unknown, cb: (p: HostPattern) => Promise<boolean>) => {
      tmpdirAtInitialize.push(env.TMPDIR);
      ask = cb;
    }),
    updateConfig: vi.fn((_config: unknown) => undefined),
    wrapWithSandboxArgv: vi.fn(
      async (command: string, _shell: string, _custom: unknown, _signal: AbortSignal, _cwd: string, _options: unknown): Promise<Wrapped> => {
        tmpdirAtWrap.push(env.CLAUDE_CODE_TMPDIR);
        return { argv: [process.execPath, '-e', command], env: { ...process.env } };
      }
    ),
    annotateStderrWithSandboxFailures: vi.fn((_id: string, _stderr: string) => ''),
    cleanupAfterCommand: vi.fn(),
    reset: vi.fn(async () => {}),
    ...over,
  };
  const agent = createAgent({
    runtime,
    spawn,
    send: (m: Sent) => sent.push(m),
    mkdir,
    rm,
    kill: (pid: number, signal: string) => process.kill(Math.abs(pid), signal),
    exit: (code: number) => exits.push(code),
    env,
  });
  const receive = (m: unknown): Promise<void> => agent.receive(JSON.stringify(m));
  const home = join(dir, 'home');
  const tmpRoot = join(dir, 'tmp');
  return {
    sent,
    exits,
    runtime,
    env,
    tmpdirAtInitialize,
    tmpdirAtWrap,
    home,
    tmpRoot,
    rt: `${tmpRoot}/rt`,
    receive,
    init: (allowedHosts: string[] = ['pypi.org']) => receive({ type: 'init', home, tmpRoot, allowedHosts }),
    run: (id: number, command: string, extra: Record<string, unknown> = {}) =>
      receive({
        type: 'run',
        id,
        command,
        cwd: dir,
        timeoutMs: 10_000,
        readPaths: ['/mnt/e/ws'],
        writePaths: ['/mnt/e/ws'],
        denyWritePaths: ['/mnt/e/ws/vendor'],
        allowedHosts: ['pypi.org'],
        ...extra,
      }),
    output: (id: number) => sent.filter((m) => m.type === 'output' && m.id === id).map((m) => String(m.chunk)).join(''),
    done: (id: number) => sent.find((m) => m.type === 'done' && m.id === id),
    ask: (p: HostPattern) => {
      if (!ask) throw new Error('the runtime was never initialised');
      return ask(p);
    },
  };
}

describe('the sandbox agent', () => {
  it("init makes the chat's home, temp and runtime folders, starts the runtime with the allowlist and nothing readable under /mnt, /home or /tmp, and says ready", async () => {
    const h = harness();
    await h.init(['pypi.org']);
    expect(existsSync(h.home)).toBe(true);
    expect(existsSync(h.tmpRoot)).toBe(true);
    expect(existsSync(h.rt)).toBe(true);
    // No per-run temp folder yet, and the temp root itself is never readable (it would turn a run's folder read-only).
    expect(h.runtime.initialize).toHaveBeenCalledWith(
      {
        network: { allowedDomains: ['pypi.org'], deniedDomains: [], allowLocalBinding: false },
        filesystem: { denyRead: DENY_READ, allowRead: [h.home, h.rt], allowWrite: [h.home], denyWrite: [] },
      },
      expect.any(Function)
    );
    expect(DENY_READ).toEqual(['/mnt', '/home', '/tmp']);
    expect(h.sent).toEqual([{ type: 'ready' }]);
  });

  it("points the agent's TMPDIR at the runtime folder before the runtime starts, so its proxy sockets stay readable", async () => {
    const h = harness();
    await h.init();
    expect(h.tmpdirAtInitialize).toEqual([h.rt]);
  });

  it('a runtime that fails to start is fatal', async () => {
    const h = harness({ initialize: vi.fn(async () => Promise.reject(new Error('bwrap not found'))) });
    await h.init();
    expect(h.sent).toEqual([{ type: 'fatal', message: 'bwrap not found' }]);
    expect(h.exits).toEqual([1]);
  });

  it("runs a command inside the runtime with the chat's folders, its home and its own temp folder, streaming the output", async () => {
    const h = harness();
    await h.init();
    await h.run(1, 'process.stdout.write("hello "); process.stderr.write("world")');
    expect(h.output(1)).toContain('hello');
    expect(h.output(1)).toContain('world');
    expect(h.done(1)).toEqual({ type: 'done', id: 1, exitCode: 0, signal: null, timedOut: false, truncated: false, note: '' });
    const call = h.runtime.wrapWithSandboxArgv.mock.calls[0]!;
    const tmp = `${h.tmpRoot}/1`;
    expect(call[1]).toBe('bash');
    expect(call[2]).toEqual({
      filesystem: {
        denyRead: DENY_READ,
        allowRead: ['/mnt/e/ws', h.home, h.rt, tmp],
        allowWrite: ['/mnt/e/ws', h.home, tmp],
        denyWrite: ['/mnt/e/ws/vendor'],
      },
    });
    expect(call[4]).toBe(dir);
    expect(call[5]).toEqual({ commandId: 'grunt-run-1', commandText: call[0] });
    expect(h.runtime.cleanupAfterCommand).toHaveBeenCalledTimes(1);
    expect(existsSync(tmp)).toBe(false);
    // Only the run's own folder goes; the runtime's sockets live on.
    expect(existsSync(h.rt)).toBe(true);
  });

  it("gives each run its own temp folder through CLAUDE_CODE_TMPDIR, which the runtime reads when it wraps the command", async () => {
    const h = harness();
    await h.init();
    await h.run(1, '');
    await h.run(2, '');
    expect(h.tmpdirAtWrap).toEqual([`${h.tmpRoot}/1`, `${h.tmpRoot}/2`]);
    // The runtime folder stays the agent's TMPDIR throughout.
    expect(h.env.TMPDIR).toBe(h.rt);
  });

  it('creates the run temp folder before wrapping, so the runtime can bind it', async () => {
    let existedAtWrap: boolean | null = null;
    const h = harness({
      wrapWithSandboxArgv: vi.fn(async (): Promise<Wrapped> => {
        existedAtWrap = existsSync(`${h.tmpRoot}/1`);
        return { argv: [process.execPath, '-e', ''], env: { ...process.env } };
      }),
    });
    await h.init();
    await h.run(1, '');
    expect(existedAtWrap).toBe(true);
  });

  it('reports the exit code', async () => {
    const h = harness();
    await h.init();
    await h.run(1, 'process.exit(3)');
    expect(h.done(1)).toMatchObject({ exitCode: 3, timedOut: false });
  });

  it('caps the output at 100 KB and says it did', async () => {
    const h = harness();
    await h.init();
    await h.run(1, 'process.stdout.write("x".repeat(300000))');
    expect(Buffer.byteLength(h.output(1))).toBeLessThanOrEqual(MAX_OUTPUT_BYTES);
    expect(h.done(1)).toMatchObject({ truncated: true });
  });

  it('kills a command that runs past its timeout', async () => {
    const h = harness();
    await h.init();
    await h.run(1, 'setTimeout(() => {}, 60000)', { timeoutMs: 300 });
    expect(h.done(1)).toMatchObject({ timedOut: true });
    expect(h.done(1)!.exitCode).not.toBe(0);
  });

  it('kills a command when Grunt cancels it', async () => {
    const h = harness();
    await h.init();
    const running = h.run(1, 'setTimeout(() => {}, 60000)');
    await vi.waitFor(() => expect(h.runtime.wrapWithSandboxArgv).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 200));
    await h.receive({ type: 'cancel', id: 1 });
    await running;
    expect(h.done(1)).toMatchObject({ timedOut: false });
    expect(h.done(1)!.exitCode).not.toBe(0);
  });

  it("asks Grunt about a host the runtime asks about, and gives the runtime Grunt's answer", async () => {
    let answer: boolean | null = null;
    const h = harness({
      wrapWithSandboxArgv: vi.fn(async (): Promise<Wrapped> => {
        answer = await h.ask({ host: 'example.com', port: 443 });
        return { argv: [process.execPath, '-e', ''], env: { ...process.env } };
      }),
    });
    await h.init();
    const running = h.run(1, 'ignored');
    await vi.waitFor(() => expect(h.sent).toContainEqual({ type: 'ask', askId: 1, host: 'example.com', port: 443 }));
    await h.receive({ type: 'answer', askId: 1, allowed: true });
    await running;
    expect(answer).toBe(true);
  });

  it('changes the allowlist only when a run brings a different one, keeping the base folders', async () => {
    const h = harness();
    await h.init(['pypi.org']);
    await h.run(1, '', { allowedHosts: ['pypi.org'] });
    expect(h.runtime.updateConfig).not.toHaveBeenCalled();
    await h.run(2, '', { allowedHosts: ['pypi.org', 'example.org'] });
    expect(h.runtime.updateConfig).toHaveBeenCalledTimes(1);
    expect(h.runtime.updateConfig.mock.calls[0]![0]).toEqual({
      network: { allowedDomains: ['pypi.org', 'example.org'], deniedDomains: [], allowLocalBinding: false },
      filesystem: { denyRead: DENY_READ, allowRead: [h.home, h.rt], allowWrite: [h.home], denyWrite: [] },
    });
  });

  it("hands back the runtime's note on what it blocked", async () => {
    const h = harness({ annotateStderrWithSandboxFailures: vi.fn(() => '<sandbox_violations>write /mnt/e/ws/vendor/x</sandbox_violations>') });
    await h.init();
    await h.run(1, 'process.exit(1)');
    expect(h.done(1)).toMatchObject({ note: '<sandbox_violations>write /mnt/e/ws/vendor/x</sandbox_violations>' });
  });

  it('a run before init fails instead of running anything', async () => {
    const h = harness();
    await h.run(1, 'process.exit(0)');
    expect(h.sent).toEqual([{ type: 'failed', id: 1, message: 'The sandbox agent was not started for a chat.' }]);
    expect(h.runtime.wrapWithSandboxArgv).not.toHaveBeenCalled();
  });

  it('close stops running commands, refuses pending asks, resets the runtime and exits', async () => {
    const h = harness();
    await h.init();
    const running = h.run(1, 'setTimeout(() => {}, 60000)');
    await vi.waitFor(() => expect(h.runtime.wrapWithSandboxArgv).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 200));
    await h.receive({ type: 'close' });
    expect(h.runtime.reset).toHaveBeenCalled();
    expect(h.exits).toEqual([0]);
    await running;
    expect(h.done(1)!.exitCode).not.toBe(0);
  });

  it('ignores lines that are not messages', async () => {
    const h = harness();
    const agent = createAgent({ runtime: h.runtime, spawn, send: () => undefined, mkdir, rm, kill: () => undefined, exit: () => undefined, env: {} });
    await agent.receive('not json');
    await agent.receive('{"type":"bogus"}');
    await agent.receive('42');
    expect(h.runtime.initialize).not.toHaveBeenCalled();
  });
});
