import { describe, expect, it, vi } from 'vitest';
import { InvalidAttachmentReferenceError, TurnRunner } from '@grunt/core/domain/turn.js';
import { FakeChatEngine, InMemoryStore } from '@grunt/core/testing/fakes.js';
import type { ResolvedProfile } from '@grunt/core/types/config.js';
import type { AppEvent } from '@grunt/core/types/events.js';
import { AppEventBus } from '../src/stream/events.js';
import { StreamRegistry } from '../src/stream/registry.js';
import { startTurn } from '../src/turn-start.js';

function profile(): ResolvedProfile {
  return {
    id: 'p1', name: 'Mock', description: null, colour: null, connectionId: 'conn', modelId: 'm', systemPrompt: null, params: {},
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

  it('re-arms project memory and rethrows when the turn cannot start', async () => {
    const { store, memory, deps } = setup();

    await expect(
      startTurn(deps, { chatId: 'chat-1', parentId: null, userParts: [{ type: 'image', attachmentId: 'nope', mime: 'image/png' }], profiles: [profile()] })
    ).rejects.toBeInstanceOf(InvalidAttachmentReferenceError);

    expect(memory.noteTurnCompleted).toHaveBeenCalledWith('chat-1');
    expect(store.chats.get('chat-1')!.headMessageId).toBeNull();
  });
});
