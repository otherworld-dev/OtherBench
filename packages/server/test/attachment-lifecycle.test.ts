import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { createContainer, type Container } from '../src/container.js';

/**
 * Integration coverage for task 32's blob-GC-on-cascade decision (#2b):
 * `DELETE /api/chats/:id`, `DELETE /api/profiles/:id`, and
 * `DELETE /api/connections/:id` all cascade attachment rows away in real
 * SQLite (`ON DELETE CASCADE`) -- something `InMemoryStore` deliberately
 * does NOT emulate (see fakes.ts), so this needs a REAL container over a
 * real (if temp-dir-backed) SQLite database and a real on-disk `BlobStore`,
 * not the `InMemoryStore` + placeholder `blobStore` most route tests use.
 */

let dir: string;
let container: Container;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'grunt-attachment-lifecycle-test-'));
  container = await createContainer({
    dbPath: join(dir, 'grunt.db'),
    secretsPath: join(dir, 'secrets.json'),
  });
});

afterEach(async () => {
  container.close();
  await rm(dir, { recursive: true, force: true });
});

function app() {
  return createApp(container);
}

function uploadForm(filename: string, content: string, mime: string): FormData {
  const form = new FormData();
  form.append('file', new File([content], filename, { type: mime }));
  return form;
}

async function createConnectionModelProfile(id: string): Promise<{ connectionId: string; modelId: string; profileId: string }> {
  const connectionId = `${id}::conn`;
  const modelId = `${id}::model`;
  const profileId = `${id}::profile`;
  container.store.connections.create({
    id: connectionId, name: 'Test Connection', kind: 'mock', baseUrl: null, secretRef: null,
    extraHeaders: {}, status: 'unknown', statusMessage: null, checkedAt: null,
  });
  container.store.models.create({
    id: modelId, connectionId, modelId: 'mock-standard', displayName: 'Mock', source: 'manual',
    supportsVision: false, supportsTools: false, supportsReasoning: false, contextWindow: null,
    maxOutput: null, priceInPer1m: null, priceOutPer1m: null, priceCachedPer1m: null, currency: 'USD',
  });
  container.store.profiles.create({
    id: profileId, name: 'Test Profile', description: null, colour: null, connectionId, modelId,
    systemPrompt: null, params: {}, toolPolicy: { fs: 'off', shell: false, mcpServerIds: [], approvalMode: 'always_ask' },
    isDefault: false, archivedAt: null,
  });
  return { connectionId, modelId, profileId };
}

async function createChat(profileId: string, id: string): Promise<void> {
  container.store.chats.create({
    id, title: 'Test chat', profileId, headMessageId: null, workspaceRoot: null, pinned: false, archivedAt: null,
  });
}

// dbPath is join(dir, 'grunt.db'), so its derived per-database write root
// (resolveAttachmentsRoots, blob-store.ts) is join(dir, 'grunt.attachments').
function blobPathFor(sha256: string): string {
  return join(dir, 'grunt.attachments', sha256.slice(0, 2), sha256);
}

describe('deleting a chat with attachments leaves no orphan blobs afterwards', () => {
  it('removes the blob once the chat (and its cascaded attachment row) is gone', async () => {
    const { profileId } = await createConnectionModelProfile('p1');
    await createChat(profileId, 'chat-1');
    const created = await (
      await app().request('/api/chats/chat-1/attachments', { method: 'POST', body: uploadForm('a.txt', 'chat-scoped content', 'text/plain') })
    ).json();
    const blobPath = blobPathFor(created.sha256);
    await expect(stat(blobPath)).resolves.toBeTruthy();

    const res = await app().request('/api/chats/chat-1', { method: 'DELETE' });

    expect(res.status).toBe(204);
    expect(container.store.chats.get('chat-1')).toBeNull();
    expect(container.store.attachments.get(created.id)).toBeNull(); // cascaded away
    await expect(stat(blobPath)).rejects.toThrow();
  });

  it('keeps the blob alive while a SECOND chat still has an attachment row referencing it; deleting that chat too finally removes it', async () => {
    const { profileId } = await createConnectionModelProfile('p1');
    await createChat(profileId, 'chat-1');
    await createChat(profileId, 'chat-2');
    const content = 'shared across two chats';
    const first = await (
      await app().request('/api/chats/chat-1/attachments', { method: 'POST', body: uploadForm('a.txt', content, 'text/plain') })
    ).json();
    const second = await (
      await app().request('/api/chats/chat-2/attachments', { method: 'POST', body: uploadForm('a-copy.txt', content, 'text/plain') })
    ).json();
    expect(first.sha256).toBe(second.sha256);
    const blobPath = blobPathFor(first.sha256);

    const firstDelete = await app().request('/api/chats/chat-1', { method: 'DELETE' });
    expect(firstDelete.status).toBe(204);
    await expect(stat(blobPath)).resolves.toBeTruthy(); // chat-2's row still references it

    const secondDelete = await app().request('/api/chats/chat-2', { method: 'DELETE' });
    expect(secondDelete.status).toBe(204);
    await expect(stat(blobPath)).rejects.toThrow();
  });
});

describe('deleting a profile cascades its chats\' attachments and GCs the orphaned blob', () => {
  it('removes the blob once the profile (and its cascaded chat + attachment rows) is gone', async () => {
    const { profileId } = await createConnectionModelProfile('p1');
    await createChat(profileId, 'chat-1');
    const created = await (
      await app().request('/api/chats/chat-1/attachments', { method: 'POST', body: uploadForm('a.txt', 'profile-cascade content', 'text/plain') })
    ).json();
    const blobPath = blobPathFor(created.sha256);
    await expect(stat(blobPath)).resolves.toBeTruthy();

    const res = await app().request(`/api/profiles/${profileId}`, { method: 'DELETE' });

    expect(res.status).toBe(204);
    expect(container.store.chats.get('chat-1')).toBeNull();
    expect(container.store.attachments.get(created.id)).toBeNull();
    await expect(stat(blobPath)).rejects.toThrow();
  });
});

describe('deleting a connection cascades its profiles/chats\' attachments and GCs the orphaned blob', () => {
  it('removes the blob once the connection (and its cascaded profile + chat + attachment rows) is gone', async () => {
    const { connectionId, profileId } = await createConnectionModelProfile('p1');
    await createChat(profileId, 'chat-1');
    const created = await (
      await app().request('/api/chats/chat-1/attachments', { method: 'POST', body: uploadForm('a.txt', 'connection-cascade content', 'text/plain') })
    ).json();
    const blobPath = blobPathFor(created.sha256);
    await expect(stat(blobPath)).resolves.toBeTruthy();

    const res = await app().request(`/api/connections/${connectionId}`, { method: 'DELETE' });

    expect(res.status).toBe(204);
    expect(container.store.profiles.get(profileId)).toBeNull();
    expect(container.store.chats.get('chat-1')).toBeNull();
    expect(container.store.attachments.get(created.id)).toBeNull();
    await expect(stat(blobPath)).rejects.toThrow();
  });
});
