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
import { cancelChatReplies, COMPUTER_START_STOPPED_REASON, ComputerSessions } from '../../src/computer/sessions.js';
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
  sessions = new ComputerSessions(driver, {
    emit: (e) => events.emit(e),
    cancelChat: (chatId) => cancelChatReplies(events, turnRunner, chatId),
    chatExists: (chatId) => store.chats.get(chatId) !== null,
  });
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

  it('stops a chat that is in control even when its row is already gone, and still answers 404', async () => {
    const replyId = await startReply('chat-1');
    await sessions.ensureSession('chat-1', 'Budget');
    await sessions.screenshot('chat-1');
    // The row went some way that told nobody (a cascade); the safety net has not been tripped yet.
    (container.store as InMemoryStore).chats.delete('chat-1');
    expect(sessions.activeChat()).toBe('chat-1');

    expect((await post('/api/chats/chat-1/computer/stop')).status).toBe(404);

    expect(driver.ended).toEqual(['chat-1']);
    expect(sessions.activeChat()).toBeNull();
    await vi.waitFor(() => expect(container.store.messages.get(replyId)?.status).toBe('cancelled'));
    // The computer is free: another chat starts, with a dialog of its own.
    expect(await sessions.ensureSession('chat-2', 'Other')).toEqual({ ok: true });
    expect(driver.started.map((s) => s.chatId)).toEqual(['chat-1', 'chat-2']);
  });

  it('stops a chat whose start dialog is still up when its row is already gone', async () => {
    class Slow extends FakeComputerDriver {
      answer: () => void = () => {};
      override async ensureSession(chatId: string, chatTitle: string) {
        await new Promise<void>((resolve) => (this.answer = resolve));
        return super.ensureSession(chatId, chatTitle);
      }
    }
    const slow = new Slow();
    const waiting = new ComputerSessions(slow, { emit: (e) => events.emit(e), cancelChat: () => {} });
    const starting = waiting.ensureSession('chat-1', 'Budget');
    (container.store as InMemoryStore).chats.delete('chat-1');
    expect((await post('/api/chats/chat-1/computer/stop', { ...container, computer: waiting })).status).toBe(404);
    slow.answer();
    expect((await starting).ok).toBe(false);
    expect(slow.hasSession('chat-1')).toBe(false);
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

  it("a reply's own Stop (POST /api/messages/:id/cancel) while its start waits on an earlier end: no native dialog comes up afterwards", async () => {
    await sessions.ensureSession('chat-1', 'Budget');
    await sessions.screenshot('chat-1');
    // The desktop app is slow to confirm the end of the last session.
    const real = driver.endSession.bind(driver);
    let release: () => void = () => {};
    vi.spyOn(driver, 'endSession').mockImplementation(async (chatId: string) => {
      await new Promise<void>((resolve) => (release = resolve));
      return real(chatId);
    });
    const stopping = sessions.stop('chat-1');
    const replyId = await startReply('chat-1');
    // The new reply asks for control again, and waits for that end.
    const restart = sessions.ensureSession('chat-1', 'Budget');
    await new Promise((resolve) => setImmediate(resolve));

    expect((await post(`/api/messages/${replyId}/cancel`)).status).toBe(204);
    release();
    await stopping;
    expect(await restart).toEqual({ ok: false, reason: COMPUTER_START_STOPPED_REASON });
    // One dialog, for the first session; none for the reply that was stopped.
    expect(driver.started.map((s) => s.chatId)).toEqual(['chat-1']);
    expect(sessions.holder()).toBeNull();
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

  it('GET /api/computer/status says whether computer use can be offered, to a signed-in caller only', async () => {
    const status = async (c: Container): Promise<unknown> => (await createApp(c).request('/api/computer/status')).json();
    expect(await status(container)).toEqual({ computerUse: true });
    driver.isAvailable = false;
    expect(await status(container)).toEqual({ computerUse: false });
    const { computer: _drop, ...without } = container;
    expect(await status(without as Container)).toEqual({ computerUse: false });
    // A driver that can't say is "no", not a 500.
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    driver.isAvailable = true;
    vi.spyOn(driver, 'available').mockImplementation(() => {
      throw new Error('the desktop app is gone');
    });
    const res = await createApp(container).request('/api/computer/status');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ computerUse: false });
    // Behind the sign-in: with a token set, no token gets nothing.
    const gated = createApp(container, { token: 'secret-token' });
    expect((await gated.request('/api/computer/status')).status).toBe(401);
    expect((await gated.request('/api/computer/status', { headers: { Authorization: 'Bearer secret-token' } })).status).toBe(200);
    errors.mockRestore();
  });

  it('GET /api/health, which needs no sign-in, says nothing about computer use and never asks the driver', async () => {
    const available = vi.spyOn(driver, 'available').mockImplementation(() => {
      throw new Error('the desktop app is gone');
    });
    const res = await createApp(container, { token: 'secret-token' }).request('/api/health');
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['platform', 'status', 'time']);
    expect(available).not.toHaveBeenCalled();
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
