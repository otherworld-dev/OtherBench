import { beforeEach, describe, expect, it } from 'vitest';
import { TurnRunner } from '@otherbench/core/domain/turn.js';
import { FakeSecretStore, InMemoryStore } from '@otherbench/core/testing/fakes.js';
import type { ChatEngine, EngineEvent, EngineRequest } from '@otherbench/core/ports/chat-engine.js';
import type { ReplyNote } from '@otherbench/core/types/notes.js';
import { createApp } from '../../src/app.js';
import type { Container } from '../../src/container.js';
import { NotesService } from '../../src/notes/service.js';
import { resolveProfile } from '../../src/profile-resolution.js';
import { COMMAND_MID_REPLY } from '../../src/routes/notes.js';
import { StreamRegistry } from '../../src/stream/registry.js';
import { startTurn } from '../../src/turn-start.js';

/** A ChatEngine whose replies run until the test ends them (as in turns.test.ts). It can't take a note into a reply, so notes wait. */
function manualEngine(): { engine: ChatEngine; push: (messageId: string, event: EngineEvent | null) => void } {
  const channels = new Map<string, { queued: (EngineEvent | null)[]; waiters: ((event: EngineEvent | null) => void)[] }>();
  const channelFor = (messageId: string) => {
    let ch = channels.get(messageId);
    if (!ch) {
      ch = { queued: [], waiters: [] };
      channels.set(messageId, ch);
    }
    return ch;
  };
  const engine: ChatEngine = {
    async *stream(req: EngineRequest): AsyncIterable<EngineEvent> {
      const ch = channelFor(req.messageId);
      while (true) {
        if (req.signal.aborted) return;
        const event = await new Promise<EngineEvent | null>((resolve) => {
          if (ch.queued.length > 0) {
            resolve(ch.queued.shift() as EngineEvent | null);
            return;
          }
          const onAbort = (): void => resolve(null);
          req.signal.addEventListener('abort', onAbort, { once: true });
          ch.waiters.push((e) => {
            req.signal.removeEventListener('abort', onAbort);
            resolve(e);
          });
        });
        if (event === null || req.signal.aborted) return;
        yield event;
        if (event.type === 'finish' || event.type === 'error') return;
      }
    },
    listModels: async () => [],
    testConnection: async () => ({ ok: true, message: 'ok', latencyMs: 0 }),
  };
  const push = (messageId: string, event: EngineEvent | null): void => {
    const ch = channelFor(messageId);
    const waiter = ch.waiters.shift();
    if (waiter) waiter(event);
    else ch.queued.push(event);
  };
  return { engine, push };
}

/** Reads SSE records from a response until one arrives with the given event name. */
async function readUntil(res: Response, eventName: string): Promise<unknown> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) throw new Error(`the stream ended before a "${eventName}" event`);
      buffer += decoder.decode(value, { stream: true });
      let end: number;
      while ((end = buffer.indexOf('\n\n')) !== -1) {
        const record = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        if (/^event: (.*)$/m.exec(record)?.[1] === eventName) return JSON.parse(/^data: (.*)$/m.exec(record)![1]!);
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
}

let container: Container;
let push: (messageId: string, event: EngineEvent | null) => void;

beforeEach(() => {
  const store = new InMemoryStore();
  const manual = manualEngine();
  push = manual.push;
  let notes: NotesService | null = null;
  // As the container wires it.
  const turnRunner = new TurnRunner(store, manual.engine, {
    takeNote: (messageId, noteId) => notes?.take(messageId, noteId) ?? null,
    heldAttachment: (attachmentId, chatId) => notes?.heldAttachmentIds(chatId).includes(attachmentId) ?? false,
  });
  const streamRegistry = new StreamRegistry(turnRunner, store);
  container = {
    store,
    secrets: new FakeSecretStore(),
    engine: manual.engine,
    registry: {} as never,
    toolProvider: {} as never,
    mcpManager: {} as never,
    turnRunner,
    streamRegistry,
    blobStore: {} as never,
    close: () => {},
  };
  notes = new NotesService({
    store,
    turnRunner,
    engine: manual.engine,
    streamRegistry,
    startTurn: (input) => startTurn(container, input),
    resolveProfile: (id) => resolveProfile(container, id),
  });
  container.notes = notes;
  turnRunner.on((e) => {
    if (e.type === 'status' && e.status !== 'streaming') notes.replyEnded(e.messageId, e.status);
  });

  store.connections.create({ id: 'conn-1', name: 'Conn', kind: 'mock', baseUrl: null, secretRef: null, extraHeaders: {}, status: 'unknown', statusMessage: null, checkedAt: null });
  store.profiles.create({
    id: 'profile-1', name: 'P', description: null, colour: null, connectionId: 'conn-1', modelId: 'model-x', systemPrompt: null, params: {},
    toolPolicy: { fs: 'off', shell: false, mcpServerIds: [], approvalMode: 'always_ask' }, isDefault: true, archivedAt: null,
  });
  for (const id of ['chat-1', 'chat-2']) {
    store.chats.create({ id, title: 'Chat', profileId: 'profile-1', headMessageId: null, workspaceRoot: null, pinned: false, archivedAt: null });
  }
  const attachment = (id: string, chatId: string, filename: string, mime: string) =>
    store.attachments.create({ id, chatId, messageId: null, filename, mime, size: 10, sha256: id, storagePath: id, extractedText: null });
  attachment('att-1', 'chat-1', 'shot.png', 'image/png');
  attachment('att-2', 'chat-1', 'spec.pdf', 'application/pdf');
  attachment('att-other', 'chat-2', 'theirs.png', 'image/png');
});

const FINISH: EngineEvent = { type: 'finish', usage: { tokensIn: 1, tokensOut: 1, tokensCached: 0, tokensReasoning: 0 }, finishReason: 'stop' };

function request(method: string, path: string, body?: unknown): Promise<Response> {
  return createApp(container).request(path, { method, headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}

/** Starts a reply in chat-1 that runs until the test ends it. */
async function running(): Promise<{ userMessageId: string; replyId: string }> {
  const res = await request('POST', '/api/chats/chat-1/turns', { parts: [{ type: 'text', text: 'do the work' }], profileIds: ['profile-1'] });
  expect(res.status).toBe(202);
  const { userMessageId, assistantMessageIds } = (await res.json()) as { userMessageId: string; assistantMessageIds: string[] };
  return { userMessageId, replyId: assistantMessageIds[0]! };
}

function postNote(body: Record<string, unknown>, chatId = 'chat-1'): Promise<Response> {
  return request('POST', `/api/chats/${chatId}/notes`, { text: 'and the tests', parentId: null, profileIds: ['profile-1'], clientId: 'tab-1', ...body });
}

describe('POST /api/chats/:id/notes', () => {
  it('posts a note to a busy chat and lists it in hello', async () => {
    const { replyId } = await running();

    const res = await postNote({ parentId: replyId });

    expect(res.status).toBe(202);
    const { note } = (await res.json()) as { note: ReplyNote };
    expect(note).toMatchObject({ chatId: 'chat-1', text: 'and the tests', attachments: [], path: 'wait', replyIds: [replyId], parentId: replyId, profileIds: ['profile-1'], clientId: 'tab-1' });
    const hello = (await readUntil(await request('GET', '/api/chats/chat-1/stream'), 'hello')) as { notes: ReplyNote[]; noteOutcomes: unknown[] };
    expect(hello.notes).toEqual([note]);
    expect(hello.noteOutcomes).toEqual([]);
  });

  it('409 idle for a quiet chat', async () => {
    const res = await postNote({});

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ kind: 'idle' });
    expect(container.notes!.hasWaiting('chat-1')).toBe(false);
  });

  it('409 command for /clear mid-reply', async () => {
    container.store.connections.update('conn-1', { kind: 'claude_code' });
    const { replyId } = await running();

    for (const text of ['/clear', ' /compact focus on tests', '/clear and more']) {
      const res = await postNote({ text, parentId: replyId });
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ kind: 'command', error: COMMAND_MID_REPLY });
    }
    expect(COMMAND_MID_REPLY).toBe('Wait for the reply to finish, or stop it, before sending a command.');
    expect(container.notes!.hasWaiting('chat-1')).toBe(false);
  });

  it('takes the attachments as stored, whatever the client says they are', async () => {
    await running();

    const res = await postNote({ text: '', attachments: [{ attachmentId: 'att-1', mime: 'text/html', filename: 'evil.html' }, { attachmentId: 'att-2' }] });

    expect(res.status).toBe(202);
    const { note } = (await res.json()) as { note: ReplyNote };
    expect(note.attachments).toEqual([
      { attachmentId: 'att-1', mime: 'image/png', filename: 'shot.png' },
      { attachmentId: 'att-2', mime: 'application/pdf', filename: 'spec.pdf' },
    ]);
  });

  it("400 for another chat's attachment, an unknown one, a sent one, or one already on a waiting note", async () => {
    const { userMessageId } = await running();
    container.store.attachments.create({ id: 'att-sent', chatId: 'chat-1', messageId: userMessageId, filename: 'old.png', mime: 'image/png', size: 1, sha256: 's', storagePath: 's', extractedText: null });
    expect((await postNote({ attachments: [{ attachmentId: 'att-1' }] })).status).toBe(202);

    for (const id of ['att-other', 'att-missing', 'att-sent', 'att-1']) {
      const res = await postNote({ attachments: [{ attachmentId: id }] });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toContain(`"${id}"`);
    }
    const twice = await postNote({ attachments: [{ attachmentId: 'att-2' }, { attachmentId: 'att-2' }] });
    expect(twice.status).toBe(400);
    expect(container.notes!.helloState('chat-1').notes).toHaveLength(1);
  });

  it('two notes sent at once with the same attachment: only one holds it', async () => {
    await running();
    // Resolving the profile reads its key: both requests are past their attachment checks before either is sent.
    container.store.connections.update('conn-1', { secretRef: 'key-1' });
    container.secrets.get = async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return 'sk-test';
    };

    const results = await Promise.all([postNote({ attachments: [{ attachmentId: 'att-1' }] }), postNote({ attachments: [{ attachmentId: 'att-1' }] })]);

    expect(results.map((r) => r.status).sort()).toEqual([202, 400]);
    const refused = results.find((r) => r.status === 400)!;
    expect(((await refused.json()) as { error: string }).error).toContain('"att-1"');
    expect(container.notes!.heldAttachmentIds('chat-1')).toEqual(['att-1']);
  });

  it('400 for bad fields', async () => {
    const { replyId } = await running();
    const bad: Record<string, unknown>[] = [
      { text: undefined },
      { text: 42 },
      { text: '' },
      { text: '   ' },
      { clientId: '' },
      { clientId: undefined },
      { profileIds: [] },
      { profileIds: [3] },
      { profileIds: 'profile-1' },
      { parentId: undefined },
      { parentId: 7 },
      { parentId: 'not-a-message' },
      { attachments: 'att-1' },
      { attachments: [{ id: 'att-1' }] },
    ];
    for (const fields of bad) {
      const res = await postNote({ parentId: replyId, ...fields });
      expect(res.status, JSON.stringify(fields)).toBe(400);
    }
    expect(container.notes!.hasWaiting('chat-1')).toBe(false);
  });

  it('409 workspace_unresolved, as turns are', async () => {
    container.store.chats.create({ id: 'remote', title: 'T', profileId: 'profile-1', headMessageId: null, workspace: { kind: 'machine', nodeId: 'node-elsewhere', root: '/x' }, pinned: false, archivedAt: null });

    const res = await postNote({}, 'remote');

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ kind: 'workspace_unresolved' });
  });

  it('404 for an unknown chat', async () => {
    expect((await postNote({}, 'nope')).status).toBe(404);
    expect((await request('DELETE', '/api/chats/nope/notes/n1')).status).toBe(404);
  });
});

describe('DELETE /api/chats/:id/notes/:noteId', () => {
  it('DELETE returns the note, then 409 read', async () => {
    await running();
    const { note } = (await (await postNote({ attachments: [{ attachmentId: 'att-1' }] })).json()) as { note: ReplyNote };

    const res = await request('DELETE', `/api/chats/chat-1/notes/${note.id}`);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ note });
    expect(container.notes!.hasWaiting('chat-1')).toBe(false);
    // Its attachment is the composer's again.
    expect(container.notes!.heldAttachmentIds('chat-1')).toEqual([]);

    const again = await request('DELETE', `/api/chats/chat-1/notes/${note.id}`);
    expect(again.status).toBe(409);
    expect(await again.json()).toEqual({ kind: 'read' });
  });
});

describe('POST /api/chats/:id/turns while notes wait', () => {
  it('POST turns is refused while notes wait', async () => {
    const { replyId } = await running();
    expect((await postNote({ parentId: replyId })).status).toBe(202);

    const res = await request('POST', '/api/chats/chat-1/turns', { parentId: replyId, parts: [{ type: 'text', text: 'another' }], profileIds: ['profile-1'] });

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ kind: 'notes-waiting', error: 'Messages you sent are still waiting for this reply.' });
    expect(container.store.messages.children(replyId)).toEqual([]);

    // The reply ends: the note goes out as the next turn, and a turn is accepted again once that one has.
    push(replyId, FINISH);
    await expect.poll(() => container.store.messages.children(replyId).map((m) => m.parts)).toEqual([[{ type: 'text', text: 'and the tests' }]]);
    await expect.poll(() => container.notes!.hasWaiting('chat-1')).toBe(false);
  });

  it('regenerate and retry are refused while notes wait', async () => {
    const store = container.store;
    const producedBy = { profileId: 'profile-1', profileName: 'P', connectionId: 'conn-1', modelId: 'model-x' };
    store.messages.create({ id: 'u0', chatId: 'chat-1', parentId: null, role: 'user', parts: [{ type: 'text', text: 'hi' }], status: 'complete', error: null, producedBy: null });
    store.messages.create({ id: 'a0', chatId: 'chat-1', parentId: 'u0', role: 'assistant', parts: [{ type: 'text', text: 'Hello.' }], status: 'complete', error: null, producedBy });
    store.messages.create({ id: 'u1', chatId: 'chat-1', parentId: 'a0', role: 'user', parts: [{ type: 'text', text: 'more' }], status: 'complete', error: null, producedBy: null });
    store.messages.create({ id: 'a1', chatId: 'chat-1', parentId: 'u1', role: 'assistant', parts: [], status: 'error', error: { kind: 'unknown', message: 'boom', retryable: true }, producedBy });
    const res = await request('POST', '/api/chats/chat-1/turns', { parentId: 'a0', parts: [{ type: 'text', text: 'do the work' }], profileIds: ['profile-1'] });
    const replyId = ((await res.json()) as { assistantMessageIds: string[] }).assistantMessageIds[0]!;
    expect((await postNote({ parentId: replyId })).status).toBe(202);
    const refused = { kind: 'notes-waiting', error: 'Messages you sent are still waiting for this reply.' };

    const regenerate = await request('POST', '/api/chats/chat-1/regenerate', { messageId: 'a0' });
    expect(regenerate.status).toBe(409);
    expect(await regenerate.json()).toEqual(refused);

    const retry = await request('POST', '/api/messages/a1/retry');
    expect(retry.status).toBe(409);
    expect(await retry.json()).toEqual(refused);

    expect(store.messages.children('u0').map((m) => m.id)).toEqual(['a0']);
    expect(store.messages.get('a1')!.status).toBe('error');
  });

  it('a reply running with no notes waiting does not refuse a turn', async () => {
    const { replyId } = await running();

    const res = await request('POST', '/api/chats/chat-1/turns', { parentId: replyId, parts: [{ type: 'text', text: 'another' }], profileIds: ['profile-1'] });

    expect(res.status).toBe(202);
  });
});
