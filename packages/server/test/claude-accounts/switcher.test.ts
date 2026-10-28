import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { join } from 'node:path';
import { continuePrompt } from '@otherbench/core/domain/claude-accounts.js';
import { TurnRunner } from '@otherbench/core/domain/turn.js';
import type { EngineEvent, EngineRequest } from '@otherbench/core/ports/chat-engine.js';
import { FakeChatEngine, FakeSecretStore, InMemoryStore } from '@otherbench/core/testing/fakes.js';
import type { AppEvent } from '@otherbench/core/types/events.js';
import type { CanonMessage, MessageStatus, SerializedError } from '@otherbench/core/types/messages.js';
import { createApp } from '../../src/app.js';
import { ClaudeAccountService } from '../../src/claude-accounts/service.js';
import { attachAccountSwitcher } from '../../src/claude-accounts/switcher.js';
import type { Container } from '../../src/container.js';
import { resolveProfile } from '../../src/profile-resolution.js';
import { AppEventBus } from '../../src/stream/events.js';
import { StreamRegistry } from '../../src/stream/registry.js';
import { startTurn } from '../../src/turn-start.js';

const home = process.platform === 'win32' ? 'C:\\h' : '/h';
const usage = { tokensIn: 0, tokensOut: 0, tokensCached: 0, tokensReasoning: 0 };
const producedBy = { profileId: 'p1', profileName: 'CC', connectionId: 'cc', modelId: 'sonnet' };

let container: Container;
let accounts: ClaudeAccountService;
let engine: FakeChatEngine;
let seen: AppEvent[];
let detach: () => void;
let resetsAt: number;

/** Main's replies are cut off by the usage limit; VH's finish. */
function script(req: EngineRequest): EngineEvent[] {
  const slug = req.claudeAccount?.slug ?? 'main';
  if (slug === 'vh') {
    return [
      { type: 'engine-meta', meta: { engine: 'claude_code', sessionId: 's-vh', backend: 'claude:vh', account: 'vh', cwd: '/ws' } },
      { type: 'text-delta', text: 'Carried on.' },
      { type: 'finish', usage, finishReason: 'stop' },
    ];
  }
  return [
    { type: 'engine-meta', meta: { engine: 'claude_code', sessionId: 's-main', backend: 'claude', cwd: '/ws' } },
    { type: 'text-delta', text: 'Half done' },
    { type: 'error', error: { kind: 'rate_limit', retryable: true, message: 'Claude usage limit reached.', detail: { text: 'limit', resetsAt } } },
  ];
}

beforeEach(() => {
  resetsAt = Date.now() + 3_600_000;
  const store = new InMemoryStore();
  const events = new AppEventBus();
  seen = [];
  events.subscribe((e) => seen.push(e));
  store.connections.create({ id: 'cc', name: 'CC', kind: 'claude_code', baseUrl: null, secretRef: null, extraHeaders: {}, status: 'unknown', statusMessage: null, checkedAt: null });
  store.profiles.create({
    id: 'p1', name: 'CC', description: null, colour: null, connectionId: 'cc', modelId: 'sonnet', systemPrompt: null, params: {},
    toolPolicy: { fs: 'off', shell: false, mcpServerIds: [], approvalMode: 'always_ask' }, isDefault: true, archivedAt: null,
  });
  engine = new FakeChatEngine(script);
  accounts = new ClaudeAccountService({ store, engine, events, home, baseEnv: {} });
  accounts.add({ name: 'VH', colour: '#e0a030', configDir: join(home, '.claude-vh') });
  const turnRunner = new TurnRunner(store, engine, { pathExists: () => true, claudeAccountFor: (chatId) => accounts.resolveForTurn(chatId) });
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
    claudeAccounts: accounts,
    close: () => {},
  };
  detach = attachAccountSwitcher(container);
});

afterEach(() => detach());

function chat(accountAutoSwitch: boolean): void {
  container.store.chats.create({ id: 'chat-1', title: 'T', profileId: 'p1', headMessageId: null, workspaceRoot: '/ws', pinned: false, archivedAt: null, accountAutoSwitch });
}

/** Sends a message the way the turns route does and waits for every reply it started to end. */
async function send(profiles = 1): Promise<string[]> {
  const p = await resolveProfile(container, 'p1');
  const { assistantMessageIds } = await startTurn(container, { chatId: 'chat-1', parentId: null, userParts: [{ type: 'text', text: 'Do the task' }], profiles: Array(profiles).fill(p) });
  await vi.waitFor(() => {
    for (const id of assistantMessageIds) expect(container.store.messages.get(id)!.status).not.toBe('streaming');
  });
  return assistantMessageIds;
}

function userChildren(messageId: string): CanonMessage[] {
  return container.store.messages.children(messageId).filter((m) => m.role === 'user');
}

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
}

const RATE_LIMIT: SerializedError = { kind: 'rate_limit', retryable: true, message: 'Claude usage limit reached.', detail: { text: 'limit' } };

/** A user message with its cut-off reply, written straight to the store (head on the user message). */
function seed(opts: { status?: MessageStatus; error?: SerializedError; siblings?: number } = {}): string {
  const { store } = container;
  store.messages.create({ id: 'u1', chatId: 'chat-1', parentId: null, role: 'user', parts: [{ type: 'text', text: 'Do it' }], status: 'complete', error: null, producedBy: null });
  for (let i = 0; i < (opts.siblings ?? 1); i++) {
    store.messages.create({
      id: `a${i + 1}`, chatId: 'chat-1', parentId: 'u1', role: 'assistant', parts: [{ type: 'text', text: 'Half done' }],
      status: opts.status ?? 'error', error: opts.error ?? RATE_LIMIT, producedBy,
      engineMeta: { engine: 'claude_code', sessionId: 's', backend: 'claude', cwd: '/ws' },
    });
  }
  store.chats.update('chat-1', { headMessageId: 'u1' });
  return 'a1';
}

function finished(messageId: string, status: 'error' | 'cancelled' = 'error'): void {
  container.events!.emit({ type: 'turn-finished', chatId: 'chat-1', messageId, status });
}

describe('attachAccountSwitcher', () => {
  it('continues on the other account when the toggle is on', async () => {
    chat(true);
    const [replyId] = await send();

    await vi.waitFor(() => expect(userChildren(replyId!)).toHaveLength(1));
    const reply = container.store.messages.get(replyId!)!;
    expect(reply.status).toBe('error');
    expect(reply.parts).toEqual([{ type: 'text', text: 'Half done' }]);
    expect(container.store.chats.get('chat-1')!.claudeAccount).toBe('vh');

    const next = userChildren(replyId!)[0]!;
    expect(next.parts).toEqual([{ type: 'text', text: continuePrompt('Main', 'VH') }]);
    expect(accounts.limitedUntil('main')).toBe(resetsAt);
    expect(seen).toContainEqual({ type: 'claude-account-switched', chatId: 'chat-1', from: 'Main', to: 'VH', resetsAt, midReply: true });

    // The continuation runs on VH, as a plain reply under the new user message.
    const [continuation] = container.store.messages.children(next.id);
    await vi.waitFor(() => expect(container.store.messages.get(continuation!.id)!.status).toBe('complete'));
    expect(engine.requests.at(-1)!.claudeAccount?.slug).toBe('vh');
    expect(container.store.chats.get('chat-1')!.headMessageId).toBe(next.id);
  });

  it('toggle off: marks the account limited but does not continue', async () => {
    chat(false);
    const [replyId] = await send();
    await settle();

    expect(accounts.limitedUntil('main')).toBe(resetsAt);
    expect(userChildren(replyId!)).toEqual([]);
    expect(container.store.chats.get('chat-1')!.claudeAccount).toBeNull();
    expect(seen.some((e) => e.type === 'claude-account-switched')).toBe(false);
  });

  it('holds the account for five hours when the error has no reset time', async () => {
    chat(false);
    seed();
    const before = Date.now();
    finished('a1');
    await settle();

    const until = accounts.limitedUntil('main')!;
    expect(until).toBeGreaterThanOrEqual(before + 5 * 3_600_000);
    expect(until).toBeLessThanOrEqual(Date.now() + 5 * 3_600_000);
  });

  describe('does not continue a compare variant or a superseded reply', () => {
    it('the parent has 2 assistant children', async () => {
      chat(true);
      const ids = await send(2);
      await settle();

      for (const id of ids) expect(userChildren(id)).toEqual([]);
      expect(accounts.limitedUntil('main')).toBe(resetsAt);
      expect(container.store.chats.get('chat-1')!.claudeAccount).toBeNull();
    });

    it('the head has moved past the reply', async () => {
      chat(true);
      seed();
      container.store.messages.create({ id: 'u2', chatId: 'chat-1', parentId: 'a1', role: 'user', parts: [{ type: 'text', text: 'Never mind' }], status: 'complete', error: null, producedBy: null });
      container.store.chats.update('chat-1', { headMessageId: 'u2' });
      finished('a1');
      await settle();

      expect(userChildren('a1').map((m) => m.id)).toEqual(['u2']);
      expect(container.store.chats.get('chat-1')!.claudeAccount).toBeNull();
    });

    it('the reply was cancelled', async () => {
      chat(true);
      seed({ status: 'cancelled' });
      finished('a1', 'cancelled');
      await settle();

      expect(userChildren('a1')).toEqual([]);
      expect(accounts.limitedUntil('main')).toBeNull();
    });
  });

  it('leaves a reply that failed for another reason alone', async () => {
    chat(true);
    seed({ error: { kind: 'unknown', retryable: false, message: 'odd' } });
    finished('a1');
    await settle();

    expect(userChildren('a1')).toEqual([]);
    expect(accounts.limitedUntil('main')).toBeNull();
  });

  it('continues a reply only once', async () => {
    chat(true);
    seed();
    finished('a1');
    finished('a1');
    await vi.waitFor(() => expect(userChildren('a1')).toHaveLength(1));
    await settle();

    expect(userChildren('a1')).toHaveLength(1);
    expect(seen.filter((e) => e.type === 'claude-account-switched')).toHaveLength(1);
  });

  it('all accounts limited: no continuation, and one exhausted event listing both', async () => {
    chat(true);
    const vhUntil = Date.now() + 7_200_000;
    accounts.markLimited('vh', vhUntil);
    const [replyId] = await send();
    await settle();

    expect(userChildren(replyId!)).toEqual([]);
    expect(container.store.chats.get('chat-1')!.claudeAccount).toBeNull();
    const exhausted = seen.filter((e) => e.type === 'claude-accounts-exhausted');
    expect(exhausted).toEqual([
      { type: 'claude-accounts-exhausted', chatId: 'chat-1', resets: [{ name: 'Main', resetsAt }, { name: 'VH', resetsAt: vhUntil }] },
    ]);
  });
});

describe('POST /api/chats/:id/continue-on-account', () => {
  const post = (body: unknown, chatId = 'chat-1') =>
    createApp(container).request(`/api/chats/${chatId}/continue-on-account`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  it('continues an errored reply on the account asked for, whatever the toggle', async () => {
    chat(false);
    const [replyId] = await send();
    await settle();
    expect(userChildren(replyId!)).toEqual([]);

    const res = await post({ messageId: replyId, account: 'vh' });
    expect(res.status).toBe(202);
    const body = (await res.json()) as { userMessageId: string; assistantMessageIds: string[] };

    const next = container.store.messages.get(body.userMessageId)!;
    expect(next.parentId).toBe(replyId);
    expect(next.parts).toEqual([{ type: 'text', text: continuePrompt('Main', 'VH') }]);
    expect(body.assistantMessageIds.map((id) => container.store.messages.get(id)!.parentId)).toEqual([next.id]);
    expect(container.store.chats.get('chat-1')!.claudeAccount).toBe('vh');
    const reply = container.store.messages.get(replyId!)!;
    expect(reply.status).toBe('error');
    expect(reply.parts).toEqual([{ type: 'text', text: 'Half done' }]);
    expect(seen).toContainEqual({ type: 'claude-account-switched', chatId: 'chat-1', from: 'Main', to: 'VH', resetsAt, midReply: false });

    // Not twice.
    expect((await post({ messageId: replyId, account: 'vh' })).status).toBe(409);
  });

  it('is 404 for an unknown chat or message, and 400 for an unknown account', async () => {
    chat(false);
    seed();
    expect((await post({ messageId: 'a1', account: 'vh' }, 'nope')).status).toBe(404);
    expect((await post({ messageId: 'nope', account: 'vh' })).status).toBe(404);
    expect((await post({ messageId: 'a1', account: 'gone' })).status).toBe(400);
    expect((await post({ account: 'vh' })).status).toBe(400);
  });

  it('is 409 for a reply that is not cut off by a usage limit, or for the account that wrote it', async () => {
    chat(false);
    seed({ error: { kind: 'unknown', retryable: false, message: 'odd' } });
    expect((await post({ messageId: 'a1', account: 'vh' })).status).toBe(409);
    expect((await post({ messageId: 'u1', account: 'vh' })).status).toBe(409);

    container.store.messages.updateStatus('a1', 'error', RATE_LIMIT);
    expect((await post({ messageId: 'a1', account: 'main' })).status).toBe(409);
    expect(userChildren('a1')).toEqual([]);
  });
});
