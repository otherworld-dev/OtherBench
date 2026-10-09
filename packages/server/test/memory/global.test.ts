import { beforeEach, describe, expect, it, vi } from 'vitest';
import { emptyGlobalMemoryBody } from '@grunt/core/domain/global-memory.js';
import { MEMORY_QUIET_MS } from '@grunt/core/domain/memory.js';
import type { ChatEngine, EngineEvent, EngineRequest } from '@grunt/core/ports/chat-engine.js';
import { InMemoryStore } from '@grunt/core/testing/fakes.js';
import type { Profile, ResolvedProfile } from '@grunt/core/types/config.js';
import { GlobalMemoryService, NO_GLOBAL_MEMORY_MODEL_MESSAGE, type GlobalMemoryServiceDeps } from '../../src/memory/global.js';
import { MemoryServices } from '../../src/memory/index.js';
import { ProjectMemoryService } from '../../src/memory/service.js';
import { MemoryQueue } from '../../src/memory/shared.js';
import { ManualClock } from './manual-clock.js';

const ZERO = { tokensIn: 0, tokensOut: 0, tokensCached: 0, tokensReasoning: 0 };
const reply = (text: string): EngineEvent[] => [{ type: 'text-delta', text }, { type: 'finish', usage: ZERO, finishReason: 'stop' }];

/** A learned note in the fixed format; empty sections render as a bare heading. */
function gnote({ pinned = '', prefs = '- British English' }: { pinned?: string; prefs?: string } = {}): string {
  return [`## Pinned${pinned ? `\n${pinned}` : ''}`, `## Preferences${prefs ? `\n${prefs}` : ''}`, '## Setup and tools', '## Working style'].join('\n\n');
}

const PROJECT_NOTE = '## Pinned\n\n## Goals\n- Ship\n\n## Decisions\n\n## Current focus\n\n## Open questions';

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

function profileRow(id: string, over: Partial<Profile> = {}): Profile {
  return {
    id,
    name: id,
    description: null,
    colour: null,
    connectionId: 'conn',
    modelId: 'm',
    systemPrompt: null,
    params: {},
    toolPolicy: { fs: 'off', shell: false, mcpServerIds: [], approvalMode: 'always_ask' },
    isDefault: false,
    archivedAt: null,
    ...over,
  };
}

let store: InMemoryStore;
let clock: ManualClock;
let respond: (req: EngineRequest) => EngineEvent[] | Promise<EngineEvent[]>;
let requests: EngineRequest[];
let tips: Map<string, string>;
let seq: number;

const engine: ChatEngine = {
  async *stream(req) {
    requests.push(req);
    const events = await respond(req);
    for (const event of events) {
      if (req.signal.aborted) return;
      yield event;
    }
  },
  listModels: async () => [],
  testConnection: async () => ({ ok: true, message: 'ok', latencyMs: 0 }),
};

const resolveProfile = async (id: string): Promise<ResolvedProfile> => {
  const profile = store.profiles.get(id);
  if (!profile) throw new Error(`cannot resolve ${id}`);
  return { ...profile, connection: store.connections.get(profile.connectionId)!, apiKey: null, model: null };
};

function makeService(over: Partial<GlobalMemoryServiceDeps> = {}): GlobalMemoryService {
  return new GlobalMemoryService({ store, engine, resolveProfile, now: clock.now, scheduler: clock, ...over });
}

function addChat(id: string, over: { projectId?: string | null; memoryExcluded?: boolean; runsOn?: string } = {}): void {
  store.chats.create({
    id,
    title: `Chat ${id}`,
    profileId: 'p-app',
    headMessageId: null,
    workspaceRoot: null,
    pinned: false,
    archivedAt: null,
    projectId: over.projectId === undefined ? null : over.projectId,
    memoryExcluded: over.memoryExcluded ?? false,
    ...(over.runsOn ? { runsOn: over.runsOn } : {}),
  });
}

function exchange(chatId: string, user: string, assistant: string, at = clock.time): { userId: string; replyId: string } {
  seq += 1;
  const userId = `${chatId}-u${seq}`;
  const replyId = `${chatId}-a${seq}`;
  store.messages.create({ id: userId, chatId, parentId: tips.get(chatId) ?? null, role: 'user', parts: [{ type: 'text', text: user }], status: 'complete', error: null, producedBy: null, createdAt: at });
  store.messages.create({
    id: replyId,
    chatId,
    parentId: userId,
    role: 'assistant',
    parts: [{ type: 'text', text: assistant }],
    status: 'complete',
    error: null,
    producedBy: { profileId: 'p-app', profileName: 'App', connectionId: 'conn', modelId: 'm' },
    createdAt: at + 1,
  });
  store.chats.update(chatId, { headMessageId: userId });
  tips.set(chatId, replyId);
  return { userId, replyId };
}

function promptOf(req: EngineRequest | undefined): string {
  const part = req?.messages[0]?.parts[0];
  return part?.type === 'text' ? part.text : '';
}

beforeEach(() => {
  store = new InMemoryStore();
  clock = new ManualClock();
  respond = () => reply(gnote());
  requests = [];
  tips = new Map();
  seq = 0;
  store.connections.create({ id: 'conn', name: 'Local', kind: 'ollama', baseUrl: null, secretRef: null, extraHeaders: {}, status: 'unknown', statusMessage: null, checkedAt: null });
  store.profiles.create(profileRow('p-app', { isDefault: true }));
  store.profiles.create(profileRow('p-project'));
  store.profiles.create(profileRow('p-memory'));
  store.projects.create({ id: 'proj', name: 'Alpha', workspaceRoot: null, defaultProfileId: 'p-project' });
});

describe('global memory: quiet timer', () => {
  it("folds a chat's new turns into the global note 5 minutes after its last reply, in a project or not", async () => {
    const service = makeService();
    addChat('loose');
    addChat('in-proj', { projectId: 'proj' });
    const loose = exchange('loose', 'I use Windows 11', 'Noted');
    exchange('in-proj', 'I prefer British English', 'Noted');
    service.noteTurnCompleted('loose');
    service.noteTurnCompleted('in-proj');

    clock.advance(MEMORY_QUIET_MS - 1);
    await service.idle();
    expect(requests).toHaveLength(0);

    clock.advance(1);
    await service.idle();
    expect(requests).toHaveLength(2);
    expect(store.globalMemory.get()).toMatchObject({ note: gnote(), noteUpdatedBy: 'summariser' });
    expect(store.chats.get('loose')!.globalMemoryCursor).toBe(loose.replyId);
  });

  it('starts no timer for a chat excluded from memory, or one that runs on another machine', () => {
    const service = makeService();
    addChat('private', { memoryExcluded: true });
    addChat('elsewhere', { runsOn: 'laptop' });
    service.noteTurnCompleted('private');
    service.noteTurnCompleted('elsewhere');
    service.noteTurnCompleted('no-such-chat');
    expect(clock.pending()).toEqual([]);
  });
});

describe('global memory: an update', () => {
  it('sends the current note and the new turns as one tool-less utility call, and leaves the project cursor alone', async () => {
    const service = makeService();
    addChat('chat', { projectId: 'proj' });
    store.chats.update('chat', { memoryCursor: 'kept' });
    const { replyId } = exchange('chat', 'I moved to Linux', 'Noted');
    service.noteTurnCompleted('chat');
    clock.advance(MEMORY_QUIET_MS);
    await service.idle();

    expect(requests[0]).toMatchObject({ tools: [], purpose: 'utility' });
    expect(promptOf(requests[0])).toContain(`<current-note>\n${emptyGlobalMemoryBody()}\n</current-note>`);
    expect(promptOf(requests[0])).toContain('User: I moved to Linux');
    expect(store.chats.get('chat')).toMatchObject({ globalMemoryCursor: replyId, memoryCursor: 'kept' });
  });

  it("keeps the user's ## Pinned exactly, even when the model rewrites it", async () => {
    store.globalMemory.saveNote(gnote({ pinned: '- Windows 11' }), 'user', null);
    respond = () => reply(gnote({ pinned: '- macOS', prefs: '- Concise answers' }));
    const service = makeService();
    addChat('chat');
    exchange('chat', 'Keep it short', 'ok');
    service.noteTurnCompleted('chat');
    clock.advance(MEMORY_QUIET_MS);
    await service.idle();
    expect(store.globalMemory.get().note).toBe(gnote({ pinned: '- Windows 11', prefs: '- Concise answers' }));
  });

  it("refuses a note in project memory's format and records why; the next good update clears it", async () => {
    respond = () => reply(PROJECT_NOTE);
    const service = makeService();
    addChat('chat');
    exchange('chat', 'hi', 'ok');
    service.noteTurnCompleted('chat');
    clock.advance(MEMORY_QUIET_MS);
    await service.idle();
    expect(store.globalMemory.get().noteUpdatedAt).toBe(0);
    expect(service.lastError()).toMatchObject({ chatId: 'chat' });
    expect(service.lastError()!.message).toMatch(/rejected/);

    respond = () => reply(gnote());
    exchange('chat', 'again', 'ok');
    service.noteTurnCompleted('chat');
    clock.advance(MEMORY_QUIET_MS);
    await service.idle();
    expect(service.lastError()).toBeNull();
  });

  it('discards its result when the user saves the note while it runs: the user save wins', async () => {
    const gate = deferred<EngineEvent[]>();
    respond = () => gate.promise;
    const service = makeService();
    addChat('chat');
    exchange('chat', 'hi', 'ok');
    service.noteTurnCompleted('chat');
    clock.advance(MEMORY_QUIET_MS);
    await Promise.resolve();
    await Promise.resolve();

    store.globalMemory.saveNote(gnote({ prefs: '- Mine' }), 'user', null);
    gate.resolve(reply(gnote({ prefs: '- Model' })));
    await service.idle();
    expect(store.globalMemory.get()).toMatchObject({ note: gnote({ prefs: '- Mine' }), noteUpdatedBy: 'user' });
  });
});

describe('global memory: which model runs it', () => {
  it('uses the Memory model setting, else the app default, never a project default', async () => {
    const service = makeService();
    addChat('chat', { projectId: 'proj' });
    exchange('chat', 'hi', 'ok');
    service.noteTurnCompleted('chat');
    clock.advance(MEMORY_QUIET_MS);
    await service.idle();
    expect(requests[0]!.profile.id).toBe('p-app');

    store.settings.update({ memoryProfileId: 'p-memory' });
    exchange('chat', 'again', 'ok');
    service.noteTurnCompleted('chat');
    clock.advance(MEMORY_QUIET_MS);
    await service.idle();
    expect(requests[1]!.profile.id).toBe('p-memory');
  });

  it('records why and calls nothing when no profile is usable', async () => {
    for (const id of ['p-app', 'p-project', 'p-memory']) store.profiles.update(id, { archivedAt: 1 });
    const service = makeService();
    addChat('chat');
    exchange('chat', 'hi', 'ok');
    service.noteTurnCompleted('chat');
    clock.advance(MEMORY_QUIET_MS);
    await service.idle();
    expect(requests).toHaveLength(0);
    expect(service.lastError()!.message).toBe(NO_GLOBAL_MEMORY_MODEL_MESSAGE);
  });
});

describe('global memory: startup sweep', () => {
  it('queues chats whose last reply is over 5 minutes old, times the rest, and skips up-to-date and excluded chats', async () => {
    addChat('old');
    addChat('recent');
    addChat('done');
    addChat('private', { memoryExcluded: true });
    exchange('old', 'a', 'b', clock.time - MEMORY_QUIET_MS - 10);
    exchange('recent', 'a', 'b', clock.time - 60_000);
    const { replyId } = exchange('done', 'a', 'b', clock.time - MEMORY_QUIET_MS - 10);
    store.chats.update('done', { globalMemoryCursor: replyId });
    exchange('private', 'a', 'b', clock.time - MEMORY_QUIET_MS - 10);

    const service = makeService();
    service.sweep();
    await service.idle();
    expect(requests.map((r) => r.chatId)).toEqual(['old']);
    expect(clock.pending()).toHaveLength(1);
  });
});

describe('memory services together', () => {
  it('a quiet project chat updates its project note and then the global note, one call at a time', async () => {
    const gates: { resolve: (events: EngineEvent[]) => void }[] = [];
    respond = (req) => {
      const gate = deferred<EngineEvent[]>();
      gates.push(gate);
      void req;
      return gate.promise;
    };
    const queue = new MemoryQueue();
    const project = new ProjectMemoryService({ store, engine, resolveProfile, now: clock.now, scheduler: clock, queue });
    const memory = new MemoryServices(project, makeService({ queue }));
    addChat('chat', { projectId: 'proj' });
    exchange('chat', 'hi', 'ok');
    memory.noteTurnCompleted('chat');
    clock.advance(MEMORY_QUIET_MS);

    await vi.waitFor(() => expect(requests).toHaveLength(1));
    expect(promptOf(requests[0])).toContain('for the project "Alpha"');
    await new Promise((r) => setTimeout(r, 20));
    expect(requests).toHaveLength(1); // the global update waits its turn
    gates[0]!.resolve(reply(PROJECT_NOTE));
    await vi.waitFor(() => expect(requests).toHaveLength(2));
    expect(promptOf(requests[1])).toContain('lasting facts about the user');
    gates[1]!.resolve(reply(gnote()));
    await memory.idle();
    expect(store.projectMemory.get('proj')!.body).toBe(PROJECT_NOTE);
    expect(store.globalMemory.get().note).toBe(gnote());
  });

  it('forwards turn starts, cancels and the sweep to both, and reports both errors', () => {
    const queue = new MemoryQueue();
    const project = new ProjectMemoryService({ store, engine, resolveProfile, now: clock.now, scheduler: clock, queue });
    const global = makeService({ queue });
    const memory = new MemoryServices(project, global);
    addChat('chat', { projectId: 'proj' });
    exchange('chat', 'hi', 'ok');
    memory.noteTurnCompleted('chat');
    expect(clock.pending()).toEqual([MEMORY_QUIET_MS, MEMORY_QUIET_MS]);
    memory.noteTurnStarted('chat');
    expect(clock.pending()).toEqual([]);
    memory.noteTurnCompleted('chat');
    memory.cancel('chat');
    expect(clock.pending()).toEqual([]);
    expect(memory.lastError('proj')).toBeNull();
    expect(memory.lastGlobalError()).toBeNull();
  });
});
