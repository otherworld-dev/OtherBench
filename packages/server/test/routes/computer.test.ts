import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { expectationOf, parseAction } from '@grunt/core/domain/computer-apps.js';
import { TurnRunner } from '@grunt/core/domain/turn.js';
import type { ChatEngine } from '@grunt/core/ports/chat-engine.js';
import type { ComputerAction } from '@grunt/core/ports/computer.js';
import type { ResolvedProfile } from '@grunt/core/types/config.js';
import type { AppEvent } from '@grunt/core/types/events.js';
import { FAKE_COMPUTER_APP, FakeComputerDriver } from '@grunt/core/testing/fake-computer.js';
import { FakeSecretStore, InMemoryStore } from '@grunt/core/testing/fakes.js';
import { createBlobStore } from '@grunt/store-sqlite/blob-store.js';
import { createApp } from '../../src/app.js';
import { cancelChatReplies, ComputerSessions } from '../../src/computer/sessions.js';
import type { Container } from '../../src/container.js';
import { AppEventBus } from '../../src/stream/events.js';
import { StreamRegistry } from '../../src/stream/registry.js';

/** A reply that runs until it is stopped. */
const untilStopped: ChatEngine = {
  async *stream(req) {
    await new Promise<void>((resolve) => {
      if (req.signal.aborted) resolve();
      req.signal.addEventListener('abort', () => resolve(), { once: true });
    });
  },
  listModels: async () => [],
  testConnection: async () => ({ ok: true, message: 'ok', latencyMs: 0 }),
};

function profile(): ResolvedProfile {
  return {
    id: 'profile-1', name: 'P', description: null, colour: null, connectionId: 'conn-1', modelId: 'm', systemPrompt: null, params: {},
    toolPolicy: { fs: 'off', shell: false, mcpServerIds: [], approvalMode: 'always_ask', computer: true }, isDefault: false, archivedAt: null,
    connection: { id: 'conn-1', name: 'Mock', kind: 'mock', baseUrl: null, secretRef: null, extraHeaders: {}, status: 'unknown', statusMessage: null, checkedAt: null },
    apiKey: null, model: null,
  };
}

let dir: string;
let container: Container;
let driver: FakeComputerDriver;
let events: AppEventBus;
let sessions: ComputerSessions;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'grunt-computer-route-'));
  const store = new InMemoryStore();
  for (const id of ['chat-1', 'chat-2']) {
    store.chats.create({ id, title: id === 'chat-1' ? 'Budget' : 'Other', profileId: 'profile-1', headMessageId: null, workspaceRoot: null, pinned: false, archivedAt: null });
  }
  const turnRunner = new TurnRunner(store, untilStopped);
  events = new AppEventBus();
  events.attach(turnRunner, store);
  driver = new FakeComputerDriver();
  sessions = new ComputerSessions(driver, { emit: (e) => events.emit(e), cancelChat: (chatId) => cancelChatReplies(events, turnRunner, chatId) });
  container = {
    store,
    secrets: new FakeSecretStore(),
    engine: untilStopped,
    registry: {} as never,
    toolProvider: {} as never,
    mcpManager: {} as never,
    turnRunner,
    streamRegistry: new StreamRegistry(turnRunner, store),
    blobStore: createBlobStore(join(dir, 'attachments')),
    events,
    computer: sessions,
    close: () => {},
  };
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const post = (path: string, c: Container = container) => createApp(c).request(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });

async function startReply(chatId: string): Promise<string> {
  const { assistantMessageIds } = await container.turnRunner.run({ chatId, parentId: null, userParts: [{ type: 'text', text: 'go' }], profiles: [profile()] });
  events.emit({ type: 'turn-started', chatId, messageIds: assistantMessageIds });
  return assistantMessageIds[0]!;
}

describe('POST /api/chats/:id/computer/stop', () => {
  it("ends the chat's control session and cancels its running reply, and no other chat's", async () => {
    const replyId = await startReply('chat-1');
    const otherReply = await startReply('chat-2');
    await sessions.ensureSession('chat-1', 'Budget');
    const seen: AppEvent[] = [];
    events.subscribe((e) => seen.push(e));

    const res = await post('/api/chats/chat-1/computer/stop');

    expect(res.status).toBe(204);
    expect(driver.ended).toEqual(['chat-1']);
    expect(sessions.activeChat()).toBeNull();
    expect(seen).toContainEqual({ type: 'computer-session', chatId: 'chat-1', active: false });
    await vi.waitFor(() => expect(container.store.messages.get(replyId)?.status).toBe('cancelled'));
    expect(container.store.messages.get(otherReply)?.status).toBe('streaming');
    container.turnRunner.cancel(otherReply);
  });

  it('answers 204 for a chat that is not in control, and still cancels its reply', async () => {
    const replyId = await startReply('chat-2');
    await sessions.ensureSession('chat-1', 'Budget');
    expect((await post('/api/chats/chat-2/computer/stop')).status).toBe(204);
    // The chat in control is untouched.
    expect(sessions.activeChat()).toBe('chat-1');
    expect(driver.hasSession('chat-1')).toBe(true);
    await vi.waitFor(() => expect(container.store.messages.get(replyId)?.status).toBe('cancelled'));
  });

  it('404s for a chat that does not exist, and tells the driver nothing', async () => {
    const end = vi.spyOn(driver, 'endSession');
    expect((await post('/api/chats/nope/computer/stop')).status).toBe(404);
    expect(end).not.toHaveBeenCalled();
  });

  it('answers 204 on a server with no driver', async () => {
    const { computer: _drop, ...without } = container;
    expect((await post('/api/chats/chat-1/computer/stop', without as Container)).status).toBe(204);
    expect((await post('/api/chats/nope/computer/stop', without as Container)).status).toBe(404);
  });

  it('is behind the sign-in like the rest of the API', async () => {
    const res = await createApp(container, { token: 'secret-token' }).request('/api/chats/chat-1/computer/stop', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    expect(res.status).toBe(401);
  });
});

describe('computer use and the rest of the API', () => {
  it("deleting a chat ends its control session and cancels its reply", async () => {
    const replyId = await startReply('chat-1');
    await sessions.ensureSession('chat-1', 'Budget');
    const cancel = vi.spyOn(container.turnRunner, 'cancel');
    const res = await createApp(container).request('/api/chats/chat-1', { method: 'DELETE' });
    expect(res.status).toBe(204);
    expect(driver.ended).toEqual(['chat-1']);
    expect(sessions.activeChat()).toBeNull();
    expect(cancel).toHaveBeenCalledWith(replyId);
    expect(container.store.chats.get('chat-1')).toBeNull();
  });

  it('a chat is still deleted when the driver cannot be told', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    await sessions.ensureSession('chat-1', 'Budget');
    vi.spyOn(driver, 'endSession').mockRejectedValue(new Error('the desktop app is gone'));
    const res = await createApp(container).request('/api/chats/chat-1', { method: 'DELETE' });
    expect(res.status).toBe(204);
    expect(container.store.chats.get('chat-1')).toBeNull();
    expect(sessions.activeChat()).toBeNull();
    errors.mockRestore();
  });

  it('GET /api/health says whether computer use can be offered', async () => {
    const computerUse = async (c: Container): Promise<unknown> => ((await (await createApp(c).request('/api/health')).json()) as { computerUse: unknown }).computerUse;
    expect(await computerUse(container)).toBe(true);
    driver.isAvailable = false;
    expect(await computerUse(container)).toBe(false);
    const { computer: _drop, ...without } = container;
    expect(await computerUse(without as Container)).toBe(false);
    // Still a liveness probe: no token needed.
    expect((await createApp(container, { token: 'secret-token' }).request('/api/health')).status).toBe(200);
  });

  it('GET /api/events opens with the chats in control and their last action, and nothing that was typed', async () => {
    const SECRET = 'hunter2-CorrectHorseBatteryStaple';
    const parsed = parseAction({ action: 'type', text: SECRET }, { reserved: [] });
    if (!parsed.ok) throw new Error(parsed.reason);
    const expectation = expectationOf({
      app: FAKE_COMPUTER_APP.path,
      appShellView: false,
      appWindow: FAKE_COMPUTER_APP.windowId,
      appPid: FAKE_COMPUTER_APP.pid,
      appStarted: FAKE_COMPUTER_APP.startedAt,
    })!;
    await sessions.ensureSession('chat-1', 'Budget');
    expect(await sessions.act('chat-1', parsed.action as ComputerAction, expectation)).toEqual({ ok: true });

    const stream = await createApp(container).request('/api/events');
    const reader = stream.body!.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    expect(first).toContain('event: hello');
    expect(first).toContain(`"computerSessions":[{"chatId":"chat-1","lastAction":"type ${SECRET.length} characters"}]`);
    expect(first).not.toContain(SECRET);

    await sessions.stop('chat-1');
    const live = new TextDecoder().decode((await reader.read()).value);
    expect(live).toContain('{"type":"computer-session","chatId":"chat-1","active":false}');
    await reader.cancel();

    // A window opened after the stop is told of no session.
    const later = await createApp(container).request('/api/events');
    const laterReader = later.body!.getReader();
    expect(new TextDecoder().decode((await laterReader.read()).value)).toContain('"computerSessions":[]');
    await laterReader.cancel();
  });

  it('GET /api/events says no chat is in control on a server with no event bus', async () => {
    const { events: _drop, ...without } = container;
    const stream = await createApp(without as Container).request('/api/events');
    const reader = stream.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain('"computerSessions":[]');
    await reader.cancel();
  });
});
