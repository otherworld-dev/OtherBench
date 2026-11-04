import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SCHEDULE_CHECK_MAX_MS } from '@otherbench/core/domain/schedule.js';
import { TurnRunner } from '@otherbench/core/domain/turn.js';
import { resolveWorkspace } from '@otherbench/core/domain/workspace.js';
import { InMemoryStore } from '@otherbench/core/testing/fakes.js';
import type { ChatEngine, EngineEvent, EngineRequest } from '@otherbench/core/ports/chat-engine.js';
import type { NewSchedule } from '@otherbench/core/ports/store.js';
import type { ResolvedProfile } from '@otherbench/core/types/config.js';
import type { AppEvent } from '@otherbench/core/types/events.js';
import { collectMessageTree } from '../../src/routes/chats.js';
import { ScheduleBusyError, ScheduleService, type ScheduleServiceDeps } from '../../src/schedule/service.js';
import { AppEventBus } from '../../src/stream/events.js';
import { StreamRegistry } from '../../src/stream/registry.js';
import { startTurn, type TurnStartDeps } from '../../src/turn-start.js';
import { ManualClock } from '../memory/manual-clock.js';

/** A ChatEngine driven by hand per message id (as in routes/turns.test.ts), recording every request. */
function manualEngine(): { engine: ChatEngine; push: (messageId: string, event: EngineEvent | null) => void; requests: EngineRequest[] } {
  interface Channel {
    queued: (EngineEvent | null)[];
    waiters: ((event: EngineEvent | null) => void)[];
  }
  const channels = new Map<string, Channel>();
  const requests: EngineRequest[] = [];
  const channelFor = (messageId: string): Channel => {
    let ch = channels.get(messageId);
    if (!ch) {
      ch = { queued: [], waiters: [] };
      channels.set(messageId, ch);
    }
    return ch;
  };
  const engine: ChatEngine = {
    async *stream(req: EngineRequest): AsyncIterable<EngineEvent> {
      requests.push(req);
      const ch = channelFor(req.messageId);
      while (true) {
        if (req.signal.aborted) return;
        const event = await new Promise<EngineEvent | null>((resolve) => {
          if (ch.queued.length > 0) {
            resolve(ch.queued.shift() as EngineEvent | null);
            return;
          }
          const onAbort = (): void => resolve(null);
          req.signal.addEventListener('abort', onAbort, { once: true });
          ch.waiters.push((e) => {
            req.signal.removeEventListener('abort', onAbort);
            resolve(e);
          });
        });
        if (event === null || req.signal.aborted) return;
        yield event;
        if (event.type === 'finish' || event.type === 'error') return;
      }
    },
    listModels: async () => [],
    testConnection: async () => ({ ok: true, message: 'ok', latencyMs: 0 }),
  };
  const push = (messageId: string, event: EngineEvent | null): void => {
    const ch = channelFor(messageId);
    const waiter = ch.waiters.shift();
    if (waiter) waiter(event);
    else ch.queued.push(event);
  };
  return { engine, push, requests };
}

const FINISH: EngineEvent = { type: 'finish', usage: { tokensIn: 1, tokensOut: 1, tokensCached: 0, tokensReasoning: 0 }, finishReason: 'stop' };
const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
const HOUR = 60 * 60_000;
const T0 = Date.parse('2026-10-12T07:00:00Z'); // Monday 08:00 in London
const NINE = Date.parse('2026-10-12T08:00:00Z'); // Monday 09:00 in London

let store: InMemoryStore;
let clock: ManualClock;
let engine: ReturnType<typeof manualEngine>;
let bus: AppEventBus;
let events: AppEvent[];
let runner: TurnRunner;
let turnDeps: TurnStartDeps;
let service: ScheduleService;

async function resolveP(id: string): Promise<ResolvedProfile> {
  const p = store.profiles.get(id);
  if (!p) throw new Error(`Profile "${id}" not found.`);
  return { ...p, connection: store.connections.get(p.connectionId)!, apiKey: null, model: null };
}

function build(over: Partial<ScheduleServiceDeps> = {}): ScheduleService {
  return new ScheduleService({
    store,
    turnRunner: runner,
    startTurn: (input) => startTurn(turnDeps, input),
    resolveProfile: resolveP,
    resolveWorkspace: (ws) => resolveWorkspace(ws, store.nodes.self().id, store.locations.allPaths(), () => true),
    isChatBusy: (chatId) => bus.runningTurns().some((t) => t.chatId === chatId),
    emit: (e) => bus.emit(e),
    now: clock.now,
    scheduler: clock,
    ...over,
  });
}

function addChat(id: string): void {
  store.chats.create({ id, title: `Chat ${id}`, profileId: 'p1', headMessageId: null, workspaceRoot: null, pinned: false, archivedAt: null });
}

function addSchedule(id: string, over: Partial<NewSchedule> = {}): void {
  store.schedules.create({
    id,
    name: 'Weekly report',
    prompt: 'hello',
    profileId: 'p1',
    target: { kind: 'chat', chatId: 'chat-1' },
    rule: { cadence: 'daily', time: '09:00' },
    timezone: 'Europe/London',
    enabled: true,
    nextRunAt: NINE,
    ...over,
  });
}

const lastUserText = (req: EngineRequest): string => (req.messages.at(-1)!.parts[0] as { text: string }).text;
const scheduleEvents = (): AppEvent[] => events.filter((e) => e.type === 'schedule-run-started' || e.type === 'schedule-run-finished');
async function settle(): Promise<void> {
  await service.idle();
  await flush();
}

beforeEach(() => {
  store = new InMemoryStore();
  clock = new ManualClock(T0);
  engine = manualEngine();
  runner = new TurnRunner(store, engine.engine);
  bus = new AppEventBus();
  bus.attach(runner, store);
  events = [];
  bus.subscribe((e) => events.push(e));
  turnDeps = { store, turnRunner: runner, streamRegistry: new StreamRegistry(runner, store), events: bus };
  store.connections.create({ id: 'conn', name: 'Mock', kind: 'mock', baseUrl: null, secretRef: null, extraHeaders: {}, status: 'unknown', statusMessage: null, checkedAt: null });
  store.profiles.create({
    id: 'p1', name: 'Mock', description: null, colour: null, connectionId: 'conn', modelId: 'm', systemPrompt: null, params: {},
    toolPolicy: { fs: 'off', shell: false, mcpServerIds: [], approvalMode: 'ask_on_mutate', artifacts: false, recall: false },
    isDefault: true, archivedAt: null,
  });
  for (const id of ['chat-1', 'chat-2', 'chat-3']) addChat(id);
  service = build();
});

afterEach(() => service.dispose());

describe("ScheduleService: the schedule's Auto", () => {
  function addClaudeCodeProfile(): void {
    store.connections.create({ id: 'cc', name: 'Claude Code', kind: 'claude_code', baseUrl: null, secretRef: null, extraHeaders: {}, status: 'unknown', statusMessage: null, checkedAt: null });
    store.profiles.create({
      id: 'p-cc', name: 'Claude', description: null, colour: null, connectionId: 'cc', modelId: 'm', systemPrompt: null, params: {},
      toolPolicy: { fs: 'off', shell: false, mcpServerIds: [], approvalMode: 'always_ask', artifacts: false, recall: true },
      isDefault: false, archivedAt: null,
    });
  }

  it('runs in auto mode, and says so in the bracketed paragraph, when the schedule allows it on a Claude Code profile', async () => {
    addClaudeCodeProfile();
    addSchedule('s1', { profileId: 'p-cc', autoMode: true });
    service.start();
    clock.advance(HOUR);
    await settle();
    await vi.waitFor(() => expect(engine.requests).toHaveLength(1));
    const req = engine.requests[0]!;
    expect(req.unattended).toBe(true);
    expect(req.autoMode).toBe(true);
    expect(lastUserText(req)).toContain('Nobody is watching this run: auto mode decides tool calls, and any that would still need approval will be refused.');
  });

  it('stays out of auto mode when the schedule allows it but the profile is not Claude Code, or when the schedule leaves it off', async () => {
    addClaudeCodeProfile();
    addChat('chat-4');
    addSchedule('s1', { autoMode: true });
    addSchedule('s2', { profileId: 'p-cc', target: { kind: 'chat', chatId: 'chat-4' } });
    service.start();
    clock.advance(HOUR);
    await settle();
    await vi.waitFor(() => expect(engine.requests).toHaveLength(2));
    for (const req of engine.requests) {
      expect(req.unattended).toBe(true);
      expect(req.autoMode).toBe(false);
      expect(lastUserText(req)).toContain('Nobody is watching this run, so tool calls that need approval will be refused.');
    }
  });
});

describe('ScheduleService: when runs start', () => {
  it('runs a schedule at its time, unattended, with the bracketed first paragraph, and records it', async () => {
    addSchedule('s1');
    service.start();
    clock.advance(HOUR - 1);
    await settle();
    expect(engine.requests).toHaveLength(0);

    clock.advance(1);
    await settle();
    await vi.waitFor(() => expect(engine.requests).toHaveLength(1));
    const req = engine.requests[0]!;
    expect(req.unattended).toBe(true);
    expect(req.autoMode).toBe(false);
    expect(lastUserText(req)).toBe(
      '[Scheduled run "Weekly report": Monday 12 October 2026, 09:00 (Europe/London). This is the first run. Nobody is watching this run, so tool calls that need approval will be refused. It is stopped if it is still going after 30 minutes.]\n\nhello'
    );
    const run = store.schedules.runs('s1')[0]!;
    expect(run).toMatchObject({ trigger: 'scheduled', status: 'running', dueAt: NINE, startedAt: NINE, chatId: 'chat-1', messageId: req.messageId });
    expect(store.chats.get('chat-1')!.headMessageId).toBe(run.userMessageId);

    engine.push(req.messageId, FINISH);
    await flush();
    expect(store.schedules.runs('s1')[0]).toMatchObject({ status: 'complete', finishedAt: NINE, detail: null, refusedCalls: 0 });
    expect(scheduleEvents()).toEqual([
      { type: 'schedule-run-started', scheduleId: 's1', scheduleName: 'Weekly report', runId: run.id, chatId: 'chat-1', messageId: req.messageId },
      { type: 'schedule-run-finished', scheduleId: 's1', scheduleName: 'Weekly report', runId: run.id, chatId: 'chat-1', messageId: req.messageId, status: 'complete', detail: null },
    ]);
  });

  it('moves nextRunAt on before the turn starts, so a crash mid-run never repeats the slot', async () => {
    addSchedule('s1');
    const seen: (number | null)[] = [];
    service.dispose();
    service = build({
      startTurn: async (input) => {
        seen.push(store.schedules.get('s1')!.nextRunAt);
        return startTurn(turnDeps, input);
      },
    });
    service.start();
    clock.advance(HOUR);
    await settle();
    expect(seen).toEqual([Date.parse('2026-10-13T08:00:00Z')]);
  });

  it('runs a schedule that missed several slots once, marked late, and moves on from now', async () => {
    const friday = NINE - 3 * 24 * HOUR;
    addSchedule('s1', { nextRunAt: friday });
    service.start();
    await settle();
    await vi.waitFor(() => expect(engine.requests).toHaveLength(1));
    expect(store.schedules.runs('s1')).toHaveLength(1);
    expect(store.schedules.runs('s1')[0]).toMatchObject({ trigger: 'late', dueAt: friday, startedAt: T0 });
    expect(store.schedules.get('s1')!.nextRunAt).toBe(NINE);
    expect(lastUserText(engine.requests[0]!)).toContain('Monday 12 October 2026, 08:00 (Europe/London). It was due Friday 9 October 2026, 09:00.');
  });

  it('marks a run left "running" by a previous process as an error on start', () => {
    addSchedule('s1', { nextRunAt: NINE + 24 * HOUR });
    store.schedules.addRun({ id: 'r-old', scheduleId: 's1', trigger: 'scheduled', dueAt: NINE - 24 * HOUR, startedAt: NINE - 24 * HOUR, status: 'running' });
    service.start();
    expect(store.schedules.runs('s1')[0]).toMatchObject({ id: 'r-old', status: 'error', detail: 'OtherBench stopped before this run finished.', finishedAt: T0 });
  });

  it('runs at most two at once; a third waits, oldest due first, and starts when one ends', async () => {
    addSchedule('a', { target: { kind: 'chat', chatId: 'chat-1' }, nextRunAt: NINE - 2000 });
    addSchedule('b', { target: { kind: 'chat', chatId: 'chat-2' }, nextRunAt: NINE - 1000 });
    addSchedule('c', { target: { kind: 'chat', chatId: 'chat-3' }, nextRunAt: NINE });
    clock.advance(HOUR);
    service.start();
    await settle();
    await vi.waitFor(() => expect(engine.requests).toHaveLength(2));
    expect(store.schedules.runs('c')).toEqual([]);
    expect(store.schedules.get('c')!.nextRunAt).toBe(NINE);
    expect(clock.pending().every((ms) => ms > 0)).toBe(true);

    engine.push(store.schedules.runs('a')[0]!.messageId!, FINISH);
    await vi.waitFor(() => expect(engine.requests).toHaveLength(3));
    await settle();
    expect(store.schedules.runs('c')[0]).toMatchObject({ trigger: 'scheduled', status: 'running' });
  });

  it('records a slot as not started when the previous run is still going, and moves on', async () => {
    addSchedule('s1', { timeLimitMinutes: null });
    service.start();
    clock.advance(HOUR);
    await settle();
    await vi.waitFor(() => expect(engine.requests).toHaveLength(1));

    clock.advance(24 * HOUR);
    await settle();
    const [skipped, first] = store.schedules.runs('s1');
    expect(skipped).toMatchObject({ status: 'not_started', detail: 'The previous run was still going.', dueAt: NINE + 24 * HOUR, finishedAt: NINE + 24 * HOUR });
    expect(first).toMatchObject({ status: 'running' });
    expect(store.schedules.get('s1')!.nextRunAt).toBe(NINE + 48 * HOUR);
    expect(engine.requests).toHaveLength(1);
    expect(scheduleEvents().at(-1)).toMatchObject({ type: 'schedule-run-finished', status: 'not_started', chatId: 'chat-1', messageId: null });
  });

  it('waits for a reply being written in the target chat, then runs late, continuing from that reply', async () => {
    addSchedule('s1');
    service.start();
    const mine = await startTurn(turnDeps, { chatId: 'chat-1', parentId: null, userParts: [{ type: 'text', text: 'mine' }], profiles: [await resolveP('p1')] });
    clock.advance(HOUR + 10 * 60_000);
    await settle();
    expect(store.schedules.runs('s1')).toEqual([]);
    expect(clock.pending().every((ms) => ms > 0)).toBe(true);

    engine.push(mine.assistantMessageIds[0]!, FINISH);
    await vi.waitFor(() => expect(store.schedules.runs('s1')[0]?.userMessageId).toBeTruthy());
    const run = store.schedules.runs('s1')[0]!;
    expect(run).toMatchObject({ trigger: 'late', dueAt: NINE });
    expect(store.messages.get(run.userMessageId!)!.parentId).toBe(mine.assistantMessageIds[0]);
  });

  it('never starts two runs in one chat at once: the second waits for the first reply, then continues from it', async () => {
    addSchedule('a', { nextRunAt: NINE - 1000 });
    addSchedule('b', { nextRunAt: NINE });
    clock.advance(HOUR);
    service.start();
    await settle();
    await vi.waitFor(() => expect(engine.requests).toHaveLength(1));
    expect(store.schedules.runs('b')).toEqual([]);

    const first = store.schedules.runs('a')[0]!;
    engine.push(first.messageId!, FINISH);
    await vi.waitFor(() => expect(store.schedules.runs('b')[0]?.userMessageId).toBeTruthy());
    expect(store.messages.get(store.schedules.runs('b')[0]!.userMessageId!)!.parentId).toBe(first.messageId);
  });

  it('dispose stops the timer: nothing runs after it', async () => {
    addSchedule('s1');
    service.start();
    service.dispose();
    expect(clock.pending()).toEqual([]);
    clock.advance(2 * HOUR);
    await settle();
    expect(engine.requests).toHaveLength(0);
  });
});

describe('ScheduleService: every N hours and cron rules', () => {
  it('runs an every-3-hours schedule at each slot, scheduled, and moves to the next slot that day', async () => {
    addSchedule('s1', { rule: { cadence: 'hourly', time: '09:00', everyHours: 3 } });
    service.start();
    expect(clock.pending()).toEqual([SCHEDULE_CHECK_MAX_MS]);
    clock.advance(HOUR);
    await settle();
    await vi.waitFor(() => expect(engine.requests).toHaveLength(1));
    expect(store.schedules.get('s1')!.nextRunAt).toBe(NINE + 3 * HOUR);
    engine.push(engine.requests[0]!.messageId, FINISH);
    await flush();

    clock.advance(3 * HOUR);
    await settle();
    await vi.waitFor(() => expect(engine.requests).toHaveLength(2));
    expect(store.schedules.runs('s1').map((r) => [r.trigger, r.dueAt])).toEqual([
      ['scheduled', NINE + 3 * HOUR],
      ['scheduled', NINE],
    ]);
    expect(store.schedules.get('s1')!.nextRunAt).toBe(NINE + 6 * HOUR);
    // The check timer; the other pending one is the run's own 30-minute timeout.
    expect(clock.pending()[0]).toBeGreaterThan(0);
    expect(clock.pending()[0]).toBeLessThanOrEqual(SCHEDULE_CHECK_MAX_MS);
  });

  it('runs a cron schedule that missed several slots once, marked late, and moves on from now', async () => {
    const due = NINE - 3 * HOUR; // 06:00 in London; every quarter hour since has been missed
    addSchedule('s1', { rule: { cadence: 'cron', cron: '*/15 * * * *' }, nextRunAt: due });
    service.start();
    await settle();
    await vi.waitFor(() => expect(engine.requests).toHaveLength(1));
    expect(store.schedules.runs('s1')).toHaveLength(1);
    expect(store.schedules.runs('s1')[0]).toMatchObject({ trigger: 'late', dueAt: due, startedAt: T0 });
    expect(store.schedules.get('s1')!.nextRunAt).toBe(T0 + 15 * 60_000);
    expect(lastUserText(engine.requests[0]!)).toContain('It was due Monday 12 October 2026, 06:00.');
  });

  it('runs a cron slot reached within 5 minutes as scheduled, not late', async () => {
    addSchedule('s1', { rule: { cadence: 'cron', cron: '0 9 * * 1-5' } });
    service.start();
    clock.advance(HOUR + 4 * 60_000);
    await settle();
    await vi.waitFor(() => expect(engine.requests).toHaveLength(1));
    expect(store.schedules.runs('s1')[0]).toMatchObject({ trigger: 'scheduled', dueAt: NINE });
    // Monday 09:00 done: Tuesday 09:00 next.
    expect(store.schedules.get('s1')!.nextRunAt).toBe(NINE + 24 * HOUR);
  });
});

describe('ScheduleService: runs that cannot start are recorded as not started, with why', () => {
  async function runNowDetail(): Promise<string | null> {
    service.start();
    service.runNow('s1');
    await settle();
    const run = store.schedules.runs('s1')[0]!;
    expect(run.status).toBe('not_started');
    expect(engine.requests).toHaveLength(0);
    expect(scheduleEvents()).toEqual([expect.objectContaining({ type: 'schedule-run-finished', status: 'not_started', runId: run.id })]);
    return run.detail;
  }

  beforeEach(() => addSchedule('s1', { nextRunAt: NINE + 24 * HOUR }));

  it('a chat ending in a compare turn with no reply kept', async () => {
    store.messages.create({ id: 'u1', chatId: 'chat-1', parentId: null, role: 'user', parts: [{ type: 'text', text: 'q' }], status: 'complete', error: null, producedBy: null });
    for (const id of ['v1', 'v2']) {
      store.messages.create({ id, chatId: 'chat-1', parentId: 'u1', role: 'assistant', parts: [], status: 'complete', error: null, producedBy: { profileId: 'p1', profileName: 'Mock', connectionId: 'conn', modelId: 'm' } });
    }
    store.chats.update('chat-1', { headMessageId: 'u1' });
    expect(await runNowDetail()).toMatch(/no reply kept/);
  });

  it('a chat that now runs on another machine', async () => {
    store.chats.update('chat-1', { runsOn: 'node-other' });
    expect(await runNowDetail()).toBe("This chat now runs on another machine, so its schedule can't run here.");
  });

  it("a chat whose folder doesn't resolve here", async () => {
    store.chats.update('chat-1', { workspace: { kind: 'machine', nodeId: 'node-other', root: '/srv/x' } });
    expect(await runNowDetail()).toContain('on another machine');
  });

  it('an archived profile', async () => {
    store.profiles.update('p1', { archivedAt: 5 });
    expect(await runNowDetail()).toBe('The profile "Mock" is archived. Choose another profile for this schedule.');
  });

  it("a project whose folder doesn't resolve here, with no chat made", async () => {
    store.projects.create({ id: 'proj', name: 'Alpha', workspace: { kind: 'machine', nodeId: 'node-other', root: '/srv/alpha' }, defaultProfileId: null });
    store.schedules.delete('s1');
    addSchedule('s1', { target: { kind: 'project', projectId: 'proj' }, nextRunAt: NINE + 24 * HOUR });
    const before = store.chats.list().length;
    expect(await runNowDetail()).toContain('on another machine');
    expect(store.chats.list()).toHaveLength(before);
  });
});

describe('ScheduleService: targets, endings and Run now', () => {
  it('a project target makes a new chat per run, titled with the schedule and the date, and Run now leaves the timetable alone', async () => {
    store.projects.create({ id: 'proj', name: 'Alpha', workspace: null, defaultProfileId: null });
    addSchedule('s1', { target: { kind: 'project', projectId: 'proj' }, nextRunAt: NINE + 24 * HOUR });
    service.start();
    service.runNow('s1');
    await settle();
    await vi.waitFor(() => expect(engine.requests).toHaveLength(1));

    const run = store.schedules.runs('s1')[0]!;
    expect(run).toMatchObject({ trigger: 'manual', dueAt: null, createdChat: true, status: 'running' });
    const chat = store.chats.get(run.chatId!)!;
    expect(chat).toMatchObject({ title: 'Weekly report · 12 Oct 2026', projectId: 'proj', profileId: 'p1', runsOn: store.nodes.self().id });
    expect(store.schedules.madeChat(chat.id)).toBe(true);
    expect(store.schedules.get('s1')!.nextRunAt).toBe(NINE + 24 * HOUR);
    expect(lastUserText(engine.requests[0]!)).toMatch(/^\[Run by hand from schedule "Weekly report": Monday 12 October 2026, 08:00 \(Europe\/London\)\./);
  });

  it('stops a run at the default 30-minute limit and records it as timed out', async () => {
    addSchedule('s1');
    service.start();
    clock.advance(HOUR);
    await settle();
    await vi.waitFor(() => expect(engine.requests).toHaveLength(1));
    expect(lastUserText(engine.requests[0]!)).toContain('It is stopped if it is still going after 30 minutes.]');

    clock.advance(30 * 60_000);
    await vi.waitFor(() => expect(store.schedules.runs('s1')[0]!.status).toBe('timed_out'));
    expect(store.schedules.runs('s1')[0]!.detail).toBe("Stopped at the schedule's time limit of 30 minutes.");
    expect(store.messages.get(engine.requests[0]!.messageId)!.status).toBe('cancelled');
  });

  it('a run that finished leaves nothing to time out later', async () => {
    const cancel = vi.spyOn(runner, 'cancel');
    addSchedule('s1');
    service.start();
    clock.advance(HOUR);
    await settle();
    await vi.waitFor(() => expect(engine.requests).toHaveLength(1));
    engine.push(engine.requests[0]!.messageId, FINISH);
    await flush();

    clock.advance(31 * 60_000);
    await settle();
    expect(cancel).not.toHaveBeenCalled();
    expect(store.schedules.runs('s1')[0]!.status).toBe('complete');
    expect(scheduleEvents().map((e) => e.type)).toEqual(['schedule-run-started', 'schedule-run-finished']);
  });

  it("records a failed reply's error as the run's detail", async () => {
    addSchedule('s1');
    service.start();
    clock.advance(HOUR);
    await settle();
    await vi.waitFor(() => expect(engine.requests).toHaveLength(1));
    engine.push(engine.requests[0]!.messageId, { type: 'error', error: { kind: 'transient', message: 'The provider fell over.', retryable: true } });
    await vi.waitFor(() => expect(store.schedules.runs('s1')[0]!.status).toBe('error'));
    expect(store.schedules.runs('s1')[0]!.detail).toBe('The provider fell over.');
  });

  it("counts the reply's refused tool calls", async () => {
    addSchedule('s1');
    service.start();
    clock.advance(HOUR);
    await settle();
    await vi.waitFor(() => expect(engine.requests).toHaveLength(1));
    const messageId = engine.requests[0]!.messageId;
    const audit = (id: string, msg: string, grantedBy: string): void => {
      store.audit.create({ id, chatId: 'chat-1', messageId: msg, toolName: 'run_command', argsRedacted: {}, resultSummary: 'x', durationMs: 0, grantedBy });
    };
    audit('a1', messageId, 'deny:unattended');
    audit('a2', messageId, 'deny:unattended');
    audit('a3', messageId, 'auto_read');
    audit('a4', 'another-message', 'deny:unattended');
    engine.push(messageId, FINISH);
    await vi.waitFor(() => expect(store.schedules.runs('s1')[0]!.status).toBe('complete'));
    expect(store.schedules.runs('s1')[0]!.refusedCalls).toBe(2);
  });

  it('Run now refuses, with a reason, a schedule already running, a chat with a reply on its way, and a full house', async () => {
    addSchedule('a', { nextRunAt: NINE + 24 * HOUR, target: { kind: 'chat', chatId: 'chat-1' } });
    addSchedule('b', { nextRunAt: NINE + 24 * HOUR, target: { kind: 'chat', chatId: 'chat-1' } });
    addSchedule('c', { nextRunAt: NINE + 24 * HOUR, target: { kind: 'chat', chatId: 'chat-2' } });
    addSchedule('d', { nextRunAt: NINE + 24 * HOUR, target: { kind: 'chat', chatId: 'chat-3' } });
    service.start();
    const kindOf = (fn: () => unknown): string | null => {
      try {
        fn();
        return null;
      } catch (err) {
        return err instanceof ScheduleBusyError ? err.kind : 'other';
      }
    };

    expect(kindOf(() => service.runNow('a'))).toBeNull();
    expect(kindOf(() => service.runNow('a'))).toBe('running');
    expect(kindOf(() => service.runNow('b'))).toBe('busy');
    expect(kindOf(() => service.runNow('c'))).toBeNull();
    expect(kindOf(() => service.runNow('d'))).toBe('full');
    await settle();
    expect(service.isRunning('a')).toBe(true);
  });

  it('a chat with waiting notes is busy: its due run waits, and Run now is refused as busy', async () => {
    const waiting = new Set(['chat-1']);
    service.dispose();
    service = build({ hasWaitingNotes: (chatId) => waiting.has(chatId) });
    addSchedule('s1');
    addSchedule('s2', { nextRunAt: NINE + 24 * HOUR });
    service.start();
    clock.advance(HOUR);
    await settle();
    expect(engine.requests).toHaveLength(0);
    expect(store.schedules.runs('s1')).toEqual([]);
    expect(() => service.runNow('s2')).toThrow(
      expect.objectContaining({ kind: 'busy', message: 'Messages you sent in this chat are still waiting to go out. Try again when they have.' }),
    );

    // The notes went out: the run that waited starts.
    waiting.clear();
    service.poke();
    await settle();
    await vi.waitFor(() => expect(engine.requests).toHaveLength(1));
    expect(store.schedules.runs('s1')[0]).toMatchObject({ trigger: 'scheduled', status: 'running' });
  });

  it('Run now names a reply being written, not waiting notes, when both hold', () => {
    service.dispose();
    service = build({ isChatBusy: (chatId) => chatId === 'chat-1', hasWaitingNotes: (chatId) => chatId === 'chat-1' });
    addSchedule('s1', { nextRunAt: NINE + 24 * HOUR });
    service.start();
    expect(() => service.runNow('s1')).toThrow(
      expect.objectContaining({ kind: 'busy', message: 'A reply is being written in this chat. Try again when it has finished.' }),
    );
  });

  it('a schedule deleted while its run is going lets the reply finish, unrecorded', async () => {
    addSchedule('s1', { nextRunAt: NINE + 24 * HOUR });
    service.start();
    service.runNow('s1');
    await settle();
    await vi.waitFor(() => expect(engine.requests).toHaveLength(1));
    const messageId = engine.requests[0]!.messageId;

    store.schedules.delete('s1');
    engine.push(messageId, FINISH);
    await vi.waitFor(() => expect(store.messages.get(messageId)!.status).toBe('complete'));
    await settle();
    expect(scheduleEvents().map((e) => e.type)).toEqual(['schedule-run-started']);
  });
});

describe("ScheduleService: a schedule's time limit", () => {
  const MINUTE = 60_000;

  /** Starts s1's 09:00 run and returns its reply's id. */
  async function startRun(over: Partial<NewSchedule> = {}): Promise<string> {
    addSchedule('s1', over);
    service.start();
    clock.advance(HOUR);
    await settle();
    await vi.waitFor(() => expect(engine.requests).toHaveLength(1));
    return engine.requests[0]!.messageId;
  }

  it("stops the reply as Stop does at the schedule's own limit, not a moment before, and says so in the run, the chat and the finished event", async () => {
    const cancel = vi.spyOn(runner, 'cancel');
    const messageId = await startRun({ timeLimitMinutes: 10 });
    engine.push(messageId, { type: 'text-delta', text: 'Working on it' });
    await flush();
    expect(lastUserText(engine.requests[0]!)).toContain('It is stopped if it is still going after 10 minutes.]');

    clock.advance(10 * MINUTE - 1);
    await settle();
    expect(cancel).not.toHaveBeenCalled();
    expect(store.schedules.runs('s1')[0]!.status).toBe('running');

    clock.advance(1);
    const detail = "Stopped at the schedule's time limit of 10 minutes.";
    await vi.waitFor(() => expect(store.schedules.runs('s1')[0]!.status).toBe('timed_out'));
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(cancel).toHaveBeenCalledWith(messageId, detail);
    expect(engine.requests[0]!.signal.aborted).toBe(true);
    expect(store.schedules.runs('s1')[0]).toMatchObject({ detail, finishedAt: NINE + 10 * MINUTE });
    const reply = store.messages.get(messageId)!;
    expect(reply.status).toBe('cancelled');
    expect(reply.parts.at(-1)).toEqual({ type: 'notice', text: detail });
    expect(scheduleEvents().at(-1)).toMatchObject({ type: 'schedule-run-finished', status: 'timed_out', detail, chatId: 'chat-1', messageId });
    expect(service.isRunning('s1')).toBe(false);
  });

  it('a run that finishes just before its limit is complete, and nothing is stopped later', async () => {
    const cancel = vi.spyOn(runner, 'cancel');
    const messageId = await startRun({ timeLimitMinutes: 10 });
    clock.advance(10 * MINUTE - 1);
    engine.push(messageId, FINISH);
    await vi.waitFor(() => expect(store.schedules.runs('s1')[0]!.status).toBe('complete'));

    clock.advance(HOUR);
    await settle();
    expect(cancel).not.toHaveBeenCalled();
    expect(store.schedules.runs('s1')[0]).toMatchObject({ status: 'complete', detail: null, finishedAt: NINE + 10 * MINUTE - 1 });
    expect(store.messages.get(messageId)!.parts.some((p) => p.type === 'notice')).toBe(false);
  });

  it('with no limit, a run goes on for as long as its reply does', async () => {
    const cancel = vi.spyOn(runner, 'cancel');
    const messageId = await startRun({ timeLimitMinutes: null, rule: { cadence: 'weekly', time: '09:00', weekdays: [1] } });
    expect(lastUserText(engine.requests[0]!)).not.toContain('It is stopped if');
    // The check timer only: no limit is armed for the run.
    expect(clock.pending()).toEqual([SCHEDULE_CHECK_MAX_MS]);

    clock.advance(25 * HOUR);
    await settle();
    expect(cancel).not.toHaveBeenCalled();
    expect(store.schedules.runs('s1')[0]!.status).toBe('running');

    engine.push(messageId, FINISH);
    await vi.waitFor(() => expect(store.schedules.runs('s1')[0]!.status).toBe('complete'));
  });

  it('counts a wait the reply is held on (a card, a long command) and releases it', async () => {
    let released = false;
    const waiting: ChatEngine = {
      async *stream(req: EngineRequest): AsyncIterable<EngineEvent> {
        engine.requests.push(req);
        yield { type: 'text-delta', text: 'Asking first' };
        // As a tool call parked on an approval card: only the reply's signal lets it go.
        await new Promise<void>((resolve) => req.signal.addEventListener('abort', () => resolve(), { once: true }));
        released = true;
      },
      listModels: async () => [],
      testConnection: async () => ({ ok: true, message: 'ok', latencyMs: 0 }),
    };
    runner = new TurnRunner(store, waiting);
    bus.attach(runner, store);
    turnDeps = { ...turnDeps, turnRunner: runner, streamRegistry: new StreamRegistry(runner, store) };
    service.dispose();
    service = build();
    await startRun({ timeLimitMinutes: 10 });

    clock.advance(10 * MINUTE);
    await vi.waitFor(() => expect(store.schedules.runs('s1')[0]!.status).toBe('timed_out'));
    expect(released).toBe(true);
  });

  it("the user's own Stop before the limit is recorded as stopped, with no time-limit notice", async () => {
    const messageId = await startRun({ timeLimitMinutes: 10 });
    clock.advance(5 * MINUTE);
    runner.cancel(messageId);
    await vi.waitFor(() => expect(store.schedules.runs('s1')[0]!.status).toBe('cancelled'));
    expect(store.schedules.runs('s1')[0]!.detail).toBeNull();
    expect(store.messages.get(messageId)!.parts.some((p) => p.type === 'notice')).toBe(false);

    clock.advance(10 * MINUTE);
    await settle();
    expect(store.schedules.runs('s1')[0]!.status).toBe('cancelled');
  });

  it('a run keeps the limit it started with when the schedule is edited during it', async () => {
    const messageId = await startRun({ timeLimitMinutes: 10 });
    store.schedules.update('s1', { timeLimitMinutes: null });
    clock.advance(10 * MINUTE);
    await vi.waitFor(() => expect(store.schedules.runs('s1')[0]!.status).toBe('timed_out'));
    expect(store.messages.get(messageId)!.status).toBe('cancelled');
  });

  it('a run cut off by a restart is closed as an error, and no limit is left armed for it', () => {
    addSchedule('s1', { nextRunAt: NINE + 24 * HOUR, timeLimitMinutes: 10 });
    store.schedules.addRun({ id: 'r-old', scheduleId: 's1', trigger: 'scheduled', dueAt: T0 - 5 * MINUTE, startedAt: T0 - 5 * MINUTE, status: 'running' });
    service.start();
    expect(store.schedules.runs('s1')[0]).toMatchObject({ id: 'r-old', status: 'error', detail: 'OtherBench stopped before this run finished.' });
    expect(clock.pending()).toEqual([SCHEDULE_CHECK_MAX_MS]);
  });
});

describe('ScheduleService: deleted chats and store errors', () => {
  let logged: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    logged = vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => logged.mockRestore());

  /** DELETE /api/chats/:id on SQLite: the chat's messages cascade away, so they read as missing and writing to them throws. */
  function deleteChat(chatId: string): void {
    const gone = new Set(collectMessageTree(store, chatId).map((m) => m.id));
    store.chats.delete(chatId);
    const messages = store.messages;
    const missing = (id: string): void => {
      if (gone.has(id)) throw new Error(`message: not found: ${id}`);
    };
    const get = messages.get.bind(messages);
    const updateParts = messages.updateParts.bind(messages);
    const updateStatus = messages.updateStatus.bind(messages);
    vi.spyOn(messages, 'get').mockImplementation((id) => (gone.has(id) ? null : get(id)));
    vi.spyOn(messages, 'updateParts').mockImplementation((id, parts) => {
      missing(id);
      updateParts(id, parts);
    });
    vi.spyOn(messages, 'updateStatus').mockImplementation((id, status, error) => {
      missing(id);
      updateStatus(id, status, error);
    });
  }

  it("ends a run whose chat was deleted mid-reply as an error, and the schedule's next slot runs", async () => {
    store.projects.create({ id: 'proj', name: 'Alpha', workspace: null, defaultProfileId: null });
    addSchedule('s1', { target: { kind: 'project', projectId: 'proj' } });
    service.start();
    clock.advance(HOUR);
    await settle();
    await vi.waitFor(() => expect(engine.requests).toHaveLength(1));
    const first = store.schedules.runs('s1')[0]!;
    engine.push(first.messageId!, { type: 'text-delta', text: 'Working on it' });
    await flush();

    deleteChat(first.chatId!);
    clock.advance(SCHEDULE_CHECK_MAX_MS);
    await settle();
    expect(store.schedules.runs('s1')[0]).toMatchObject({ id: first.id, status: 'error', detail: 'The chat was deleted.', finishedAt: NINE + SCHEDULE_CHECK_MAX_MS });
    expect(service.isRunning('s1')).toBe(false);
    expect(engine.requests[0]!.signal.aborted).toBe(true);
    expect(scheduleEvents().at(-1)).toMatchObject({ type: 'schedule-run-finished', runId: first.id, status: 'error', detail: 'The chat was deleted.' });

    clock.advance(24 * HOUR - SCHEDULE_CHECK_MAX_MS);
    await settle();
    await vi.waitFor(() => expect(engine.requests).toHaveLength(2));
    expect(store.schedules.runs('s1')[0]).toMatchObject({ trigger: 'scheduled', status: 'running', dueAt: NINE + 24 * HOUR });
    expect(store.schedules.runs('s1').filter((r) => r.status === 'not_started')).toEqual([]);
  });

  it('keeps checking after a store error: a due() that throws once leaves the timer armed, and the schedule runs on the next tick', async () => {
    addSchedule('s1');
    const due = store.schedules.due.bind(store.schedules);
    let failures = 0;
    vi.spyOn(store.schedules, 'due').mockImplementation((now) => {
      if (now >= NINE && failures === 0) {
        failures++;
        throw new Error('database is locked');
      }
      return due(now);
    });
    service.start();
    clock.advance(HOUR);
    await settle();
    expect(failures).toBe(1);
    expect(engine.requests).toHaveLength(0);
    expect(clock.pending()).toEqual([SCHEDULE_CHECK_MAX_MS]);
    expect(logged).toHaveBeenCalled();

    clock.advance(SCHEDULE_CHECK_MAX_MS);
    await settle();
    await vi.waitFor(() => expect(engine.requests).toHaveLength(1));
    expect(store.schedules.runs('s1')[0]).toMatchObject({ trigger: 'scheduled', dueAt: NINE });
  });

  it('a poke never throws to its caller, even when the store does', () => {
    addSchedule('s1');
    service.start();
    vi.spyOn(store.schedules, 'due').mockImplementation(() => {
      throw new Error('database is locked');
    });
    vi.spyOn(store.schedules, 'list').mockImplementation(() => {
      throw new Error('database is locked');
    });
    expect(() => service.poke()).not.toThrow();
    expect(clock.pending()).toEqual([SCHEDULE_CHECK_MAX_MS]);
  });

  describe('a store error when a run times out', () => {
    const TIMEOUT_AT = NINE + 30 * 60_000;

    /** One slot, s1 running in chat-1, s2 due 15 minutes after s1's timeout in chat-2. */
    async function startFirstRun(): Promise<string> {
      service.dispose();
      service = build({ limits: { maxConcurrent: 1 } });
      addSchedule('s1');
      addSchedule('s2', { target: { kind: 'chat', chatId: 'chat-2' }, nextRunAt: NINE + 45 * 60_000 });
      service.start();
      clock.advance(HOUR);
      await settle();
      await vi.waitFor(() => expect(engine.requests).toHaveLength(1));
      return engine.requests[0]!.messageId;
    }

    async function expectLaterScheduleStarts(): Promise<void> {
      expect(service.isRunning('s1')).toBe(false);
      clock.advance(15 * 60_000);
      await settle();
      await vi.waitFor(() => expect(engine.requests).toHaveLength(2));
      expect(store.schedules.runs('s2')[0]).toMatchObject({ trigger: 'scheduled', dueAt: NINE + 45 * 60_000 });
    }

    it('is logged, not thrown from the timer: the run is ended as an error, its slot freed, and a later schedule runs', async () => {
      const messageId = await startFirstRun();
      const get = store.messages.get.bind(store.messages);
      vi.spyOn(store.messages, 'get').mockImplementation((id) => {
        if (clock.now() === TIMEOUT_AT) throw new Error('database is locked');
        return get(id);
      });

      expect(() => clock.advance(30 * 60_000)).not.toThrow();
      expect(logged).toHaveBeenCalledWith(expect.stringContaining('run '), expect.objectContaining({ message: 'database is locked' }));
      expect(store.schedules.runs('s1')[0]).toMatchObject({ status: 'error', detail: "OtherBench couldn't stop this run: database is locked" });
      expect(scheduleEvents().at(-1)).toMatchObject({ type: 'schedule-run-finished', status: 'error', messageId });
      await expectLaterScheduleStarts();
    });

    it('is still contained when the reply cannot be cancelled and the run cannot be recorded either', async () => {
      await startFirstRun();
      vi.spyOn(runner, 'cancel').mockImplementation(() => {
        throw new Error('cancel failed');
      });
      const updateRun = store.schedules.updateRun.bind(store.schedules);
      vi.spyOn(store.schedules, 'updateRun').mockImplementation((id, patch) => {
        if (clock.now() === TIMEOUT_AT) throw new Error('database is locked');
        return updateRun(id, patch);
      });

      expect(() => clock.advance(30 * 60_000)).not.toThrow();
      expect(logged).toHaveBeenCalledTimes(2);
      await expectLaterScheduleStarts();
    });
  });

  it('a run being set up when the service is disposed never starts its turn', async () => {
    addSchedule('s1', { nextRunAt: NINE + 24 * HOUR });
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    service.dispose();
    service = build({
      resolveProfile: async (id) => {
        await gate;
        return resolveP(id);
      },
    });
    service.start();
    service.runNow('s1');
    service.dispose();
    release();
    await settle();
    expect(engine.requests).toHaveLength(0);
    expect(store.chats.get('chat-1')!.headMessageId).toBeNull();
    expect(clock.pending()).toEqual([]);
  });
});
