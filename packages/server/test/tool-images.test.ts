import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_TOOL_IMAGE_BYTES, MAX_TOOL_VIDEO_BYTES, toolImageBound, toolVideoBound } from '@otherbench/core/domain/tool-images.js';
import { TurnRunner } from '@otherbench/core/domain/turn.js';
import type { EngineEvent, EngineRequest } from '@otherbench/core/ports/chat-engine.js';
import type { Store } from '@otherbench/core/ports/store.js';
import type { ResolvedProfile } from '@otherbench/core/types/config.js';
import { FAKE_PNG } from '@otherbench/core/testing/fake-computer.js';
import { FakeChatEngine, FakeSecretStore } from '@otherbench/core/testing/fakes.js';
import { createBlobStore, sha256Of, type BlobStore } from '@otherbench/store-sqlite/blob-store.js';
import { openDatabase } from '@otherbench/store-sqlite/db.js';
import { runMigrations } from '@otherbench/store-sqlite/migrations/index.js';
import { SqliteStore } from '@otherbench/store-sqlite/store.js';
import { createApp } from '../src/app.js';
import type { Container } from '../src/container.js';
import { StreamRegistry } from '../src/stream/registry.js';
import { toolImageSaver } from '../src/tool-images.js';

/**
 * The saver against the REAL attachment repo (SQLite, with its guard that a
 * file's message is a message of the file's own chat) and a real blob store
 * on a temp folder. Only the engine is a stand-in.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00]);
const GIF = Buffer.concat([Buffer.from('GIF89a', 'latin1'), Buffer.from([1, 0, 1, 0, 0, 0, 0])]);
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom', 'latin1'), Buffer.alloc(16)]);
const WEBM = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 0x01, 0x42, 0x82, 0x84]), Buffer.from('webm', 'latin1'), Buffer.alloc(8)]);
const WEBP = Buffer.concat([Buffer.from('RIFF', 'latin1'), Buffer.from([4, 0, 0, 0]), Buffer.from('WEBP', 'latin1')]);

let dir: string;
let store: Store;
let blobStore: BlobStore;

function seed(s: Store): void {
  s.connections.create({ id: 'conn-1', name: 'Mock', kind: 'mock', baseUrl: null, secretRef: null, extraHeaders: {}, status: 'unknown', statusMessage: null, checkedAt: null });
  s.profiles.create({
    id: 'profile-1', name: 'P', description: null, colour: null, connectionId: 'conn-1', modelId: 'm', systemPrompt: null, params: {},
    toolPolicy: { fs: 'off', shell: false, mcpServerIds: [], approvalMode: 'always_ask' }, isDefault: false, archivedAt: null,
  });
  for (const id of ['chat-1', 'chat-2']) {
    s.chats.create({ id, title: id, profileId: 'profile-1', headMessageId: null, workspaceRoot: null, pinned: false, archivedAt: null });
  }
  for (const [id, chatId] of [['m1', 'chat-1'], ['m2', 'chat-2']] as const) {
    s.messages.create({ id, chatId, parentId: null, role: 'assistant', parts: [], status: 'streaming', error: null, producedBy: null });
  }
}

/** Every file under the blob root, temp files included. */
async function blobFiles(): Promise<string[]> {
  const root = join(dir, 'attachments');
  const shards = await readdir(root).catch(() => [] as string[]);
  const files: string[] = [];
  for (const shard of shards) files.push(...(await readdir(join(root, shard))));
  return files;
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'otherbench-tool-images-'));
  const db = openDatabase(':memory:');
  runMigrations(db);
  store = new SqliteStore(db);
  blobStore = createBlobStore(join(dir, 'attachments'));
  seed(store);
});

afterEach(async () => {
  vi.restoreAllMocks();
  store.close();
  await rm(dir, { recursive: true, force: true });
});

describe('toolImageSaver', () => {
  it('stores the bytes in the blob store and adds a row on exactly the chat and reply it was given', async () => {
    const id = await toolImageSaver(store, blobStore)('chat-1', 'm1', FAKE_PNG, 'image/png');
    expect(id).toMatch(UUID);
    const row = store.attachments.get(id)!;
    expect(row).toEqual({
      id,
      chatId: 'chat-1',
      messageId: 'm1',
      filename: 'tool-image.png',
      mime: 'image/png',
      size: FAKE_PNG.length,
      sha256: sha256Of(FAKE_PNG),
      storagePath: blobStore.pathFor(sha256Of(FAKE_PNG)),
      extractedText: null,
    });
    expect(await blobStore.get(row.sha256)).toEqual(FAKE_PNG);
    expect(toolImageBound(row, 'chat-1', 'm1')).toBe(true);
    expect(toolImageBound(row, 'chat-2', 'm2')).toBe(false);
  });

  it('gives every call an id of its own, the same bytes included', async () => {
    const save = toolImageSaver(store, blobStore);
    const first = await save('chat-1', 'm1', FAKE_PNG, 'image/png');
    const second = await save('chat-1', 'm1', FAKE_PNG, 'image/png');
    const third = await save('chat-2', 'm2', FAKE_PNG, 'image/png');
    expect(new Set([first, second, third]).size).toBe(3);
    for (const id of [first, second, third]) expect(id).toMatch(UUID);
    expect(store.attachments.get(third)).toMatchObject({ chatId: 'chat-2', messageId: 'm2' });
    // One blob for the three rows: storage is by content.
    expect(await blobFiles()).toEqual([sha256Of(FAKE_PNG)]);
  });

  it('names the file from a fixed table, by the type it was handed', async () => {
    const save = toolImageSaver(store, blobStore);
    const names: string[] = [];
    for (const [bytes, mime] of [[FAKE_PNG, 'image/png'], [JPEG, 'image/jpeg'], [GIF, 'image/gif'], [WEBP, 'image/webp']] as const) {
      const row = store.attachments.get(await save('chat-1', 'm1', bytes, mime))!;
      expect(row.mime).toBe(mime);
      expect(row.size).toBe(bytes.length);
      names.push(row.filename);
    }
    expect(names).toEqual(['tool-image.png', 'tool-image.jpg', 'tool-image.gif', 'tool-image.webp']);
  });

  it('stores nothing for a type that is not a raster it knows, a type the bytes are not, no bytes, or too many', async () => {
    const save = toolImageSaver(store, blobStore);
    const put = vi.spyOn(blobStore, 'put');
    const tooBig = Buffer.concat([FAKE_PNG, Buffer.alloc(MAX_TOOL_IMAGE_BYTES)]);
    const refused: [Buffer, string][] = [
      [Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), 'image/svg+xml'],
      [FAKE_PNG, 'image/svg+xml'],
      [FAKE_PNG, 'text/html'],
      [FAKE_PNG, 'image/jpeg'],
      [FAKE_PNG, 'image/png; charset=x'],
      [FAKE_PNG, 'IMAGE/PNG'],
      [Buffer.from('<html><script>alert(1)</script></html>'), 'image/png'],
      [Buffer.alloc(0), 'image/png'],
      [tooBig, 'image/png'],
    ];
    for (const [bytes, mime] of refused) await expect(save('chat-1', 'm1', bytes, mime), mime).rejects.toThrow();
    expect(put).not.toHaveBeenCalled();
    expect(store.attachments.list('chat-1')).toEqual([]);
    expect(await blobFiles()).toEqual([]);
    // Exactly at the cap is kept.
    const atCap = Buffer.concat([FAKE_PNG, Buffer.alloc(MAX_TOOL_IMAGE_BYTES - FAKE_PNG.length)]);
    expect(store.attachments.get(await save('chat-1', 'm1', atCap, 'image/png'))?.size).toBe(MAX_TOOL_IMAGE_BYTES);
  });

  it('stores an mp4 or webm under a fixed name, up to the video cap, and refuses one byte over', async () => {
    const save = toolImageSaver(store, blobStore);
    const mp4 = store.attachments.get(await save('chat-1', 'm1', MP4, 'video/mp4'))!;
    expect(mp4).toMatchObject({ filename: 'tool-video.mp4', mime: 'video/mp4', size: MP4.length });
    expect(toolVideoBound(mp4, 'chat-1', 'm1')).toBe(true);
    expect(toolImageBound(mp4, 'chat-1', 'm1')).toBe(false);
    expect(store.attachments.get(await save('chat-1', 'm1', WEBM, 'video/webm'))).toMatchObject({ filename: 'tool-video.webm', mime: 'video/webm' });
    const atCap = Buffer.concat([WEBM, Buffer.alloc(MAX_TOOL_VIDEO_BYTES - WEBM.length)]);
    expect(store.attachments.get(await save('chat-1', 'm1', atCap, 'video/webm'))?.size).toBe(MAX_TOOL_VIDEO_BYTES);
    const before = store.attachments.list('chat-1').length;
    await expect(save('chat-1', 'm1', Buffer.concat([atCap, Buffer.alloc(1)]), 'video/webm')).rejects.toThrow();
    // The wrong type for the bytes (an image said to be a video, and the other way round) is refused.
    await expect(save('chat-1', 'm1', FAKE_PNG, 'video/mp4')).rejects.toThrow();
    await expect(save('chat-1', 'm1', MP4, 'image/png')).rejects.toThrow();
    await expect(save('chat-1', 'm1', MP4, 'video/webm')).rejects.toThrow();
    await expect(save('chat-1', 'm1', Buffer.from('<html>'), 'video/mp4')).rejects.toThrow();
    expect(store.attachments.list('chat-1').length).toBe(before);
  });

  it('leaves no row behind when the blob cannot be written', async () => {
    vi.spyOn(blobStore, 'put').mockRejectedValue(Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' }));
    await expect(toolImageSaver(store, blobStore)('chat-1', 'm1', FAKE_PNG, 'image/png')).rejects.toThrow(/ENOSPC/);
    expect(store.attachments.list('chat-1')).toEqual([]);
    expect(store.attachments.isReferenced(sha256Of(FAKE_PNG))).toBe(false);
  });

  it('leaves no row and no blob behind when the repo refuses the row: a reply that does not exist, or one of another chat', async () => {
    const save = toolImageSaver(store, blobStore);
    await expect(save('chat-1', 'ghost', FAKE_PNG, 'image/png')).rejects.toThrow(/not a message of chat/);
    await expect(save('chat-1', 'm2', FAKE_PNG, 'image/png')).rejects.toThrow(/not a message of chat/);
    await expect(save('no-such-chat', 'm1', FAKE_PNG, 'image/png')).rejects.toThrow();
    expect(store.attachments.list('chat-1')).toEqual([]);
    expect(store.attachments.list('chat-2')).toEqual([]);
    expect(await blobFiles()).toEqual([]);
  });

  it('keeps a blob another row still uses when its own row is refused', async () => {
    const save = toolImageSaver(store, blobStore);
    const kept = await save('chat-1', 'm1', FAKE_PNG, 'image/png');
    await expect(save('chat-1', 'ghost', FAKE_PNG, 'image/png')).rejects.toThrow();
    expect(store.attachments.list('chat-1').map((a) => a.id)).toEqual([kept]);
    expect(await blobStore.get(sha256Of(FAKE_PNG))).toEqual(FAKE_PNG);
  });
});

// ---------------------------------------------------------------------------
// The round trip: the runner, the saver, the repo, the blob store and the
// scoped route are the real ones. The engine is scripted.

const FINISH: EngineEvent = { type: 'finish', usage: { tokensIn: 1, tokensOut: 1, tokensCached: 0, tokensReasoning: 0 }, finishReason: 'stop' };
const INLINE = { type: 'image', data: FAKE_PNG.toString('base64'), mimeType: 'image/png' };

function profile(): ResolvedProfile {
  return {
    id: 'profile-1', name: 'P', description: null, colour: null, connectionId: 'conn-1', modelId: 'm', systemPrompt: null, params: {},
    toolPolicy: { fs: 'off', shell: false, mcpServerIds: [], approvalMode: 'always_ask' }, isDefault: false, archivedAt: null,
    connection: { id: 'conn-1', name: 'Mock', kind: 'mock', baseUrl: null, secretRef: null, extraHeaders: {}, status: 'unknown', statusMessage: null, checkedAt: null },
    apiKey: null,
    model: {
      id: 'model-1', connectionId: 'conn-1', modelId: 'm', displayName: 'M', source: 'manual', supportsVision: true, supportsTools: true, supportsReasoning: false,
      contextWindow: null, maxOutput: null, priceInPer1m: null, priceOutPer1m: null, priceCachedPer1m: null, currency: 'USD',
    },
  };
}

function build(engine: FakeChatEngine): { container: Container; turnRunner: TurnRunner } {
  const turnRunner = new TurnRunner(store, engine, {
    saveToolImage: toolImageSaver(store, blobStore),
    // As the container wires it: the row, then its blob.
    loadAttachment: async (id) => blobStore.get(store.attachments.get(id)!.sha256),
  });
  const container: Container = {
    store,
    secrets: new FakeSecretStore(),
    engine,
    registry: {} as never,
    toolProvider: {} as never,
    mcpManager: {} as never,
    turnRunner,
    streamRegistry: new StreamRegistry(turnRunner, store),
    blobStore,
    close: () => {},
  };
  return { container, turnRunner };
}

const finished = (id: string) => vi.waitFor(() => expect(store.messages.get(id)?.status).toBe('complete'));
const url = (chatId: string, messageId: string, attachmentId: string) => `/api/chats/${chatId}/messages/${messageId}/tool-images/${attachmentId}`;

describe('a screenshot from a tool, from the turn to the next turn', () => {
  it('is stored for the reply, served by the scoped route to that chat only, and loaded for the model on the next turn', async () => {
    const shot: EngineEvent[] = [
      { type: 'tool-call', id: 'call-1', name: 'computer', args: { action: 'screenshot' } },
      { type: 'tool-result', id: 'call-1', name: 'computer', result: [{ type: 'text', text: 'Screenshot, 1x1.' }, INLINE], isError: false },
      FINISH,
    ];
    const engine = new FakeChatEngine((req: EngineRequest) => (req.messages.length === 1 ? shot : [FINISH]));
    const { container, turnRunner } = build(engine);
    const broadcast: unknown[] = [];
    turnRunner.on((e) => broadcast.push(e));

    const first = await turnRunner.run({ chatId: 'chat-1', parentId: null, userParts: [{ type: 'text', text: 'look' }], profiles: [profile()] });
    const replyId = first.assistantMessageIds[0]!;
    await finished(replyId);

    // The reply holds a reference, never the bytes; so did everything that was broadcast.
    const result = store.messages.get(replyId)!.parts.find((p) => p.type === 'tool-result') as { result: { type: string; attachmentId?: string; mimeType?: string }[] };
    const ref = result.result[1]!;
    expect(ref).toEqual({ type: 'image', attachmentId: expect.stringMatching(UUID), mimeType: 'image/png' });
    expect(JSON.stringify(store.messages.get(replyId))).not.toContain(INLINE.data);
    expect(JSON.stringify(broadcast)).not.toContain(INLINE.data);
    const attachmentId = ref.attachmentId!;

    // The row is the reply's own, and passes the one binding test.
    const row = store.attachments.get(attachmentId)!;
    expect(row).toMatchObject({ chatId: 'chat-1', messageId: replyId, mime: 'image/png', size: FAKE_PNG.length, filename: 'tool-image.png' });
    expect(toolImageBound(row, 'chat-1', replyId)).toBe(true);

    // The scoped route serves it for that chat and reply...
    const app = createApp(container);
    const served = await app.request(url('chat-1', replyId, attachmentId));
    expect(served.status).toBe(200);
    expect(served.headers.get('content-type')).toBe('image/png');
    expect(Buffer.from(await served.arrayBuffer())).toEqual(FAKE_PNG);
    // ...and to no other chat, and for no other reply.
    expect((await app.request(url('chat-2', replyId, attachmentId))).status).toBe(404);
    expect((await app.request(url('chat-2', 'm2', attachmentId))).status).toBe(404);
    expect((await app.request(url('chat-1', 'm1', attachmentId))).status).toBe(404);

    // The next turn: the history still names the image, and the model's loader gives its bytes back.
    const second = await turnRunner.run({ chatId: 'chat-1', parentId: replyId, userParts: [{ type: 'text', text: 'and now?' }], profiles: [profile()] });
    await finished(second.assistantMessageIds[0]!);
    const next = engine.requests[1]!;
    expect(JSON.stringify(next.messages)).toContain(attachmentId);
    expect(await next.loadToolImage!({ chatId: 'chat-1', messageId: replyId, attachmentId })).toEqual(FAKE_PNG);
    expect(next.toolImageSize!({ chatId: 'chat-1', messageId: replyId, attachmentId })).toBe(FAKE_PNG.length);
    // Not for another chat, and not as another reply's.
    expect(await next.loadToolImage!({ chatId: 'chat-2', messageId: replyId, attachmentId })).toBeNull();
    expect(await next.loadToolImage!({ chatId: 'chat-1', messageId: second.assistantMessageIds[0]!, attachmentId })).toBeNull();
  });

  it('shows a note, and stores nothing, when the image cannot be kept', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(blobStore, 'put').mockRejectedValue(Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }));
    const engine = new FakeChatEngine([{ type: 'tool-result', id: 'call-1', name: 'computer', result: [INLINE], isError: false }, FINISH]);
    const { turnRunner } = build(engine);
    const first = await turnRunner.run({ chatId: 'chat-1', parentId: null, userParts: [{ type: 'text', text: 'look' }], profiles: [profile()] });
    await finished(first.assistantMessageIds[0]!);
    const part = store.messages.get(first.assistantMessageIds[0]!)!.parts.find((p) => p.type === 'tool-result') as { result: unknown };
    expect(part.result).toEqual([{ type: 'text', text: '[image not kept]' }]);
    expect(store.attachments.list('chat-1')).toEqual([]);
  });
});
