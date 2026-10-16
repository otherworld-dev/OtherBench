import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TurnRunner } from '@otherbench/core/domain/turn.js';
import { FakeChatEngine, FakeSecretStore, InMemoryStore } from '@otherbench/core/testing/fakes.js';
import { createBlobStore } from '@otherbench/store-sqlite/blob-store.js';
import { createApp } from '../../src/app.js';
import type { Container } from '../../src/container.js';
import { StreamRegistry } from '../../src/stream/registry.js';

let container: Container;
let dataDir: string;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'otherbench-attachments-route-test-'));
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
  container.store.chats.create({
    id: 'chat-1',
    title: 'Test chat',
    profileId: 'profile-1',
    headMessageId: null,
    workspaceRoot: null,
    pinned: false,
    archivedAt: null,
  });
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

function app() {
  return createApp(container);
}

function uploadForm(filename: string, content: string | Uint8Array, mime: string): FormData {
  const form = new FormData();
  form.append('file', new File([content], filename, { type: mime }));
  return form;
}

describe('POST /api/chats/:id/attachments', () => {
  it('uploads a text file, extracting its content into extractedText', async () => {
    const res = await app().request('/api/chats/chat-1/attachments', {
      method: 'POST',
      body: uploadForm('notes.txt', 'hello from a test file', 'text/plain'),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body).toMatchObject({
      chatId: 'chat-1',
      messageId: null,
      filename: 'notes.txt',
      mime: 'text/plain',
      size: 'hello from a test file'.length,
      extractedText: 'hello from a test file',
    });
    expect(typeof body.id).toBe('string');
    expect(typeof body.sha256).toBe('string');
  });

  it('leaves extractedText null for an image (no OCR is performed)', async () => {
    const res = await app().request('/api/chats/chat-1/attachments', {
      method: 'POST',
      body: uploadForm('photo.png', new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]), 'image/png'),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.extractedText).toBeNull();
    expect(body.mime).toBe('image/png');
  });

  it('uploading the SAME bytes twice creates two attachment rows that share one blob on disk', async () => {
    const content = 'identical content, uploaded twice';

    const first = await app().request('/api/chats/chat-1/attachments', {
      method: 'POST',
      body: uploadForm('a.txt', content, 'text/plain'),
    });
    const second = await app().request('/api/chats/chat-1/attachments', {
      method: 'POST',
      body: uploadForm('a-renamed-copy.txt', content, 'text/plain'),
    });

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    const firstBody = await first.json();
    const secondBody = await second.json();

    // Two distinct attachment rows...
    expect(firstBody.id).not.toBe(secondBody.id);
    // ...pointing at the exact same content-addressed blob.
    expect(firstBody.sha256).toBe(secondBody.sha256);
    expect(firstBody.storagePath).toBe(secondBody.storagePath);

    expect(container.store.attachments.list('chat-1')).toHaveLength(2);

    // And only ONE file actually exists on disk under that hash's shard dir.
    const shardDir = join(dataDir, 'attachments', firstBody.sha256.slice(0, 2));
    const entries = await readdir(shardDir);
    expect(entries).toEqual([firstBody.sha256]);
  });

  it('rejects a file over the 25MB cap with 413, and does not create an attachment row', async () => {
    const oversized = new Uint8Array(25 * 1024 * 1024 + 1);

    const res = await app().request('/api/chats/chat-1/attachments', {
      method: 'POST',
      body: uploadForm('huge.bin', oversized, 'application/octet-stream'),
    });

    expect(res.status).toBe(413);
    expect(container.store.attachments.list('chat-1')).toHaveLength(0);
  });

  describe('upload size limit is enforced before the file is read in full', () => {
    const MB = 1024 * 1024;

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('rejects an over-limit body with 413 and the usual {error} shape, without the handler ever running', async () => {
      const chatsGet = vi.spyOn(container.store.chats, 'get');
      const attachmentsCreate = vi.spyOn(container.store.attachments, 'create');
      const blobPut = vi.spyOn(container.blobStore, 'put');
      const formData = vi.spyOn(Request.prototype, 'formData');

      // Well past the cap plus multipart overhead; no Content-Length header, so
      // this exercises the streaming path.
      const res = await app().request('/api/chats/chat-1/attachments', {
        method: 'POST',
        body: uploadForm('huge.bin', new Uint8Array(27 * MB), 'application/octet-stream'),
      });

      expect(res.status).toBe(413);
      const body = (await res.json()) as { error: string };
      expect(Object.keys(body)).toEqual(['error']);
      expect(body.error).toMatch(/25MB/);
      expect(chatsGet).not.toHaveBeenCalled();
      expect(formData).not.toHaveBeenCalled();
      expect(blobPut).not.toHaveBeenCalled();
      expect(attachmentsCreate).not.toHaveBeenCalled();
      expect(container.store.attachments.list('chat-1')).toHaveLength(0);
    });

    it('rejects up front on an oversized Content-Length without reading the body', async () => {
      const formData = vi.spyOn(Request.prototype, 'formData');
      const blobPut = vi.spyOn(container.blobStore, 'put');
      const form = uploadForm('a.txt', 'tiny', 'text/plain');

      const res = await app().request('/api/chats/chat-1/attachments', {
        method: 'POST',
        headers: { 'content-length': String(40 * MB) },
        body: form,
      });

      expect(res.status).toBe(413);
      expect(await res.json()).toEqual({ error: expect.stringMatching(/25MB/) });
      expect(formData).not.toHaveBeenCalled();
      expect(blobPut).not.toHaveBeenCalled();
    });

    it('still accepts a file of exactly the cap', async () => {
      const res = await app().request('/api/chats/chat-1/attachments', {
        method: 'POST',
        body: uploadForm('max.bin', new Uint8Array(25 * MB), 'application/octet-stream'),
      });
      expect(res.status).toBe(201);
      expect(((await res.json()) as { size: number }).size).toBe(25 * MB);
    });

    it('a file one byte over the cap but inside the multipart allowance is still refused by the post-read check, with the byte-count message', async () => {
      const res = await app().request('/api/chats/chat-1/attachments', {
        method: 'POST',
        body: uploadForm('barely.bin', new Uint8Array(25 * MB + 1), 'application/octet-stream'),
      });
      expect(res.status).toBe(413);
      expect(((await res.json()) as { error: string }).error).toMatch(/is \d+ bytes, over the/);
      expect(container.store.attachments.list('chat-1')).toHaveLength(0);
    });
  });

  it('404s for an unknown chat', async () => {
    const res = await app().request('/api/chats/does-not-exist/attachments', {
      method: 'POST',
      body: uploadForm('a.txt', 'x', 'text/plain'),
    });
    expect(res.status).toBe(404);
  });

  it('400s when the "file" field is missing', async () => {
    const form = new FormData();
    form.append('not-file', 'oops');
    const res = await app().request('/api/chats/chat-1/attachments', { method: 'POST', body: form });
    expect(res.status).toBe(400);
  });
});

describe('GET /api/chats/:id/attachments', () => {
  it('lists every attachment uploaded to a chat', async () => {
    await app().request('/api/chats/chat-1/attachments', { method: 'POST', body: uploadForm('a.txt', 'A', 'text/plain') });
    await app().request('/api/chats/chat-1/attachments', { method: 'POST', body: uploadForm('b.txt', 'B', 'text/plain') });

    const res = await app().request('/api/chats/chat-1/attachments');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveLength(2);
    expect(body.map((a: { filename: string }) => a.filename).sort()).toEqual(['a.txt', 'b.txt']);
  });
});

describe('GET /api/attachments/:id', () => {
  it('returns one attachment by id', async () => {
    const created = await (await app().request('/api/chats/chat-1/attachments', { method: 'POST', body: uploadForm('a.txt', 'A', 'text/plain') })).json();

    const res = await app().request(`/api/attachments/${created.id}`);
    expect(res.status).toBe(200);
    expect((await res.json()).id).toBe(created.id);
  });

  it('404s for an unknown attachment id', async () => {
    const res = await app().request('/api/attachments/does-not-exist');
    expect(res.status).toBe(404);
  });
});

describe('GET /api/attachments/:id/content', () => {
  it('streams back the exact original bytes, forced to a download for a non-image type -- stored MIME is never trusted for inline rendering (security fix: was `text/plain` inline, is now `application/octet-stream` + attachment; nothing in the UI relied on inline text)', async () => {
    const created = await (
      await app().request('/api/chats/chat-1/attachments', { method: 'POST', body: uploadForm('a.txt', 'original bytes', 'text/plain') })
    ).json();

    const res = await app().request(`/api/attachments/${created.id}/content`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/octet-stream');
    expect(res.headers.get('content-disposition')).toMatch(/^attachment/);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(await res.text()).toBe('original bytes');
  });
});

/**
 * Regression coverage for the stored-XSS-via-attachment-serve hole: this
 * origin also hosts an API that can run shell commands (see this route's
 * module doc), so a script that executes here can call `/api/...` as the
 * user -- "uploaded a file" must never become "ran a command on the
 * machine". Every test in this block failed against the pre-fix route,
 * which served attachments with the STORED (attacker-controlled) MIME type
 * and an unconditional `Content-Disposition: inline`.
 */
describe('GET /api/attachments/:id/content -- inline-render hardening', () => {
  it('never serves an uploaded .html file as inline text/html (the actual stored-XSS vector: fetching it would have executed script in this origin)', async () => {
    const created = await (
      await app().request('/api/chats/chat-1/attachments', {
        method: 'POST',
        body: uploadForm('evil.html', '<script>fetch("/api/chats").then(r=>r.json()).then(console.log)</script>', 'text/html'),
      })
    ).json();

    const res = await app().request(`/api/attachments/${created.id}/content`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).not.toBe('text/html');
    expect(res.headers.get('content-type')).toBe('application/octet-stream');
    expect(res.headers.get('content-disposition')).toMatch(/^attachment/);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('never serves an uploaded .svg file as inline image/svg+xml -- SVG can carry <script> and is not inert like a raster image', async () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(document.cookie)</script></svg>';
    const created = await (
      await app().request('/api/chats/chat-1/attachments', {
        method: 'POST',
        body: uploadForm('evil.svg', svg, 'image/svg+xml'),
      })
    ).json();

    const res = await app().request(`/api/attachments/${created.id}/content`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).not.toBe('image/svg+xml');
    expect(res.headers.get('content-type')).toBe('application/octet-stream');
    expect(res.headers.get('content-disposition')).toMatch(/^attachment/);
  });

  it('still serves a PNG inline with its real Content-Type, so the thread/composer thumbnail preview keeps working', async () => {
    const created = await (
      await app().request('/api/chats/chat-1/attachments', {
        method: 'POST',
        body: uploadForm('photo.png', new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), 'image/png'),
      })
    ).json();

    const res = await app().request(`/api/attachments/${created.id}/content`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(res.headers.get('content-disposition')).toMatch(/^inline/);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('a filename engineered to break out of the quoted Content-Disposition value (CR/LF, quotes, a trailing backslash) cannot inject a header or malform the value', async () => {
    const nasty = 'evil".txt\r\nX-Injected: yes\r\nbackslash\\';
    const created = await (
      await app().request('/api/chats/chat-1/attachments', { method: 'POST', body: uploadForm(nasty, 'hi', 'text/plain') })
    ).json();

    const res = await app().request(`/api/attachments/${created.id}/content`);
    expect(res.status).toBe(200);
    expect(res.headers.get('x-injected')).toBeNull();
    const disposition = res.headers.get('content-disposition')!;
    expect(disposition).not.toMatch(/[\r\n]/);
    // No raw backslash anywhere: one right before the closing quote of the
    // ASCII `filename="..."` fallback would escape it under the HTTP
    // quoted-string grammar and leave the value unterminated for a strict
    // parser -- the pre-fix code only stripped CR/LF/", not backslash.
    expect(disposition).not.toContain('\\');
    expect(disposition.startsWith('attachment')).toBe(true);
  });

  it('a non-ASCII filename round-trips via the RFC 5987 filename* parameter rather than being mangled', async () => {
    const created = await (
      await app().request('/api/chats/chat-1/attachments', { method: 'POST', body: uploadForm('café ☕.txt', 'hi', 'text/plain') })
    ).json();

    const res = await app().request(`/api/attachments/${created.id}/content`);
    const disposition = res.headers.get('content-disposition')!;
    expect(disposition).toContain(`filename*=UTF-8''${encodeURIComponent('café ☕.txt')}`);
  });
});

/**
 * `storagePath` is a raw SERVER filesystem path (task 32 decision #3) -- the
 * client only ever fetches attachment bytes via `GET .../content`, never a
 * filesystem path, so it should never appear in a response body. Checked at
 * every response site that returns an `Attachment` shape: upload, list, and
 * single-get.
 */
describe('storagePath is never serialised to a client', () => {
  it('is absent from the upload (POST) response', async () => {
    const res = await app().request('/api/chats/chat-1/attachments', {
      method: 'POST',
      body: uploadForm('a.txt', 'hello', 'text/plain'),
    });
    const body = await res.json();

    expect(body).not.toHaveProperty('storagePath');
    expect(JSON.stringify(body)).not.toContain('storagePath');
  });

  it('is absent from the list (GET /chats/:id/attachments) response', async () => {
    await app().request('/api/chats/chat-1/attachments', { method: 'POST', body: uploadForm('a.txt', 'hello', 'text/plain') });

    const res = await app().request('/api/chats/chat-1/attachments');
    const body = await res.json();

    expect(JSON.stringify(body)).not.toContain('storagePath');
    expect(body).toHaveLength(1);
    expect(body[0]).not.toHaveProperty('storagePath');
  });

  it('is absent from the single-get (GET /attachments/:id) response', async () => {
    const created = await (
      await app().request('/api/chats/chat-1/attachments', { method: 'POST', body: uploadForm('a.txt', 'hello', 'text/plain') })
    ).json();

    const res = await app().request(`/api/attachments/${created.id}`);
    const body = await res.json();

    expect(body).not.toHaveProperty('storagePath');
    expect(JSON.stringify(body)).not.toContain('storagePath');
  });
});

/**
 * Task 32 decision #1: `DELETE /api/attachments/:id` only ever deletes an
 * UNSENT attachment (`messageId === null`). Deleting one that's already
 * part of a sent message would make the transcript misrepresent what was
 * actually sent -- refused with 409 instead. Deleting an unsent one removes
 * the row and then GCs its blob, unless some OTHER row (dedupe: even across
 * chats) still shares the same sha256 -- decision #1's whole point.
 */
describe('DELETE /api/attachments/:id', () => {
  it('removes an unsent attachment\'s row AND its blob file on disk', async () => {
    const created = await (
      await app().request('/api/chats/chat-1/attachments', { method: 'POST', body: uploadForm('a.txt', 'delete me', 'text/plain') })
    ).json();
    const blobPath = join(dataDir, 'attachments', created.sha256.slice(0, 2), created.sha256);
    await expect(stat(blobPath)).resolves.toBeTruthy();

    const res = await app().request(`/api/attachments/${created.id}`, { method: 'DELETE' });

    expect(res.status).toBe(204);
    expect(container.store.attachments.get(created.id)).toBeNull();
    await expect(stat(blobPath)).rejects.toThrow();
  });

  it('keeps the blob alive while a SECOND attachment row (in a different chat) still shares its sha256; removing that one too finally removes the blob', async () => {
    container.store.chats.create({
      id: 'chat-2', title: 'Second chat', profileId: 'profile-1', headMessageId: null,
      workspaceRoot: null, pinned: false, archivedAt: null,
    });
    const content = 'shared content across two chats';
    const first = await (
      await app().request('/api/chats/chat-1/attachments', { method: 'POST', body: uploadForm('a.txt', content, 'text/plain') })
    ).json();
    const second = await (
      await app().request('/api/chats/chat-2/attachments', { method: 'POST', body: uploadForm('a-copy.txt', content, 'text/plain') })
    ).json();
    expect(first.sha256).toBe(second.sha256);
    const blobPath = join(dataDir, 'attachments', first.sha256.slice(0, 2), first.sha256);

    const firstDelete = await app().request(`/api/attachments/${first.id}`, { method: 'DELETE' });
    expect(firstDelete.status).toBe(204);
    // Still referenced by `second` -- the blob must survive.
    await expect(stat(blobPath)).resolves.toBeTruthy();

    const secondDelete = await app().request(`/api/attachments/${second.id}`, { method: 'DELETE' });
    expect(secondDelete.status).toBe(204);
    await expect(stat(blobPath)).rejects.toThrow();
  });

  it('409s for an attachment already sent as part of a message, leaving its row and blob untouched', async () => {
    const created = await (
      await app().request('/api/chats/chat-1/attachments', { method: 'POST', body: uploadForm('a.txt', 'already sent', 'text/plain') })
    ).json();
    container.store.attachments.update(created.id, { messageId: 'msg-1' });
    const blobPath = join(dataDir, 'attachments', created.sha256.slice(0, 2), created.sha256);

    const res = await app().request(`/api/attachments/${created.id}`, { method: 'DELETE' });

    expect(res.status).toBe(409);
    expect(container.store.attachments.get(created.id)).not.toBeNull();
    await expect(stat(blobPath)).resolves.toBeTruthy();
  });

  it('404s for an unknown attachment id', async () => {
    const res = await app().request('/api/attachments/does-not-exist', { method: 'DELETE' });
    expect(res.status).toBe(404);
  });

  /**
   * Task 32 fix round 1, Critical 1: before this, NOTHING ever set
   * `attachment.messageId` in production -- the only place that did was
   * this very test file, setting it BY HAND. This test sends a real turn
   * through the real route (`POST /chats/:id/turns`, which drives the real
   * `TurnRunner.run`) instead, so it fails against the pre-fix code (the
   * attachment stays `messageId: null` and DELETE wrongly succeeds).
   */
  it('409s for an attachment actually sent via POST /chats/:id/turns -- no hand-set messageId', async () => {
    container.store.connections.create({
      id: 'conn-1', name: 'Conn', kind: 'mock', baseUrl: null, secretRef: null,
      extraHeaders: {}, status: 'unknown', statusMessage: null, checkedAt: null,
    });
    container.store.profiles.create({
      id: 'profile-1', name: 'Profile', description: null, colour: null, connectionId: 'conn-1', modelId: 'mock-standard',
      systemPrompt: null, params: {}, toolPolicy: { fs: 'off', shell: false, mcpServerIds: [], approvalMode: 'always_ask' },
      isDefault: false, archivedAt: null,
    });
    const created = await (
      await app().request('/api/chats/chat-1/attachments', { method: 'POST', body: uploadForm('a.txt', 'sent for real', 'text/plain') })
    ).json();
    const blobPath = join(dataDir, 'attachments', created.sha256.slice(0, 2), created.sha256);

    const turnRes = await app().request('/api/chats/chat-1/turns', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        parentId: null,
        parts: [{ type: 'file', attachmentId: created.id, mime: 'text/plain', filename: 'a.txt' }],
        profileIds: ['profile-1'],
      }),
    });
    expect(turnRes.status).toBe(202);
    // The real turn actually bound it -- not a hand-set messageId.
    expect(container.store.attachments.get(created.id)?.messageId).not.toBeNull();

    const res = await app().request(`/api/attachments/${created.id}`, { method: 'DELETE' });

    expect(res.status).toBe(409);
    expect(container.store.attachments.get(created.id)).not.toBeNull();
    await expect(stat(blobPath)).resolves.toBeTruthy();
  });

  it('400s when a turn\'s part references an attachment belonging to a DIFFERENT chat', async () => {
    container.store.connections.create({
      id: 'conn-1', name: 'Conn', kind: 'mock', baseUrl: null, secretRef: null,
      extraHeaders: {}, status: 'unknown', statusMessage: null, checkedAt: null,
    });
    container.store.profiles.create({
      id: 'profile-1', name: 'Profile', description: null, colour: null, connectionId: 'conn-1', modelId: 'mock-standard',
      systemPrompt: null, params: {}, toolPolicy: { fs: 'off', shell: false, mcpServerIds: [], approvalMode: 'always_ask' },
      isDefault: false, archivedAt: null,
    });
    container.store.chats.create({
      id: 'chat-2', title: 'Other chat', profileId: 'profile-1', headMessageId: null,
      workspaceRoot: null, pinned: false, archivedAt: null,
    });
    const created = await (
      await app().request('/api/chats/chat-2/attachments', { method: 'POST', body: uploadForm('a.txt', 'wrong chat', 'text/plain') })
    ).json();

    const turnRes = await app().request('/api/chats/chat-1/turns', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        parentId: null,
        parts: [{ type: 'file', attachmentId: created.id, mime: 'text/plain', filename: 'a.txt' }],
        profileIds: ['profile-1'],
      }),
    });

    expect(turnRes.status).toBe(400);
    expect(container.store.attachments.get(created.id)?.messageId).toBeNull();
  });
});

describe('POST /api/chats/:id/attachments/from-path (Task 39)', () => {
  const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

  function fromPath(path: unknown, contentType = 'application/json') {
    return app().request('/api/chats/chat-1/attachments/from-path', {
      method: 'POST',
      headers: { 'Content-Type': contentType },
      body: JSON.stringify({ path }),
    });
  }

  it('attaches an image from a local path as an unsent attachment, typed by its extension', async () => {
    const { writeFile } = await import('node:fs/promises');
    const file = join(dataDir, 'Screen Shot.PNG');
    await writeFile(file, PNG);
    const res = await fromPath(file);
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ chatId: 'chat-1', messageId: null, filename: 'Screen Shot.PNG', mime: 'image/png', size: PNG.length });
    expect(body).not.toHaveProperty('storagePath');
  });

  it('refuses anything that is not an image, a relative path, a missing file and a folder', async () => {
    const { mkdir, writeFile } = await import('node:fs/promises');
    await writeFile(join(dataDir, 'notes.txt'), 'hello');
    await mkdir(join(dataDir, 'folder.png'));
    expect((await fromPath(join(dataDir, 'notes.txt'))).status).toBe(415);
    expect((await fromPath(join(dataDir, 'page.svg'))).status).toBe(415);
    expect((await fromPath('relative/pic.png')).status).toBe(400);
    expect((await fromPath(join(dataDir, 'missing.png'))).status).toBe(404);
    expect((await fromPath(join(dataDir, 'folder.png'))).status).toBe(400);
    expect(container.store.attachments.list('chat-1')).toEqual([]);
  });

  it('refuses a file named like an image whose bytes are not that image', async () => {
    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(dataDir, 'secrets.png'), 'API_KEY=sk-not-an-image');
    await writeFile(join(dataDir, 'really-a-gif.png'), 'GIF89a....');
    const res = await fromPath(join(dataDir, 'secrets.png'));
    expect(res.status).toBe(415);
    expect(((await res.json()) as { error: string }).error).toContain("doesn't look like a PNG image");
    expect((await fromPath(join(dataDir, 'really-a-gif.png'))).status).toBe(415);
    expect(container.store.attachments.list('chat-1')).toEqual([]);
  });

  it('refuses a link named like an image that leads to something else', async (ctx) => {
    const { symlink, writeFile } = await import('node:fs/promises');
    await writeFile(join(dataDir, 'notes.txt'), 'private notes');
    try {
      await symlink(join(dataDir, 'notes.txt'), join(dataDir, 'innocent.png'), 'file');
    } catch {
      ctx.skip(); // creating file symlinks needs Developer Mode or admin on Windows
    }
    const res = await fromPath(join(dataDir, 'innocent.png'));
    expect(res.status).toBe(415);
    expect(container.store.attachments.list('chat-1')).toEqual([]);
  });

  it('refuses a file over the 25MB cap without reading it, and a non-JSON body', async () => {
    const { open } = await import('node:fs/promises');
    const big = join(dataDir, 'big.png');
    const handle = await open(big, 'w');
    await handle.truncate(25 * 1024 * 1024 + 1); // sparse: no 25MB actually written
    await handle.close();
    const res = await fromPath(big);
    expect(res.status).toBe(413);
    expect(((await res.json()) as { error: string }).error).toContain('25MB');

    expect((await fromPath(big, 'text/plain')).status).toBe(415);
  });

  it('404s for an unknown chat', async () => {
    const res = await app().request('/api/chats/nope/attachments/from-path', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: join(dataDir, 'x.png') }),
    });
    expect(res.status).toBe(404);
  });
});
