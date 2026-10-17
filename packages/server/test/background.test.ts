import { describe, expect, it, vi } from 'vitest';
import { TurnRunner } from '@otherbench/core/domain/turn.js';
import { FakeChatEngine, FakeSecretStore, InMemoryStore } from '@otherbench/core/testing/fakes.js';
import type { Part } from '@otherbench/core/types/messages.js';
import { handleBackground } from '../src/background.js';
import type { Container } from '../src/container.js';
import { StreamRegistry } from '../src/stream/registry.js';

function container(): Container {
  const store = new InMemoryStore();
  const turnRunner = new TurnRunner(store, new FakeChatEngine([]));
  return { store, secrets: new FakeSecretStore(), turnRunner, streamRegistry: new StreamRegistry(turnRunner, store) } as unknown as Container;
}

const card: Part = { type: 'subagent', callId: 't1', label: 'implementer', prompt: 'fix it', profileId: 'p', profileName: 'general-purpose', modelId: 'opus', status: 'background', parts: [], startedAt: 1 };

describe('handleBackground', () => {
  it("folds a finished helper into its card in an earlier reply, and tells the chat's subscribers", () => {
    const c = container();
    c.store.chats.create({ id: 'chat-1', title: 'T', profileId: 'p', headMessageId: null, workspaceRoot: null, pinned: false, archivedAt: null });
    c.store.messages.create({ id: 'm1', chatId: 'chat-1', parentId: null, role: 'assistant', parts: [card], status: 'complete', error: null, producedBy: null });
    const heard: unknown[] = [];
    c.streamRegistry.subscribe('chat-1', (e) => heard.push(e));

    handleBackground(c, { type: 'helper-event', chatId: 'chat-1', messageId: 'm1', callId: 't1', event: { type: 'text-delta', text: 'Fixed.' } });
    handleBackground(c, { type: 'helper-event', chatId: 'chat-1', messageId: 'm1', callId: 't1', event: { type: 'end', status: 'complete', at: 9 } });

    expect(c.store.messages.get('m1')!.parts[0]).toMatchObject({ status: 'complete', finishedAt: 9, parts: [{ type: 'text', text: 'Fixed.' }] });
    expect(heard).toEqual([{ type: 'messages-changed', chatId: 'chat-1' }, { type: 'messages-changed', chatId: 'chat-1' }]);
  });

  it("ignores a card event for another chat's message", () => {
    const c = container();
    c.store.chats.create({ id: 'chat-1', title: 'T', profileId: 'p', headMessageId: null, workspaceRoot: null, pinned: false, archivedAt: null });
    c.store.messages.create({ id: 'm1', chatId: 'chat-1', parentId: null, role: 'assistant', parts: [card], status: 'complete', error: null, producedBy: null });
    handleBackground(c, { type: 'helper-event', chatId: 'other', messageId: 'm1', callId: 't1', event: { type: 'end', status: 'complete' } });
    expect(c.store.messages.get('m1')!.parts[0]).toMatchObject({ status: 'background' });
  });

  it('puts the helpers on the chat stream', () => {
    const c = container();
    const set = vi.spyOn(c.streamRegistry, 'setHelpers');
    handleBackground(c, { type: 'helpers', chatId: 'chat-1', helpers: [] });
    expect(set).toHaveBeenCalledWith('chat-1', []);
  });
});
