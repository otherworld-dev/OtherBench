import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MAX_SCHEDULE_ATTACHMENTS } from '@otherbench/core/domain/schedule.js';
import { TurnRunner } from '@otherbench/core/domain/turn.js';
import { FakeChatEngine, FakeSecretStore, InMemoryStore } from '@otherbench/core/testing/fakes.js';
import type { PublicScheduleAttachment, ScheduleView } from '@otherbench/core/ports/store.js';
import { sweepOrphanedBlobs } from '@otherbench/store-sqlite/blob-gc.js';
import { createBlobStore } from '@otherbench/store-sqlite/blob-store.js';
import { createApp } from '../../src/app.js';
import type { Container } from '../../src/container.js';
import { forwardedApi } from '../../src/peer/forward.js';
import { StreamRegistry } from '../../src/stream/registry.js';

let container: Container;
let dataDir: string;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'otherbench-schedule-attachments-test-'));
  const store = new InMemoryStore();
  const engine = new FakeChatEngine([]);
  const turnRunner = new TurnRunner(store, engine);
  container = {
    store,
    secrets: new FakeSecretStore(),
    engine,
    registry: {} as never,
    toolProvider: {} as never,
    mcpManager: {} as never,
    turnRunner,
    streamRegistry: new StreamRegistry(turnRunner, store),
    blobStore: createBlobStore(join(dataDir, 'attachments')),
    close: () => {},
  };
  store.connections.create({ id: 'conn', name: 'Mock', kind: 'mock', baseUrl: null, secretRef: null, extraHeaders: {}, status: 'unknown', statusMessage: null, checkedAt: null });
  store.profiles.create({
    id: 'p1', name: 'Mock', description: null, colour: null, connectionId: 'conn', modelId: 'm', systemPrompt: null, params: {},
    toolPolicy: { fs: 'off', shell: false, mcpServerIds: [], approvalMode: 'always_ask' }, isDefault: true, archivedAt: null,
  });
  store.chats.create({ id: 'chat-1', title: 'Chat', profileId: 'p1', headMessageId: null, workspaceRoot: null, pinned: false, archivedAt: null });
  store.projects.create({ id: 'proj', name: 'Alpha', workspace: null, defaultProfileId: null });
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

const api = (path: string, init?: RequestInit) => createApp(container).request(`/api${path}`, init);

async function makeSchedule(target: Record<string, string> = { chatId: 'chat-1' }): Promise<ScheduleView> {
  const res = await api('/schedules', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Report', prompt: 'hello', profileId: 'p1', target, rule: { cadence: 'daily', time: '09:00' }, enabled: false }),
  });
  expect(res.status).toBe(201);
  return (await res.json()) as ScheduleView;
}

async function upload(scheduleId: string, filename: string, content: string, mime: string): Promise<Response> {
  const form = new FormData();
  form.append('file', new File([content], filename, { type: mime }));
  return api(`/schedules/${scheduleId}/attachments`, { method: 'POST', body: form });
}

async function uploaded(scheduleId: string, filename: string, content: string, mime = 'text/plain'): Promise<PublicScheduleAttachment> {
  const res = await upload(scheduleId, filename, content, mime);
  expect(res.status).toBe(201);
  return (await res.json()) as PublicScheduleAttachment;
}

const blobPath = (sha256: string): string => join(dataDir, 'attachments', sha256.slice(0, 2), sha256);
const exists = (path: string): Promise<boolean> => stat(path).then(() => true, () => false);

describe('schedule attachments', () => {
  it('uploads a file to a schedule, reads its text, lists it on the schedule without its server path, and keeps the blob through a GC sweep', async () => {
    const s = await makeSchedule();
    const file = await uploaded(s.id, 'notes.txt', 'hello world');
    expect(file).toMatchObject({ scheduleId: s.id, filename: 'notes.txt', mime: 'text/plain', size: 11 });
    expect(file).not.toHaveProperty('storagePath');
    expect(file).not.toHaveProperty('extractedText');
    expect(container.store.schedules.getAttachment(file.id)!.extractedText).toBe('hello world');

    const list = (await (await api('/schedules')).json()) as ScheduleView[];
    expect(list[0]!.attachments).toEqual([file]);
    expect(list[0]!.attachments[0]).not.toHaveProperty('storagePath');

    // Nothing in any chat holds the blob, only the schedule: the sweep keeps it.
    await sweepOrphanedBlobs(container.store, container.blobStore);
    expect(await exists(blobPath(file.sha256))).toBe(true);
  });

  it(`refuses an unknown schedule, a missing file, and a file past the ${MAX_SCHEDULE_ATTACHMENTS}th`, async () => {
    const s = await makeSchedule();
    expect((await upload('nope', 'a.txt', 'a', 'text/plain')).status).toBe(404);
    const empty = await api(`/schedules/${s.id}/attachments`, { method: 'POST', body: new FormData() });
    expect(empty.status).toBe(400);
    for (let i = 0; i < MAX_SCHEDULE_ATTACHMENTS; i++) await uploaded(s.id, `f${i}.txt`, `file ${i}`);
    const extra = await upload(s.id, 'one-more.txt', 'extra', 'text/plain');
    expect(extra.status).toBe(409);
    expect(((await extra.json()) as { error: string }).error).toBe(`A schedule can carry at most ${MAX_SCHEDULE_ATTACHMENTS} files.`);
    expect(container.store.schedules.attachments(s.id)).toHaveLength(MAX_SCHEDULE_ATTACHMENTS);
  });

  it('deletes an attachment, and its blob once nothing else holds it; another schedule\'s attachment is a 404', async () => {
    const a = await makeSchedule();
    const b = await makeSchedule({ projectId: 'proj' });
    const onA = await uploaded(a.id, 'same.txt', 'shared bytes');
    const onB = await uploaded(b.id, 'same.txt', 'shared bytes');
    expect(onA.sha256).toBe(onB.sha256);

    expect((await api(`/schedules/${a.id}/attachments/${onB.id}`, { method: 'DELETE' })).status).toBe(404);
    expect((await api(`/schedules/${a.id}/attachments/${onA.id}`, { method: 'DELETE' })).status).toBe(204);
    expect(container.store.schedules.getAttachment(onA.id)).toBeNull();
    expect(await exists(blobPath(onA.sha256))).toBe(true);
    expect((await api(`/schedules/${b.id}/attachments/${onB.id}`, { method: 'DELETE' })).status).toBe(204);
    expect(await exists(blobPath(onB.sha256))).toBe(false);
  });

  it("releases a schedule's blobs when the schedule is deleted, or its project, but not one a chat attachment still holds", async () => {
    const s = await makeSchedule();
    const own = await uploaded(s.id, 'own.txt', 'only the schedule');
    const shared = await uploaded(s.id, 'shared.txt', 'also in a chat');
    const form = new FormData();
    form.append('file', new File(['also in a chat'], 'shared.txt', { type: 'text/plain' }));
    expect((await api('/chats/chat-1/attachments', { method: 'POST', body: form })).status).toBe(201);

    expect((await api(`/schedules/${s.id}`, { method: 'DELETE' })).status).toBe(204);
    expect(await exists(blobPath(own.sha256))).toBe(false);
    expect(await exists(blobPath(shared.sha256))).toBe(true);

    const onProject = await makeSchedule({ projectId: 'proj' });
    const file = await uploaded(onProject.id, 'p.txt', 'project schedule file');
    expect((await api('/projects/proj', { method: 'DELETE' })).status).toBe(204);
    expect(container.store.schedules.get(onProject.id)).toBeNull();
    expect(await exists(blobPath(file.sha256))).toBe(false);
  });

  it('has no attachment routes on the peer listener', async () => {
    const s = await makeSchedule();
    const form = new FormData();
    form.append('file', new File(['x'], 'x.txt', { type: 'text/plain' }));
    expect((await forwardedApi(container).request(`/schedules/${s.id}/attachments`, { method: 'POST', body: form })).status).toBe(404);
    expect(container.store.schedules.attachments(s.id)).toEqual([]);
  });
});
