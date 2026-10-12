import { describe, expect, it, vi } from 'vitest';
import { channelFromProcess, MAX_LINE_CHARS, type AgentExit } from '../src/agent-channel.js';
import type { AgentMessage } from '../src/protocol.js';
import { fakeChild } from './helpers.js';

const tick = (): Promise<void> => new Promise((r) => setImmediate(r));

describe('channelFromProcess', () => {
  it('writes each message as one JSON line', async () => {
    const f = fakeChild();
    channelFromProcess(f.child).send({ type: 'cancel', id: 3 });
    await tick();
    expect(f.written()).toBe('{"type":"cancel","id":3}\n');
  });

  it('reads messages split across chunks, CRLF and UTF-8 alike, and ignores lines that are not messages', async () => {
    const f = fakeChild();
    const got: AgentMessage[] = [];
    channelFromProcess(f.child).onMessage((m) => got.push(m));
    f.stdout.write('{"type":"rea');
    f.stdout.write('dy"}\r\nnot json\n{"type":"output","id":1,"chunk":"h');
    f.stdout.write(Buffer.from([0xc3]));
    f.stdout.write(Buffer.from([0xa9]));
    f.stdout.write('"}\n{"type":"ask","askId":1,"host":"x","port":"443"}\n');
    await tick();
    expect(got).toEqual([{ type: 'ready' }, { type: 'output', id: 1, chunk: 'hé' }]);
  });

  it("reports the agent's exit with the end of what it printed on stderr", async () => {
    const f = fakeChild();
    const exits: AgentExit[] = [];
    channelFromProcess(f.child).onExit((e) => exits.push(e));
    f.stderr.write('node: bad option\n');
    await tick();
    f.exit(9);
    await vi.waitFor(() => expect(exits).toEqual([{ code: 9, detail: 'node: bad option\n' }]));
  });

  it('keeps reading a chatty agent stderr, and explains its exit with only the end of it', async () => {
    const f = fakeChild();
    const exits: AgentExit[] = [];
    channelFromProcess(f.child).onExit((e) => exits.push(e));
    for (let i = 0; i < 200; i += 1) f.stderr.write(`${String(i).padStart(3, '0')} ${'w'.repeat(1000)}\n`);
    await tick();
    expect(f.stderr.readableLength).toBe(0);
    f.exit(1);
    await vi.waitFor(() => expect(exits).toHaveLength(1));
    expect(exits[0]!.detail.length).toBeLessThanOrEqual(2000);
    expect(exits[0]!.detail).toContain('199 www');
    expect(exits[0]!.detail).not.toContain('000 www');
  });

  it('stops an agent that sends a line longer than 1 MB', async () => {
    const f = fakeChild();
    const exits: AgentExit[] = [];
    channelFromProcess(f.child).onExit((e) => exits.push(e));
    f.stdout.write('x'.repeat(MAX_LINE_CHARS + 1));
    await vi.waitFor(() => expect(exits).toHaveLength(1));
    expect(f.killed).toBe(true);
    expect(exits[0]!.detail).toContain('longer than 1 MB');
  });

  it('sends nothing once the agent has exited', async () => {
    const f = fakeChild();
    const channel = channelFromProcess(f.child);
    f.exit(0);
    await tick();
    channel.send({ type: 'close' });
    await tick();
    expect(f.written()).toBe('');
  });
});
