import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { lstat, mkdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// Plain ESM that ships into the VM; vitest loads it as it is.
import { createAgent, DENIED_RESOLVED_ADDRESSES, DENY_READ, isPrivateAddress, LOOKUP_TIMEOUT_MS, MAX_OUTPUT_BYTES } from '../resources/agent-core.mjs';

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
type Lookup = (host: string) => Promise<Array<{ address: string }>>;

function harness(
  over: Record<string, unknown> = {},
  fakes: { spawn?: unknown; kill?: (pid: number, signal: string) => void; rm?: typeof rm; realpath?: typeof realpath; lookup?: Lookup } = {}
) {
  const sent: Sent[] = [];
  const exits: number[] = [];
  const warnings: string[] = [];
  const env: Record<string, string | undefined> = {};
  const tmpdirAtInitialize: Array<string | undefined> = [];
  const tmpdirAtWrap: Array<string | undefined> = [];
  let ask: ((p: HostPattern) => Promise<boolean>) | null = null;
  // Every name resolves to a public address unless a test says otherwise.
  const lookedUp: string[] = [];
  const lookup: Lookup = (host) => {
    lookedUp.push(host);
    return fakes.lookup ? fakes.lookup(host) : Promise.resolve([{ address: '93.184.216.34' }]);
  };
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
    spawn: (fakes.spawn ?? spawn) as typeof spawn,
    send: (m: Sent) => sent.push(m),
    mkdir,
    rm: fakes.rm ?? rm,
    lstat,
    realpath: fakes.realpath ?? realpath,
    warn: (m: string) => warnings.push(m),
    kill: fakes.kill ?? ((pid: number, signal: string) => process.kill(Math.abs(pid), signal)),
    exit: (code: number) => exits.push(code),
    env,
    lookup,
  });
  const receive = (m: unknown): Promise<void> => agent.receive(JSON.stringify(m));
  const home = join(dir, 'home');
  const tmpRoot = join(dir, 'tmp');
  return {
    sent,
    exits,
    warnings,
    runtime,
    env,
    tmpdirAtInitialize,
    tmpdirAtWrap,
    lookedUp,
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
        network: { allowedDomains: ['pypi.org'], deniedDomains: [], allowLocalBinding: false, deniedResolvedAddresses: DENIED_RESOLVED_ADDRESSES },
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
    await h.run(1, '0');
    await h.run(2, '0');
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
    await h.run(1, '0');
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
    await h.run(1, '0', { allowedHosts: ['pypi.org'] });
    expect(h.runtime.updateConfig).not.toHaveBeenCalled();
    await h.run(2, '0', { allowedHosts: ['pypi.org', 'example.org'] });
    expect(h.runtime.updateConfig).toHaveBeenCalledTimes(1);
    expect(h.runtime.updateConfig.mock.calls[0]![0]).toEqual({
      network: { allowedDomains: ['pypi.org', 'example.org'], deniedDomains: [], allowLocalBinding: false, deniedResolvedAddresses: DENIED_RESOLVED_ADDRESSES },
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

  it('close stops running commands, waits for them to report, then resets the runtime and exits', async () => {
    let reportedBeforeReset: boolean | null = null;
    const h = harness({
      reset: vi.fn(async () => {
        reportedBeforeReset = h.done(1) !== undefined;
      }),
    });
    await h.init();
    const running = h.run(1, 'setTimeout(() => {}, 60000)');
    await vi.waitFor(() => expect(h.runtime.wrapWithSandboxArgv).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 200));
    await h.receive({ type: 'close' });
    expect(reportedBeforeReset).toBe(true);
    expect(h.runtime.reset).toHaveBeenCalled();
    expect(h.exits).toEqual([0]);
    expect(h.done(1)!.exitCode).not.toBe(0);
    await running;
  });

  it('close refuses a pending network ask', async () => {
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
    await h.receive({ type: 'close' });
    await running;
    expect(answer).toBe(false);
    expect(h.exits).toEqual([0]);
  });

  it('a second close does nothing more', async () => {
    const h = harness();
    await h.init();
    await h.receive({ type: 'close' });
    await h.receive({ type: 'close' });
    expect(h.runtime.reset).toHaveBeenCalledTimes(1);
    expect(h.exits).toEqual([0]);
  });

  it('ignores lines that are not messages', async () => {
    const h = harness();
    const agent = createAgent({
      runtime: h.runtime,
      spawn,
      send: () => undefined,
      mkdir,
      rm,
      lstat,
      realpath,
      kill: () => undefined,
      exit: () => undefined,
      env: {},
      lookup: async () => [],
    });
    await agent.receive('not json');
    await agent.receive('{"type":"bogus"}');
    await agent.receive('42');
    expect(h.runtime.initialize).not.toHaveBeenCalled();
  });
});

/** A promise the test settles by hand. */
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('the sandbox agent, awkward timing', () => {
  it('a cancel that lands while the command is still being wrapped means it never starts', async () => {
    const wrapping = deferred<Wrapped>();
    const h = harness({ wrapWithSandboxArgv: vi.fn(() => wrapping.promise) });
    await h.init();
    const running = h.run(1, 'process.stdout.write("ran")');
    await vi.waitFor(() => expect(h.runtime.wrapWithSandboxArgv).toHaveBeenCalled());
    await h.receive({ type: 'cancel', id: 1 });
    wrapping.resolve({ argv: [process.execPath, '-e', 'process.stdout.write("ran")'], env: { ...process.env } });
    await running;
    expect(h.output(1)).toBe('');
    expect(h.done(1)).toEqual({ type: 'done', id: 1, exitCode: null, signal: 'SIGTERM', timedOut: false, truncated: false, note: '' });
    expect(h.runtime.cleanupAfterCommand).toHaveBeenCalledTimes(1);
  });

  it('a cancel while a network ask is pending refuses it, so the wrap can finish', async () => {
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
    await h.receive({ type: 'cancel', id: 1 });
    await running;
    expect(answer).toBe(false);
    expect(h.done(1)).toMatchObject({ type: 'done', signal: 'SIGTERM' });
  });

  it('refuses an ask still pending when the command times out', async () => {
    const h = harness();
    await h.init();
    const running = h.run(1, 'setTimeout(() => {}, 60000)', { timeoutMs: 300 });
    await vi.waitFor(() => expect(h.runtime.wrapWithSandboxArgv).toHaveBeenCalled());
    const answer = h.ask({ host: 'example.com', port: 443 });
    await running;
    await expect(answer).resolves.toBe(false);
    expect(h.done(1)).toMatchObject({ timedOut: true });
  });

  it('refuses an ask still pending when the command finishes', async () => {
    const h = harness();
    await h.init();
    const running = h.run(1, 'setTimeout(() => {}, 200)');
    await vi.waitFor(() => expect(h.runtime.wrapWithSandboxArgv).toHaveBeenCalled());
    const answer = h.ask({ host: 'example.com', port: 443 });
    await running;
    await expect(answer).resolves.toBe(false);
  });

  it('reports a failure to change the allowlist, and tries again on the next run', async () => {
    const h = harness({
      updateConfig: vi.fn(() => {
        throw new Error('bad config');
      }),
    });
    await h.init(['pypi.org']);
    await h.run(1, '0', { allowedHosts: ['example.org'] });
    expect(h.sent.filter((m) => m.id === 1)).toEqual([{ type: 'failed', id: 1, message: 'bad config' }]);
    expect(h.runtime.wrapWithSandboxArgv).not.toHaveBeenCalled();
    // The allowlist was not recorded as changed, so the next run changes it again.
    await h.run(2, '0', { allowedHosts: ['example.org'] });
    expect(h.runtime.updateConfig).toHaveBeenCalledTimes(2);
    // And the agent is not stuck on the failed run.
    expect(h.sent.filter((m) => m.id === 2)).toEqual([{ type: 'failed', id: 2, message: 'bad config' }]);
  });

  it('never sends more than 100 KB of multi-byte output, and never cuts a character in half', async () => {
    const h = harness();
    await h.init();
    await h.run(1, 'process.stdout.write(String.fromCharCode(0x20ac).repeat(40000))');
    const text = h.output(1);
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(MAX_OUTPUT_BYTES);
    expect(text).toMatch(/^€+$/);
    expect(h.done(1)).toMatchObject({ truncated: true });
  });

  it('never sends more than 100 KB of binary output', async () => {
    const h = harness();
    await h.init();
    await h.run(1, 'process.stdout.write(Buffer.alloc(300000, 0xff))');
    expect(Buffer.byteLength(h.output(1))).toBeLessThanOrEqual(MAX_OUTPUT_BYTES);
    expect(h.done(1)).toMatchObject({ truncated: true });
  });

  it('does not say truncated for output that fits exactly', async () => {
    const h = harness();
    await h.init();
    await h.run(1, `process.stdout.write("x".repeat(${MAX_OUTPUT_BYTES}))`);
    expect(Buffer.byteLength(h.output(1))).toBe(MAX_OUTPUT_BYTES);
    expect(h.done(1)).toMatchObject({ truncated: false });
  });

  it('keeps the runtime note to 4 KB', async () => {
    const h = harness({ annotateStderrWithSandboxFailures: vi.fn(() => 'n'.repeat(10_000)) });
    await h.init();
    await h.run(1, '0');
    expect(String(h.done(1)!.note)).toHaveLength(4096);
  });

  it('stopping a command twice does not restart the kill clock', async () => {
    const child = Object.assign(new EventEmitter(), { pid: 4242, stdout: new EventEmitter(), stderr: new EventEmitter() });
    const kills: Array<[number, string]> = [];
    const h = harness({}, { spawn: () => child, kill: (pid, signal) => void kills.push([pid, signal]) });
    await h.init();
    const running = h.run(1, '0', { timeoutMs: 50 });
    await vi.waitFor(() => expect(kills).toEqual([[-4242, 'SIGTERM']]));
    await h.receive({ type: 'cancel', id: 1 });
    expect(kills).toEqual([[-4242, 'SIGTERM']]);
    child.emit('close', null, 'SIGTERM');
    await running;
    expect(h.done(1)).toMatchObject({ timedOut: true, signal: 'SIGTERM' });
  });

  it('caps a huge timeout instead of letting the timer overflow', async () => {
    const h = harness();
    await h.init();
    // Node turns a delay over 2^31-1 ms into 1 ms, which would time this command out at once.
    await h.run(1, 'setTimeout(() => {}, 300)', { timeoutMs: 1e12 });
    expect(h.done(1)).toMatchObject({ exitCode: 0, timedOut: false });
  });
});

describe('the sandbox agent, input from the host', () => {
  const repliesFor = (h: ReturnType<typeof harness>, id: number) => h.sent.filter((m) => m.id === id);

  it.each([['../x'], [-1], [1.5], [Number.MAX_SAFE_INTEGER + 2], [null]])('ignores a run whose id is %j', async (id) => {
    const h = harness();
    await h.init();
    h.sent.length = 0;
    await h.receive({ type: 'run', id, command: 'process.exit(0)', cwd: dir, timeoutMs: 1000, allowedHosts: ['pypi.org'] });
    expect(h.sent).toEqual([]);
    expect(h.runtime.wrapWithSandboxArgv).not.toHaveBeenCalled();
  });

  it.each([
    ['an empty command', { command: '' }],
    ['a command that is not text', { command: 7 }],
    ['a relative working folder', { cwd: 'ws' }],
    ['a missing working folder', { cwd: undefined }],
    ['a zero timeout', { timeoutMs: 0 }],
    ['a negative timeout', { timeoutMs: -5 }],
    ['a timeout that is not a number', { timeoutMs: '1000' }],
    ['an infinite timeout', { timeoutMs: Infinity }],
  ])('refuses a run with %s without running anything', async (_name, bad) => {
    const h = harness();
    await h.init();
    await h.run(1, 'process.exit(0)', bad);
    const replies = repliesFor(h, 1);
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({ type: 'failed', id: 1 });
    expect(h.runtime.wrapWithSandboxArgv).not.toHaveBeenCalled();
  });

  it('refuses an init without absolute folders, as fatal', async () => {
    const h = harness();
    await h.receive({ type: 'init', home: 'home', tmpRoot: '/tmp/x', allowedHosts: [] });
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]).toMatchObject({ type: 'fatal' });
    expect(h.exits).toEqual([1]);
    expect(h.runtime.initialize).not.toHaveBeenCalled();
  });

  it('ignores a second init', async () => {
    const h = harness();
    await h.init();
    await h.init(['example.org']);
    expect(h.runtime.initialize).toHaveBeenCalledTimes(1);
    expect(h.sent).toEqual([{ type: 'ready' }]);
  });

  it('refuses a run while the runtime is still starting', async () => {
    const starting = deferred();
    const h = harness({ initialize: vi.fn(() => starting.promise) });
    const initialising = h.init();
    await h.run(1, 'process.exit(0)');
    expect(repliesFor(h, 1)).toEqual([{ type: 'failed', id: 1, message: 'The sandbox agent was not started for a chat.' }]);
    starting.resolve();
    await initialising;
    expect(h.sent.at(-1)).toEqual({ type: 'ready' });
    expect(h.runtime.wrapWithSandboxArgv).not.toHaveBeenCalled();
  });

  it('refuses a second run while one is in flight, and the first still finishes', async () => {
    const h = harness();
    await h.init();
    const first = h.run(1, 'setTimeout(() => {}, 300)');
    await vi.waitFor(() => expect(h.runtime.wrapWithSandboxArgv).toHaveBeenCalled());
    await h.run(2, 'process.exit(0)');
    expect(repliesFor(h, 2)).toEqual([{ type: 'failed', id: 2, message: 'The sandbox agent is already running a command.' }]);
    await h.run(1, 'process.exit(0)');
    expect(repliesFor(h, 1)).toEqual([{ type: 'failed', id: 1, message: 'Run 1 is already running.' }]);
    await first;
    expect(repliesFor(h, 1).filter((m) => m.type === 'done')).toHaveLength(1);
    expect(h.runtime.wrapWithSandboxArgv).toHaveBeenCalledTimes(1);
  });

  it("takes the next run as soon as it has reported done, while the last run's temp folder is still being cleared", async () => {
    const clearing = deferred();
    const slowRm = (async (path: string, options: object) => {
      // Only the first run's folder is slow to clear.
      if (path.endsWith('/1')) await clearing.promise;
      return rm(path, options);
    }) as typeof rm;
    const h = harness({}, { rm: slowRm });
    await h.init();
    const first = h.run(1, '0');
    await vi.waitFor(() => expect(h.done(1)).toBeDefined());
    // Grunt sends the next run the moment it sees done.
    await h.run(2, '0');
    expect(h.done(2)).toBeDefined();
    expect(repliesFor(h, 2).filter((m) => m.type === 'failed')).toEqual([]);
    clearing.resolve();
    await first;
    expect(existsSync(`${h.tmpRoot}/1`)).toBe(false);
  });

  it('a runtime that fails to start after a close already came in does not report fatal as well', async () => {
    const starting = deferred();
    const h = harness({ initialize: vi.fn(() => starting.promise) });
    const initialising = h.init();
    await vi.waitFor(() => expect(h.runtime.initialize).toHaveBeenCalled());
    await h.receive({ type: 'close' });
    starting.reject(new Error('too late'));
    await initialising;
    expect(h.sent).toEqual([]);
    expect(h.exits).toEqual([0]);
  });

  it('takes the next run once the last one is done, even with the same id', async () => {
    const h = harness();
    await h.init();
    await h.run(1, '0');
    await h.run(1, '0');
    expect(h.sent.filter((m) => m.type === 'done')).toHaveLength(2);
  });

  it('refuses a run after close started', async () => {
    const h = harness();
    await h.init();
    await h.receive({ type: 'close' });
    await h.run(1, 'process.exit(0)');
    expect(repliesFor(h, 1)).toEqual([{ type: 'failed', id: 1, message: 'The sandbox agent is closing.' }]);
    expect(h.runtime.wrapWithSandboxArgv).not.toHaveBeenCalled();
  });

  it('a cancel for a run that is not running does nothing', async () => {
    const h = harness();
    await h.init();
    await h.receive({ type: 'cancel', id: 9 });
    await h.receive({ type: 'cancel', id: 'x' });
    expect(h.sent).toEqual([{ type: 'ready' }]);
  });
});

describe('the sandbox agent, links in the temp folder', () => {
  // A command can write to its own temp folder, and the agent (outside the inner
  // sandbox) deletes that folder afterwards: a link must never carry the delete
  // anywhere else. (A 'junction' is the unprivileged link on Windows, a plain
  // symlink elsewhere.)
  let outside: string;
  beforeEach(() => {
    outside = mkdtempSync(join(tmpdir(), 'grunt-agent-outside-'));
    writeFileSync(join(outside, 'keep.txt'), 'precious');
  });
  afterEach(() => rmSync(outside, { recursive: true, force: true }));
  const survives = () => expect(readFileSync(join(outside, 'keep.txt'), 'utf8')).toBe('precious');
  const linkTo = (target: string, at: string) => symlinkSync(target, at, 'junction');

  it('deletes the run folder without following a link inside it', async () => {
    const h = harness();
    await h.init();
    await h.run(1, `require("node:fs").symlinkSync(${JSON.stringify(outside)}, process.env.TMPDIR + "/link", "junction")`);
    expect(h.done(1)).toMatchObject({ exitCode: 0 });
    expect(existsSync(`${h.tmpRoot}/1`)).toBe(false);
    survives();
    expect(h.warnings).toEqual([]);
  });

  it('leaves alone a run folder the command swapped for a link', async () => {
    const h = harness();
    await h.init();
    await h.run(
      1,
      `const fs = require("node:fs"); fs.rmSync(process.env.TMPDIR, { recursive: true }); fs.symlinkSync(${JSON.stringify(outside)}, process.env.TMPDIR, "junction")`
    );
    expect(h.done(1)).toMatchObject({ exitCode: 0 });
    survives();
    expect(h.warnings).toHaveLength(1);
    expect(h.warnings[0]).toContain('not a plain folder');
  });

  it('leaves alone a run folder that resolves anywhere but directly under the temp root', async () => {
    const h = harness({}, { realpath: (async (p: string) => (p.endsWith('/1') ? outside : realpath(p))) as typeof realpath });
    await h.init();
    await h.run(1, '0');
    expect(h.done(1)).toMatchObject({ exitCode: 0 });
    expect(existsSync(`${h.tmpRoot}/1`)).toBe(true);
    survives();
    expect(h.warnings).toHaveLength(1);
    expect(h.warnings[0]).toContain('resolves to');
  });

  it('refuses a run whose folder is already a link, and touches nothing through it', async () => {
    const h = harness();
    await h.init();
    linkTo(outside, `${h.tmpRoot}/1`);
    await h.run(1, '0');
    expect(h.sent.filter((m) => m.id === 1)).toEqual([{ type: 'failed', id: 1, message: 'The temp folder for this run is already taken.' }]);
    expect(h.runtime.wrapWithSandboxArgv).not.toHaveBeenCalled();
    survives();
  });

  it("clears a real folder an earlier agent of the chat left under the run's id", async () => {
    const h = harness();
    await h.init();
    mkdirSync(`${h.tmpRoot}/1`);
    writeFileSync(`${h.tmpRoot}/1/stale.txt`, 'old');
    // Exits with the number of entries in its temp folder.
    await h.run(1, 'process.exit(require("node:fs").readdirSync(process.env.TMPDIR).length)');
    expect(h.done(1)).toMatchObject({ exitCode: 0 });
    expect(existsSync(`${h.tmpRoot}/1`)).toBe(false);
  });

  it.each([['tmp'], ['home']])('refuses to start with the %s folder a link', async (which) => {
    const h = harness();
    linkTo(outside, join(dir, which));
    await h.init();
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]).toMatchObject({ type: 'fatal' });
    expect(h.exits).toEqual([1]);
    expect(h.runtime.initialize).not.toHaveBeenCalled();
    survives();
  });
});

describe('the sandbox agent, private destinations', () => {
  const asksSent = (h: ReturnType<typeof harness>) => h.sent.filter((m) => m.type === 'ask');
  const resolvingTo =
    (...addresses: string[]): Lookup =>
    async () =>
      addresses.map((address) => ({ address }));

  it('asks the runtime to refuse the private-use, multicast and reserved ranges once a name is resolved', () => {
    expect(DENIED_RESOLVED_ADDRESSES).toEqual([
      '10.0.0.0/8',
      '172.16.0.0/12',
      '192.168.0.0/16',
      '100.64.0.0/10',
      'fc00::/7',
      '224.0.0.0/4',
      '240.0.0.0/4',
      '198.18.0.0/15',
      '127.0.0.0/8',
      '169.254.0.0/16',
    ]);
  });

  it('resolves the host and goes on to ask Grunt when every address is public', async () => {
    const h = harness({}, { lookup: resolvingTo('93.184.216.34', '2606:2800:220:1:248:1893:25c8:1946') });
    await h.init();
    void h.ask({ host: 'pypi.org', port: 443 });
    await vi.waitFor(() => expect(asksSent(h)).toEqual([{ type: 'ask', askId: 1, host: 'pypi.org', port: 443 }]));
    expect(h.lookedUp).toEqual(['pypi.org']);
  });

  it.each([
    ['loopback', '127.0.0.1'],
    ['an IPv4-mapped loopback', '::ffff:127.0.0.1'],
    ['a private address', '10.1.2.3'],
    ['the cloud metadata address', '169.254.169.254'],
    ['IPv6 loopback', '::1'],
    ['a unique local IPv6 address', 'fd12:3456::1'],
  ])('refuses a name that resolves to %s, without asking Grunt', async (_name, address) => {
    const h = harness({}, { lookup: resolvingTo(address) });
    await h.init();
    await expect(h.ask({ host: 'rebind.example.com', port: 443 })).resolves.toBe(false);
    expect(asksSent(h)).toEqual([]);
  });

  it('refuses a name when any one of its addresses is private', async () => {
    const h = harness({}, { lookup: resolvingTo('93.184.216.34', '192.168.1.5') });
    await h.init();
    await expect(h.ask({ host: 'mixed.example.com', port: 443 })).resolves.toBe(false);
    expect(asksSent(h)).toEqual([]);
  });

  it.each([
    ['fails', async () => Promise.reject(new Error('ENOTFOUND'))],
    [
      'throws',
      () => {
        throw new Error('boom');
      },
    ],
    ['finds nothing', async () => []],
  ])('refuses a name whose lookup %s, without asking Grunt', async (_name, lookup) => {
    const h = harness({}, { lookup: lookup as Lookup });
    await h.init();
    await expect(h.ask({ host: 'nowhere.example.com', port: 443 })).resolves.toBe(false);
    expect(asksSent(h)).toEqual([]);
  });

  it('refuses a name that takes too long to resolve, without asking Grunt', async () => {
    const h = harness({}, { lookup: () => new Promise(() => undefined) });
    await h.init();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const answer = h.ask({ host: 'slow.example.com', port: 443 });
      await vi.advanceTimersByTimeAsync(LOOKUP_TIMEOUT_MS);
      await expect(answer).resolves.toBe(false);
    } finally {
      vi.useRealTimers();
    }
    expect(asksSent(h)).toEqual([]);
  });

  it('does not raise a card for a name that finished resolving after its run was cancelled', async () => {
    const resolving = deferred<Array<{ address: string }>>();
    const h = harness({}, { lookup: () => resolving.promise });
    await h.init();
    let answer: Promise<boolean> | null = null;
    h.runtime.wrapWithSandboxArgv.mockImplementationOnce(async () => {
      answer = h.ask({ host: 'late.example.com', port: 443 });
      await answer;
      return { argv: [process.execPath, '-e', ''], env: { ...process.env } };
    });
    const running = h.run(1, 'ignored');
    await vi.waitFor(() => expect(h.lookedUp).toEqual(['late.example.com']));
    await h.receive({ type: 'cancel', id: 1 });
    resolving.resolve([{ address: '93.184.216.34' }]);
    await running;
    await expect(answer).resolves.toBe(false);
    expect(asksSent(h)).toEqual([]);
  });
});

describe('isPrivateAddress', () => {
  it.each([
    '0.0.0.0', '0.1.2.3', '10.0.0.1', '10.255.255.255', '100.64.0.1', '100.127.255.255', '127.0.0.1', '127.255.255.255',
    '169.254.169.254', '172.16.0.1', '172.31.255.255', '192.0.0.8', '192.0.2.1', '192.168.0.1', '198.18.0.1', '198.19.255.255',
    '198.51.100.1', '203.0.113.9', '224.0.0.1', '239.255.255.255', '240.0.0.1', '255.255.255.255',
    '::', '::1', 'fe80::1', 'fe80::1%eth0', 'febf::1', 'fec0::1', 'fc00::1', 'fd12:3456:789a::1', 'ff02::1', '2001:db8::1',
    '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:10.1.2.3', '::ffff:a9fe:a9fe', '::ffff:0:0', '::127.0.0.1', '0:0:0:0:0:ffff:c0a8:101',
    '64:ff9b::7f00:1', '64:ff9b::10.0.0.1', '[::1]',
    // Unreadable addresses are refused, not guessed at.
    '', 'localhost', '1.2.3', '1.2.3.4.5', '256.1.1.1', '010.0.0.1', '1.2.3.-4', '::ffff:1.2.3', '1::2::3', '1:2:3:4:5:6:7:8:9', 'g::1', ':1:2:3:4:5:6:7', 42, null, undefined,
  ])('refuses %j', (address) => {
    expect(isPrivateAddress(address)).toBe(true);
  });

  it.each([
    '1.1.1.1', '8.8.8.8', '93.184.216.34', '9.255.255.255', '11.0.0.1', '100.63.255.255', '100.128.0.1', '126.255.255.255', '128.0.0.1',
    '169.253.1.1', '169.255.1.1', '172.15.255.255', '172.32.0.1', '192.0.1.1', '192.0.3.1', '192.167.1.1', '192.169.1.1', '198.17.255.255',
    '198.20.0.1', '198.51.99.1', '198.51.101.1', '203.0.112.1', '203.0.114.1', '223.255.255.255',
    '2606:2800:220:1:248:1893:25c8:1946', '2001:4860:4860::8888', '2001:db9::1', '2a00:1450:4009:81f::200e', 'fb00::1', 'fe00::1',
    '::ffff:8.8.8.8', '::ffff:0808:0808', '64:ff9b::808:808',
  ])('lets %s through', (address) => {
    expect(isPrivateAddress(address)).toBe(false);
  });
});
