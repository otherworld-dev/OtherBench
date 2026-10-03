import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MEMORY_FORMAT_ERROR, MEMORY_QUIET_MS, emptyMemoryBody } from '@grunt/core/domain/memory.js';
import { TurnRunner } from '@grunt/core/domain/turn.js';
import type { ChatEngine, EngineEvent, EngineRequest } from '@grunt/core/ports/chat-engine.js';
import { FakeSecretStore, InMemoryStore } from '@grunt/core/testing/fakes.js';
import { createBlobStore } from '@grunt/store-sqlite/blob-store.js';
import { createApp } from '../../src/app.js';
import type { Container } from '../../src/container.js';
import { ProjectMemoryService } from '../../src/memory/service.js';
import { resolveProfile } from '../../src/profile-resolution.js';
import { StreamRegistry } from '../../src/stream/registry.js';
import { ManualClock } from '../memory/manual-clock.js';

const ZERO = { tokensIn: 0, tokensOut: 0, tokensCached: 0, tokensReasoning: 0 };
const reply = (text: string): EngineEvent[] => [{ type: 'text-delta', text }, { type: 'finish', usage: ZERO, finishReason: 'stop' }];

function note({ pinned = '', goals = '' }: { pinned?: string; goals?: string } = {}): string {
  return [`## Pinned${pinned ? `\n${pinned}` : ''}`, `## Goals${goals ? `\n${goals}` : ''}`, '## Decisions', '## Current focus', '## Open questions'].join('\n\n');
}

let container: Container;
let dataDir: string;
let clock: ManualClock;
/** Answers both chat turns and memory updates; tests swap it. */
let respond: (req: EngineRequest) => EngineEvent[];

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'grunt-memory-route-test-'));
  const store = new InMemoryStore();
  respond = () => reply(note({ goals: '- From the model' }));
  const engine: ChatEngine = {
    async *stream(req) {
      for (const event of respond(req)) {
        if (req.signal.aborted) return;
        yield event;
      }
    },
    listModels: async () => [],
    testConnection: async () => ({ ok: true, message: 'ok', latencyMs: 0 }),
  };
  const turnRunner = new TurnRunner(store, engine);
  clock = new ManualClock();
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
  const memory = new ProjectMemoryService({ store, engine, resolveProfile: (id) => resolveProfile(container, id), now: clock.now, scheduler: clock });
  memory.attach(turnRunner);
  container.memory = memory;

  store.connections.create({ id: 'conn-1', name: 'Conn', kind: 'mock', baseUrl: null, secretRef: null, extraHeaders: {}, status: 'unknown', statusMessage: null, checkedAt: null });
  store.profiles.create({
    id: 'profile-1',
    name: 'Profile One',
    description: null,
    colour: null,
    connectionId: 'conn-1',
    modelId: 'model-1',
    systemPrompt: null,
    params: {},
    toolPolicy: { fs: 'off', shell: false, mcpServerIds: [], approvalMode: 'always_ask' },
    isDefault: true,
    archivedAt: null,
  });
  store.projects.create({ id: 'proj', name: 'Alpha', workspaceRoot: null, defaultProfileId: null });
  store.projects.create({ id: 'proj-2', name: 'Beta', workspaceRoot: null, defaultProfileId: null });
  for (const [id, projectId] of [['chat-1', 'proj'], ['loose', null]] as const) {
    store.chats.create({ id, title: id, profileId: 'profile-1', headMessageId: null, workspaceRoot: null, pinned: false, archivedAt: null, projectId });
  }
});

afterEach(async () => {
  container.memory?.dispose();
  await rm(dataDir, { recursive: true, force: true });
});

function send(method: string, path: string, body?: unknown): Promise<Response> {
  return Promise.resolve(
    createApp(container).request(path, {
      method,
      headers: { 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  );
}

async function json<T = Record<string, unknown>>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

/** One completed exchange in chat-1, with the head parked on the user message. */
function exchange(text: string): void {
  const { store } = container;
  const tip = store.chats.get('chat-1')!.headMessageId;
  const parentId = tip ? (store.messages.children(tip)[0]?.id ?? null) : null;
  const userId = `u-${text}`;
  store.messages.create({ id: userId, chatId: 'chat-1', parentId, role: 'user', parts: [{ type: 'text', text }], status: 'complete', error: null, producedBy: null });
  store.messages.create({
    id: `a-${text}`,
    chatId: 'chat-1',
    parentId: userId,
    role: 'assistant',
    parts: [{ type: 'text', text: 'ok' }],
    status: 'complete',
    error: null,
    producedBy: { profileId: 'profile-1', profileName: 'Profile One', connectionId: 'conn-1', modelId: 'model-1' },
  });
  store.chats.update('chat-1', { headMessageId: userId });
}

describe('GET/PUT /api/projects/:id/memory', () => {
  it('a new project has the empty note, never saved, and no failure', async () => {
    const res = await send('GET', '/api/projects/proj/memory');
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({
      memory: { projectId: 'proj', body: emptyMemoryBody(), updatedAt: 0, updatedBy: 'user', sourceChatId: null },
      lastError: null,
    });
  });

  it('404s for an unknown project', async () => {
    expect((await send('GET', '/api/projects/nope/memory')).status).toBe(404);
    expect((await send('PUT', '/api/projects/nope/memory', { body: note() })).status).toBe(404);
    expect((await send('GET', '/api/projects/nope/memory/versions')).status).toBe(404);
  });

  it('PUT saves the note as the user, normalised, and the user may edit Pinned (review focus 4)', async () => {
    const typed = '## pinned\r\n- Keep v1\r\n\r\n## Goals\r\n- Ship\r\n\r\n## Decisions\r\n\r\n## Current Focus  \r\n\r\n## Open questions\r\n';
    const res = await send('PUT', '/api/projects/proj/memory', { body: typed });
    expect(res.status).toBe(200);
    const view = await json<{ memory: Record<string, unknown> }>(res);
    expect(view.memory).toMatchObject({ projectId: 'proj', body: note({ pinned: '- Keep v1', goals: '- Ship' }), updatedBy: 'user', sourceChatId: null });
    expect(container.store.projectMemory.versions('proj')).toHaveLength(1);
  });

  it('PUT with the note unchanged adds no version', async () => {
    await send('PUT', '/api/projects/proj/memory', { body: note({ goals: '- Ship' }) });
    await send('PUT', '/api/projects/proj/memory', { body: note({ goals: '- Ship' }) });
    expect(container.store.projectMemory.versions('proj')).toHaveLength(1);
  });

  it('PUT rejects wrong headings, a note over 4,000 characters, or a missing body, and saves nothing', async () => {
    const cases: [unknown, string][] = [
      [{ body: '## Goals\n- Only goals' }, MEMORY_FORMAT_ERROR],
      [{ body: note({ goals: 'x'.repeat(4_000) }) }, `The note is ${note({ goals: 'x'.repeat(4_000) }).length.toLocaleString('en-US')} characters; the limit is 4,000.`],
      [{ body: '' }, 'The note is empty.'],
      [{}, '"body" is required and must be a string.'],
      [{ body: 7 }, '"body" is required and must be a string.'],
    ];
    for (const [body, message] of cases) {
      const res = await send('PUT', '/api/projects/proj/memory', body);
      expect(res.status).toBe(400);
      expect(await json(res)).toEqual({ error: message });
    }
    expect(container.store.projectMemory.get('proj')).toBeNull();
  });
});

describe('memory versions', () => {
  it('lists versions newest first with their length, returns one in full, and 404s a version of another project', async () => {
    container.store.projectMemory.save('proj', note({ goals: '- One' }), 'user', null, 1000);
    container.store.projectMemory.save('proj', note({ goals: '- Two' }), 'summariser', 'chat-1', 2000);
    container.store.projectMemory.save('proj-2', note(), 'user', null, 1500);

    const list = await json<Record<string, unknown>[]>(await send('GET', '/api/projects/proj/memory/versions'));
    expect(list.map((v) => [v['createdAt'], v['createdBy'], v['sourceChatId'], v['length']])).toEqual([
      [2000, 'summariser', 'chat-1', note({ goals: '- Two' }).length],
      [1000, 'user', null, note({ goals: '- One' }).length],
    ]);
    expect(Object.keys(list[0]!).sort()).toEqual(['createdAt', 'createdBy', 'id', 'length', 'sourceChatId']);

    const one = await send('GET', `/api/projects/proj/memory/versions/${list[1]!['id'] as string}`);
    expect(one.status).toBe(200);
    expect(await json(one)).toMatchObject({ projectId: 'proj', body: note({ goals: '- One' }), createdBy: 'user' });

    const otherId = container.store.projectMemory.versions('proj-2')[0]!.id;
    expect((await send('GET', `/api/projects/proj/memory/versions/${otherId}`)).status).toBe(404);
    expect((await send('GET', '/api/projects/proj/memory/versions/nope')).status).toBe(404);
  });

  it('restore saves that version as a new user version', async () => {
    container.store.projectMemory.save('proj', note({ goals: '- One' }), 'user', null, 1000);
    container.store.projectMemory.save('proj', note({ goals: '- Two' }), 'summariser', 'chat-1', 2000);
    const oldest = container.store.projectMemory.versions('proj')[1]!;

    const res = await send('POST', `/api/projects/proj/memory/versions/${oldest.id}/restore`);

    expect(res.status).toBe(200);
    expect((await json<{ memory: Record<string, unknown> }>(res)).memory).toMatchObject({ body: note({ goals: '- One' }), updatedBy: 'user', sourceChatId: null });
    expect(container.store.projectMemory.versions('proj')).toHaveLength(3);
    expect((await send('POST', '/api/projects/proj-2/memory/versions/' + oldest.id + '/restore')).status).toBe(404);
  });
});

describe('POST /api/chats/:id/memory/update', () => {
  it('runs the update now and returns what it did', async () => {
    exchange('We chose SQLite');
    const res = await send('POST', '/api/chats/chat-1/memory/update');
    expect(res.status).toBe(200);
    expect(await json(res)).toMatchObject({ status: 'updated', memory: { body: note({ goals: '- From the model' }), updatedBy: 'summariser', sourceChatId: 'chat-1' } });
    expect((await json<{ memory: Record<string, unknown> }>(await send('GET', '/api/projects/proj/memory'))).memory['body']).toBe(note({ goals: '- From the model' }));
  });

  it("409s for a chat outside a project or one that doesn't add to memory; 404s an unknown chat", async () => {
    const loose = await send('POST', '/api/chats/loose/memory/update');
    expect(loose.status).toBe(409);
    expect(await json(loose)).toEqual({ error: "This chat isn't in a project." });

    container.store.chats.update('chat-1', { memoryExcluded: true });
    const excluded = await send('POST', '/api/chats/chat-1/memory/update');
    expect(excluded.status).toBe(409);
    expect(await json(excluded)).toEqual({ error: 'This chat is set to not add to project memory.' });

    expect((await send('POST', '/api/chats/nope/memory/update')).status).toBe(404);
  });

  it('a failed update shows up as lastError in GET memory, and clears after a success', async () => {
    exchange('We chose SQLite');
    respond = () => reply('not a note');
    expect(await json(await send('POST', '/api/chats/chat-1/memory/update'))).toMatchObject({ status: 'failed' });
    const view = await json<{ lastError: Record<string, unknown> | null }>(await send('GET', '/api/projects/proj/memory'));
    expect(view.lastError).toEqual({ message: `The memory model's note was rejected: ${MEMORY_FORMAT_ERROR}`, at: clock.time, chatId: 'chat-1' });

    respond = () => reply(note({ goals: '- Fixed' }));
    await send('POST', '/api/chats/chat-1/memory/update');
    expect((await json<{ lastError: unknown }>(await send('GET', '/api/projects/proj/memory'))).lastError).toBeNull();
  });

  it('503s when the memory service is not running', async () => {
    delete container.memory;
    const res = await send('POST', '/api/chats/chat-1/memory/update');
    expect(res.status).toBe(503);
    expect(await json(res)).toEqual({ error: "Project memory isn't running on this server." });
  });
});

describe('chat and turn hooks', () => {
  it("starting a turn cancels the chat's quiet timer, and its reply starts a fresh one", async () => {
    const memory = container.memory!;
    const started = vi.spyOn(memory, 'noteTurnStarted');
    memory.noteTurnCompleted('chat-1');
    clock.advance(60_000);

    const res = await send('POST', '/api/chats/chat-1/turns', { parts: [{ type: 'text', text: 'hi' }], profileIds: ['profile-1'] });

    expect(res.status).toBe(202);
    expect(started).toHaveBeenCalledWith('chat-1');
    const { assistantMessageIds } = await json<{ assistantMessageIds: string[] }>(res);
    await vi.waitFor(() => expect(container.store.messages.get(assistantMessageIds[0]!)!.status).toBe('complete'));
    expect(clock.pending()).toEqual([MEMORY_QUIET_MS]);
  });

  it('a retried reply counts as a new turn too', async () => {
    const started = vi.spyOn(container.memory!, 'noteTurnStarted');
    respond = () => [{ type: 'error', error: { kind: 'transient', message: 'boom', retryable: true } }];
    const res = await send('POST', '/api/chats/chat-1/turns', { parts: [{ type: 'text', text: 'hi' }], profileIds: ['profile-1'] });
    const { assistantMessageIds } = await json<{ assistantMessageIds: string[] }>(res);
    const id = assistantMessageIds[0]!;
    await vi.waitFor(() => expect(container.store.messages.get(id)!.status).toBe('error'));

    respond = () => reply('fine now');
    expect((await send('POST', `/api/messages/${id}/retry`)).status).toBe(202);
    expect(started).toHaveBeenCalledTimes(2);
    expect(started).toHaveBeenLastCalledWith('chat-1');
  });

  it("excluding a chat, moving it, or deleting it drops its quiet timer", async () => {
    const memory = container.memory!;
    memory.noteTurnCompleted('chat-1');
    expect((await send('PATCH', '/api/chats/chat-1', { memoryExcluded: true })).status).toBe(200);
    expect(clock.pending()).toEqual([]);

    container.store.chats.update('chat-1', { memoryExcluded: false });
    memory.noteTurnCompleted('chat-1');
    await send('PATCH', '/api/chats/chat-1', { projectId: 'proj-2' });
    expect(clock.pending()).toEqual([]);

    memory.noteTurnCompleted('chat-1');
    expect(clock.pending()).toEqual([MEMORY_QUIET_MS]);
    expect((await send('DELETE', '/api/chats/chat-1')).status).toBe(204);
    expect(clock.pending()).toEqual([]);
  });
});
