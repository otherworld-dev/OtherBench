import { afterEach, describe, expect, it } from 'vitest';
import { TurnRunner } from '@otherbench/core/domain/turn.js';
import { FakeSecretStore, InMemoryStore } from '@otherbench/core/testing/fakes.js';
import type { ChatEngine, EngineEvent, EngineRequest } from '@otherbench/core/ports/chat-engine.js';
import type { ScheduleView } from '@otherbench/core/ports/store.js';
import { createApp } from '../../src/app.js';
import type { Container } from '../../src/container.js';
import { forwardedApi } from '../../src/peer/forward.js';
import { resolveProfile } from '../../src/profile-resolution.js';
import { serverTimeZone } from '../../src/routes/schedules.js';
import { formatInZone } from '@otherbench/core/domain/schedule.js';
import { ScheduleService, type ScheduleLimits } from '../../src/schedule/service.js';
import { AppEventBus } from '../../src/stream/events.js';
import { StreamRegistry } from '../../src/stream/registry.js';
import { startTurn } from '../../src/turn-start.js';
import { workspaceResolver } from '../../src/workspace-view.js';

/** An engine whose replies never finish on their own, so runs stay running. */
const hangingEngine: ChatEngine = {
  async *stream(req: EngineRequest): AsyncIterable<EngineEvent> {
    await new Promise<void>((resolve) => req.signal.addEventListener('abort', () => resolve(), { once: true }));
  },
  listModels: async () => [],
  testConnection: async () => ({ ok: true, message: 'ok', latencyMs: 0 }),
};

let container: Container;

function setup(limits?: Partial<ScheduleLimits>): void {
  const store = new InMemoryStore();
  const turnRunner = new TurnRunner(store, hangingEngine);
  const events = new AppEventBus();
  events.attach(turnRunner, store);
  container = {
    store,
    events,
    secrets: new FakeSecretStore(),
    engine: hangingEngine,
    registry: {} as never,
    toolProvider: {} as never,
    mcpManager: {} as never,
    turnRunner,
    streamRegistry: new StreamRegistry(turnRunner, store),
    blobStore: {} as never,
    close: () => {},
  };
  container.schedules = new ScheduleService({
    store,
    turnRunner,
    startTurn: (input) => startTurn(container, input),
    resolveProfile: (id) => resolveProfile(container, id),
    resolveWorkspace: (ws) => workspaceResolver(container)(ws),
    isChatBusy: (chatId) => events.runningTurns().some((t) => t.chatId === chatId),
    emit: (e) => events.emit(e),
    ...(limits ? { limits } : {}),
  });
  store.connections.create({ id: 'conn', name: 'Mock', kind: 'mock', baseUrl: null, secretRef: null, extraHeaders: {}, status: 'unknown', statusMessage: null, checkedAt: null });
  for (const [id, archivedAt] of [['p1', null], ['archived', 5]] as const) {
    store.profiles.create({
      id, name: id === 'p1' ? 'Mock' : 'Old', description: null, colour: null, connectionId: 'conn', modelId: 'm', systemPrompt: null, params: {},
      toolPolicy: { fs: 'off', shell: false, mcpServerIds: [], approvalMode: 'always_ask' }, isDefault: id === 'p1', archivedAt,
    });
  }
  for (const id of ['chat-1', 'chat-2']) store.chats.create({ id, title: `Chat ${id}`, profileId: 'p1', headMessageId: null, workspaceRoot: null, pinned: false, archivedAt: null });
  store.projects.create({ id: 'proj', name: 'Alpha', workspace: null, defaultProfileId: null });
}

afterEach(() => container.schedules?.dispose());

const body = (over: Record<string, unknown> = {}) => ({
  name: 'Weekly report',
  prompt: 'hello',
  profileId: 'p1',
  target: { chatId: 'chat-1' },
  rule: { cadence: 'daily', time: '09:00' },
  ...over,
});

const send = (method: string, path: string, data?: unknown) =>
  createApp(container).request(`/api/schedules${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
  });

async function create(over: Record<string, unknown> = {}): Promise<ScheduleView> {
  const res = await send('POST', '', body(over));
  expect(res.status).toBe(201);
  return (await res.json()) as ScheduleView;
}

describe('POST /api/schedules', () => {
  it("makes a schedule in the server's zone, with its next run, and lists it with what the UI shows", async () => {
    setup();
    const before = Date.now();
    const made = await create();
    expect(made).toMatchObject({
      name: 'Weekly report',
      target: { kind: 'chat', chatId: 'chat-1' },
      timezone: serverTimeZone(),
      enabled: true,
      targetName: 'Chat chat-1',
      describe: 'Every day at 09:00',
      running: false,
      activeRun: null,
      lastRun: null,
      warnings: ['This profile asks before every tool call, so every tool call will be refused.'],
    });
    expect(made.nextRunAt!).toBeGreaterThan(before);
    expect(made.nextRunAt! - before).toBeLessThanOrEqual(25 * 60 * 60_000);

    const list = (await (await send('GET', '')).json()) as ScheduleView[];
    expect(list.map((s) => s.id)).toEqual([made.id]);
    expect((await create({ target: { projectId: 'proj' }, enabled: false })).nextRunAt).toBeNull();
  });

  it('refuses each bad field with a 400 naming it', async () => {
    setup();
    const cases: [Record<string, unknown>, RegExp][] = [
      [{ name: '   ' }, /"name"/],
      [{ name: 'x'.repeat(81) }, /"name"/],
      [{ prompt: '' }, /"prompt"/],
      [{ prompt: 'x'.repeat(20_001) }, /"prompt"/],
      [{ profileId: 'nope' }, /"profileId"/],
      [{ profileId: 'archived' }, /archived/],
      [{ target: undefined }, /"target"/],
      [{ target: { chatId: 'chat-1', projectId: 'proj' } }, /"target"/],
      [{ target: { chatId: 'nope' } }, /"target.chatId"/],
      [{ target: { projectId: 'nope' } }, /"target.projectId"/],
      [{ rule: { cadence: 'yearly', time: '09:00' } }, /"rule.cadence"/],
      [{ rule: { cadence: 'weekly', time: '09:00', weekdays: [] } }, /"rule.weekdays"/],
      [{ rule: { cadence: 'hourly', time: '09:00', everyHours: 24 } }, /"rule.everyHours"/],
      [{ rule: { cadence: 'cron', cron: '0 9 * *' } }, /^"rule.cron": A cron rule has five fields/],
      [{ rule: { cadence: 'cron', cron: '61 9 * * *' } }, /^"rule.cron": The minute field's "61" is out of range: 0 to 59.$/],
      [{ enabled: 'yes' }, /"enabled"/],
      [{ autoMode: 'yes' }, /"autoMode"/],
      [{ timeLimitMinutes: 0 }, /"timeLimitMinutes"/],
      [{ timeLimitMinutes: 1441 }, /"timeLimitMinutes"/],
      [{ timeLimitMinutes: 2.5 }, /"timeLimitMinutes"/],
      [{ timeLimitMinutes: '30' }, /"timeLimitMinutes"/],
      [{ timezone: 'Mars/Olympus' }, /^"timezone" must be an IANA time zone/],
      [{ timezone: '+05:00' }, /"timezone"/],
    ];
    for (const [over, message] of cases) {
      const res = await send('POST', '', body(over));
      expect(res.status, JSON.stringify(over)).toBe(400);
      expect(((await res.json()) as { error: string }).error).toMatch(message);
    }
    expect(container.store.schedules.list()).toEqual([]);
  });

  it('refuses a chat that runs on another machine, saying where to make the schedule', async () => {
    setup();
    container.store.chats.update('chat-2', { runsOn: 'node-other' });
    const res = await send('POST', '', body({ target: { chatId: 'chat-2' } }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe(
      'This chat runs on another machine. A schedule runs on the machine that holds it: make the schedule there, or run the chat here.'
    );
  });

  it('refuses a 101st schedule', async () => {
    setup();
    for (let i = 0; i < 100; i++) {
      container.store.schedules.create({ id: `s${i}`, name: 'S', prompt: 'p', profileId: 'p1', target: { kind: 'project', projectId: 'proj' }, rule: { cadence: 'daily', time: '09:00' }, timezone: 'UTC', enabled: false, nextRunAt: null });
    }
    const res = await send('POST', '', body());
    expect(res.status).toBe(409);
  });
});

describe('PATCH and DELETE /api/schedules/:id', () => {
  it('pausing clears the next run; resuming computes it from now, so a slot missed while paused never fires', async () => {
    setup();
    const made = await create();
    container.store.schedules.update(made.id, { nextRunAt: Date.now() - 3 * 24 * 60 * 60_000 });

    const paused = (await (await send('PATCH', `/${made.id}`, { enabled: false })).json()) as ScheduleView;
    expect(paused).toMatchObject({ enabled: false, nextRunAt: null });

    const before = Date.now();
    const resumed = (await (await send('PATCH', `/${made.id}`, { enabled: true })).json()) as ScheduleView;
    expect(resumed.enabled).toBe(true);
    expect(resumed.nextRunAt!).toBeGreaterThan(before);
    expect(container.store.schedules.runs(made.id)).toEqual([]);
  });

  it('a rule change recomputes the next run; other edits keep it; the target never changes', async () => {
    setup();
    const made = await create();
    const renamed = (await (await send('PATCH', `/${made.id}`, { name: 'Daily', prompt: 'hi' })).json()) as ScheduleView;
    expect(renamed).toMatchObject({ name: 'Daily', prompt: 'hi', nextRunAt: made.nextRunAt });
    const weekly = (await (await send('PATCH', `/${made.id}`, { rule: { cadence: 'weekly', time: '09:00', weekdays: [1] } })).json()) as ScheduleView;
    expect(weekly.describe).toBe('Mondays at 09:00');
    const before = Date.now();
    const hourly = (await (await send('PATCH', `/${made.id}`, { rule: { cadence: 'hourly', time: '00:00', everyHours: 1 } })).json()) as ScheduleView;
    expect(hourly.describe).toBe('Every hour from 00:00 to 23:00');
    expect(hourly.nextRunAt! - before).toBeLessThanOrEqual(2 * 60 * 60_000);
    const cron = (await (await send('PATCH', `/${made.id}`, { rule: { cadence: 'cron', cron: ' */5  * * * * ' } })).json()) as ScheduleView;
    expect(cron).toMatchObject({ describe: 'Cron rule */5 * * * *', rule: { cadence: 'cron', cron: '*/5 * * * *' } });
    expect(cron.nextRunAt! - before).toBeLessThanOrEqual(5 * 60_000 + 1000);
    const bad = await send('PATCH', `/${made.id}`, { rule: { cadence: 'cron', cron: '0 0 30 2 *' } });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toBe('"rule.cron": It never runs: none of those months has any of those days.');
    expect(container.store.schedules.get(made.id)!.rule).toEqual({ cadence: 'cron', cron: '*/5 * * * *' });
    expect((await send('PATCH', `/${made.id}`, { target: { chatId: 'chat-2' } })).status).toBe(400);
    expect((await send('PATCH', '/nope', { name: 'x' })).status).toBe(404);
  });

  it("Auto is off unless asked for, set on create or edit, and the warnings follow it on a Claude Code profile", async () => {
    setup();
    container.store.connections.create({ id: 'cc', name: 'Claude Code', kind: 'claude_code', baseUrl: null, secretRef: null, extraHeaders: {}, status: 'unknown', statusMessage: null, checkedAt: null });
    container.store.profiles.create({
      id: 'p-cc', name: 'Claude', description: null, colour: null, connectionId: 'cc', modelId: 'm', systemPrompt: null, params: {},
      toolPolicy: { fs: 'off', shell: false, mcpServerIds: [], approvalMode: 'always_ask' }, isDefault: false, archivedAt: null,
    });
    const refused = ['This profile asks before every tool call, so every tool call will be refused.'];
    const decides = ["Auto mode decides Claude Code's tool calls. One it blocks is refused, and so is one it would still ask you about."];

    const made = await create({ profileId: 'p-cc' });
    expect(made).toMatchObject({ autoMode: false, warnings: refused });
    expect(await create({ profileId: 'p-cc', autoMode: true })).toMatchObject({ autoMode: true, warnings: decides });

    const on = (await (await send('PATCH', `/${made.id}`, { autoMode: true })).json()) as ScheduleView;
    expect(on).toMatchObject({ autoMode: true, warnings: decides, nextRunAt: made.nextRunAt });
    const kept = (await (await send('PATCH', `/${made.id}`, { name: 'Daily' })).json()) as ScheduleView;
    expect(kept.autoMode).toBe(true);
    const off = (await (await send('PATCH', `/${made.id}`, { autoMode: false })).json()) as ScheduleView;
    expect(off).toMatchObject({ autoMode: false, warnings: refused });
    expect((await send('PATCH', `/${made.id}`, { autoMode: 1 })).status).toBe(400);
  });

  it('the time limit is 30 minutes unless given, null for no limit, and can be changed or taken off by an edit', async () => {
    setup();
    const made = await create();
    expect(made.timeLimitMinutes).toBe(30);
    expect((await create({ timeLimitMinutes: null })).timeLimitMinutes).toBeNull();
    expect((await create({ timeLimitMinutes: 1440 })).timeLimitMinutes).toBe(1440);

    const longer = (await (await send('PATCH', `/${made.id}`, { timeLimitMinutes: 120 })).json()) as ScheduleView;
    expect(longer).toMatchObject({ timeLimitMinutes: 120, nextRunAt: made.nextRunAt });
    const kept = (await (await send('PATCH', `/${made.id}`, { name: 'Daily' })).json()) as ScheduleView;
    expect(kept.timeLimitMinutes).toBe(120);
    const none = (await (await send('PATCH', `/${made.id}`, { timeLimitMinutes: null })).json()) as ScheduleView;
    expect(none.timeLimitMinutes).toBeNull();
    const bad = await send('PATCH', `/${made.id}`, { timeLimitMinutes: -5 });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toBe('"timeLimitMinutes" must be a whole number of minutes from 1 to 1440, or null for no limit.');
    expect(container.store.schedules.get(made.id)!.timeLimitMinutes).toBeNull();
  });

  it('takes a zone on create and edit; a new zone recomputes the next run in it, and a bad one is refused', async () => {
    setup();
    const nine = { cadence: 'daily', time: '09:00' };
    const before = Date.now();
    const made = await create({ rule: nine, timezone: 'Asia/Tokyo' });
    expect(made.timezone).toBe('Asia/Tokyo');
    expect(formatInZone(made.nextRunAt!, 'Asia/Tokyo', 'time')).toBe('09:00');
    expect(made.nextRunAt! - before).toBeLessThanOrEqual(25 * 60 * 60_000);

    const moved = (await (await send('PATCH', `/${made.id}`, { timezone: 'america/new_york' })).json()) as ScheduleView;
    expect(moved.timezone).toBe('America/New_York');
    expect(formatInZone(moved.nextRunAt!, 'America/New_York', 'time')).toBe('09:00');
    expect(moved.nextRunAt!).toBeGreaterThan(before);
    expect(moved.nextRunAt!).not.toBe(made.nextRunAt);
    // The same zone again changes nothing; other edits keep the zone.
    const same = (await (await send('PATCH', `/${made.id}`, { timezone: 'America/New_York', name: 'Renamed' })).json()) as ScheduleView;
    expect(same).toMatchObject({ timezone: 'America/New_York', nextRunAt: moved.nextRunAt });

    const bad = await send('PATCH', `/${made.id}`, { timezone: 'Mars/Olympus' });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toBe('"timezone" must be an IANA time zone, such as "Europe/London".');
    expect(container.store.schedules.get(made.id)!.timezone).toBe('America/New_York');

    // A paused schedule takes a new zone and stays paused.
    const paused = (await (await send('PATCH', `/${made.id}`, { enabled: false })).json()) as ScheduleView;
    const pausedMoved = (await (await send('PATCH', `/${paused.id}`, { timezone: 'UTC' })).json()) as ScheduleView;
    expect(pausedMoved).toMatchObject({ timezone: 'UTC', enabled: false, nextRunAt: null });
  });

  it('DELETE removes it', async () => {
    setup();
    const made = await create();
    expect((await send('DELETE', `/${made.id}`)).status).toBe(204);
    expect(container.store.schedules.get(made.id)).toBeNull();
    expect((await send('DELETE', `/${made.id}`)).status).toBe(404);
  });
});

describe('POST /api/schedules/:id/run', () => {
  it('starts a run by hand (202) and lists it in the history; a second press is a 409 "running"', async () => {
    setup();
    const made = await create();
    const res = await send('POST', `/${made.id}/run`);
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ trigger: 'manual', status: 'running', scheduleId: made.id });
    const again = await send('POST', `/${made.id}/run`);
    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({ kind: 'running' });
    await container.schedules!.idle();
    const runs = (await (await send('GET', `/${made.id}/runs`)).json()) as { trigger: string }[];
    expect(runs.map((r) => r.trigger)).toEqual(['manual']);
  });

  it('lists the run being written as the active run, also once a later slot was recorded as not started', async () => {
    setup();
    const made = await create();
    await send('POST', `/${made.id}/run`);
    await container.schedules!.idle();
    const running = container.store.schedules.lastRun(made.id)!;
    expect(running.messageId).toBeTruthy();
    // What the service writes when the run overruns its next slot.
    container.store.schedules.addRun({ id: 'skipped', scheduleId: made.id, trigger: 'scheduled', dueAt: running.startedAt + 1, startedAt: running.startedAt + 1, finishedAt: running.startedAt + 1, status: 'not_started', detail: 'The previous run was still going.' });

    const [view] = (await (await send('GET', '')).json()) as ScheduleView[];
    expect(view).toMatchObject({ running: true, activeRun: { runId: running.id, messageId: running.messageId }, lastRun: { id: 'skipped', messageId: null } });
  });

  it('is a 409 "busy" while a reply is being written in its chat', async () => {
    setup();
    const made = await create();
    const turn = await createApp(container).request('/api/chats/chat-1/turns', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ parts: [{ type: 'text', text: 'mine' }], profileIds: ['p1'] }),
    });
    expect(turn.status).toBe(202);
    const res = await send('POST', `/${made.id}/run`);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ kind: 'busy' });
  });

  it('is a 409 "full" when the scheduled-run slots are taken', async () => {
    setup({ maxConcurrent: 1 });
    const first = await create();
    const second = await create({ target: { projectId: 'proj' } });
    expect((await send('POST', `/${first.id}/run`)).status).toBe(202);
    const res = await send('POST', `/${second.id}/run`);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ kind: 'full' });
  });

  it('runs a paused schedule and leaves it paused', async () => {
    setup();
    const made = await create({ enabled: false });
    expect((await send('POST', `/${made.id}/run`)).status).toBe(202);
    await container.schedules!.idle();
    expect(container.store.schedules.get(made.id)).toMatchObject({ enabled: false, nextRunAt: null });
  });
});

describe('the peer listener', () => {
  it('has no schedule routes', async () => {
    setup();
    const made = await create();
    expect((await forwardedApi(container).request('/schedules')).status).toBe(404);
    expect((await forwardedApi(container).request(`/schedules/${made.id}/run`, { method: 'POST' })).status).toBe(404);
  });
});
