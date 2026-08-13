import { describe, it, expect, beforeEach } from 'vitest';
import { TurnRunner } from '@grunt/core/domain/turn.js';
import { InMemoryStore, FakeSecretStore, FakeChatEngine } from '@grunt/core/testing/fakes.js';
import type { PricingSnapshot } from '@grunt/core/types/usage.js';
import { createApp } from '../../src/app.js';
import type { Container } from '../../src/container.js';
import { StreamRegistry } from '../../src/stream/registry.js';

let container: Container;

beforeEach(() => {
  const store = new InMemoryStore();
  const engine = new FakeChatEngine([]);
  const turnRunner = new TurnRunner(store, engine);
  container = {
    store,
    secrets: new FakeSecretStore(),
    engine,
    registry: {} as never,
    turnRunner,
    streamRegistry: new StreamRegistry(turnRunner, store),
    close: () => {},
  };
});

function app() {
  return createApp(container);
}

/** Seeds a connection + profile + chat, returning their ids. */
function seedChat(chatId: string, chatTitle = 'Test chat'): { connectionId: string; profileId: string; chatId: string } {
  const connectionId = `conn-${chatId}`;
  const profileId = `profile-${chatId}`;
  container.store.connections.create({
    id: connectionId,
    name: 'Conn',
    kind: 'mock',
    baseUrl: null,
    secretRef: null,
    extraHeaders: {},
    status: 'unknown',
    statusMessage: null,
    checkedAt: null,
  });
  container.store.profiles.create({
    id: profileId,
    name: 'Profile',
    description: null,
    colour: null,
    connectionId,
    modelId: 'model-x',
    systemPrompt: null,
    params: {},
    toolPolicy: { fs: 'off', shell: false, mcpServerIds: [], approvalMode: 'always_ask' },
    isDefault: false,
    archivedAt: null,
  });
  container.store.chats.create({
    id: chatId,
    title: chatTitle,
    profileId,
    headMessageId: null,
    workspaceRoot: null,
    pinned: false,
    archivedAt: null,
  });
  return { connectionId, profileId, chatId };
}

function seedAssistantMessage(
  id: string,
  chatId: string,
  profileId: string,
  connectionId: string,
  overrides: { status?: 'complete' | 'cancelled' | 'error'; error?: { kind: 'rate_limit'; message: string; retryable: boolean } } = {}
): void {
  container.store.messages.create({
    id,
    chatId,
    parentId: null,
    role: 'assistant',
    parts: [],
    status: overrides.status ?? 'complete',
    error: overrides.error ?? null,
    producedBy: { profileId, profileName: 'Profile', connectionId, modelId: 'model-x' },
  });
}

const pricing: PricingSnapshot = { priceInPer1m: 3, priceOutPer1m: 15, priceCachedPer1m: null, currency: 'USD' };

function seedUsage(id: string, chatId: string, messageId: string, profileId: string, connectionId: string, costEstimate: number): void {
  container.store.usage.create({
    id,
    chatId,
    messageId,
    profileId,
    connectionId,
    modelId: 'model-x',
    tokensIn: 1000,
    tokensOut: 200,
    tokensCached: 0,
    tokensReasoning: 0,
    costEstimate,
    pricingSnapshot: pricing,
    latencyMs: 400,
  });
}

describe('GET /api/usage', () => {
  it('returns an empty rollup when nothing has run yet', async () => {
    seedChat('chat-1');
    const res = await app().request('/api/usage');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { profiles: unknown[]; totalMeasuredCost: number };
    expect(body.profiles).toEqual([]);
    expect(body.totalMeasuredCost).toBe(0);
  });

  it('aggregates usage across every chat when chatId is omitted', async () => {
    const a = seedChat('chat-a', 'Chat A');
    const b = seedChat('chat-b', 'Chat B');
    seedAssistantMessage('m1', a.chatId, a.profileId, a.connectionId);
    seedUsage('u1', a.chatId, 'm1', a.profileId, a.connectionId, 3);
    seedAssistantMessage('m2', b.chatId, b.profileId, b.connectionId);
    seedUsage('u2', b.chatId, 'm2', b.profileId, b.connectionId, 10);

    const res = await app().request('/api/usage');
    const body = (await res.json()) as { totalMeasuredCost: number; chats: { chatId: string; chatTitle: string; measuredCost: number }[] };

    expect(body.totalMeasuredCost).toBe(13);
    expect(body.chats.find((ch) => ch.chatId === 'chat-a')).toMatchObject({ chatTitle: 'Chat A', measuredCost: 3 });
    expect(body.chats.find((ch) => ch.chatId === 'chat-b')).toMatchObject({ chatTitle: 'Chat B', measuredCost: 10 });
  });

  it('scopes to a single chat via ?chatId=, excluding other chats\' spend', async () => {
    const a = seedChat('chat-a', 'Chat A');
    const b = seedChat('chat-b', 'Chat B');
    seedAssistantMessage('m1', a.chatId, a.profileId, a.connectionId);
    seedUsage('u1', a.chatId, 'm1', a.profileId, a.connectionId, 3);
    seedAssistantMessage('m2', b.chatId, b.profileId, b.connectionId);
    seedUsage('u2', b.chatId, 'm2', b.profileId, b.connectionId, 10);

    const res = await app().request('/api/usage?chatId=chat-a');
    const body = (await res.json()) as { totalMeasuredCost: number; chats: { chatId: string }[] };

    expect(body.totalMeasuredCost).toBe(3);
    expect(body.chats.map((ch) => ch.chatId)).toEqual(['chat-a']);
  });

  it('404s for an unknown chatId', async () => {
    const res = await app().request('/api/usage?chatId=no-such-chat');
    expect(res.status).toBe(404);
  });

  // Task 28's two usage-honesty requirements, exercised through the actual
  // HTTP route (the rollup MATH itself is unit-tested exhaustively in
  // packages/core/test/usage-rollup.test.ts -- this just proves the route
  // wires the right data into it).
  it('reports a cancelled variant as cancelledCount, never folded into measuredCost', async () => {
    const a = seedChat('chat-a');
    seedAssistantMessage('m1', a.chatId, a.profileId, a.connectionId, { status: 'cancelled' });
    seedUsage('u1', a.chatId, 'm1', a.profileId, a.connectionId, 0);

    const res = await app().request('/api/usage?chatId=chat-a');
    const body = (await res.json()) as { totalMeasuredCost: number; totalCancelledCount: number };

    expect(body.totalCancelledCount).toBe(1);
    expect(body.totalMeasuredCost).toBe(0);
  });

  it('reports an errored variant with no usage row as unmeasuredErrorCount, never silently dropped', async () => {
    const a = seedChat('chat-a');
    seedAssistantMessage('m1', a.chatId, a.profileId, a.connectionId, {
      status: 'error',
      error: { kind: 'rate_limit', message: 'boom', retryable: true },
    });
    // No usage row written for m1 -- exactly what happens server-side when the engine never reaches `finish` (turn.ts).

    const res = await app().request('/api/usage?chatId=chat-a');
    const body = (await res.json()) as { totalUnmeasuredErrorCount: number; profiles: { unmeasuredErrorCount: number }[] };

    expect(body.totalUnmeasuredErrorCount).toBe(1);
    expect(body.profiles[0]?.unmeasuredErrorCount).toBe(1);
  });
});

describe('editing pricing does not alter historical cost_estimate', () => {
  it('a usage row written under one pricing_snapshot keeps its cost_estimate/pricing_snapshot after the model\'s price is edited', async () => {
    const a = seedChat('chat-a');
    const model = container.store.models.create({
      id: 'model-row-1',
      connectionId: a.connectionId,
      modelId: 'model-x',
      displayName: 'Model X',
      source: 'manual',
      supportsVision: false,
      supportsTools: false,
      supportsReasoning: false,
      contextWindow: null,
      maxOutput: null,
      priceInPer1m: 3,
      priceOutPer1m: 15,
      priceCachedPer1m: null,
      currency: 'USD',
    });
    seedAssistantMessage('m1', a.chatId, a.profileId, a.connectionId);
    seedUsage('u1', a.chatId, 'm1', a.profileId, a.connectionId, 3);
    const before = container.store.usage.get('u1');

    // Prices change after the fact (e.g. the provider raised rates).
    const patchRes = await app().request(`/api/models/${model.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ priceInPer1m: 30, priceOutPer1m: 150 }),
    });
    expect(patchRes.status).toBe(200);
    expect((await patchRes.json()) as { priceInPer1m: number }).toMatchObject({ priceInPer1m: 30 });

    const after = container.store.usage.get('u1');
    expect(after).toEqual(before);
    expect(after?.costEstimate).toBe(3);
    expect(after?.pricingSnapshot).toEqual(pricing);

    // The rollup itself is likewise unaffected by the edit.
    const usageRes = await app().request('/api/usage?chatId=chat-a');
    const body = (await usageRes.json()) as { totalMeasuredCost: number };
    expect(body.totalMeasuredCost).toBe(3);
  });
});
