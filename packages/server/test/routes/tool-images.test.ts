import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TurnRunner } from '@otherbench/core/domain/turn.js';
import { FAKE_PNG } from '@otherbench/core/testing/fake-computer.js';
import { FakeChatEngine, FakeSecretStore, InMemoryStore } from '@otherbench/core/testing/fakes.js';
import type { Attachment } from '@otherbench/core/ports/store.js';
import { createBlobStore } from '@otherbench/store-sqlite/blob-store.js';
import { createApp } from '../../src/app.js';
import type { Container } from '../../src/container.js';
import { StreamRegistry } from '../../src/stream/registry.js';

let container: Container;
let dataDir: string;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'otherbench-tool-image-route-test-'));
  const store = new InMemoryStore();
  const engine = new FakeChatEngine([]);
  const turnRunner = new TurnRunner(store, engine);
  container = {
    store,
    secrets: new FakeSecretStore(),
    engine,
    registry: {} as never,
    toolProvider: {} as never,
    mcpManager: {} as never,
    turnRunner,
    streamRegistry: new StreamRegistry(turnRunner, store),
    blobStore: createBlobStore(join(dataDir, 'attachments')),
    close: () => {},
  };
  for (const id of ['chat-1', 'chat-2']) {
    store.chats.create({ id, title: id, profileId: 'profile-1', headMessageId: null, workspaceRoot: null, pinned: false, archivedAt: null });
  }
  for (const [id, chatId] of [['m1', 'chat-1'], ['m1b', 'chat-1'], ['m2', 'chat-2']] as const) {
    store.messages.create({ id, chatId, parentId: null, role: 'assistant', parts: [], status: 'complete', error: null, producedBy: null });
  }
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

const app = () => createApp(container);

async function file(id: string, over: Partial<Attachment> = {}, bytes: Buffer = FAKE_PNG): Promise<void> {
  const blob = await container.blobStore.put(bytes);
  container.store.attachments.create({
    id,
    chatId: 'chat-1',
    messageId: 'm1',
    filename: `${id}.png`,
    mime: 'image/png',
    size: blob.size,
    sha256: blob.sha256,
    storagePath: blob.path,
    extractedText: null,
    ...over,
  });
}

const url = (chatId: string, messageId: string, attachmentId: string) => `/api/chats/${chatId}/messages/${messageId}/tool-images/${attachmentId}`;

describe('GET /api/chats/:chatId/messages/:messageId/tool-images/:attachmentId', () => {
  it('serves the bytes of an image stored for exactly that chat and reply, typed from the bytes, with the inert headers', async () => {
    await file('shot', { mime: 'image/png; evil=1' });
    const res = await app().request(url('chat-1', 'm1', 'shot'));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(res.headers.get('content-disposition')).toBe(`inline; filename="image.png"; filename*=UTF-8''image.png`);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('content-security-policy')).toBe("default-src 'none'; sandbox");
    expect(res.headers.get('content-length')).toBe(String(FAKE_PNG.length));
    expect(Buffer.from(await res.arrayBuffer())).toEqual(FAKE_PNG);
  });

  it('is a 404, the same for every reason, for anything that is not bound to that chat and reply', async () => {
    await file('other-chat', { chatId: 'chat-2', messageId: 'm2' });
    await file('other-reply', { messageId: 'm1b' });
    await file('ghost-message', { messageId: 'ghost' });
    await file('unsent', { messageId: null });
    await file('svg-row', { mime: 'image/svg+xml' });
    await file('html-bytes', {}, Buffer.from('<html><script>alert(1)</script></html>'));
    await file('huge-row', { size: 6 * 1024 * 1024 });
    await file('blob-gone', { sha256: 'f'.repeat(64) });
    const asked: [string, string, string][] = [
      ['chat-1', 'm1', 'other-chat'], // another chat's file through this chat's URL
      ['chat-2', 'm1', 'other-chat'], // the right file, a chat that does not hold that reply
      ['chat-1', 'm2', 'other-chat'], // a reply of another chat in this chat's URL
      ['chat-1', 'm1', 'other-reply'], // right chat, wrong reply
      ['chat-1', 'ghost', 'ghost-message'], // the reply is missing
      ['chat-1', 'm1', 'unsent'],
      ['chat-1', 'm1', 'svg-row'], // not on the raster allowlist
      ['chat-1', 'm1', 'html-bytes'], // labelled png, not a raster
      ['chat-1', 'm1', 'huge-row'],
      ['chat-1', 'm1', 'blob-gone'],
      ['chat-1', 'm1', 'no-such-file'],
      ['no-such-chat', 'm1', 'no-such-file'],
    ];
    const bodies = new Set<string>();
    for (const [chatId, messageId, attachmentId] of asked) {
      const res = await app().request(url(chatId, messageId, attachmentId));
      expect(res.status, `${chatId}/${messageId}/${attachmentId}`).toBe(404);
      bodies.add(await res.text());
    }
    expect(bodies.size).toBe(1);
    // The right file through the right chat is still served.
    expect((await app().request(url('chat-2', 'm2', 'other-chat'))).status).toBe(200);
  });
});

describe('video on the tool-images route', () => {
  const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom', 'latin1'), Buffer.from('0123456789abcdefghijklmnopqrstuvwxyz', 'latin1')]);
  const video = (id: string, over: Partial<Attachment> = {}, bytes: Buffer = MP4) => file(id, { mime: 'video/mp4', filename: 'tool-video.mp4', ...over }, bytes);

  it('is the same 404 when the message holding the file is not an assistant reply', async () => {
    container.store.messages.create({ id: 'u1', chatId: 'chat-1', parentId: null, role: 'user', parts: [], status: 'complete', error: null, producedBy: null });
    await file('on-user', { messageId: 'u1' });
    const res = await app().request(url('chat-1', 'u1', 'on-user'));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual(await (await app().request(url('chat-1', 'm1', 'nothing'))).json());
  });

  it('serves a stored mp4 typed from its bytes, with Accept-Ranges and the inert headers', async () => {
    await video('clip', { mime: 'video/mp4; evil=1' });
    const res = await app().request(url('chat-1', 'm1', 'clip'));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('video/mp4');
    expect(res.headers.get('accept-ranges')).toBe('bytes');
    expect(res.headers.get('content-disposition')).toBe(`inline; filename="video.mp4"; filename*=UTF-8''video.mp4`);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('content-security-policy')).toBe("default-src 'none'; sandbox");
    expect(res.headers.get('content-length')).toBe(String(MP4.length));
    expect(Buffer.from(await res.arrayBuffer())).toEqual(MP4);
  });

  it('answers a single range with 206, Content-Range and just those bytes', async () => {
    await video('clip');
    const get = (range: string) => app().request(url('chat-1', 'm1', 'clip'), { headers: { Range: range } });
    const first = await get('bytes=0-9');
    expect(first.status).toBe(206);
    expect(first.headers.get('content-range')).toBe(`bytes 0-9/${MP4.length}`);
    expect(first.headers.get('content-length')).toBe('10');
    expect(first.headers.get('content-type')).toBe('video/mp4');
    expect(first.headers.get('x-content-type-options')).toBe('nosniff');
    expect(first.headers.get('content-security-policy')).toBe("default-src 'none'; sandbox");
    expect(Buffer.from(await first.arrayBuffer())).toEqual(MP4.subarray(0, 10));
    const open = await get('bytes=20-');
    expect(open.status).toBe(206);
    expect(open.headers.get('content-range')).toBe(`bytes 20-${MP4.length - 1}/${MP4.length}`);
    expect(Buffer.from(await open.arrayBuffer())).toEqual(MP4.subarray(20));
    const suffix = await get('bytes=-5');
    expect(suffix.status).toBe(206);
    expect(Buffer.from(await suffix.arrayBuffer())).toEqual(MP4.subarray(MP4.length - 5));
    const clamped = await get(`bytes=10-${MP4.length + 100}`);
    expect(clamped.headers.get('content-range')).toBe(`bytes 10-${MP4.length - 1}/${MP4.length}`);
  });

  it('is a 416 with the size for a range outside the file, and a full 200 for a malformed or multiple range', async () => {
    await video('clip');
    const get = (range: string) => app().request(url('chat-1', 'm1', 'clip'), { headers: { Range: range } });
    for (const range of [`bytes=${MP4.length}-`, `bytes=${MP4.length + 5}-${MP4.length + 9}`, 'bytes=-0']) {
      const res = await get(range);
      expect(res.status, range).toBe(416);
      expect(res.headers.get('content-range'), range).toBe(`bytes */${MP4.length}`);
    }
    for (const range of ['bytes=0-1,4-5', 'bytes=abc', 'bytes=5-2', 'items=0-1', 'bytes=', 'bytes=-']) {
      const res = await get(range);
      expect(res.status, range).toBe(200);
      expect(Buffer.from(await res.arrayBuffer()), range).toEqual(MP4);
    }
  });

  it('is the same 404 for a video of another reply or chat, bytes that are not a video, or a row of the other kind', async () => {
    await video('other-reply', { messageId: 'm1b' });
    await video('other-chat', { chatId: 'chat-2', messageId: 'm2' });
    await video('html-bytes', {}, Buffer.from('<html><script>alert(1)</script></html>'));
    await video('png-bytes', {}, FAKE_PNG);
    await video('huge-row', { size: 65 * 1024 * 1024 });
    await file('image-row-video-bytes', { mime: 'image/png' }, MP4);
    const bodies = new Set<string>();
    for (const id of ['other-reply', 'other-chat', 'html-bytes', 'png-bytes', 'huge-row', 'image-row-video-bytes']) {
      const res = await app().request(url('chat-1', 'm1', id), { headers: { Range: 'bytes=0-9' } });
      expect(res.status, id).toBe(404);
      bodies.add(await res.text());
    }
    expect(bodies.size).toBe(1);
  });
});

describe('the id-only attachment routes', () => {
  it('still show an unsent upload and a file sent in its own chat (including an edit that kept its first message)', async () => {
    await file('preview', { messageId: null });
    await file('sent', { messageId: 'm1' });
    await file('kept-first', { messageId: 'm1b' });
    for (const id of ['preview', 'sent', 'kept-first']) {
      expect((await app().request(`/api/attachments/${id}`)).status, id).toBe(200);
      expect((await app().request(`/api/attachments/${id}/content`)).status, id).toBe(200);
    }
  });

  it('show an image a Cowork import made, whose id is `<line uuid>:image:<n>`, with the colons as they are or percent-encoded', async () => {
    const imported = '3f2b8c1e-9d4a-4c1b-8e7f-0a1b2c3d4e5f:image:1';
    await file(imported, { messageId: 'm1', filename: 'image-1.png' });
    for (const id of [imported, encodeURIComponent(imported)]) {
      const row = await app().request(`/api/attachments/${id}`);
      expect(row.status, id).toBe(200);
      expect(await row.json(), id).toMatchObject({ id: imported, chatId: 'chat-1', messageId: 'm1' });
      const content = await app().request(`/api/attachments/${id}/content`);
      expect(content.status, id).toBe(200);
      expect(content.headers.get('content-type'), id).toBe('image/png');
      expect(Buffer.from(await content.arrayBuffer()), id).toEqual(FAKE_PNG);
      // An import only makes user images, never a tool's; an id of this shape is carried by the scoped route all the same.
      expect((await app().request(url('chat-1', 'm1', id))).status, id).toBe(200);
    }
  });

  it("refuse a sent file whose reply is missing or in another chat, as if there were no such file", async () => {
    await file('moved', { messageId: 'm2' }); // chat-1's file on chat-2's reply
    await file('ghost', { messageId: 'ghost' });
    for (const id of ['moved', 'ghost']) {
      expect((await app().request(`/api/attachments/${id}`)).status, id).toBe(404);
      expect((await app().request(`/api/attachments/${id}/content`)).status, id).toBe(404);
    }
  });
});
