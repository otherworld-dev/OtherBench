import { describe, expect, it, vi } from 'vitest';
import { SANDBOX_MAX_OUTPUT_BYTES } from '@otherbench/core/ports/sandbox.js';
import { AgentClient, CLOSE_GRACE_MS, type AgentRun } from '../src/agent-client.js';
import { FakeChannel, scriptedAgent, type AgentScript } from './helpers.js';

const run = (over: Partial<AgentRun> = {}): AgentRun => ({
  command: 'make',
  cwd: '/mnt/e/ws',
  timeoutMs: 120_000,
  readPaths: ['/mnt/e/ws'],
  writePaths: ['/mnt/e/ws'],
  denyWritePaths: [],
  allowedHosts: ['pypi.org'],
  signal: new AbortController().signal,
  askHost: async () => false,
  ...over,
});
const done = (id: number, over: Record<string, unknown> = {}) => ({ type: 'done' as const, id, exitCode: 0, signal: null, timedOut: false, truncated: false, note: '', unguarded: [] as string[], ...over });

describe('AgentClient', () => {
  it("starts the agent for its chat, and is ready when the agent says so", async () => {
    const { client, channel } = scriptedAgent({}, { home: '/home/otherbench/chats/c1', tmpRoot: '/tmp/otherbench-chats/c1', allowedHosts: ['pypi.org'] });
    await client.ready;
    expect(channel.sent[0]).toEqual({ type: 'init', home: '/home/otherbench/chats/c1', tmpRoot: '/tmp/otherbench-chats/c1', allowedHosts: ['pypi.org'] });
    expect(client.alive).toBe(true);
  });

  it("is not ready when the agent can't start", async () => {
    const { client } = scriptedAgent({ ready: 'fatal' });
    await expect(client.ready).rejects.toMatchObject({ code: 'agent_failed', message: expect.stringContaining('namespace') });
  });

  it('gives up on an agent that never says ready, and stops it', async () => {
    const channel = new FakeChannel({ ready: 'silent' });
    const client = new AgentClient(channel, { home: '/h', tmpRoot: '/t', allowedHosts: [] }, Date.now, 20);
    await expect(client.ready).rejects.toMatchObject({ code: 'agent_failed', message: expect.stringContaining("didn't start") });
    expect(channel.killed).toBe(true);
  });

  it('sends each run with its own id and paths, and collects its output', async () => {
    const { client, channel } = scriptedAgent({
      onRun: (m, ch) =>
        queueMicrotask(() => {
          ch.emit({ type: 'output', id: m.id, chunk: 'Lin' });
          ch.emit({ type: 'output', id: m.id, chunk: 'ux\n' });
          ch.emit(done(m.id));
        }),
    });
    expect(await client.run(run({ command: 'uname' }))).toEqual({ exitCode: 0, signal: null, timedOut: false, truncated: false, output: 'Linux\n' });
    await client.run(run({ command: 'id', denyWritePaths: ['/mnt/d/refs'] }));
    expect(channel.runs().map((m) => [m.id, m.command])).toEqual([[1, 'uname'], [2, 'id']]);
    expect(channel.runs()[1]).toMatchObject({ cwd: '/mnt/e/ws', readPaths: ['/mnt/e/ws'], writePaths: ['/mnt/e/ws'], denyWritePaths: ['/mnt/d/refs'], allowedHosts: ['pypi.org'], timeoutMs: 120_000 });
  });

  it('caps the output at 100 KB however much the agent sends, and says so', async () => {
    const { client } = scriptedAgent({
      onRun: (m, ch) =>
        queueMicrotask(() => {
          for (let i = 0; i < 3; i += 1) ch.emit({ type: 'output', id: m.id, chunk: 'x'.repeat(60 * 1024) });
          ch.emit(done(m.id));
        }),
    });
    const out = await client.run(run());
    expect(out.truncated).toBe(true);
    expect(out.output.startsWith('x'.repeat(SANDBOX_MAX_OUTPUT_BYTES))).toBe(true);
    expect(out.output).toContain('[... output truncated: combined stdout+stderr exceeded the 100KB cap ...]');
    expect(out.output.length).toBeLessThan(SANDBOX_MAX_OUTPUT_BYTES + 200);
  });

  it('cuts the output between characters, never inside one', async () => {
    const { client } = scriptedAgent({
      onRun: (m, ch) =>
        queueMicrotask(() => {
          ch.emit({ type: 'output', id: m.id, chunk: 'x'.repeat(SANDBOX_MAX_OUTPUT_BYTES - 1) });
          ch.emit({ type: 'output', id: m.id, chunk: 'é' });
          ch.emit(done(m.id));
        }),
    });
    const out = await client.run(run());
    expect(out.truncated).toBe(true);
    expect(out.output).not.toContain('�');
    expect(out.output.startsWith('x'.repeat(SANDBOX_MAX_OUTPUT_BYTES - 1) + '\n')).toBe(true);
  });

  it("adds the timeout note, then the runtime's note on what it blocked", async () => {
    const { client } = scriptedAgent({
      onRun: (m, ch) => queueMicrotask(() => ch.emit(done(m.id, { exitCode: null, signal: 'SIGKILL', timedOut: true, note: '<sandbox_violations>x</sandbox_violations>' }))),
    });
    const out = await client.run(run({ timeoutMs: 5000 }));
    expect(out).toMatchObject({ timedOut: true, signal: 'SIGKILL', exitCode: null });
    expect(out.output).toContain('[... command killed after exceeding its 5000ms timeout ...]');
    expect(out.output.endsWith('<sandbox_violations>x</sandbox_violations>')).toBe(true);
  });

  it('names the timeout the agent applied, which it caps at 600 s', async () => {
    const { client } = scriptedAgent({ onRun: (m, ch) => queueMicrotask(() => ch.emit(done(m.id, { exitCode: null, signal: 'SIGKILL', timedOut: true }))) });
    const out = await client.run(run({ timeoutMs: 3_600_000 }));
    expect(out.output).toContain('exceeding its 600000ms timeout');
  });

  it('cancels the running command when its signal aborts', async () => {
    const { client, channel } = scriptedAgent({ onRun: () => undefined });
    const ac = new AbortController();
    const running = client.run(run({ signal: ac.signal }));
    await vi.waitFor(() => expect(channel.runs()).toHaveLength(1));
    ac.abort();
    expect(channel.sent.at(-1)).toEqual({ type: 'cancel', id: 1 });
    channel.emit(done(1, { exitCode: null, signal: 'SIGTERM' }));
    expect(await running).toMatchObject({ signal: 'SIGTERM' });
  });

  it('does not cancel a command that has already finished', async () => {
    const { client, channel } = scriptedAgent();
    const ac = new AbortController();
    await client.run(run({ signal: ac.signal }));
    ac.abort();
    expect(channel.sent.filter((m) => m.type === 'cancel')).toEqual([]);
  });

  it('refuses a run whose turn was already stopped, sending nothing', async () => {
    const { client, channel } = scriptedAgent();
    const ac = new AbortController();
    ac.abort();
    await expect(client.run(run({ signal: ac.signal }))).rejects.toMatchObject({ code: 'aborted' });
    expect(channel.runs()).toHaveLength(0);
  });

  it("puts a host the agent asks about to the running command's askHost, and sends the answer back", async () => {
    const askHost = vi.fn(async (host: string) => host === 'example.com');
    const { client, channel } = scriptedAgent({ onRun: (_m, ch) => queueMicrotask(() => ch.emit({ type: 'ask', askId: 7, host: 'example.com', port: 443 })) });
    const running = client.run(run({ askHost }));
    await vi.waitFor(() => expect(channel.sent).toContainEqual({ type: 'answer', askId: 7, allowed: true }));
    expect(askHost).toHaveBeenCalledWith('example.com', 443, expect.any(AbortSignal));
    channel.finish(1);
    await running;
  });

  describe('a question about a host that stops mattering', () => {
    /** A run with an unanswered question; resolves with the question's signal. */
    async function pending(over: { script?: AgentScript; abort?: AbortController } = {}) {
      let askSignal!: AbortSignal;
      const askHost = vi.fn((_host: string, _port: number | undefined, signal: AbortSignal) => {
        askSignal = signal;
        return new Promise<boolean>(() => undefined);
      });
      const { client, channel } = scriptedAgent({ onRun: () => undefined, ...over.script });
      const running = client.run(run({ askHost, signal: (over.abort ?? new AbortController()).signal }));
      running.catch(() => undefined);
      await vi.waitFor(() => expect(channel.runs()).toHaveLength(1));
      channel.emit({ type: 'ask', askId: 1, host: 'example.com', port: 443 });
      await vi.waitFor(() => expect(askHost).toHaveBeenCalled());
      expect(askSignal.aborted).toBe(false);
      return { client, channel, running, askSignal };
    }

    it('is withdrawn when the turn is stopped', async () => {
      const ac = new AbortController();
      const { askSignal } = await pending({ abort: ac });
      ac.abort();
      expect(askSignal.aborted).toBe(true);
    });

    it('is withdrawn when the command times out and finishes', async () => {
      const { channel, running, askSignal } = await pending();
      channel.emit(done(1, { exitCode: null, signal: 'SIGKILL', timedOut: true }));
      await running;
      expect(askSignal.aborted).toBe(true);
    });

    it('is withdrawn when the command finishes', async () => {
      const { channel, running, askSignal } = await pending();
      channel.finish(1);
      await running;
      expect(askSignal.aborted).toBe(true);
    });

    it('is withdrawn when the command fails', async () => {
      const { channel, running, askSignal } = await pending();
      channel.emit({ type: 'failed', id: 1, message: 'bad', unguarded: [] });
      await expect(running).rejects.toMatchObject({ code: 'agent_failed' });
      expect(askSignal.aborted).toBe(true);
    });

    it('is withdrawn when the agent exits', async () => {
      const { channel, running, askSignal } = await pending();
      channel.emitExit(1, 'gone');
      await expect(running).rejects.toMatchObject({ code: 'agent_failed' });
      expect(askSignal.aborted).toBe(true);
    });

    it('is withdrawn when the agent is told to close', async () => {
      const { client, askSignal } = await pending({ script: { ignoreClose: true } });
      const closing = client.close(10);
      expect(askSignal.aborted).toBe(true);
      await closing;
    });

    it('is not answered once withdrawn, even if the card answers late', async () => {
      let answerCard!: (allowed: boolean) => void;
      const { client, channel } = scriptedAgent({ onRun: () => undefined });
      const running = client.run(run({ askHost: () => new Promise<boolean>((r) => (answerCard = r)) }));
      await vi.waitFor(() => expect(channel.runs()).toHaveLength(1));
      channel.emit({ type: 'ask', askId: 2, host: 'example.com', port: 443 });
      await vi.waitFor(() => expect(answerCard).toBeTypeOf('function'));
      channel.finish(1);
      await running;
      answerCard(true);
      await new Promise((r) => setImmediate(r));
      expect(channel.sent.filter((m) => m.type === 'answer')).toEqual([]);
    });
  });

  it('answers no when askHost throws instead of returning a promise', async () => {
    const { client, channel } = scriptedAgent({ onRun: (_m, ch) => queueMicrotask(() => ch.emit({ type: 'ask', askId: 6, host: 'example.com', port: 443 })) });
    const running = client.run(
      run({
        askHost: () => {
          throw new Error('no card');
        },
      })
    );
    await vi.waitFor(() => expect(channel.sent).toContainEqual({ type: 'answer', askId: 6, allowed: false }));
    channel.finish(1);
    await running;
  });

  it('stops an agent that does not report a cancelled command, and fails the run', async () => {
    const channel = new FakeChannel({ onRun: () => undefined });
    const client = new AgentClient(channel, { home: '/h', tmpRoot: '/t', allowedHosts: [] }, Date.now, 1000, 30);
    const ac = new AbortController();
    const running = client.run(run({ signal: ac.signal }));
    await vi.waitFor(() => expect(channel.runs()).toHaveLength(1));
    ac.abort();
    await expect(running).rejects.toMatchObject({ code: 'agent_failed', message: expect.stringContaining('cancelled') });
    expect(channel.killed).toBe(true);
    expect(client.alive).toBe(false);
  });

  it('does not stop an agent that reports the cancelled command in time', async () => {
    const channel = new FakeChannel({ onRun: () => undefined });
    const client = new AgentClient(channel, { home: '/h', tmpRoot: '/t', allowedHosts: [] }, Date.now, 1000, 40);
    const ac = new AbortController();
    const running = client.run(run({ signal: ac.signal }));
    await vi.waitFor(() => expect(channel.runs()).toHaveLength(1));
    ac.abort();
    channel.emit(done(1, { exitCode: null, signal: 'SIGTERM' }));
    await running;
    await new Promise((r) => setTimeout(r, 80));
    expect(channel.killed).toBe(false);
  });

  it("gives a cancelled run's restore its own grace once the agent says it has started, then still stops a wedged one", async () => {
    const channel = new FakeChannel({ onRun: () => undefined });
    // Cancel watchdog 30 ms, restore grace 200 ms.
    const client = new AgentClient(channel, { home: '/h', tmpRoot: '/t', allowedHosts: [] }, Date.now, 1000, 30, 200);
    const unguarded: string[][] = [];
    const ac = new AbortController();
    const running = client.run(run({ signal: ac.signal, onUnguarded: (p) => unguarded.push(p) }));
    await vi.waitFor(() => expect(channel.runs()).toHaveLength(1));
    ac.abort();
    channel.emit({ type: 'restoring', id: 1 });
    await new Promise((r) => setTimeout(r, 90));
    expect(channel.killed).toBe(false);
    // A slow restore that finishes inside the grace is reported as usual.
    channel.emit(done(1, { exitCode: null, signal: 'SIGTERM' }));
    await running;
    expect(unguarded).toEqual([]);

    const ac2 = new AbortController();
    const wedged = client.run(run({ signal: ac2.signal, onUnguarded: (p) => unguarded.push(p) }));
    await vi.waitFor(() => expect(channel.runs()).toHaveLength(2));
    ac2.abort();
    channel.emit({ type: 'restoring', id: 2 });
    await expect(wedged).rejects.toMatchObject({ code: 'agent_failed', message: expect.stringContaining('cancelled') });
    expect(channel.killed).toBe(true);
    expect(unguarded).toEqual([['/mnt/e/ws']]);
  });

  it('reports the folders an agent says it could not put back, before the run settles', async () => {
    const unguarded: string[][] = [];
    const { client } = scriptedAgent({ onRun: (m, ch) => queueMicrotask(() => ch.finish(m.id, '', 0, ['/mnt/e/ws', '/home/otherbench/chats/c1'])) });
    let seenFirst = false;
    await client.run(run({ onUnguarded: (p) => unguarded.push(p) })).then(() => (seenFirst = unguarded.length > 0));
    // Only the run's writable folders (not the chat's home, which isn't on Windows).
    expect(unguarded).toEqual([['/mnt/e/ws']]);
    expect(seenFirst).toBe(true);
  });

  it('counts a run whose agent died before reporting it as unguarded, and one that reported as not', async () => {
    const unguarded: string[][] = [];
    const { client, channel } = scriptedAgent({ onRun: () => undefined });
    const running = client.run(run({ onUnguarded: (p) => unguarded.push(p) }));
    await vi.waitFor(() => expect(channel.runs()).toHaveLength(1));
    channel.emit({ type: 'restoring', id: 1 });
    channel.emitExit(1, 'wsl shut down');
    await expect(running).rejects.toMatchObject({ code: 'agent_failed' });
    expect(unguarded).toEqual([['/mnt/e/ws']]);
  });

  it("close waits for a run's restore that has started, up to the restore grace, then kills", async () => {
    const channel = new FakeChannel({ onRun: () => undefined, ignoreClose: true });
    const client = new AgentClient(channel, { home: '/h', tmpRoot: '/t', allowedHosts: [] }, Date.now, 1000, 30, 150);
    const unguarded: string[][] = [];
    const running = client.run(run({ onUnguarded: (p) => unguarded.push(p) }));
    running.catch(() => undefined);
    await vi.waitFor(() => expect(channel.runs()).toHaveLength(1));
    channel.emit({ type: 'restoring', id: 1 });
    const started = Date.now();
    await client.close(20);
    expect(Date.now() - started).toBeGreaterThanOrEqual(100);
    expect(channel.killed).toBe(true);
    expect(unguarded).toEqual([['/mnt/e/ws']]);
  });

  it('close without a restore under way kills after its own grace', async () => {
    const channel = new FakeChannel({ ignoreClose: true });
    const client = new AgentClient(channel, { home: '/h', tmpRoot: '/t', allowedHosts: [] }, Date.now, 1000, 30, 10_000);
    await client.ready;
    const started = Date.now();
    await client.close(20);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(channel.killed).toBe(true);
  });

  it('stops waiting for an agent that has not started when the turn is stopped', async () => {
    const channel = new FakeChannel({ ready: 'silent' });
    const client = new AgentClient(channel, { home: '/h', tmpRoot: '/t', allowedHosts: [] });
    const ac = new AbortController();
    const running = client.run(run({ signal: ac.signal }));
    ac.abort();
    await expect(running).rejects.toMatchObject({ code: 'aborted' });
    expect(client.busy).toBe(false);
    channel.kill();
    expect(channel.runs()).toHaveLength(0);
  });

  it('stops waiting behind another command when the turn is stopped, and never sends it', async () => {
    const { client, channel } = scriptedAgent({ onRun: () => undefined });
    const a = client.run(run({ command: 'a' }));
    const ac = new AbortController();
    const b = client.run(run({ command: 'b', signal: ac.signal }));
    await vi.waitFor(() => expect(channel.runs()).toHaveLength(1));
    ac.abort();
    await expect(b).rejects.toMatchObject({ code: 'aborted' });
    expect(client.busy).toBe(true);
    channel.finish(1);
    await a;
    await new Promise((r) => setImmediate(r));
    expect(channel.runs().map((m) => m.command)).toEqual(['a']);
    expect(channel.sent.filter((m) => m.type === 'cancel')).toEqual([]);
    expect(client.busy).toBe(false);
  });

  it('refuses an ask when no command is running', async () => {
    const { client, channel } = scriptedAgent();
    await client.ready;
    channel.emit({ type: 'ask', askId: 3, host: 'example.com', port: null });
    await vi.waitFor(() => expect(channel.sent).toContainEqual({ type: 'answer', askId: 3, allowed: false }));
  });

  it('refuses an ask whose command was stopped, without raising a question', async () => {
    const askHost = vi.fn(async () => true);
    const { client, channel } = scriptedAgent({ onRun: () => undefined });
    const ac = new AbortController();
    const running = client.run(run({ signal: ac.signal, askHost }));
    await vi.waitFor(() => expect(channel.runs()).toHaveLength(1));
    ac.abort();
    channel.emit({ type: 'ask', askId: 4, host: 'example.com', port: 443 });
    await vi.waitFor(() => expect(channel.sent).toContainEqual({ type: 'answer', askId: 4, allowed: false }));
    expect(askHost).not.toHaveBeenCalled();
    channel.emit(done(1, { exitCode: null, signal: 'SIGTERM' }));
    await running;
  });

  it('answers no when the question cannot be put', async () => {
    const { client, channel } = scriptedAgent({ onRun: (_m, ch) => queueMicrotask(() => ch.emit({ type: 'ask', askId: 5, host: 'example.com', port: 443 })) });
    const running = client.run(
      run({
        askHost: async () => {
          throw new Error('no card');
        },
      })
    );
    await vi.waitFor(() => expect(channel.sent).toContainEqual({ type: 'answer', askId: 5, allowed: false }));
    channel.finish(1);
    await running;
  });

  it('runs commands one at a time, so a network question belongs to the command that is running', async () => {
    const { client, channel } = scriptedAgent({ onRun: () => undefined });
    const askA = vi.fn(async () => true);
    const askB = vi.fn(async () => false);
    const a = client.run(run({ command: 'a', askHost: askA, allowedHosts: ['pypi.org'] }));
    const b = client.run(run({ command: 'b', askHost: askB, allowedHosts: ['github.com'] }));
    await vi.waitFor(() => expect(channel.runs()).toHaveLength(1));
    expect(client.busy).toBe(true);
    channel.finish(1);
    await a;
    await vi.waitFor(() => expect(channel.runs()).toHaveLength(2));
    expect(channel.runs()[1]).toMatchObject({ command: 'b', allowedHosts: ['github.com'] });
    channel.emit({ type: 'ask', askId: 1, host: 'example.com', port: 443 });
    await vi.waitFor(() => expect(channel.sent).toContainEqual({ type: 'answer', askId: 1, allowed: false }));
    expect(askA).not.toHaveBeenCalled();
    expect(askB).toHaveBeenCalledWith('example.com', 443, expect.any(AbortSignal));
    channel.finish(2);
    await b;
    expect(client.busy).toBe(false);
  });

  it('sends the next run only after the previous one failed, too', async () => {
    let first = true;
    const { client, channel } = scriptedAgent({
      onRun: (m, ch) => {
        if (first) {
          first = false;
          queueMicrotask(() => ch.emit({ type: 'failed', id: m.id, message: 'bad cwd', unguarded: [] }));
        } else queueMicrotask(() => ch.finish(m.id, 'ok\n'));
      },
    });
    const a = client.run(run({ command: 'a' }));
    const b = client.run(run({ command: 'b' }));
    await expect(a).rejects.toMatchObject({ code: 'agent_failed', message: 'bad cwd' });
    expect(await b).toMatchObject({ output: 'ok\n' });
    expect(channel.runs().map((m) => m.id)).toEqual([1, 2]);
  });

  it('fails the running command, and is dead, when the agent exits', async () => {
    const { client, channel } = scriptedAgent({ onRun: () => undefined });
    const running = client.run(run());
    await vi.waitFor(() => expect(channel.runs()).toHaveLength(1));
    channel.emitExit(1, 'Segmentation fault');
    await expect(running).rejects.toMatchObject({ code: 'agent_failed', message: expect.stringContaining('Segmentation fault') });
    expect(client.alive).toBe(false);
    await expect(client.exited).resolves.toEqual({ code: 1, detail: 'Segmentation fault' });
  });

  it('reports an agent-side failure of one command without losing the agent', async () => {
    const { client } = scriptedAgent({ onRun: (m, ch) => queueMicrotask(() => ch.emit({ type: 'failed', id: m.id, message: 'bwrap: execvp bash: No such file', unguarded: [] })) });
    await expect(client.run(run())).rejects.toMatchObject({ code: 'agent_failed', message: 'bwrap: execvp bash: No such file' });
    expect(client.alive).toBe(true);
  });

  it('close asks the agent to stop, and kills one that does not', async () => {
    const polite = scriptedAgent();
    await polite.client.ready;
    await polite.client.close();
    expect(polite.channel.sent.at(-1)).toEqual({ type: 'close' });
    expect(polite.channel.killed).toBe(false);
    expect(polite.client.alive).toBe(false);

    const stubborn = scriptedAgent({ ignoreClose: true });
    await stubborn.client.ready;
    await stubborn.client.close(10);
    expect(stubborn.channel.killed).toBe(true);
    expect(stubborn.client.alive).toBe(false);
  });

  it('gives a closing agent longer than the 2.5 s it takes to stop a command in flight', () => {
    expect(CLOSE_GRACE_MS).toBeGreaterThan(2500);
  });

  it('does not send a command that was waiting when the agent was told to close', async () => {
    const { client, channel } = scriptedAgent({ onRun: () => undefined, ignoreClose: true });
    const a = client.run(run({ command: 'a' }));
    const b = client.run(run({ command: 'b' }));
    b.catch(() => undefined);
    await vi.waitFor(() => expect(channel.runs()).toHaveLength(1));
    const closing = client.close(50);
    channel.finish(1);
    await a;
    await closing;
    await expect(b).rejects.toMatchObject({ code: 'agent_failed' });
    expect(channel.runs()).toHaveLength(1);
  });
});
