import { describe, expect, it, vi } from 'vitest';
import { TurnRunner } from '@otherbench/core/domain/turn.js';
import { FakeChatEngine, FakeSecretStore, InMemoryStore } from '@otherbench/core/testing/fakes.js';
import type { Store } from '@otherbench/core/ports/store.js';
import type { Part } from '@otherbench/core/types/messages.js';
import { openDatabase } from '@otherbench/store-sqlite/db.js';
import { runMigrations } from '@otherbench/store-sqlite/migrations/index.js';
import { SqliteStore } from '@otherbench/store-sqlite/store.js';
import { handleBackground } from '../src/background.js';
import type { Container } from '../src/container.js';
import { AppEventBus } from '../src/stream/events.js';
import { StreamRegistry } from '../src/stream/registry.js';

function container(store: Store = new InMemoryStore()): Container {
  const turnRunner = new TurnRunner(store, new FakeChatEngine([]));
  return { store, secrets: new FakeSecretStore(), turnRunner, streamRegistry: new StreamRegistry(turnRunner, store) } as unknown as Container;
}

const card: Part = { type: 'subagent', callId: 't1', label: 'implementer', prompt: 'fix it', profileId: 'p', profileName: 'general-purpose', modelId: 'opus', status: 'background', parts: [], startedAt: 1 };

describe('handleBackground', () => {
  it("holds a card update for a reply still being written until it ends, so the reply's last write doesn't undo it", () => {
    const c = container();
    const events = new AppEventBus();
    (c as { events?: AppEventBus }).events = events;
    c.store.chats.create({ id: 'chat-1', title: 'T', profileId: 'p', headMessageId: null, workspaceRoot: null, pinned: false, archivedAt: null });
    c.store.messages.create({ id: 'm1', chatId: 'chat-1', parentId: null, role: 'assistant', parts: [card], status: 'streaming', error: null, producedBy: null });

    handleBackground(c, { type: 'helper-event', chatId: 'chat-1', messageId: 'm1', callId: 't1', event: { type: 'end', status: 'complete', at: 9 } });
    // TurnRunner's last write, from what it had: the card still working in the background.
    c.store.messages.updateParts('m1', [card]);
    c.store.messages.updateStatus('m1', 'complete', null);
    events.emit({ type: 'turn-finished', chatId: 'chat-1', messageId: 'm1', status: 'complete' });

    expect(c.store.messages.get('m1')!.parts[0]).toMatchObject({ status: 'complete', finishedAt: 9 });
  });

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

  it('logs the card brought up to date as a change, so paired machines stop showing the helper working', () => {
    const db = openDatabase(':memory:');
    runMigrations(db);
    const store = new SqliteStore(db);
    const c = container(store);
    store.connections.create({ id: 'c1', name: 'C', kind: 'mock', baseUrl: null, secretRef: null, extraHeaders: {}, status: 'unknown', statusMessage: null, checkedAt: null });
    store.models.create({ id: 'm', connectionId: 'c1', modelId: 'm', displayName: 'M', source: 'manual', supportsVision: false, supportsTools: false, supportsReasoning: false, contextWindow: null, maxOutput: null, priceInPer1m: null, priceOutPer1m: null, priceCachedPer1m: null, currency: 'USD' });
    store.profiles.create({ id: 'p', name: 'P', description: null, colour: null, connectionId: 'c1', modelId: 'm', systemPrompt: null, params: {}, toolPolicy: { fs: 'off', shell: false, mcpServerIds: [], approvalMode: 'always_ask' }, isDefault: true, archivedAt: null });
    store.chats.create({ id: 'chat-1', title: 'T', profileId: 'p', headMessageId: null, workspaceRoot: null, pinned: false, archivedAt: null });
    store.messages.create({ id: 'm1', chatId: 'chat-1', parentId: null, role: 'assistant', parts: [card], status: 'complete', error: null, producedBy: null });
    const before = store.sync.latestSeq();

    handleBackground(c, { type: 'helper-event', chatId: 'chat-1', messageId: 'm1', callId: 't1', event: { type: 'end', status: 'complete', at: 9 } });

    const changed = store.sync.changesSince(before, 100).rows.filter((r) => r.tbl === 'message');
    expect(changed.map((r) => r.id)).toEqual(['m1']);
    const logged = changed[0]!;
    expect(logged.op === 'upsert' ? JSON.parse(logged.row['parts'] as string)[0] : null).toMatchObject({ status: 'complete' });
    db.close();
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
