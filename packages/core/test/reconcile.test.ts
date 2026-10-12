import { describe, it, expect } from 'vitest';
import { InMemoryStore, FakeChatEngine } from '../src/testing/fakes.js';
import { TurnRunner } from '../src/domain/turn.js';
import { reconcileInterruptedTurns, INTERRUPTED_BY_RESTART_ERROR, SUBAGENT_INTERRUPTED_MESSAGE } from '../src/domain/reconcile.js';
import type { Connection, ModelInfo, Profile, ResolvedProfile } from '../src/types/config.js';
import type { Part } from '../src/types/messages.js';

// ---------------------------------------------------------------------------
// Fixtures -- a message row needs a full connection -> model -> profile ->
// chat chain to exist for the contract InMemoryStore/SqliteStore share (see
// store-contract.ts); minimal versions of the same fixtures turn.test.ts
// uses.
// ---------------------------------------------------------------------------

function seedChatChain(store: InMemoryStore, id: string): void {
  const connection: Connection = {
    id: `${id}::conn`,
    name: 'Test Connection',
    kind: 'mock',
    baseUrl: null,
    secretRef: null,
    extraHeaders: {},
    status: 'unknown',
    statusMessage: null,
    checkedAt: null,
  };
  const model: ModelInfo = {
    id: `${id}::model`,
    connectionId: connection.id,
    modelId: 'test-model',
    displayName: 'Test Model',
    source: 'manual',
    supportsVision: false,
    supportsTools: false,
    supportsReasoning: false,
    contextWindow: null,
    maxOutput: null,
    priceInPer1m: null,
    priceOutPer1m: null,
    priceCachedPer1m: null,
    currency: 'USD',
  };
  const profile: Profile = {
    id: `${id}::profile`,
    name: 'Test Profile',
    description: null,
    colour: null,
    connectionId: connection.id,
    modelId: model.id,
    systemPrompt: null,
    params: {},
    toolPolicy: { fs: 'off', shell: false, mcpServerIds: [], approvalMode: 'always_ask' },
    isDefault: false,
    archivedAt: null,
  };
  store.connections.create(connection);
  store.models.create(model);
  store.profiles.create(profile);
  store.chats.create({ id, profileId: profile.id, title: 'Test Chat', headMessageId: null, workspaceRoot: null, pinned: false, archivedAt: null });
}

function makeResolvedProfile(overrides: Partial<ResolvedProfile> = {}): ResolvedProfile {
  return {
    id: 'chat-a::profile',
    name: 'Test Profile',
    description: null,
    colour: null,
    connectionId: 'chat-a::conn',
    modelId: 'chat-a::model',
    systemPrompt: null,
    params: {},
    toolPolicy: { fs: 'off', shell: false, mcpServerIds: [], approvalMode: 'always_ask' },
    isDefault: false,
    archivedAt: null,
    connection: {
      id: 'chat-a::conn',
      name: 'Test Connection',
      kind: 'mock',
      baseUrl: null,
      secretRef: null,
      extraHeaders: {},
      status: 'unknown',
      statusMessage: null,
      checkedAt: null,
    },
    apiKey: null,
    model: null,
    ...overrides,
  };
}

describe('reconcileInterruptedTurns', () => {
  it('transitions an orphaned streaming message to a terminal state and records why', () => {
    const store = new InMemoryStore();
    seedChatChain(store, 'chat-a');
    const parts: Part[] = [{ type: 'text', text: 'Hi, I was in the middle of' }];
    store.messages.create({
      id: 'user-1',
      chatId: 'chat-a',
      parentId: null,
      role: 'user',
      parts: [{ type: 'text', text: 'hello' }],
      status: 'complete',
      error: null,
      producedBy: null,
    });
    store.messages.create({
      id: 'msg-orphaned',
      chatId: 'chat-a',
      parentId: 'user-1',
      role: 'assistant',
      parts,
      status: 'streaming',
      error: null,
      producedBy: null,
    });

    const reconciled = reconcileInterruptedTurns(store);

    expect(reconciled.map((m) => m.id)).toEqual(['msg-orphaned']);
    const after = store.messages.get('msg-orphaned');
    // Terminal: no longer streaming, and not silently dropped into some
    // other in-flight-looking state.
    expect(after?.status).toBe('error');
    expect(after?.status).not.toBe('streaming');
    // Honest about the cause -- distinguishable from a real provider error.
    expect(after?.error).toEqual(INTERRUPTED_BY_RESTART_ERROR);
    expect(after?.error?.message.toLowerCase()).toContain('restart');
    // The partial content already checkpointed before the crash survives
    // untouched -- reconciliation only ever changes status/error.
    expect(after?.parts).toEqual(parts);
  });

  it("turns a sub-agent that was queued or running when Grunt died into an error, leaving finished ones alone", () => {
    const store = new InMemoryStore();
    seedChatChain(store, 'chat-a');
    const card = (callId: string, status: 'queued' | 'running' | 'complete'): Part => ({
      type: 'subagent', callId, label: callId, prompt: 'p', profileId: 'p', profileName: 'P', modelId: 'm', status, parts: [],
    });
    store.messages.create({ id: 'user-1', chatId: 'chat-a', parentId: null, role: 'user', parts: [], status: 'complete', error: null, producedBy: null });
    store.messages.create({ id: 'reply-1', chatId: 'chat-a', parentId: 'user-1', role: 'assistant', parts: [card('a', 'queued'), card('b', 'running'), card('c', 'complete')], status: 'streaming', error: null, producedBy: null });

    // A message that is not streaming is nobody's orphan: its queued card is left alone.
    store.messages.create({ id: 'reply-2', chatId: 'chat-a', parentId: 'user-1', role: 'assistant', parts: [card('d', 'queued')], status: 'complete', error: null, producedBy: null });

    reconcileInterruptedTurns(store);

    const reply = store.messages.get('reply-1')!;
    expect(reply.status).toBe('error');
    const parts = reply.parts as Extract<Part, { type: 'subagent' }>[];
    expect(parts.map((p) => [p.callId, p.status, p.error])).toEqual([
      ['a', 'error', SUBAGENT_INTERRUPTED_MESSAGE],
      ['b', 'error', SUBAGENT_INTERRUPTED_MESSAGE],
      ['c', 'complete', undefined],
    ]);
    const untouched = store.messages.get('reply-2')!;
    expect(untouched.status).toBe('complete');
    expect((untouched.parts as Extract<Part, { type: 'subagent' }>[])[0]!.status).toBe('queued');
  });

  it('leaves complete, error, and cancelled messages alone', () => {
    const store = new InMemoryStore();
    seedChatChain(store, 'chat-a');
    store.messages.create({ id: 'root', chatId: 'chat-a', parentId: null, role: 'user', parts: [], status: 'complete', error: null, producedBy: null });
    store.messages.create({ id: 'done', chatId: 'chat-a', parentId: 'root', role: 'assistant', parts: [{ type: 'text', text: 'ok' }], status: 'complete', error: null, producedBy: null });
    store.messages.create({ id: 'failed', chatId: 'chat-a', parentId: 'root', role: 'assistant', parts: [], status: 'error', error: { kind: 'auth', message: 'bad key', retryable: false }, producedBy: null });
    store.messages.create({ id: 'stopped', chatId: 'chat-a', parentId: 'root', role: 'assistant', parts: [], status: 'cancelled', error: null, producedBy: null });

    const reconciled = reconcileInterruptedTurns(store);

    expect(reconciled).toEqual([]);
    expect(store.messages.get('done')?.status).toBe('complete');
    expect(store.messages.get('failed')).toMatchObject({ status: 'error', error: { kind: 'auth' } });
    expect(store.messages.get('stopped')?.status).toBe('cancelled');
  });

  it('reconciles every orphaned message across every chat, not just the first', () => {
    const store = new InMemoryStore();
    seedChatChain(store, 'chat-a');
    seedChatChain(store, 'chat-b');
    for (const chatId of ['chat-a', 'chat-b']) {
      store.messages.create({ id: `${chatId}::root`, chatId, parentId: null, role: 'user', parts: [], status: 'complete', error: null, producedBy: null });
      store.messages.create({ id: `${chatId}::orphan`, chatId, parentId: `${chatId}::root`, role: 'assistant', parts: [], status: 'streaming', error: null, producedBy: null });
    }

    const reconciled = reconcileInterruptedTurns(store);

    expect(reconciled.map((m) => m.id).sort()).toEqual(['chat-a::orphan', 'chat-b::orphan']);
  });

  it('is a no-op returning [] when nothing is orphaned', () => {
    const store = new InMemoryStore();
    expect(reconcileInterruptedTurns(store)).toEqual([]);
  });

  it('the reconciled message is subsequently retryable through TurnRunner', async () => {
    const store = new InMemoryStore();
    seedChatChain(store, 'chat-a');
    store.messages.create({ id: 'user-1', chatId: 'chat-a', parentId: null, role: 'user', parts: [{ type: 'text', text: 'hi' }], status: 'complete', error: null, producedBy: null });
    store.messages.create({
      id: 'msg-orphaned',
      chatId: 'chat-a',
      parentId: 'user-1',
      role: 'assistant',
      parts: [{ type: 'text', text: 'partial...' }],
      status: 'streaming',
      error: null,
      producedBy: null,
    });

    // Before reconciliation, retry correctly refuses a streaming row -- this
    // is precisely the dead end reconciliation exists to close.
    const engine = new FakeChatEngine([{ type: 'text-delta', text: 'Full answer' }]);
    const runner = new TurnRunner(store, engine);
    await expect(runner.retry('chat-a', 'msg-orphaned', makeResolvedProfile())).rejects.toThrow(/is streaming, not error/i);

    reconcileInterruptedTurns(store);
    expect(store.messages.get('msg-orphaned')?.status).toBe('error');

    // After reconciliation, the exact same call that was refused now
    // succeeds -- the row has a real path back to a terminal, useful state.
    await expect(runner.retry('chat-a', 'msg-orphaned', makeResolvedProfile())).resolves.toBeUndefined();
    const after = store.messages.get('msg-orphaned');
    expect(after?.status).toBe('complete');
    expect(after?.error).toBeNull();
  });
});
