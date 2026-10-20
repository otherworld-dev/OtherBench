import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MEMORY_FORMAT_ERROR, MEMORY_QUIET_MS, NO_MEMORY_MODEL_MESSAGE, emptyMemoryBody } from '@otherbench/core/domain/memory.js';
import { TurnRunner, type TurnEvent } from '@otherbench/core/domain/turn.js';
import type { ChatEngine, EngineEvent, EngineRequest } from '@otherbench/core/ports/chat-engine.js';
import { FakeChatEngine, InMemoryStore } from '@otherbench/core/testing/fakes.js';
import type { Profile, ResolvedProfile } from '@otherbench/core/types/config.js';
import type { MessageStatus } from '@otherbench/core/types/messages.js';
import { MEMORY_UPDATE_TIMEOUT_MS, ProjectMemoryService, type ProjectMemoryServiceDeps } from '../../src/memory/service.js';
import { ManualClock } from './manual-clock.js';

const ZERO = { tokensIn: 0, tokensOut: 0, tokensCached: 0, tokensReasoning: 0 };
const reply = (text: string): EngineEvent[] => [{ type: 'text-delta', text }, { type: 'finish', usage: ZERO, finishReason: 'stop' }];

/** A note in the fixed format; empty sections render as a bare heading. */
function note({ pinned = '', goals = '- Ship project memory' }: { pinned?: string; goals?: string } = {}): string {
  return [`## Pinned${pinned ? `\n${pinned}` : ''}`, `## Goals${goals ? `\n${goals}` : ''}`, '## Decisions', '## Current focus', '## Open questions'].join('\n\n');
}

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
/** What the scripted memory model answers; tests swap it. */
let respond: (req: EngineRequest) => EngineEvent[] | Promise<EngineEvent[]>;
let requests: EngineRequest[];
/** Profile ids `resolveProfile` refuses, as if their connection were gone. */
let unresolvable: Set<string>;
let service: ProjectMemoryService;
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

function makeService(over: Partial<ProjectMemoryServiceDeps> = {}): ProjectMemoryService {
  return new ProjectMemoryService({
    store,
    engine,
    resolveProfile: async (id: string): Promise<ResolvedProfile> => {
      const profile = store.profiles.get(id);
      if (!profile || unresolvable.has(id)) throw new Error(`cannot resolve ${id}`);
      return { ...profile, connection: store.connections.get(profile.connectionId)!, apiKey: null, model: null };
    },
    now: clock.now,
    scheduler: clock,
    ...over,
  });
}

function addChat(id: string, over: { projectId?: string | null; memoryExcluded?: boolean } = {}): void {
  store.chats.create({
    id,
    title: `Chat ${id}`,
    profileId: 'p-app',
    headMessageId: null,
    workspaceRoot: null,
    pinned: false,
    archivedAt: null,
    projectId: over.projectId === undefined ? 'proj' : over.projectId,
    memoryExcluded: over.memoryExcluded ?? false,
  });
}

/** Adds a user message and its reply under the chat's tip, and parks the head on the user message like the web client. */
function exchange(chatId: string, user: string, assistant: string, opts: { at?: number; status?: MessageStatus } = {}): { userId: string; replyId: string } {
  const at = opts.at ?? clock.time;
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
    status: opts.status ?? 'complete',
    error: null,
    producedBy: { profileId: 'p-app', profileName: 'App', connectionId: 'conn', modelId: 'm' },
    createdAt: at + 1,
  });
  store.chats.update(chatId, { headMessageId: userId });
  tips.set(chatId, replyId);
  return { userId, replyId };
}

/** The text of the single user message a memory request carries. */
function promptOf(req: EngineRequest | undefined): string {
  const part = req?.messages[0]?.parts[0];
  return part?.type === 'text' ? part.text : '';
}

/** A memory model that holds each answer until the test releases it. */
function gatedModel(): { resolve: (events: EngineEvent[]) => void }[] {
  const gates: { resolve: (events: EngineEvent[]) => void }[] = [];
  respond = () => {
    const gate = deferred<EngineEvent[]>();
    gates.push(gate);
    return gate.promise;
  };
  return gates;
}

beforeEach(() => {
  store = new InMemoryStore();
  clock = new ManualClock();
  respond = () => reply(note());
  requests = [];
  unresolvable = new Set();
  tips = new Map();
  seq = 0;
  // Any real kind: the scripted engine above answers, never the connection.
  store.connections.create({ id: 'conn', name: 'Local', kind: 'ollama', baseUrl: null, secretRef: null, extraHeaders: {}, status: 'unknown', statusMessage: null, checkedAt: null });
  store.profiles.create(profileRow('p-app', { isDefault: true }));
  store.profiles.create(profileRow('p-project'));
  store.profiles.create(profileRow('p-memory'));
  store.projects.create({ id: 'proj', name: 'Alpha', workspaceRoot: null, defaultProfileId: 'p-project' });
  addChat('chat');
  service = makeService();
});

describe('quiet timer', () => {
  it('folds a chat\'s new turns in 5 minutes after its last reply, not before', async () => {
    const { replyId } = exchange('chat', 'We use SQLite', 'Noted');
    service.noteTurnCompleted('chat');
    expect(clock.pending()).toEqual([MEMORY_QUIET_MS]);

    clock.advance(MEMORY_QUIET_MS - 1);
    await service.idle();
    expect(requests).toHaveLength(0);

    clock.advance(1);
    await service.idle();
    expect(requests).toHaveLength(1);
    expect(store.projectMemory.get('proj')).toMatchObject({ body: note(), updatedBy: 'summariser', sourceChatId: 'chat', updatedAt: clock.time });
    expect(store.chats.get('chat')!.memoryCursor).toBe(replyId);
  });

  it('a new turn starting cancels the timer, and the next reply starts it again from zero', async () => {
    exchange('chat', 'First', 'ok');
    service.noteTurnCompleted('chat');
    clock.advance(3 * 60_000);
    service.noteTurnStarted('chat');
    expect(clock.pending()).toEqual([]);

    exchange('chat', 'Second', 'ok');
    service.noteTurnCompleted('chat');
    clock.advance(3 * 60_000);
    await service.idle();
    expect(requests).toHaveLength(0);
    clock.advance(2 * 60_000);
    await service.idle();
    expect(requests).toHaveLength(1);
  });

  it('starts no timer for a chat outside a project, one excluded from memory, or one whose project is gone', () => {
    addChat('loose', { projectId: null });
    addChat('private', { memoryExcluded: true });
    service.noteTurnCompleted('loose');
    service.noteTurnCompleted('private');
    service.noteTurnCompleted('no-such-chat');
    expect(clock.pending()).toEqual([]);

    store.projects.delete('proj');
    service.noteTurnCompleted('chat');
    expect(clock.pending()).toEqual([]);
  });

  it("never folds an app chat into its linked project's note (spec 2026-10-20-code-tab-design, Goal 9: the link is read-only)", async () => {
    store.apps.create({ id: 'app-1', name: 'Shop', linkedProjectId: 'proj' });
    addChat('app-chat', { projectId: null });
    store.chats.update('app-chat', { appId: 'app-1' });
    store.projectMemory.save('proj', note({ goals: '- Untouched' }), 'user', null);
    const before = store.projectMemory.get('proj');
    exchange('app-chat', 'We use SQLite', 'Noted');

    service.noteTurnCompleted('app-chat');
    expect(clock.pending()).toEqual([]);
    clock.advance(MEMORY_QUIET_MS * 2);
    service.sweep();
    expect(clock.pending()).toEqual([]);
    expect(await service.updateNow('app-chat')).toMatchObject({ status: 'discarded' });
    await service.idle();

    expect(requests).toHaveLength(0);
    expect(store.projectMemory.get('proj')).toEqual(before);
  });

  it('starts no timer for a chat that runs on another machine: that machine summarises it', () => {
    addChat('elsewhere');
    store.chats.update('elsewhere', { runsOn: 'node-other' });
    service.noteTurnCompleted('elsewhere');
    expect(clock.pending()).toEqual([]);
  });

  it('a timer whose chat was excluded before it fired does nothing', async () => {
    exchange('chat', 'Plan', 'ok');
    service.noteTurnCompleted('chat');
    store.chats.update('chat', { memoryExcluded: true });
    clock.advance(MEMORY_QUIET_MS);
    await service.idle();
    expect(requests).toHaveLength(0);
  });

  it('attach() starts the timer when a TurnRunner reply completes', async () => {
    const runner = new TurnRunner(store, new FakeChatEngine(reply('Sure.')));
    service.attach(runner);
    const result = await runner.run({
      chatId: 'chat',
      parentId: null,
      userParts: [{ type: 'text', text: 'hi' }],
      profiles: [{ ...profileRow('p-app'), connection: store.connections.get('conn')!, apiKey: null, model: null }],
    });
    await vi.waitFor(() => expect(store.messages.get(result.assistantMessageIds[0]!)!.status).toBe('complete'));
    expect(clock.pending()).toEqual([MEMORY_QUIET_MS]);
  });

  it('dispose() drops pending timers and schedules no more', () => {
    exchange('chat', 'Plan', 'ok');
    service.noteTurnCompleted('chat');
    service.dispose();
    expect(clock.pending()).toEqual([]);
    service.noteTurnCompleted('chat');
    expect(clock.pending()).toEqual([]);
  });
});

describe('an update', () => {
  it('sends the current note and the new turns as one utility request with no tools', async () => {
    exchange('chat', 'We use SQLite', 'Noted');
    await service.updateNow('chat');
    const req = requests[0]!;
    expect(req).toMatchObject({ purpose: 'utility', tools: [], workspaceRoot: null, chatId: 'chat' });
    expect(req.messages).toHaveLength(1);
    expect(req.messages[0]!.role).toBe('user');
    expect(promptOf(req)).toContain(`<current-note>\n${emptyMemoryBody()}\n</current-note>`);
    expect(promptOf(req)).toContain('User: We use SQLite\n\nAssistant: Noted');
  });

  it('records what the update used, against the newest reply it read', async () => {
    const { replyId } = exchange('chat', 'We use SQLite', 'Noted');
    respond = () => [{ type: 'text-delta', text: note() }, { type: 'finish', usage: { tokensIn: 900, tokensOut: 60, tokensCached: 0, tokensReasoning: 0 }, finishReason: 'stop' }];
    await service.updateNow('chat');
    expect(store.usage.list('chat')).toEqual([expect.objectContaining({ purpose: 'memory', messageId: replyId, profileId: 'p-project', tokensIn: 900, tokensOut: 60 })]);
  });

  it('keeps ## Pinned exactly as it was, even when the model rewrites it', async () => {
    store.projectMemory.save('proj', note({ pinned: '- Never break v1 clients' }), 'user', null);
    exchange('chat', 'Drop v1?', 'No.');
    respond = () => reply(note({ pinned: '- (rewritten by the model)', goals: '- Keep v1' }));

    expect((await service.updateNow('chat')).status).toBe('updated');

    expect(store.projectMemory.get('proj')).toMatchObject({ body: note({ pinned: '- Never break v1 clients', goals: '- Keep v1' }), updatedBy: 'summariser', sourceChatId: 'chat' });
    expect(promptOf(requests[0])).toContain('- Never break v1 clients');
  });

  it('rejects a note with missing or reordered headings: nothing changes and the failure is recorded', async () => {
    exchange('chat', 'Plan', 'ok');
    respond = () => reply('## Goals\n- Only one heading');
    const error = `The memory model (p-project) wrote a note that was rejected: ${MEMORY_FORMAT_ERROR}`;

    expect(await service.updateNow('chat')).toEqual({ status: 'failed', error });

    expect(store.projectMemory.get('proj')).toBeNull();
    expect(store.chats.get('chat')!.memoryCursor).toBeNull();
    expect(service.lastError('proj')).toEqual({ message: error, at: clock.time, chatId: 'chat' });
  });

  it('rejects a note over 4,000 characters', async () => {
    exchange('chat', 'Plan', 'ok');
    respond = () => reply(note({ goals: 'x'.repeat(4_100) }));
    const outcome = await service.updateNow('chat');
    expect(outcome.status).toBe('failed');
    expect(outcome.status === 'failed' ? outcome.error : '').toMatch(/the limit is 4,000\.$/);
    expect(store.projectMemory.get('proj')).toBeNull();
  });

  it('accepts a note wrapped in a code fence after a preamble (review focus 1)', async () => {
    exchange('chat', 'Plan', 'ok');
    respond = () => reply(`Here is the updated note:\n\n\`\`\`markdown\n${note({ goals: '- Fenced' })}\n\`\`\``);
    expect((await service.updateNow('chat')).status).toBe('updated');
    expect(store.projectMemory.get('proj')!.body).toBe(note({ goals: '- Fenced' }));
  });

  it('records an engine error, and the next successful update clears it', async () => {
    exchange('chat', 'Plan', 'ok');
    respond = () => [{ type: 'error', error: { kind: 'rate_limit', message: 'Slow down', retryable: true } }];
    expect(await service.updateNow('chat')).toEqual({ status: 'failed', error: 'Memory update failed: Slow down' });
    expect(service.lastError('proj')!.message).toBe('Memory update failed: Slow down');

    respond = () => reply(note());
    expect((await service.updateNow('chat')).status).toBe('updated');
    expect(service.lastError('proj')).toBeNull();
  });

  it('advances the cursor to the newest message it included; with nothing new it makes no call', async () => {
    exchange('chat', 'First', 'ok');
    const { replyId } = exchange('chat', 'Second', 'ok');
    await service.updateNow('chat');
    expect(store.chats.get('chat')!.memoryCursor).toBe(replyId);
    expect(promptOf(requests[0])).toContain('User: First');

    expect(await service.updateNow('chat')).toEqual({ status: 'nothing-new' });
    expect(requests).toHaveLength(1);

    exchange('chat', 'Third', 'ok');
    await service.updateNow('chat');
    expect(promptOf(requests[1])).toContain('User: Third');
    expect(promptOf(requests[1])).not.toContain('User: Second');
  });

  it('sends only the most recent 30,000 characters of new conversation', async () => {
    exchange('chat', `OLDEST ${'x'.repeat(40_000)}`, 'ok');
    exchange('chat', 'NEWEST', 'ok');
    await service.updateNow('chat');
    const prompt = promptOf(requests[0]);
    expect(prompt).toContain('User: NEWEST');
    expect(prompt).toContain('[earlier messages omitted]');
    expect(prompt).not.toContain('OLDEST');
  });

  it('makes no call when no new reply completed (an errored reply is not folded in)', async () => {
    exchange('chat', 'Plan', 'boom', { status: 'error' });
    expect(await service.updateNow('chat')).toEqual({ status: 'nothing-new' });
    expect(requests).toHaveLength(0);
  });

  it('saves no version when the model returns the note unchanged, but still advances the cursor', async () => {
    const { replyId } = exchange('chat', 'Small talk', 'ok');
    respond = () => reply(emptyMemoryBody());
    expect(await service.updateNow('chat')).toEqual({ status: 'unchanged' });
    expect(store.projectMemory.versions('proj')).toEqual([]);
    expect(store.chats.get('chat')!.memoryCursor).toBe(replyId);
  });
});

describe('serialisation', () => {
  it("runs one update per project at a time, and the second sees the first one's note", async () => {
    addChat('chat-2');
    exchange('chat', 'Plan A', 'ok');
    exchange('chat-2', 'Plan B', 'ok');
    const gates = gatedModel();

    const first = service.updateNow('chat');
    const second = service.updateNow('chat-2');
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    await new Promise((resolve) => setImmediate(resolve));
    expect(requests).toHaveLength(1);

    gates[0]!.resolve(reply(note({ goals: '- From chat one' })));
    expect((await first).status).toBe('updated');
    await vi.waitFor(() => expect(requests).toHaveLength(2));
    expect(promptOf(requests[1])).toContain('- From chat one');

    gates[1]!.resolve(reply(note({ goals: '- From chat one\n- From chat two' })));
    expect((await second).status).toBe('updated');
    expect(store.projectMemory.versions('proj')).toHaveLength(2);
  });

  it('Update now pressed twice makes one call and one version; the second run finds nothing new (review focus 3)', async () => {
    exchange('chat', 'Plan', 'ok');
    const first = service.updateNow('chat');
    const second = service.updateNow('chat');
    // The second press joins the queued first update instead of queueing another.
    expect(second).toBe(first);
    expect((await first).status).toBe('updated');
    expect((await second).status).toBe('updated');
    expect(requests).toHaveLength(1);
    expect(store.projectMemory.versions('proj')).toHaveLength(1);
  });

  it('a quiet timer that fires while Update now runs queues behind it and finds nothing new (review focus 3)', async () => {
    service = makeService({ timeoutMs: 24 * 3_600_000 });
    exchange('chat', 'Plan', 'ok');
    const gates = gatedModel();
    const manual = service.updateNow('chat');
    await vi.waitFor(() => expect(requests).toHaveLength(1));

    service.noteTurnCompleted('chat');
    clock.advance(MEMORY_QUIET_MS);
    gates[0]!.resolve(reply(note()));

    expect((await manual).status).toBe('updated');
    await service.idle();
    expect(requests).toHaveLength(1);
    expect(store.projectMemory.versions('proj')).toHaveLength(1);
  });
});

describe('startup sweep', () => {
  it('queues chats whose last reply is over 5 minutes old, times the rest, and skips up-to-date, excluded and loose chats', async () => {
    addChat('recent');
    addChat('done');
    addChat('excluded', { memoryExcluded: true });
    addChat('loose', { projectId: null });
    exchange('chat', 'Old work', 'ok', { at: clock.time - 6 * 60_000 });
    exchange('recent', 'Recent work', 'ok', { at: clock.time - 2 * 60_000 });
    const { replyId } = exchange('done', 'Done work', 'ok', { at: clock.time - 60 * 60_000 });
    store.chats.update('done', { memoryCursor: replyId });
    exchange('excluded', 'Private', 'ok', { at: clock.time - 60 * 60_000 });
    exchange('loose', 'Loose', 'ok', { at: clock.time - 60 * 60_000 });

    service.sweep();
    // 'recent' replied 2 min ago (its reply is 1 ms after its question): 3 min + 1 ms to go.
    expect(clock.pending()).toEqual([3 * 60_000 + 1]);
    await service.idle();
    expect(requests).toHaveLength(1);
    expect(promptOf(requests[0])).toContain('Old work');

    clock.advance(3 * 60_000 + 1);
    await service.idle();
    expect(requests).toHaveLength(2);
    expect(promptOf(requests[1])).toContain('Recent work');
  });

  it("skips a chat whose cursor is already its newest message without reading its messages", () => {
    const { replyId } = exchange('chat', 'Done', 'ok', { at: clock.time - 60 * 60_000 });
    store.chats.update('chat', { memoryCursor: replyId });
    const roots = vi.spyOn(store.messages, 'roots');
    service.sweep();
    expect(roots).not.toHaveBeenCalledWith('chat');
    expect(clock.pending()).toEqual([]);
  });
});

describe('changes while an update runs', () => {
  async function startGated(): Promise<{ running: Promise<unknown>; release: () => void }> {
    exchange('chat', 'Plan', 'ok');
    const gates = gatedModel();
    const running = service.updateNow('chat');
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    return { running, release: () => gates[0]!.resolve(reply(note({ goals: '- From the model' }))) };
  }

  it('discards its result when the user saves the note meanwhile; the user save wins', async () => {
    const { running, release } = await startGated();
    const mine = note({ goals: '- Written by hand' });
    store.projectMemory.save('proj', mine, 'user', null);
    release();

    expect(await running).toEqual({ status: 'discarded', reason: 'The note was edited while the update ran.' });
    expect(store.projectMemory.get('proj')!.body).toBe(mine);
    expect(store.projectMemory.versions('proj')).toHaveLength(1);
    expect(store.chats.get('chat')!.memoryCursor).toBeNull();
  });

  it('discards its result when the project is deleted', async () => {
    const { running, release } = await startGated();
    store.projects.delete('proj');
    release();
    expect(await running).toEqual({ status: 'discarded', reason: 'The project was deleted.' });
    expect(store.projectMemory.get('proj')).toBeNull();
  });

  it('discards its result when the chat is deleted', async () => {
    const { running, release } = await startGated();
    store.chats.delete('chat');
    release();
    expect(await running).toEqual({ status: 'discarded', reason: 'The chat was deleted.' });
    expect(store.projectMemory.get('proj')).toBeNull();
  });

  it('discards its result when the chat is excluded or moved to another project', async () => {
    const excluded = await startGated();
    store.chats.update('chat', { memoryExcluded: true });
    excluded.release();
    expect(await excluded.running).toEqual({ status: 'discarded', reason: 'This chat is set to not add to project memory.' });

    store.chats.update('chat', { memoryExcluded: false });
    store.projects.create({ id: 'proj-2', name: 'Beta', workspaceRoot: null, defaultProfileId: null });
    const gates = gatedModel();
    const moved = service.updateNow('chat');
    await vi.waitFor(() => expect(requests).toHaveLength(2));
    store.chats.update('chat', { projectId: 'proj-2' });
    gates[0]!.resolve(reply(note()));
    expect(await moved).toEqual({ status: 'discarded', reason: 'The chat moved to another project.' });
    expect(store.projectMemory.get('proj')).toBeNull();
    expect(store.projectMemory.get('proj-2')).toBeNull();
  });
});

describe('which model runs it', () => {
  it('uses the Memory model setting first, then the project default, then the app default', async () => {
    store.settings.update({ memoryProfileId: 'p-memory' });
    exchange('chat', 'One', 'ok');
    await service.updateNow('chat');
    expect(requests[0]!.profile.id).toBe('p-memory');

    store.profiles.update('p-memory', { archivedAt: 5 });
    exchange('chat', 'Two', 'ok');
    await service.updateNow('chat');
    expect(requests[1]!.profile.id).toBe('p-project');

    store.projects.update('proj', { defaultProfileId: null });
    exchange('chat', 'Three', 'ok');
    await service.updateNow('chat');
    expect(requests[2]!.profile.id).toBe('p-app');
  });

  it("never picks the mock engine by itself, since it can't write a note, but uses it when it's the chosen Memory model", async () => {
    store.connections.create({ id: 'mock', name: 'Mock', kind: 'mock', baseUrl: null, secretRef: null, extraHeaders: {}, status: 'unknown', statusMessage: null, checkedAt: null });
    store.profiles.create(profileRow('p-mock', { connectionId: 'mock' }));
    store.projects.update('proj', { defaultProfileId: 'p-mock' });
    exchange('chat', 'One', 'ok');
    await service.updateNow('chat');
    expect(requests[0]!.profile.id).toBe('p-app');

    store.settings.update({ memoryProfileId: 'p-mock' });
    exchange('chat', 'Two', 'ok');
    await service.updateNow('chat');
    expect(requests[1]!.profile.id).toBe('p-mock');
  });

  it('skips a profile that cannot be resolved', async () => {
    unresolvable.add('p-project');
    exchange('chat', 'One', 'ok');
    await service.updateNow('chat');
    expect(requests[0]!.profile.id).toBe('p-app');
  });

  it('records "No model available for project memory" and calls nothing when no profile is usable', async () => {
    for (const id of ['p-app', 'p-project', 'p-memory']) store.profiles.update(id, { archivedAt: 5 });
    exchange('chat', 'One', 'ok');

    expect(await service.updateNow('chat')).toEqual({ status: 'failed', error: NO_MEMORY_MODEL_MESSAGE });
    expect(requests).toHaveLength(0);
    expect(service.lastError('proj')).toEqual({ message: NO_MEMORY_MODEL_MESSAGE, at: clock.time, chatId: 'chat' });
  });
});

describe('a model that never answers', () => {
  it('gives up after 120 s, records why, and frees the queue (review focus 2)', async () => {
    exchange('chat', 'Plan', 'ok');
    respond = (req) => new Promise((resolve) => req.signal.addEventListener('abort', () => resolve([]), { once: true }));
    const hung = service.updateNow('chat');
    await vi.waitFor(() => expect(clock.pending()).toEqual([MEMORY_UPDATE_TIMEOUT_MS]));

    clock.advance(MEMORY_UPDATE_TIMEOUT_MS);

    expect(await hung).toEqual({ status: 'failed', error: "Memory update failed: The model didn't answer within 120 s." });
    expect(service.lastError('proj')).toMatchObject({ chatId: 'chat', at: clock.time });

    respond = () => reply(note());
    expect((await service.updateNow('chat')).status).toBe('updated');
    expect(service.lastError('proj')).toBeNull();
  });
});

describe('timeouts and shutdown (fix round 1)', () => {
  const timeoutMessage = "Memory update failed: The model didn't answer within 120 s.";

  async function runHung(custom: ChatEngine): Promise<unknown> {
    service = makeService({ engine: custom });
    exchange('chat', 'Plan', 'ok');
    const hung = service.updateNow('chat');
    await vi.waitFor(() => expect(clock.pending()).toEqual([MEMORY_UPDATE_TIMEOUT_MS]));
    clock.advance(MEMORY_UPDATE_TIMEOUT_MS);
    return hung;
  }

  it("reports the timeout, not the engine's cancelled event", async () => {
    const cancelling: ChatEngine = {
      ...engine,
      async *stream(req) {
        await new Promise((resolve) => req.signal.addEventListener('abort', resolve, { once: true }));
        yield { type: 'error', error: { kind: 'cancelled', message: 'The request was cancelled.', retryable: false } } as EngineEvent;
      },
    };
    expect(await runHung(cancelling)).toEqual({ status: 'failed', error: timeoutMessage });
  });

  it('reports the timeout when the engine throws an AbortError', async () => {
    const throwing: ChatEngine = {
      ...engine,
      async *stream(req) {
        await new Promise((resolve) => req.signal.addEventListener('abort', resolve, { once: true }));
        throw new DOMException('aborted', 'AbortError');
      },
    };
    expect(await runHung(throwing)).toEqual({ status: 'failed', error: timeoutMessage });
  });

  it('frees the queue even when the engine never settles after the abort', async () => {
    const stuck: ChatEngine = { ...engine, stream: () => ({ [Symbol.asyncIterator]: () => ({ next: () => new Promise<never>(() => undefined) }) }) as never };
    expect(await runHung(stuck)).toEqual({ status: 'failed', error: timeoutMessage });
    service = makeService();
    exchange('chat', 'More', 'ok');
    expect((await service.updateNow('chat')).status).toBe('updated');
  });

  it('a failing update asked for twice while queued makes one model call', async () => {
    exchange('chat', 'Plan', 'ok');
    respond = () => [{ type: 'error', error: { kind: 'rate_limit', message: 'Slow down', retryable: true } }];
    const first = service.updateNow('chat');
    const second = service.updateNow('chat');
    const third = service.updateNow('chat');
    expect(second).toBe(first);
    expect(third).toBe(first);
    expect((await first).status).toBe('failed');
    expect(requests).toHaveLength(1);
  });

  it('dispose() aborts a running call and later work is a no-op', async () => {
    exchange('chat', 'Plan', 'ok');
    let signal: AbortSignal | undefined;
    respond = (req) => {
      signal = req.signal;
      return new Promise<EngineEvent[]>(() => undefined);
    };
    const running = service.updateNow('chat');
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    service.dispose();
    expect(signal!.aborted).toBe(true);
    expect((await running).status).toBe('failed');

    expect(await service.updateNow('chat')).toEqual({ status: 'discarded', reason: 'The memory service was shut down.' });
    service.sweep();
    expect(clock.pending()).toEqual([]);
    expect(requests).toHaveLength(1);
  });

  it('aborts the call once the stream finishes', async () => {
    exchange('chat', 'Plan', 'ok');
    let signal: AbortSignal | undefined;
    respond = (req) => {
      signal = req.signal;
      return reply(note());
    };
    await service.updateNow('chat');
    expect(signal!.aborted).toBe(true);
  });
});

describe('final-review fixes', () => {
  /** A stand-in for TurnRunner.on that lets a test emit events. */
  function fakeRunner(): { on(cb: (e: TurnEvent) => void): () => void; emit(e: TurnEvent): void } {
    const listeners = new Set<(e: TurnEvent) => void>();
    return {
      on(cb) {
        listeners.add(cb);
        return () => listeners.delete(cb);
      },
      emit(e) {
        for (const cb of listeners) cb(e);
      },
    };
  }

  it('sweep() survives a chat whose message tree cannot be read: it warns and still queues the others', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    addChat('bad');
    addChat('good');
    exchange('bad', 'Broken', 'ok', { at: clock.time - 10 * 60_000 });
    exchange('good', 'Fine', 'ok', { at: clock.time - 10 * 60_000 });
    const roots = store.messages.roots.bind(store.messages);
    vi.spyOn(store.messages, 'roots').mockImplementation((chatId: string) => {
      if (chatId === 'bad') throw new Error('disk gone');
      return roots(chatId);
    });

    expect(() => service.sweep()).not.toThrow();
    await service.idle();
    expect(requests).toHaveLength(1);
    expect(promptOf(requests[0])).toContain('Fine');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('bad'), expect.anything());
    warn.mockRestore();
  });

  it.each<MessageStatus>(['error', 'cancelled'])('attach() re-arms the quiet timer when a reply ends %s', (status) => {
    const runner = fakeRunner();
    service.attach(runner);
    exchange('chat', 'Plan', 'partial', { status });
    runner.emit({ messageId: `chat-a${seq}`, type: 'status', status });
    expect(clock.pending()).toEqual([MEMORY_QUIET_MS]);
  });

  it('attach() ignores a streaming status', () => {
    const runner = fakeRunner();
    service.attach(runner);
    exchange('chat', 'Plan', 'partial', { status: 'streaming' });
    runner.emit({ messageId: `chat-a${seq}`, type: 'status', status: 'streaming' });
    expect(clock.pending()).toEqual([]);
  });

  it('an update after an errored-only turn makes no model call', async () => {
    exchange('chat', 'Plan', 'partial', { status: 'error' });
    expect(await service.updateNow('chat')).toEqual({ status: 'nothing-new' });
    expect(requests).toHaveLength(0);
  });

  it.each(['length', 'max_tokens', 'content-filter'])('treats finishReason "%s" as a failure and saves nothing', async (finishReason) => {
    exchange('chat', 'Plan', 'ok');
    respond = () => [{ type: 'text-delta', text: note({ goals: '- cut off' }) }, { type: 'finish', usage: ZERO, finishReason }];
    const outcome = await service.updateNow('chat');
    expect(outcome.status).toBe('failed');
    expect(store.projectMemory.get('proj')).toBeNull();
    expect(store.chats.get('chat')!.memoryCursor).toBeNull();
    expect(service.lastError('proj')?.message).toContain(finishReason);
  });

  it('runs only one update at a time across projects, each project still in order', async () => {
    store.projects.create({ id: 'proj2', name: 'Beta', workspaceRoot: null, defaultProfileId: null });
    addChat('other', { projectId: 'proj2' });
    exchange('chat', 'Alpha work', 'ok');
    exchange('other', 'Beta work', 'ok');
    const gates = gatedModel();

    const first = service.updateNow('chat');
    const second = service.updateNow('other');
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    await new Promise((resolve) => setImmediate(resolve));
    expect(requests).toHaveLength(1);

    gates[0]!.resolve(reply(note()));
    expect((await first).status).toBe('updated');
    await vi.waitFor(() => expect(requests).toHaveLength(2));
    expect(promptOf(requests[1])).toContain('Beta work');
    gates[1]!.resolve(reply(note({ goals: '- Beta goal' })));
    expect((await second).status).toBe('updated');
    await service.idle();
  });
});
