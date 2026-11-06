import { describe, it, expect, beforeEach, vi } from 'vitest';
import { HANDOVER_NO_REGENERATE } from '@otherbench/core/domain/handover.js';
import { TurnRunner } from '@otherbench/core/domain/turn.js';
import type { EngineEvent, EngineRequest } from '@otherbench/core/ports/chat-engine.js';
import { FakeChatEngine, FakeSecretStore, InMemoryStore } from '@otherbench/core/testing/fakes.js';
import type { AppEvent } from '@otherbench/core/types/events.js';
import type { Part, SerializedError } from '@otherbench/core/types/messages.js';
import { createApp } from '../src/app.js';
import type { Container } from '../src/container.js';
import { HandoverService } from '../src/handover/service.js';
import { AppEventBus } from '../src/stream/events.js';
import { StreamRegistry } from '../src/stream/registry.js';

const usage = { tokensIn: 0, tokensOut: 0, tokensCached: 0, tokensReasoning: 0 };
const producedBy = { profileId: 'p1', profileName: 'CC', connectionId: 'cc', modelId: 'opus' };
const SUMMARY = '## Goal\nA tool-changing rig.\n\n## Next\nPrint the plate.';

let container: Container;
let seen: AppEvent[];
/** How the next handover summary ends. */
let summaryEnd: 'complete' | SerializedError;
/** Holds the summary open until released, so a test can act while it runs. */
let hold: Promise<void> | null;
let requests: EngineRequest[];

async function* script(req: EngineRequest): AsyncGenerator<EngineEvent> {
  requests.push(req);
  if (hold) await hold;
  if (summaryEnd !== 'complete') {
    yield { type: 'error', error: summaryEnd };
    return;
  }
  yield { type: 'engine-meta', meta: { engine: 'claude_code', sessionId: 's-1', backend: 'claude', cwd: '/ws' } };
  yield { type: 'text-delta', text: SUMMARY };
  yield { type: 'finish', usage, finishReason: 'stop' };
}

/** The fake engine, its replies written by `script` (which can wait). */
class ScriptedEngine extends FakeChatEngine {
  override async *stream(req: EngineRequest): AsyncIterable<EngineEvent> {
    yield* script(req);
  }
}

beforeEach(() => {
  summaryEnd = 'complete';
  hold = null;
  requests = [];
  const store = new InMemoryStore();
  const events = new AppEventBus();
  seen = [];
  events.subscribe((e) => seen.push(e));
  store.connections.create({ id: 'cc', name: 'CC', kind: 'claude_code', baseUrl: null, secretRef: null, extraHeaders: {}, status: 'unknown', statusMessage: null, checkedAt: null });
  store.profiles.create({
    id: 'p1', name: 'CC', description: null, colour: null, connectionId: 'cc', modelId: 'opus', systemPrompt: null, params: {},
    toolPolicy: { fs: 'off', shell: false, mcpServerIds: [], approvalMode: 'always_ask' }, isDefault: true, archivedAt: null,
  });
  const engine = new ScriptedEngine([]);
  const turnRunner = new TurnRunner(store, engine, { pathExists: () => true });
  events.attach(turnRunner, store);
  container = {
    store,
    secrets: new FakeSecretStore(),
    engine,
    registry: {} as never,
    toolProvider: {} as never,
    mcpManager: {} as never,
    turnRunner,
    streamRegistry: new StreamRegistry(turnRunner, store),
    blobStore: {} as never,
    events,
    pathExists: () => true,
    close: () => {},
  };
  container.handover = new HandoverService(container);
  store.chats.create({
    id: 'chat-1', title: 'Rig', profileId: 'p1', headMessageId: null, workspaceRoot: '/ws', pinned: false, archivedAt: null,
    effort: 'max', autoMode: true, planMode: true, claudeAccount: 'vh', accountAutoSwitch: true, contextTokens: 420_000,
  });
  seedReply();
});

/** A user message and its complete Claude Code reply, the reply at the tip. */
function seedReply(): void {
  const { store } = container;
  store.messages.create({ id: 'u1', chatId: 'chat-1', parentId: null, role: 'user', parts: [{ type: 'text', text: 'Design it' }], status: 'complete', error: null, producedBy: null });
  store.messages.create({
    id: 'a1', chatId: 'chat-1', parentId: 'u1', role: 'assistant', parts: [{ type: 'text', text: 'Designed.' }], status: 'complete', error: null, producedBy,
    engineMeta: { engine: 'claude_code', sessionId: 's-1', backend: 'claude', cwd: '/ws' },
  });
  store.chats.update('chat-1', { headMessageId: 'u1' });
}

const post = (chatId: string, body: unknown) =>
  createApp(container).request(`/api/chats/${chatId}/handover`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

/** Waits for the handover the chat started to finish (a chat-handed-over event, or the guard clearing). */
async function handedOver(): Promise<Extract<AppEvent, { type: 'chat-handed-over' }>> {
  await vi.waitFor(() => expect(seen.some((e) => e.type === 'chat-handed-over')).toBe(true));
  return seen.find((e): e is Extract<AppEvent, { type: 'chat-handed-over' }> => e.type === 'chat-handed-over')!;
}

describe('POST /api/chats/:id/handover', () => {
  it('writes the summary in the old chat, opens a fresh chat with it and the old settings, and links the two', async () => {
    container.store.schedules.create({ id: 's1', name: 'Daily', prompt: 'p', profileId: 'p1', target: { kind: 'chat', chatId: 'chat-1' }, rule: { cadence: 'daily', time: '08:00' }, timezone: 'UTC', enabled: true, nextRunAt: 5 });
    const res = await post('chat-1', { messageId: 'a1' });
    expect(res.status).toBe(202);
    const { userMessageId, assistantMessageIds } = (await res.json()) as { userMessageId: string; assistantMessageIds: string[] };
    expect(container.store.messages.get(userMessageId)!.parts).toEqual([{ type: 'handover-request' }]);
    expect(requests[0]!.handover).toBe(true);

    const event = await handedOver();
    const fresh = container.store.chats.get(event.toChatId)!;
    expect(event).toEqual({ type: 'chat-handed-over', fromChatId: 'chat-1', toChatId: fresh.id, title: 'Rig (continued)' });
    expect(fresh).toMatchObject({
      title: 'Rig (continued)', profileId: 'p1', effort: 'max', autoMode: true, planMode: true, claudeAccount: 'vh', accountAutoSwitch: true,
      contextTokens: null, handoverSuggest: true,
    });
    expect(fresh.workspace).toEqual(container.store.chats.get('chat-1')!.workspace);
    const first = container.store.messages.get(fresh.headMessageId!)!;
    expect(first).toMatchObject({ role: 'assistant', status: 'complete', parentId: null, producedBy });
    expect(first.parts).toEqual([{ type: 'handover', direction: 'from', chatId: 'chat-1', title: 'Rig' }, { type: 'text', text: SUMMARY }]);
    const summary = container.store.messages.get(assistantMessageIds[0]!)!;
    expect(summary.parts.at(-1)).toEqual({ type: 'handover', direction: 'to', chatId: fresh.id, title: 'Rig (continued)' });
    expect(container.store.schedules.get('s1')!.target).toEqual({ kind: 'chat', chatId: fresh.id });
  });

  it('keeps a chat kept out of memory out of memory in its fresh chat', async () => {
    container.store.chats.update('chat-1', { memoryExcluded: true });
    expect((await post('chat-1', { messageId: 'a1' })).status).toBe(202);
    const event = await handedOver();
    expect(container.store.chats.get(event.toChatId)!.memoryExcluded).toBe(true);
  });

  it('runs one handover at a time for a chat', async () => {
    let release!: () => void;
    hold = new Promise<void>((resolve) => (release = resolve));
    expect((await post('chat-1', { messageId: 'a1' })).status).toBe(202);
    const second = await post('chat-1', { messageId: 'a1' });
    expect(second.status).toBe(409);
    expect(await second.json()).toMatchObject({ kind: 'handover_running' });
    release();
    await handedOver();
  });

  it('refuses while the chat is busy with a reply', async () => {
    let release!: () => void;
    hold = new Promise<void>((resolve) => (release = resolve));
    const busy = await container.turnRunner.run({ chatId: 'chat-1', parentId: 'a1', userParts: [{ type: 'text', text: 'more' }], profiles: [await profile()] });
    const res = await post('chat-1', { messageId: 'a1' });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ kind: 'busy' });
    release();
    await vi.waitFor(() => expect(container.store.messages.get(busy.assistantMessageIds[0]!)!.status).not.toBe('streaming'));
  });

  it.each<[string, SerializedError]>([
    ['fails', { kind: 'unknown', retryable: false, message: 'boom' }],
    ['is stopped', { kind: 'cancelled', retryable: false, message: 'Stopped.' }],
  ])('makes no chat when the summary %s, and can be tried again', async (_what, error) => {
    summaryEnd = error;
    const res = await post('chat-1', { messageId: 'a1' });
    const { assistantMessageIds } = (await res.json()) as { assistantMessageIds: string[] };
    await vi.waitFor(() => expect(container.store.messages.get(assistantMessageIds[0]!)!.status).not.toBe('streaming'));
    await vi.waitFor(() => expect(container.handover!.isRunning('chat-1')).toBe(false));
    expect(container.store.chats.list()).toHaveLength(1);
    expect(container.store.messages.get(assistantMessageIds[0]!)!.parts.some((p: Part) => p.type === 'handover')).toBe(false);

    summaryEnd = 'complete';
    expect((await post('chat-1', { messageId: 'a1' })).status).toBe(202);
    await handedOver();
  });

  it('makes no chat when the old chat is deleted while the summary is written', async () => {
    let release!: () => void;
    hold = new Promise<void>((resolve) => (release = resolve));
    expect((await post('chat-1', { messageId: 'a1' })).status).toBe(202);
    container.store.chats.delete('chat-1');
    release();
    await vi.waitFor(() => expect(container.handover!.isRunning('chat-1')).toBe(false));
    expect(container.store.chats.list()).toHaveLength(0);
    expect(seen.some((e) => e.type === 'chat-handed-over')).toBe(false);
  });

  it('refuses a reply in a compare turn', async () => {
    container.store.messages.create({
      id: 'a2', chatId: 'chat-1', parentId: 'u1', role: 'assistant', parts: [{ type: 'text', text: 'Other.' }], status: 'complete', error: null,
      producedBy: { ...producedBy, profileName: 'Other' }, engineMeta: { engine: 'claude_code', sessionId: 's-2', backend: 'claude', cwd: '/ws' },
    });
    expect((await post('chat-1', { messageId: 'a1' })).status).toBe(400);
  });

  it('refuses a reply that is not the latest, and one that is not a Claude Code reply', async () => {
    container.store.messages.create({ id: 'u2', chatId: 'chat-1', parentId: 'a1', role: 'user', parts: [{ type: 'text', text: 'next' }], status: 'complete', error: null, producedBy: null });
    expect((await post('chat-1', { messageId: 'a1' })).status).toBe(409);
    expect((await post('chat-1', { messageId: 'u2' })).status).toBe(400);
  });

  it("can't regenerate the summary reply", async () => {
    const res = await post('chat-1', { messageId: 'a1' });
    const { assistantMessageIds } = (await res.json()) as { assistantMessageIds: string[] };
    await handedOver();
    const again = await createApp(container).request('/api/chats/chat-1/regenerate', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ messageId: assistantMessageIds[0] }),
    });
    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({ error: HANDOVER_NO_REGENERATE });
    // Nor is the summary itself handed over again.
    expect((await post('chat-1', { messageId: assistantMessageIds[0] })).status).toBe(400);
  });
});

describe('fresh chat settings and chat fields', () => {
  const patch = (path: string, body: unknown) =>
    createApp(container).request(path, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  it('takes a whole-number threshold between 50k and 2M tokens and an on/off', async () => {
    expect((await patch('/api/settings', { handoverThresholdTokens: 10_000 })).status).toBe(400);
    expect((await patch('/api/settings', { handoverThresholdTokens: 300_000.5 })).status).toBe(400);
    expect((await patch('/api/settings', { handoverEnabled: 'yes' })).status).toBe(400);
    const ok = await patch('/api/settings', { handoverThresholdTokens: 500_000, handoverEnabled: false });
    expect(ok.status).toBe(200);
    expect(container.store.settings.get()).toMatchObject({ handoverThresholdTokens: 500_000, handoverEnabled: false });
  });

  it("sets a chat's next ask and its don't-ask, leaving its place in the list alone", async () => {
    const before = container.store.chats.get('chat-1')!.updatedAt;
    expect((await patch('/api/chats/chat-1', { handoverAskAt: 630_000 })).status).toBe(200);
    expect((await patch('/api/chats/chat-1', { handoverSuggest: false })).status).toBe(200);
    expect(container.store.chats.get('chat-1')).toMatchObject({ handoverAskAt: 630_000, handoverSuggest: false, updatedAt: before });
    expect((await patch('/api/chats/chat-1', { handoverAskAt: null })).status).toBe(200);
    expect(container.store.chats.get('chat-1')!.handoverAskAt).toBeNull();
    expect((await patch('/api/chats/chat-1', { handoverAskAt: -1 })).status).toBe(400);
  });
});

async function profile() {
  const { resolveProfile } = await import('../src/profile-resolution.js');
  return resolveProfile(container, 'p1');
}
