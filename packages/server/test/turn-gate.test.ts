import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveWorkspace } from '@otherbench/core/domain/workspace.js';
import type { TurnInput, TurnResult } from '@otherbench/core/domain/turn.js';
import type { ResolvedProfile } from '@otherbench/core/types/config.js';
import { createContainer } from '../src/container.js';
import { ScheduleBusyError, ScheduleService, type ScheduleServiceDeps } from '../src/schedule/service.js';
import { ChatBusyError, TurnGate } from '../src/turn-gate.js';
import { startTurn } from '../src/turn-start.js';
import { flush, Harness } from './chat-sends/harness.js';
import { ManualClock } from './memory/manual-clock.js';

describe('TurnGate', () => {
  it('a chat is busy while a reply runs in it, and cannot be claimed', () => {
    const running = new Set(['a']);
    const gate = new TurnGate((chatId) => running.has(chatId));
    expect(gate.isBusy('a')).toBe(true);
    expect(gate.claim('a')).toBeNull();
    expect(gate.isBusy('b')).toBe(false);
  });

  it('a claim takes a free chat until it is released, once, and other chats stay free', () => {
    const gate = new TurnGate(() => false);
    const claim = gate.claim('a')!;
    expect(claim.chatId).toBe('a');
    expect(gate.isBusy('a')).toBe(true);
    expect(gate.claim('a')).toBeNull();
    expect(gate.claim('b')).not.toBeNull();
    claim.release();
    expect(gate.isBusy('a')).toBe(false);
    const next = gate.claim('a')!;
    // The first claim's second release must not let go of the chat's next one.
    claim.release();
    expect(gate.isBusy('a')).toBe(true);
    expect(gate.holdsAlone(next)).toBe(true);
  });

  it('a hold is never refused, and makes the chat busy until the last one is released', () => {
    const gate = new TurnGate((chatId) => chatId === 'a');
    const first = gate.hold('a');
    const second = gate.hold('b');
    const third = gate.hold('b');
    expect(gate.claim('b')).toBeNull();
    second.release();
    expect(gate.isBusy('b')).toBe(true);
    third.release();
    expect(gate.isBusy('b')).toBe(false);
    first.release();
  });

  it('a claim no longer holds its chat alone once something else starts or runs there', () => {
    const running = new Set<string>();
    const gate = new TurnGate((chatId) => running.has(chatId));
    const claim = gate.claim('a')!;
    expect(gate.holdsAlone(claim)).toBe(true);
    const person = gate.hold('a');
    expect(gate.holdsAlone(claim)).toBe(false);
    person.release();
    expect(gate.holdsAlone(claim)).toBe(true);
    running.add('a');
    expect(gate.holdsAlone(claim)).toBe(false);
    running.clear();
    claim.release();
    expect(gate.holdsAlone(claim)).toBe(false);
  });

  it('forgetting a deleted chat lets go of everything held for it', () => {
    const gate = new TurnGate(() => false);
    const claim = gate.claim('a')!;
    gate.forget('a');
    expect(gate.isBusy('a')).toBe(false);
    expect(gate.holdsAlone(claim)).toBe(false);
    // A chat made again under the same id is not let go by the old claim being released.
    const again = gate.claim('a')!;
    claim.release();
    expect(gate.holdsAlone(again)).toBe(true);
  });
});

const T0 = Date.parse('2026-10-12T07:00:00Z'); // Monday 08:00 in London
const NINE = Date.parse('2026-10-12T08:00:00Z'); // Monday 09:00 in London
const HOUR = 60 * 60_000;

/** A profile lookup that waits to be let through, as one with a key to read from the secrets file does. */
function slowProfiles(h: Harness): { resolve: (id: string) => Promise<ResolvedProfile>; arrive: () => void; fail: (err: Error) => void } {
  let arrive!: () => void;
  let fail!: (err: Error) => void;
  const waited = new Promise<void>((resolve, reject) => {
    arrive = resolve;
    fail = reject;
  });
  return { resolve: (id) => waited.then(() => h.resolveP(id)), arrive, fail };
}

/** Makes `run()` wait before it writes anything: the await a later change to it could add. */
function slowRun(h: Harness): () => void {
  const real = h.runner.run.bind(h.runner);
  let go!: () => void;
  const waited = new Promise<void>((resolve) => (go = resolve));
  h.runner.run = async (input: TurnInput): Promise<TurnResult> => {
    await waited;
    return real(input);
  };
  return go;
}

describe('one gate for every starter', () => {
  let h: Harness;
  let clock: ManualClock;
  let schedules: ScheduleService | null;

  function buildSchedules(over: Partial<ScheduleServiceDeps> = {}): ScheduleService {
    const service = new ScheduleService({
      store: h.store,
      turnRunner: h.runner,
      startTurn: (input, claim) => startTurn(h.turnDeps, input, claim),
      resolveProfile: h.resolveP,
      resolveWorkspace: (ws) => resolveWorkspace(ws, h.store.nodes.self().id, h.store.locations.allPaths(), () => true),
      gate: h.gate,
      hasWaitingNotes: (chatId) => h.waitingNotes.has(chatId),
      emit: (e) => h.bus.emit(e),
      now: clock.now,
      scheduler: clock,
      ...over,
    });
    schedules = service;
    return service;
  }

  function addSchedule(id = 's1'): void {
    h.store.schedules.create({
      id, name: 'Report', prompt: 'hello', profileId: 'p1', target: { kind: 'chat', chatId: 'target' },
      rule: { cadence: 'daily', time: '09:00' }, timezone: 'Europe/London', enabled: true, nextRunAt: NINE,
    });
  }

  beforeEach(() => {
    h = new Harness();
    for (const id of ['sender', 'target']) h.addChat(id);
    clock = new ManualClock(T0);
    schedules = null;
    h.build();
  });

  afterEach(() => {
    schedules?.dispose();
    h.service.dispose();
  });

  it('a message for a chat a schedule is starting in waits its turn, and goes when the run has ended', async () => {
    h.service.start();
    const profiles = slowProfiles(h);
    addSchedule();
    const service = buildSchedules({ resolveProfile: profiles.resolve });
    service.start();
    clock.advance(HOUR);
    await flush();
    expect(h.gate.isBusy('target')).toBe(true);

    const from = await h.reply('sender');
    const out = await h.send('sender', from, [{ chatId: 'target', text: 'over to you' }]);
    expect(out).toMatchObject({ sent: [{ queued: true }] });
    expect(h.runner.runningIn('target')).toHaveLength(0);

    profiles.arrive();
    await service.idle();
    await flush();
    expect(h.store.schedules.runs('s1')).toMatchObject([{ status: 'running' }]);
    expect(h.runner.runningIn('target')).toHaveLength(1);
    expect(h.store.chatSends.byToChat('target')).toMatchObject([{ status: 'queued' }]);

    await h.finish(h.runner.runningIn('target')[0]!, 'the report');
    expect(h.store.chatSends.byToChat('target')).toMatchObject([{ status: 'running' }]);
    expect(h.runner.runningIn('target')).toHaveLength(1);
  });

  it('a schedule whose chat has a message being started in it is left due, and Run now says the chat is busy', async () => {
    const profiles = slowProfiles(h);
    h.build({ resolveProfile: profiles.resolve }).start();
    addSchedule();
    const service = buildSchedules();
    const from = await h.reply('sender');
    void h.service.send(h.ctxFor('sender', from), [{ chatId: 'target', text: 'over to you' }]);
    await flush();
    expect(h.runner.runningIn('target')).toHaveLength(0);

    service.start();
    clock.advance(HOUR);
    await flush();
    expect(h.store.schedules.runs('s1')).toEqual([]);
    expect(h.store.schedules.get('s1')!.nextRunAt).toBe(NINE);
    expect(() => service.runNow('s1')).toThrow(ScheduleBusyError);
    expect(() => service.runNow('s1')).toThrow('A reply is being written in this chat. Try again when it has finished.');

    profiles.arrive();
    await h.service.idle();
    await flush();
    expect(h.runner.runningIn('target')).toHaveLength(1);
    expect(h.store.schedules.runs('s1')).toEqual([]);
  });

  it('two schedules due together on one chat start one reply; the other is left due', async () => {
    const profiles = slowProfiles(h);
    addSchedule('s1');
    addSchedule('s2');
    const service = buildSchedules({ resolveProfile: profiles.resolve });
    service.start();
    clock.advance(HOUR);
    await flush();
    profiles.arrive();
    await service.idle();
    await flush();
    expect(h.runner.runningIn('target')).toHaveLength(1);
    expect([...h.store.schedules.runs('s1'), ...h.store.schedules.runs('s2')]).toMatchObject([{ status: 'running' }]);
  });

  it('a send by the person goes out as always while a schedule is starting there, and the run is recorded as not started', async () => {
    const profiles = slowProfiles(h);
    addSchedule();
    const service = buildSchedules({ resolveProfile: profiles.resolve });
    service.start();
    clock.advance(HOUR);
    await flush();

    const mine = await h.reply('target');
    expect(h.store.messages.get(mine)?.status).toBe('streaming');

    profiles.arrive();
    await service.idle();
    await flush();
    expect(h.runner.runningIn('target')).toEqual([mine]);
    expect(h.store.schedules.runs('s1')).toMatchObject([{ status: 'not_started', detail: expect.stringMatching(/reply is (still )?being written/) }]);
  });

  it('a send by the person goes out as always while a message is being started there, and the message stays queued behind it', async () => {
    const profiles = slowProfiles(h);
    h.build({ resolveProfile: profiles.resolve }).start();
    const from = await h.reply('sender');
    void h.service.send(h.ctxFor('sender', from), [{ chatId: 'target', text: 'over to you' }]);
    await flush();

    const mine = await h.reply('target');
    profiles.arrive();
    await h.service.idle();
    await flush();
    expect(h.runner.runningIn('target')).toEqual([mine]);
    expect(h.store.chatSends.byToChat('target')).toMatchObject([{ status: 'queued' }]);
  });

  it('a claim that is no longer alone is refused at the start, with nothing written, and is ended', async () => {
    const claim = h.gate.claim('target')!;
    const mine = h.gate.hold('target');
    const input: TurnInput = { chatId: 'target', parentId: null, userParts: [{ type: 'text', text: 'hi' }], profiles: [await h.resolveP('p1')] };
    await expect(startTurn(h.turnDeps, input, claim)).rejects.toBeInstanceOf(ChatBusyError);
    expect(h.store.messages.latestId('target')).toBeNull();
    mine.release();
    expect(h.gate.isBusy('target')).toBe(false);
  });

  it('while a send by the person is still making its rows, a schedule is left due and a message stays queued', async () => {
    h.service.start();
    addSchedule();
    const service = buildSchedules();
    const from = await h.reply('sender');
    const go = slowRun(h);
    const sending = startTurn(h.turnDeps, { chatId: 'target', parentId: null, userParts: [{ type: 'text', text: 'hi' }], profiles: [await h.resolveP('p1')] });
    expect(h.gate.isBusy('target')).toBe(true);

    service.start();
    clock.advance(HOUR);
    const out = await h.send('sender', from, [{ chatId: 'target', text: 'over to you' }]);
    expect(out).toMatchObject({ sent: [{ queued: true }] });
    expect(h.store.schedules.runs('s1')).toEqual([]);

    go();
    const mine = (await sending).assistantMessageIds[0]!;
    await service.idle();
    await h.service.idle();
    await flush();
    expect(h.runner.runningIn('target')).toEqual([mine]);
    expect(h.store.schedules.runs('s1')).toEqual([]);
    expect(h.store.chatSends.byToChat('target')).toMatchObject([{ status: 'queued' }]);
  });

  it('a compare turn is one start: every variant starts, and the chat is let go once they are announced', async () => {
    const p = await h.resolveP('p1');
    const result = await startTurn(h.turnDeps, { chatId: 'target', parentId: null, userParts: [{ type: 'text', text: 'hi' }], profiles: [p, p, p] });
    expect(result.assistantMessageIds).toHaveLength(3);
    expect(h.runner.runningIn('target').sort()).toEqual([...result.assistantMessageIds].sort());
    // Busy now only because its replies run: nothing is left held once they have ended.
    for (const id of result.assistantMessageIds) h.runner.cancel(id);
    await flush();
    await flush();
    expect(h.runner.runningIn('target')).toHaveLength(0);
    expect(h.gate.isBusy('target')).toBe(false);
  });

  it('a start that fails lets the chat go: a schedule or a message whose profile cannot be resolved, a turn that cannot be made', async () => {
    const profiles = slowProfiles(h);
    addSchedule();
    const service = buildSchedules({ resolveProfile: profiles.resolve });
    service.start();
    clock.advance(HOUR);
    await flush();
    expect(h.gate.isBusy('target')).toBe(true);
    profiles.fail(new Error('The connection is gone.'));
    await service.idle();
    await flush();
    expect(h.store.schedules.runs('s1')).toMatchObject([{ status: 'not_started', detail: 'The connection is gone.' }]);
    expect(h.gate.isBusy('target')).toBe(false);

    const broken = slowProfiles(h);
    h.build({ resolveProfile: broken.resolve }).start();
    const from = await h.reply('sender');
    void h.service.send(h.ctxFor('sender', from), [{ chatId: 'target', text: 'over to you' }]);
    await flush();
    expect(h.gate.isBusy('target')).toBe(true);
    broken.fail(new Error('The connection is gone.'));
    await h.service.idle();
    await flush();
    expect(h.store.chatSends.byToChat('target')).toMatchObject([{ status: 'failed', reason: 'The connection is gone.' }]);
    expect(h.gate.isBusy('target')).toBe(false);

    const bad: TurnInput = { chatId: 'target', parentId: null, userParts: [{ type: 'image', attachmentId: 'nope', mime: 'image/png' }], profiles: [await h.resolveP('p1')] };
    await expect(startTurn(h.turnDeps, bad)).rejects.toThrow();
    expect(h.gate.isBusy('target')).toBe(false);
  });

  it('a chat deleted while a run is being set up in it is let go, and the run ends as not started', async () => {
    const profiles = slowProfiles(h);
    addSchedule();
    const service = buildSchedules({ resolveProfile: profiles.resolve });
    service.start();
    clock.advance(HOUR);
    await flush();
    expect(h.gate.isBusy('target')).toBe(true);

    h.store.chats.delete('target');
    // What the container does on `chat-deleted`.
    h.gate.forget('target');
    expect(h.gate.isBusy('target')).toBe(false);

    profiles.arrive();
    await service.idle();
    await flush();
    expect(h.gate.isBusy('target')).toBe(false);
    expect(h.runner.runningIn('target')).toHaveLength(0);
  });
});

describe('the container', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'otherbench-turn-gate-test-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('has one gate, which lets go of a chat when the chat is deleted', async () => {
    const container = await createContainer({ dbPath: join(dir, 'otherbench.db'), secretsPath: join(dir, 'secrets.json'), peerPort: 0 });
    try {
      const gate = container.turnGate!;
      const { store } = container;
      store.connections.create({ id: 'conn', name: 'Mock', kind: 'mock', baseUrl: null, secretRef: null, extraHeaders: {}, status: 'unknown', statusMessage: null, checkedAt: null });
      store.profiles.create({
        id: 'p1', name: 'Mock', description: null, colour: null, connectionId: 'conn', modelId: 'm', systemPrompt: null, params: {},
        toolPolicy: { fs: 'off', shell: false, mcpServerIds: [], approvalMode: 'always_ask', artifacts: false, recall: false }, isDefault: true, archivedAt: null,
      });
      store.chats.create({ id: 'chat-1', title: 'Chat', profileId: 'p1', headMessageId: null, workspaceRoot: null, pinned: false, archivedAt: null });
      const claim = gate.claim('chat-1')!;
      expect(gate.isBusy('chat-1')).toBe(true);
      store.chats.delete('chat-1');
      expect(gate.isBusy('chat-1')).toBe(false);
      claim.release();
    } finally {
      container.close();
      await container.settled?.();
    }
  });
});
