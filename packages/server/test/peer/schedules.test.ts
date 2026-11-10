import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { PeerScheduleSummary, PeerSchedules } from '@otherbench/core/types/peer.js';
import { createApp } from '../../src/app.js';
import { createContainer, type Container } from '../../src/container.js';
import { peerScheduleRoute } from '../../src/peer/schedule-control.js';
import { ownSchedules, peerSchedulesOf } from '../../src/peer/schedules.js';
import { makeNode, pair, type TestNode } from './helpers.js';

const summary = (over: Partial<PeerScheduleSummary> = {}): PeerScheduleSummary => ({
  id: 's1', name: 'Morning report', describe: 'Every day at 09:00', timezone: 'Europe/London', enabled: true, nextRunAt: 1_000, invalid: false,
  target: { kind: 'chat', chatId: 'c1' }, profileId: 'p1', autoMode: false, timeLimitMinutes: 30, running: false, lastRun: null, ...over,
});

describe('the schedule calls a paired machine may make', () => {
  it('are the run history, and, to manage them, the list, create, edit, delete and Run now; nothing else', () => {
    expect(peerScheduleRoute('GET', '/schedules/s1/runs')).toEqual({ kind: 'history' });
    expect(peerScheduleRoute('GET', '/schedules')).toEqual({ kind: 'manage', scheduleId: null, action: 'list' });
    expect(peerScheduleRoute('POST', '/schedules')).toEqual({ kind: 'manage', scheduleId: null, action: 'create' });
    expect(peerScheduleRoute('PATCH', '/schedules/s%201')).toEqual({ kind: 'manage', scheduleId: 's 1', action: 'patch' });
    expect(peerScheduleRoute('DELETE', '/schedules/s1')).toEqual({ kind: 'manage', scheduleId: 's1', action: 'delete' });
    expect(peerScheduleRoute('POST', '/schedules/s1/run')).toEqual({ kind: 'manage', scheduleId: 's1', action: 'run' });
    for (const [method, path] of [
      ['GET', '/schedules/s1'],
      ['PUT', '/schedules/s1'],
      ['POST', '/schedules/s1/runs'],
      ['GET', '/schedules/s1/run'],
      ['DELETE', '/schedules'],
      ['PATCH', '/schedules'],
      ['POST', '/schedules/s1/attachments'],
      ['GET', '/schedules/s1/runs/r1'],
      ['PATCH', '/schedules/%E0%A4%A'],
      ['HEAD', '/schedules/s1/runs'],
    ] as const) {
      expect(peerScheduleRoute(method, path), `${method} ${path}`).toBeNull();
    }
  });
});

describe('the schedules announcement between two peer services', () => {
  const nodes: TestNode[] = [];
  function node(name: string): TestNode {
    const n = makeNode(name, { minBackoffMs: 20, maxBackoffMs: 80 });
    nodes.push(n);
    return n;
  }
  afterEach(async () => {
    await Promise.all(nodes.splice(0).map((n) => n.close()));
  });

  async function connected(schedules: () => PeerScheduleSummary[]): Promise<{ pc: TestNode; laptop: TestNode }> {
    const pc = node('PC');
    const laptop = node('Laptop');
    pc.service.attachSchedules(schedules);
    await pair(pc, laptop);
    laptop.service.startMonitoring();
    await expect.poll(() => laptop.service.status('node-PC').status).toBe('reachable');
    return { pc, laptop };
  }

  it('sends the whole list when the stream opens, and again only when it changes', async () => {
    let list = [summary()];
    const { pc, laptop } = await connected(() => list);
    await expect.poll(() => laptop.service.schedules('node-PC')).toEqual([summary()]);
    const told = (): number => laptop.events.filter((e) => e.type === 'peer-schedules').length;
    expect(told()).toBe(1);

    // The first call after attaching always sends; the next with nothing changed doesn't.
    pc.service.announceSchedulesIfChanged();
    await expect.poll(told).toBe(2);
    pc.service.announceSchedulesIfChanged();
    pc.service.announceSchedulesIfChanged();

    list = [summary({ name: 'Renamed', lastRun: { status: 'complete', startedAt: 5, chatId: 'c1' } })];
    pc.service.announceSchedulesIfChanged();
    await expect.poll(() => laptop.service.schedules('node-PC')?.[0]?.name).toBe('Renamed');
    expect(told()).toBe(3);
    expect(laptop.service.schedules('node-PC')![0]!.lastRun).toEqual({ status: 'complete', startedAt: 5, chatId: 'c1' });

    list = [];
    pc.service.announceSchedulesIfChanged();
    await expect.poll(() => laptop.service.schedules('node-PC')).toEqual([]);
  });

  it("shows none while the machine isn't reachable, rather than its last list", async () => {
    const { pc, laptop } = await connected(() => [summary()]);
    await expect.poll(() => laptop.service.schedules('node-PC')).toHaveLength(1);
    await pc.service.listener.stop();
    await expect.poll(() => laptop.service.status('node-PC').status).toBe('unreachable');
    expect(laptop.service.schedules('node-PC')).toBeNull();
  });

  it('keeps only the fields a row shows, bounded, and drops a malformed entry; a non-list leaves the last list', async () => {
    const { pc, laptop } = await connected(() => []);
    await expect.poll(() => laptop.service.schedules('node-PC')).toEqual([]);
    pc.service.announce('schedules', {
      schedules: [
        { ...summary(), prompt: 'the secret prompt', warnings: ['x'], activeRun: { runId: 'r', messageId: 'm' }, lastRun: { status: 'error', startedAt: 9, chatId: 'c1', detail: 'boom', messageId: 'm' } },
        { ...summary({ id: 's2' }), name: 'x'.repeat(500) },
        { ...summary({ id: 's3' }), target: { kind: 'chat' } },
        { ...summary({ id: 's4' }), lastRun: { status: 'exploded', startedAt: 1 }, nextRunAt: 'soon', timeLimitMinutes: 'long', describe: 'y'.repeat(1000) },
        'not an object',
      ],
    });
    await expect.poll(() => laptop.service.schedules('node-PC')?.map((s) => s.id)).toEqual(['s1', 's4']);
    const [first, fourth] = laptop.service.schedules('node-PC')!;
    expect(first).toEqual(summary({ lastRun: { status: 'error', startedAt: 9, chatId: 'c1' } }));
    expect(JSON.stringify(first)).not.toContain('secret');
    expect(fourth!.lastRun).toBeNull();
    expect(fourth!.nextRunAt).toBeNull();
    expect(fourth!.timeLimitMinutes).toBe(30);
    expect(fourth!.describe).toHaveLength(300);

    pc.service.announce('schedules', { schedules: 'nope' });
    pc.service.announce('schedules', { schedules: [summary({ id: 'later' })] });
    await expect.poll(() => laptop.service.schedules('node-PC')?.map((s) => s.id)).toEqual(['later']);
  });

  it('says whether it lets paired machines manage its schedules, and its zone; the other reads that as no while unreachable or unsaid', async () => {
    let manage = false;
    const pc = node('PC');
    const laptop = node('Laptop');
    pc.service.attachSchedules(() => [summary()], { manage: () => manage, timezone: () => 'Europe/London' });
    await pair(pc, laptop);
    laptop.service.startMonitoring();
    await expect.poll(() => laptop.service.schedules('node-PC')).toHaveLength(1);
    expect(laptop.service.scheduleControl('node-PC')).toEqual({ manage: false, timezone: 'Europe/London' });
    expect(pc.service.schedulesAnnouncement()).toEqual({ schedules: [summary()], manage: false, timezone: 'Europe/London' });

    // Only a change is sent again, and the setting is part of what is compared.
    pc.service.announceSchedulesIfChanged();
    manage = true;
    pc.service.announceSchedulesIfChanged();
    await expect.poll(() => laptop.service.scheduleControl('node-PC').manage).toBe(true);

    // Anything but true is no; a garbled zone is none.
    pc.service.announce('schedules', { schedules: [summary()], manage: 'yes', timezone: 'x'.repeat(500) });
    await expect.poll(() => laptop.service.scheduleControl('node-PC')).toEqual({ manage: false, timezone: null });
    // An older build says only the list.
    pc.service.announce('schedules', { schedules: [summary()] });
    await expect.poll(() => laptop.service.scheduleControl('node-PC')).toEqual({ manage: false, timezone: null });
    pc.service.announce('schedules', { schedules: [summary()], manage: true, timezone: 'Europe/London' });
    await expect.poll(() => laptop.service.scheduleControl('node-PC').manage).toBe(true);

    await pc.service.listener.stop();
    await expect.poll(() => laptop.service.status('node-PC').status).toBe('unreachable');
    expect(laptop.service.scheduleControl('node-PC')).toEqual({ manage: false, timezone: null });
  });

  it("reads anything but a list as nothing said, and forgets a removed machine's", async () => {
    const pc = node('PC');
    const laptop = node('Laptop');
    await pair(pc, laptop);
    laptop.service.startMonitoring();
    await expect.poll(() => laptop.service.status('node-PC').status).toBe('reachable');
    // The PC attached nothing, so it says []. An older build sends no event at all, and the route reads that as not shared.
    expect(peerSchedulesOf({})).toBeNull();
    expect(peerSchedulesOf(null)).toBeNull();
    await expect.poll(() => laptop.service.schedules('node-PC')).toEqual([]);
    await laptop.service.remove('node-PC');
    expect(laptop.service.schedules('node-PC')).toBeNull();
  });
});

interface Machine {
  id: string;
  container: Container;
  api: (method: string, path: string, body?: unknown) => Promise<Response>;
}

describe('schedules across two real servers', () => {
  const cleanup: (() => void)[] = [];
  afterEach(() => {
    for (const c of cleanup.splice(0).reverse()) c();
  });

  async function machine(name: string): Promise<Machine> {
    const dir = mkdtempSync(join(tmpdir(), `otherbench-sched-${name}-`));
    const container = await createContainer({ dbPath: ':memory:', secretsPath: join(dir, 'secrets.json'), peerPort: 0, peerHosts: ['127.0.0.1'] });
    container.store.nodes.rename(name);
    const app = createApp(container);
    cleanup.push(() => {
      for (const m of container.store.messages.listByStatus('streaming')) container.turnRunner.cancel(m.id);
      container.close();
      rmSync(dir, { recursive: true, force: true });
    });
    return {
      id: container.store.nodes.self().id,
      container,
      api: async (method, path, body) =>
        app.request(path, { method, headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }),
    };
  }

  async function setup(): Promise<{ pc: Machine; laptop: Machine; chatId: string; profileId: string; scheduleId: string }> {
    const pc = await machine('PC');
    const laptop = await machine('Laptop');
    const view = await pc.container.peers!.startPairing();
    await laptop.container.peers!.pairWith(view.addresses[0]!, view.code);
    const connection = (await (await pc.api('POST', '/api/connections', { name: 'Mock', kind: 'mock', availability: 'anywhere' })).json()) as { id: string };
    pc.container.store.models.create({
      id: 'mock-model', connectionId: connection.id, modelId: 'mock', displayName: 'Mock', source: 'manual', supportsVision: false, supportsTools: true,
      supportsReasoning: false, contextWindow: null, maxOutput: null, priceInPer1m: null, priceOutPer1m: null, priceCachedPer1m: null, currency: 'USD',
    });
    const profile = (await (await pc.api('POST', '/api/profiles', { name: 'Reporter', connectionId: connection.id, modelId: 'mock' })).json()) as { id: string };
    const chat = (await (await pc.api('POST', '/api/chats', { profileId: profile.id, title: 'Trip plans' })).json()) as { id: string };
    const created = await pc.api('POST', '/api/schedules', {
      name: 'Morning report', prompt: 'PROMPT-ONLY-ON-THE-PC', profileId: profile.id, target: { chatId: chat.id }, rule: { cadence: 'daily', time: '09:00' }, timeLimitMinutes: 120,
    });
    expect(created.status).toBe(201);
    const schedule = (await created.json()) as { id: string };
    await laptop.container.peers!.syncerOrNull()!.pullFrom(pc.id);
    await expect.poll(() => laptop.container.peers!.status(pc.id).status).toBe('reachable');
    return { pc, laptop, chatId: chat.id, profileId: profile.id, scheduleId: schedule.id };
  }

  async function shown(laptop: Machine): Promise<PeerSchedules[]> {
    const res = await laptop.api('GET', '/api/peers/schedules');
    expect(res.status).toBe(200);
    return (await res.json()) as PeerSchedules[];
  }

  it("the laptop sees the PC's schedules, named from its synced rows, and every change made there; never the prompt", async () => {
    const { pc, laptop, chatId, scheduleId } = await setup();
    await expect.poll(async () => (await shown(laptop))[0]?.schedules.length).toBe(1);
    const [machineView] = await shown(laptop);
    expect(machineView).toMatchObject({ nodeId: pc.id, name: 'PC', status: 'reachable', shared: true });
    expect(machineView!.schedules[0]).toMatchObject({
      id: scheduleId, name: 'Morning report', describe: 'Every day at 09:00', enabled: true, target: { kind: 'chat', chatId },
      targetName: 'Trip plans', profileName: 'Reporter', timeLimitMinutes: 120, running: false, lastRun: null, autoMode: false,
    });
    expect(machineView!.schedules[0]!.nextRunAt).toBeGreaterThan(Date.now());
    expect(JSON.stringify(machineView)).not.toContain('PROMPT-ONLY-ON-THE-PC');

    // Edited there: paused and renamed.
    expect((await pc.api('PATCH', `/api/schedules/${scheduleId}`, { name: 'Evening report', enabled: false })).status).toBe(200);
    await expect.poll(async () => (await shown(laptop))[0]?.schedules[0]?.name).toBe('Evening report');
    expect((await shown(laptop))[0]!.schedules[0]).toMatchObject({ enabled: false, nextRunAt: null });

    // Run there: the last run and its result arrive.
    expect((await pc.api('POST', `/api/schedules/${scheduleId}/run`)).status).toBe(202);
    await expect.poll(async () => (await shown(laptop))[0]?.schedules[0]?.lastRun?.status, { timeout: 15_000 }).toBe('complete');

    // Deleted there.
    expect((await pc.api('DELETE', `/api/schedules/${scheduleId}`)).status).toBe(204);
    await expect.poll(async () => (await shown(laptop))[0]?.schedules.length).toBe(0);
  }, 30_000);

  it("a schedule that goes with its chat on the PC goes from the laptop's list too", async () => {
    const { pc, laptop, chatId } = await setup();
    await expect.poll(async () => (await shown(laptop))[0]?.schedules.length).toBe(1);
    expect((await pc.api('DELETE', `/api/chats/${chatId}`)).status).toBe(204);
    await expect.poll(async () => (await shown(laptop))[0]?.schedules.length).toBe(0);
  }, 30_000);

  it("and so does one whose project is deleted there, which no schedule event announces (the syncer's change check does)", async () => {
    const { pc, laptop, profileId } = await setup();
    const project = (await (await pc.api('POST', '/api/projects', { name: 'Alpha' })).json()) as { id: string };
    const made = await pc.api('POST', '/api/schedules', { name: 'Weekly', prompt: 'x', profileId, target: { projectId: project.id }, rule: { cadence: 'weekly', time: '08:00', weekdays: [1] } });
    expect(made.status).toBe(201);
    await expect.poll(async () => (await shown(laptop))[0]?.schedules.map((s) => s.targetName).sort()).toEqual(['Alpha', 'Trip plans']);
    expect((await pc.api('DELETE', `/api/projects/${project.id}`)).status).toBe(204);
    await expect.poll(async () => (await shown(laptop))[0]?.schedules.map((s) => s.name)).toEqual(['Morning report']);
  }, 30_000);

  it("says when the PC isn't reachable instead of showing its last list", async () => {
    const { pc, laptop } = await setup();
    await expect.poll(async () => (await shown(laptop))[0]?.schedules.length).toBe(1);
    await pc.container.peers!.listener.stop();
    await expect.poll(async () => (await shown(laptop))[0]?.status).toBe('unreachable');
    expect((await shown(laptop))[0]).toMatchObject({ shared: false, schedules: [] });
  }, 30_000);

  it("while the PC doesn't let paired machines manage its schedules (the default), nothing on the peer listener runs, changes or lists one", async () => {
    const { pc, laptop, profileId, chatId, scheduleId } = await setup();
    expect(pc.container.store.settings.get().peerScheduleControl).toBe(false);
    await expect.poll(async () => (await shown(laptop))[0]?.schedules.length).toBe(1);
    expect((await shown(laptop))[0]).toMatchObject({ manage: false });
    const peers = laptop.container.peers!;
    const calls: { method: string; path: string; body?: unknown }[] = [
      { method: 'GET', path: '/api/schedules' },
      { method: 'POST', path: '/api/schedules', body: { name: 'Planted', prompt: 'x', profileId, target: { chatId }, rule: { cadence: 'daily', time: '09:00' } } },
      { method: 'PATCH', path: `/api/schedules/${scheduleId}`, body: { enabled: false, prompt: 'changed' } },
      { method: 'DELETE', path: `/api/schedules/${scheduleId}` },
      { method: 'POST', path: `/api/schedules/${scheduleId}/run` },
      { method: 'PUT', path: `/api/schedules/${scheduleId}`, body: { prompt: 'changed' } },
      { method: 'GET', path: `/api/schedules/${scheduleId}` },
      { method: 'GET', path: '/api/peers/schedules' },
      { method: 'GET', path: '/peer/schedules' },
      { method: 'POST', path: '/peer/schedules', body: { schedules: [] } },
      { method: 'POST', path: `/peer/schedules/${scheduleId}/run` },
      // Nor can the setting be turned on from there: there is no settings route on the listener.
      { method: 'PATCH', path: '/api/settings', body: { peerScheduleControl: true } },
      { method: 'GET', path: '/api/settings' },
    ];
    for (const call of calls) {
      const res = await peers.call(pc.id, call);
      // A write that isn't to a schedule is refused before routing while paired machines can't drive computer use
      // here (it names no chat this machine can tell, `PeerInfluence`), and would be a 404 after it.
      if (call.path === '/api/settings' && call.method !== 'GET') expect([403, 404], `${call.method} ${call.path}`).toContain(res.status);
      else expect(res.status, `${call.method} ${call.path}`).toBe(404);
    }
    const off = await peers.call(pc.id, calls[1]!);
    expect(off.body).toMatchObject({ kind: 'peer_schedules_off' });
    expect((off.body as { error: string }).error).toContain("PC doesn't let paired machines manage its schedules, so Laptop can't change them.");
    // With computer control switched on here, the writes get past that gate and are still refused.
    pc.container.store.settings.update({ peerComputerControl: true });
    for (const call of calls.filter((c) => c.method !== 'GET')) {
      expect((await peers.call(pc.id, call)).status, `${call.method} ${call.path} (computer control on)`).toBe(404);
    }
    // The laptop's own routes for the PC's schedules come back refused the same way.
    const own: [string, string, unknown?][] = [
      ['GET', `/api/peers/${pc.id}/schedules`],
      ['POST', `/api/peers/${pc.id}/schedules`, { name: 'Planted', prompt: 'x', profileId, target: { chatId }, rule: { cadence: 'daily', time: '09:00' } }],
      ['PATCH', `/api/peers/${pc.id}/schedules/${scheduleId}`, { enabled: false }],
      ['DELETE', `/api/peers/${pc.id}/schedules/${scheduleId}`],
      ['POST', `/api/peers/${pc.id}/schedules/${scheduleId}/run`],
    ];
    for (const [method, path, body] of own) {
      const res = await laptop.api(method, path, body);
      expect(res.status, `${method} ${path}`).toBe(404);
      expect(await res.json()).toMatchObject({ kind: 'peer_schedules_off' });
    }
    // And nothing changed on the PC, and nothing was recorded.
    const left = pc.container.store.schedules.list();
    expect(left.map((s) => [s.id, s.name, s.prompt, s.enabled])).toEqual([[scheduleId, 'Morning report', 'PROMPT-ONLY-ON-THE-PC', true]]);
    expect(pc.container.store.schedules.runs(scheduleId)).toEqual([]);
    expect(pc.container.store.schedules.peerChanges()).toEqual([]);
    expect(pc.container.store.settings.get().peerScheduleControl).toBe(false);
  }, 30_000);

  it("the laptop reads a PC schedule's run history, the list the PC's own History shows, whether or not it may manage it", async () => {
    const { pc, laptop, scheduleId } = await setup();
    const history = async (): Promise<Response> => laptop.api('GET', `/api/peers/${pc.id}/schedules/${scheduleId}/runs`);
    expect((await history()).status).toBe(200);
    expect(await (await history()).json()).toEqual([]);
    expect((await pc.api('POST', `/api/schedules/${scheduleId}/run`)).status).toBe(202);
    await expect.poll(() => pc.container.store.schedules.lastRun(scheduleId)?.status, { timeout: 15_000 }).toBe('complete');
    const here = (await (await pc.api('GET', `/api/schedules/${scheduleId}/runs`)).json()) as unknown[];
    expect(here).toHaveLength(1);
    expect(await (await history()).json()).toEqual(here);
    // Over the peer listener itself, too; an unknown schedule or machine is a 404.
    expect((await laptop.container.peers!.call(pc.id, { method: 'GET', path: `/api/schedules/${scheduleId}/runs` })).body).toEqual(here);
    expect((await laptop.api('GET', `/api/peers/${pc.id}/schedules/nope/runs`)).status).toBe(404);
    expect((await laptop.api('GET', `/api/peers/node-nobody/schedules/${scheduleId}/runs`)).status).toBe(404);
    // Reading changed nothing and recorded nothing.
    expect(pc.container.store.schedules.peerChanges()).toEqual([]);
    expect(pc.container.store.schedules.runs(scheduleId)).toHaveLength(1);
  }, 30_000);

  it('once the PC lets paired machines manage its schedules, the laptop runs, pauses, resumes, edits, deletes and makes them, each recorded with the laptop', async () => {
    const { pc, laptop, profileId, chatId, scheduleId } = await setup();
    // Turned on on the PC, in its own Settings.
    const on = await pc.api('PATCH', '/api/settings', { peerScheduleControl: true });
    expect(on.status).toBe(200);
    expect(((await on.json()) as { peerScheduleControl: boolean }).peerScheduleControl).toBe(true);
    await expect.poll(async () => (await shown(laptop))[0]?.manage).toBe(true);
    expect((await shown(laptop))[0]!.timezone).toBe(pc.container.store.schedules.get(scheduleId)!.timezone);
    const at = (path = ''): string => `/api/peers/${pc.id}/schedules${path}`;

    // The full list, prompt included, for editing.
    const listed = (await (await laptop.api('GET', at())).json()) as { id: string; prompt: string }[];
    expect(listed.map((s) => [s.id, s.prompt])).toEqual([[scheduleId, 'PROMPT-ONLY-ON-THE-PC']]);

    // Pause, resume, edit.
    expect((await laptop.api('PATCH', at(`/${scheduleId}`), { enabled: false })).status).toBe(200);
    expect(pc.container.store.schedules.get(scheduleId)).toMatchObject({ enabled: false, nextRunAt: null });
    await expect.poll(async () => (await shown(laptop))[0]?.schedules[0]?.enabled).toBe(false);
    expect((await laptop.api('PATCH', at(`/${scheduleId}`), { enabled: true })).status).toBe(200);
    expect(pc.container.store.schedules.get(scheduleId)!.nextRunAt).toBeGreaterThan(Date.now());
    const edited = await laptop.api('PATCH', at(`/${scheduleId}`), { name: 'Evening report', prompt: 'NEW PROMPT', rule: { cadence: 'daily', time: '18:00' }, timeLimitMinutes: 60 });
    expect(edited.status).toBe(200);
    expect(pc.container.store.schedules.get(scheduleId)).toMatchObject({ name: 'Evening report', prompt: 'NEW PROMPT', rule: { cadence: 'daily', time: '18:00' }, timeLimitMinutes: 60 });

    // The same checks as the PC's own API, with the same answers.
    const badRule = { name: 'Bad', prompt: 'x', profileId, target: { chatId }, rule: { cadence: 'cron', cron: '61 * * * *' } };
    const fromLaptop = await laptop.api('POST', at(), badRule);
    const fromPc = await pc.api('POST', '/api/schedules', badRule);
    expect(fromLaptop.status).toBe(400);
    expect(fromPc.status).toBe(400);
    expect(await fromLaptop.json()).toEqual(await fromPc.json());
    expect((await laptop.api('PATCH', at(`/${scheduleId}`), { target: { chatId } })).status).toBe(400);
    expect((await laptop.api('PATCH', at(`/${scheduleId}`), { timeLimitMinutes: 99_999 })).status).toBe(400);
    // A chat that runs on the laptop can't be a PC schedule's target: the PC pulls it first, then says so.
    const laptopChat = (await (await laptop.api('POST', '/api/chats', { profileId, title: 'Laptop chat' })).json()) as { id: string };
    const elsewhere = await laptop.api('POST', at(), { ...badRule, rule: { cadence: 'daily', time: '09:00' }, target: { chatId: laptopChat.id } });
    expect(elsewhere.status).toBe(400);
    expect(((await elsewhere.json()) as { error: string }).error).toContain('This chat runs on Laptop.');

    // Run now.
    const ran = await laptop.api('POST', at(`/${scheduleId}/run`));
    expect(ran.status).toBe(202);
    const runId = ((await ran.json()) as { id: string }).id;
    await expect.poll(() => pc.container.store.schedules.lastRun(scheduleId)?.status, { timeout: 15_000 }).toBe('complete');
    expect(pc.container.store.schedules.lastRun(scheduleId)).toMatchObject({ id: runId, trigger: 'manual' });

    // Make one in a project, then delete it.
    const project = (await (await pc.api('POST', '/api/projects', { name: 'Alpha' })).json()) as { id: string };
    await laptop.container.peers!.syncerOrNull()!.pullFrom(pc.id);
    const made = await laptop.api('POST', at(), { name: 'Weekly', prompt: 'Made on the laptop', profileId, target: { projectId: project.id }, rule: { cadence: 'weekly', time: '08:00', weekdays: [1] } });
    expect(made.status).toBe(201);
    const madeId = ((await made.json()) as { id: string }).id;
    // In the PC's zone, never the laptop's or the body's.
    expect(pc.container.store.schedules.get(madeId)).toMatchObject({ prompt: 'Made on the laptop', timezone: pc.container.store.schedules.get(scheduleId)!.timezone });
    expect((await laptop.api('DELETE', at(`/${madeId}`))).status).toBe(204);
    expect(pc.container.store.schedules.get(madeId)).toBeNull();
    expect((await laptop.api('DELETE', at('/nope'))).status).toBe(404);

    // Every change is recorded with the machine it came from; the refused ones aren't.
    expect(pc.container.store.schedules.peerChanges().map((c) => [c.action, c.scheduleName, c.fromNode])).toEqual([
      ['deleted', 'Weekly', laptop.id],
      ['created', 'Weekly', laptop.id],
      ['ran', 'Evening report', laptop.id],
      ['edited', 'Evening report', laptop.id],
      ['resumed', 'Morning report', laptop.id],
      ['paused', 'Morning report', laptop.id],
    ]);
    expect(pc.container.store.schedules.peerChanges(scheduleId).find((c) => c.action === 'ran')!.runId).toBe(runId);
    // The PC's own list says which machine last changed it.
    const rows = (await (await pc.api('GET', '/api/schedules')).json()) as { id: string; changedFrom?: { nodeId: string; machine: string; action: string } }[];
    expect(rows.find((r) => r.id === scheduleId)!.changedFrom).toMatchObject({ nodeId: laptop.id, machine: 'Laptop', action: 'ran' });

    // Turned off again on the PC: the next call is refused, and the laptop is told.
    expect((await pc.api('PATCH', '/api/settings', { peerScheduleControl: false })).status).toBe(200);
    await expect.poll(async () => (await shown(laptop))[0]?.manage).toBe(false);
    expect((await laptop.api('PATCH', at(`/${scheduleId}`), { enabled: false })).status).toBe(404);
    expect((await laptop.api('POST', at(`/${scheduleId}/run`))).status).toBe(404);
    expect(pc.container.store.schedules.get(scheduleId)!.enabled).toBe(true);
    expect(pc.container.store.schedules.peerChanges()).toHaveLength(6);
    // The history stays readable.
    expect((await laptop.api('GET', at(`/${scheduleId}/runs`))).status).toBe(200);
  }, 60_000);

  it('ownSchedules leaves out the prompt, the warnings and the run in progress', async () => {
    const { pc } = await setup();
    const [s] = ownSchedules(pc.container.store, pc.container.schedules);
    expect(Object.keys(s!).sort()).toEqual(['autoMode', 'describe', 'enabled', 'id', 'invalid', 'lastRun', 'name', 'nextRunAt', 'profileId', 'running', 'target', 'timeLimitMinutes', 'timezone']);
  }, 30_000);
});
