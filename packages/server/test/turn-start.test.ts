import { describe, expect, it, vi } from 'vitest';
import { InvalidAttachmentReferenceError, TurnRunner } from '@otherbench/core/domain/turn.js';
import { FakeChatEngine, InMemoryStore } from '@otherbench/core/testing/fakes.js';
import type { ResolvedProfile } from '@otherbench/core/types/config.js';
import type { AppEvent } from '@otherbench/core/types/events.js';
import { AppEventBus } from '../src/stream/events.js';
import { StreamRegistry } from '../src/stream/registry.js';
import { startSelfStartedTurn, startTurn } from '../src/turn-start.js';
import type { EngineEvent, SelfStart } from '@otherbench/core/ports/chat-engine.js';

function profile(id = 'p1'): ResolvedProfile {
  return {
    id, name: 'Mock', description: null, colour: null, connectionId: 'conn', modelId: 'm', systemPrompt: null, params: {},
    toolPolicy: { fs: 'off', shell: false, mcpServerIds: [], approvalMode: 'always_ask' }, isDefault: true, archivedAt: null,
    connection: { id: 'conn', name: 'Mock', kind: 'mock', baseUrl: null, secretRef: null, extraHeaders: {}, status: 'unknown', statusMessage: null, checkedAt: null },
    apiKey: null, model: null,
  };
}

function setup() {
  const store = new InMemoryStore();
  store.chats.create({ id: 'chat-1', title: 'Chat', profileId: 'p1', headMessageId: null, workspaceRoot: null, pinned: false, archivedAt: null });
  const turnRunner = new TurnRunner(store, new FakeChatEngine([]));
  const events = new AppEventBus();
  const seen: AppEvent[] = [];
  events.subscribe((e) => seen.push(e));
  const memory = { noteTurnStarted: vi.fn(), noteTurnCompleted: vi.fn() };
  const streamRegistry = new StreamRegistry(turnRunner, store);
  return { store, seen, memory, streamRegistry, deps: { store, turnRunner, streamRegistry, events, memory: memory as never } };
}

describe('startTurn', () => {
  it('starts the turn, registers its stream, moves the head to the new user message and announces it', async () => {
    const { store, seen, memory, streamRegistry, deps } = setup();

    const result = await startTurn(deps, { chatId: 'chat-1', parentId: null, userParts: [{ type: 'text', text: 'hi' }], profiles: [profile()] });

    expect(memory.noteTurnStarted).toHaveBeenCalledWith('chat-1');
    expect(store.chats.get('chat-1')!.headMessageId).toBe(result.userMessageId);
    expect(streamRegistry.snapshot('chat-1').map((b) => b.messageId)).toEqual(result.assistantMessageIds);
    expect(seen).toContainEqual({ type: 'turn-started', chatId: 'chat-1', messageIds: result.assistantMessageIds });
  });

  it("takes the profile the message was sent with, so the chat opens on it next time, here and on paired machines", async () => {
    const { store, deps } = setup();

    await startTurn(deps, { chatId: 'chat-1', parentId: null, userParts: [{ type: 'text', text: 'hi' }], profiles: [profile('p2'), profile('p3')] });

    expect(store.chats.get('chat-1')!.profileId).toBe('p2');
  });

  it("leaves the chat's profile alone for a scheduled run", async () => {
    const { store, deps } = setup();

    await startTurn(deps, { chatId: 'chat-1', parentId: null, userParts: [{ type: 'text', text: 'hi' }], profiles: [profile('p2')], unattended: true });

    expect(store.chats.get('chat-1')!.profileId).toBe('p1');
  });

  it('re-arms project memory and rethrows when the turn cannot start', async () => {
    const { store, memory, deps } = setup();

    await expect(
      startTurn(deps, { chatId: 'chat-1', parentId: null, userParts: [{ type: 'image', attachmentId: 'nope', mime: 'image/png' }], profiles: [profile()] })
    ).rejects.toBeInstanceOf(InvalidAttachmentReferenceError);

    expect(memory.noteTurnCompleted).toHaveBeenCalledWith('chat-1');
    expect(store.chats.get('chat-1')!.headMessageId).toBeNull();
  });
});

describe('startSelfStartedTurn', () => {
  function selfStart(over: Partial<SelfStart> = {}): SelfStart & { declined: () => boolean } {
    let declined = false;
    return {
      chatId: 'chat-1', afterMessageId: 'a1', profileId: 'p1', notice: 'Carried on after the helper "implementer" reported back.', unattended: false,
      run: async function* (): AsyncGenerator<EngineEvent> {
        yield { type: 'text-delta', text: 'Reviewed.' };
        yield { type: 'finish', usage: { tokensIn: 0, tokensOut: 0, tokensCached: 0, tokensReasoning: 0 }, finishReason: 'stop' };
      },
      decline: () => { declined = true; },
      declined: () => declined,
      ...over,
    };
  }

  it('runs a self-start as a reply after the one it continues and announces it', async () => {
    const { store, seen, streamRegistry, deps } = setup();
    store.messages.create({ id: 'a1', chatId: 'chat-1', parentId: null, role: 'assistant', parts: [], status: 'complete', error: null, producedBy: null });
    const start = selfStart();

    await startSelfStartedTurn({ ...deps, resolveProfile: async () => profile() }, start);

    const started = seen.find((e) => e.type === 'turn-started') as Extract<typeof seen[number], { type: 'turn-started' }>;
    expect(started).toMatchObject({ chatId: 'chat-1' });
    const id = started.messageIds[0]!;
    await vi.waitFor(() => expect(store.messages.get(id)!.status).toBe('complete'));
    expect(store.messages.get(id)).toMatchObject({ parentId: 'a1', parts: [{ type: 'notice' }, { type: 'text', text: 'Reviewed.' }] });
    expect(streamRegistry.snapshot('chat-1').some((b) => b.messageId === id)).toBe(true);
    expect(start.declined()).toBe(false);
  });

  it("declines a self-start whose reply ends before it runs (the chat's folder is on another machine), so Claude Code's turn is read and dropped", async () => {
    const { store, seen, deps } = setup();
    store.chats.create({ id: 'chat-2', title: 'Away', profileId: 'p1', headMessageId: null, workspace: { kind: 'machine', nodeId: 'node-elsewhere', root: 'E:\\Git' }, pinned: false, archivedAt: null });
    store.messages.create({ id: 'a2', chatId: 'chat-2', parentId: null, role: 'assistant', parts: [], status: 'complete', error: null, producedBy: null });
    const start = selfStart({ chatId: 'chat-2', afterMessageId: 'a2' });

    await startSelfStartedTurn({ ...deps, resolveProfile: async () => profile() }, start);

    const started = seen.find((e) => e.type === 'turn-started') as Extract<typeof seen[number], { type: 'turn-started' }>;
    await vi.waitFor(() => expect(store.messages.get(started.messageIds[0]!)!.status).toBe('error'));
    await vi.waitFor(() => expect(start.declined()).toBe(true));
  });

  it('declines a self-start for a deleted chat, or a reply that is gone', async () => {
    const { deps } = setup();
    const gone = selfStart({ chatId: 'nope' });
    await startSelfStartedTurn({ ...deps, resolveProfile: async () => profile() }, gone);
    expect(gone.declined()).toBe(true);
    const noReply = selfStart({ afterMessageId: 'missing' });
    await startSelfStartedTurn({ ...deps, resolveProfile: async () => profile() }, noReply);
    expect(noReply.declined()).toBe(true);
  });
});
