import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TurnRunner } from '@grunt/core/domain/turn.js';
import { FakeChatEngine, FakeSecretStore, InMemoryStore } from '@grunt/core/testing/fakes.js';
import { createBlobStore } from '@grunt/store-sqlite/blob-store.js';
import { createApp } from '../../src/app.js';
import type { Container } from '../../src/container.js';
import { StreamRegistry } from '../../src/stream/registry.js';

let container: Container;
let dataDir: string;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'grunt-attachments-route-test-'));
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
    blobStore: createBlobStore(dataDir),
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
