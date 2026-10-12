import { describe, expect, it, vi } from 'vitest';
import type { AgentClient, AgentRun } from '../src/agent-client.js';
import { AgentPool, type AgentPoolOptions } from '../src/agent-pool.js';
import { scriptedAgent, type AgentScript, type FakeChannel } from './helpers.js';

const run = (over: Partial<AgentRun> = {}): AgentRun => ({
  command: 'make',
  cwd: '/mnt/e/ws',
  timeoutMs: 120_000,
  readPaths: [],
  writePaths: [],
  denyWritePaths: [],
  allowedHosts: [],
  signal: new AbortController().signal,
  askHost: async () => false,
  ...over,
});

function poolWith(opts: Partial<AgentPoolOptions> = {}, script: AgentScript = {}) {
  const started: { chatId: string; client: AgentClient; channel: FakeChannel }[] = [];
  const closed: string[] = [];
  const died: string[] = [];
  const pool = new AgentPool({
    start: (chatId) => {
      const agent = scriptedAgent(script);
      started.push({ chatId, ...agent });
      return agent.client;
    },
    onClosed: (chatId) => closed.push(chatId),
    onDied: (chatId) => died.push(chatId),
    ...opts,
  });
  return { pool, started, closed, died };
}

describe('AgentPool', () => {
  it('keeps one agent per chat and reuses it', async () => {
    const { pool, started } = poolWith();
    await pool.run('c1', run());
    await pool.run('c1', run());
    await pool.run('c2', run());
    expect(started.map((s) => s.chatId)).toEqual(['c1', 'c2']);
    expect(pool.size).toBe(2);
  });

  it('gives commands that arrive while the agent starts the same agent', async () => {
    const { pool, started } = poolWith();
    const [a, b] = await Promise.all([pool.run('c1', run()), pool.run('c1', run())]);
    expect(a.exitCode).toBe(0);
    expect(b.exitCode).toBe(0);
    expect(started).toHaveLength(1);
    expect(started[0]!.channel.runs()).toHaveLength(2);
  });

  it('passes the run, with its askHost, to the agent untouched', async () => {
    const { pool, started } = poolWith({}, { onRun: () => undefined });
    const askHost = vi.fn(async () => true);
    void pool.run('c1', run({ askHost, command: 'pip install x' }));
    await vi.waitFor(() => expect(started[0]?.channel.runs()).toHaveLength(1));
    expect(started[0]!.channel.runs()[0]).toMatchObject({ command: 'pip install x', cwd: '/mnt/e/ws' });
    started[0]!.channel.emit({ type: 'ask', askId: 7, host: 'pypi.org', port: 443 });
    await vi.waitFor(() => expect(askHost).toHaveBeenCalledWith('pypi.org', 443, expect.any(AbortSignal)));
    await vi.waitFor(() => expect(started[0]!.channel.sent.at(-1)).toEqual({ type: 'answer', askId: 7, allowed: true }));
  });

  it('closes an agent that has been idle for idleMs', async () => {
    const { pool, closed } = poolWith({ idleMs: 20 });
    await pool.run('c1', run());
    await vi.waitFor(() => expect(closed).toEqual(['c1']));
    expect(pool.has('c1')).toBe(false);
  });

  it('does not idle-close an agent while a command is running', async () => {
    const { pool, started, closed } = poolWith({ idleMs: 20 }, { onRun: () => undefined });
    const first = pool.run('c1', run());
    await vi.waitFor(() => expect(started[0]?.channel.runs()).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 60));
    expect(closed).toEqual([]);
    started[0]!.channel.finish(1, 'late');
    expect((await first).output).toBe('late');
    await vi.waitFor(() => expect(closed).toEqual(['c1']));
  });

  it('at the limit, closes the agent idle longest to make room', async () => {
    const { pool, closed, started } = poolWith({ maxAgents: 2 });
    await pool.run('c1', run());
    await pool.run('c2', run());
    await pool.run('c3', run());
    expect(closed).toEqual(['c1']);
    expect(started.map((s) => s.chatId)).toEqual(['c1', 'c2', 'c3']);
  });

  it('when every agent is busy, waits for one to finish', async () => {
    const { pool, started, closed } = poolWith({ maxAgents: 1 }, { onRun: () => undefined });
    const first = pool.run('c1', run());
    await vi.waitFor(() => expect(started[0]?.channel.runs()).toHaveLength(1));
    const second = pool.run('c2', run());
    await new Promise((r) => setTimeout(r, 20));
    expect(started).toHaveLength(1);
    started[0]!.channel.finish(1, 'one');
    await first;
    await vi.waitFor(() => expect(started[1]?.channel.runs()).toHaveLength(1));
    started[1]!.channel.finish(1, 'two');
    expect((await second).output).toBe('two');
    expect(closed).toEqual(['c1']);
  });

  it('lets two waiting chats each have a free slot rather than blocking each other', async () => {
    const { pool, started } = poolWith({ maxAgents: 3, busyWaitMs: 2000 }, { onRun: () => undefined });
    void pool.run('c1', run());
    void pool.run('c2', run());
    await vi.waitFor(() => expect(started).toHaveLength(2));
    const waiting = [pool.run('c3', run()), pool.run('c4', run())];
    void waiting;
    await vi.waitFor(() => expect(started).toHaveLength(3));
    started[0]!.channel.finish(1, 'one');
    await vi.waitFor(() => expect(started).toHaveLength(4));
  });

  it('refuses as busy when no agent frees up within busyWaitMs', async () => {
    const { pool, started } = poolWith({ maxAgents: 1, busyWaitMs: 30 }, { onRun: () => undefined });
    void pool.run('c1', run());
    await vi.waitFor(() => expect(started).toHaveLength(1));
    await expect(pool.run('c2', run())).rejects.toMatchObject({ code: 'busy', message: expect.stringContaining('1 other chat') });
  });

  it('stops waiting for a slot when its turn is stopped', async () => {
    const { pool, started } = poolWith({ maxAgents: 1, busyWaitMs: 60_000 }, { onRun: () => undefined });
    void pool.run('c1', run());
    await vi.waitFor(() => expect(started).toHaveLength(1));
    const stop = new AbortController();
    const waiting = pool.run('c2', run({ signal: stop.signal }));
    await new Promise((r) => setTimeout(r, 10));
    stop.abort();
    await expect(waiting).rejects.toMatchObject({ code: 'aborted' });
    expect(started).toHaveLength(1);
    expect(pool.has('c2')).toBe(false);
  });

  it('refuses a command whose turn was already stopped without starting an agent', async () => {
    const { pool, started } = poolWith();
    const stop = new AbortController();
    stop.abort();
    await expect(pool.run('c1', run({ signal: stop.signal }))).rejects.toMatchObject({ code: 'aborted' });
    expect(started).toHaveLength(0);
  });

  it('keeps an agent whose command was stopped while it started, for the next command', async () => {
    const { pool, started, closed } = poolWith({ idleMs: 60_000 }, { ready: 'silent' });
    const stop = new AbortController();
    const stopped = pool.run('c1', run({ signal: stop.signal }));
    await vi.waitFor(() => expect(started).toHaveLength(1));
    stop.abort();
    await expect(stopped).rejects.toMatchObject({ code: 'aborted' });
    started[0]!.channel.emit({ type: 'ready' });
    await vi.waitFor(() => expect(pool.has('c1')).toBe(true));
    expect((await pool.run('c1', run())).output).toBe('ok\n');
    expect(started[0]!.channel.runs()).toHaveLength(1);
    expect(started).toHaveLength(1);
    expect(closed).toEqual([]);
  });

  it('reports an agent that died, and starts a fresh one for its next command', async () => {
    const { pool, started, died, closed } = poolWith();
    await pool.run('c1', run());
    started[0]!.channel.emitExit(137, 'killed by wsl --shutdown');
    await vi.waitFor(() => expect(died).toEqual(['c1']));
    await pool.run('c1', run());
    expect(started.map((s) => s.chatId)).toEqual(['c1', 'c1']);
    expect(closed).toEqual([]);
    expect(died).toEqual(['c1']);
  });

  it('does not count a dead agent against the limit', async () => {
    const { pool, started, closed } = poolWith({ maxAgents: 1, busyWaitMs: 50 });
    await pool.run('c1', run());
    started[0]!.channel.emitExit(137, 'crashed');
    await pool.run('c2', run());
    expect(started.map((s) => s.chatId)).toEqual(['c1', 'c2']);
    expect(closed).toEqual([]);
  });

  it('tries a failing start once more, then reports it', async () => {
    const { pool, started } = poolWith({}, { ready: 'fatal' });
    await expect(pool.run('c1', run())).rejects.toMatchObject({ code: 'agent_failed' });
    expect(started).toHaveLength(2);
    expect(pool.has('c1')).toBe(false);
  });

  it('runs the command on the second start when the first fails', async () => {
    const scripts: AgentScript[] = [{ ready: 'fatal' }, {}];
    const started: FakeChannel[] = [];
    const pool = new AgentPool({
      start: () => {
        const agent = scriptedAgent(scripts[started.length]);
        started.push(agent.channel);
        return agent.client;
      },
    });
    expect((await pool.run('c1', run())).exitCode).toBe(0);
    expect(started).toHaveLength(2);
    expect(pool.has('c1')).toBe(true);
  });

  it("release closes the chat's agent without calling it a death", async () => {
    const { pool, started, closed, died } = poolWith();
    await pool.run('c1', run());
    await pool.release('c1');
    expect(started[0]!.channel.sent.at(-1)).toEqual({ type: 'close' });
    expect(closed).toEqual(['c1']);
    expect(died).toEqual([]);
    expect(pool.has('c1')).toBe(false);
  });

  it("does not start a chat's next agent until the old one has finished closing", async () => {
    const order: string[] = [];
    const { pool } = poolWith({
      start: (chatId) => {
        order.push(`start ${chatId}`);
        return scriptedAgent().client;
      },
      onClosed: (chatId) => order.push(`closed ${chatId}`),
    });
    await pool.run('c1', run());
    const releasing = pool.release('c1');
    const next = pool.run('c1', run());
    await Promise.all([releasing, next]);
    expect(order).toEqual(['start c1', 'closed c1', 'start c1']);
  });

  it('gives a fresh command its own start when the one it would join was cancelled and is still waiting', async () => {
    const scripts: AgentScript[] = [{ ignoreClose: true }, {}];
    const started: FakeChannel[] = [];
    const pool = new AgentPool({
      idleMs: 10,
      start: () => {
        const agent = scriptedAgent(scripts[started.length]);
        started.push(agent.channel);
        return agent.client;
      },
    });
    await pool.run('c1', run());
    // The idle timer closes the first agent, which ignores the close for its whole grace period.
    await vi.waitFor(() => expect(started[0]!.sent.at(-1)).toEqual({ type: 'close' }));
    const stop = new AbortController();
    const stopped = pool.run('c1', run({ signal: stop.signal }));
    stop.abort();
    await expect(stopped).rejects.toMatchObject({ code: 'aborted' });
    const fresh = pool.run('c1', run());
    started[0]!.emitExit(0);
    expect((await fresh).exitCode).toBe(0);
    expect(started).toHaveLength(2);
  });

  it('survives callbacks that throw', async () => {
    const { pool, started } = poolWith({
      idleMs: 10,
      onClosed: () => {
        throw new Error('onClosed broke');
      },
      onDied: () => {
        throw new Error('onDied broke');
      },
    });
    await pool.run('c1', run());
    await pool.run('c2', run());
    started[1]!.channel.emitExit(137, 'crashed');
    // c1 idles out (onClosed throws), c2 died (onDied throws): neither may take the pool down.
    await vi.waitFor(() => expect(pool.size).toBe(0));
    expect((await pool.run('c3', run())).exitCode).toBe(0);
  });

  it('treats a start that throws like one that fails: once more, then agent_failed', async () => {
    let calls = 0;
    const pool = new AgentPool({
      start: () => {
        calls += 1;
        throw new Error('spawn wsl.exe ENOENT');
      },
    });
    await expect(pool.run('c1', run())).rejects.toThrow('ENOENT');
    expect(calls).toBe(2);
    expect(pool.has('c1')).toBe(false);
  });

  it('refuses commands once closeAll has run', async () => {
    const { pool, started } = poolWith();
    await pool.run('c1', run());
    await pool.closeAll();
    await expect(pool.run('c2', run())).rejects.toMatchObject({ code: 'agent_failed' });
    expect(started).toHaveLength(1);
  });

  it('release of a chat whose agent has not been started yet cancels the start', async () => {
    const { pool, started, closed } = poolWith();
    const running = pool.run('c1', run());
    const result = expect(running).rejects.toMatchObject({ code: 'aborted' });
    await pool.release('c1');
    await result;
    expect(started).toHaveLength(0);
    expect(closed).toEqual([]);
    expect(pool.has('c1')).toBe(false);
  });

  it('closeAll closes every agent', async () => {
    const { pool, closed } = poolWith();
    await pool.run('c1', run());
    await pool.run('c2', run());
    await pool.closeAll();
    expect(closed.sort()).toEqual(['c1', 'c2']);
    expect(pool.size).toBe(0);
  });
});
