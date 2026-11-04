import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Attachment, Store } from '@otherbench/core/ports/store.js';
import { encodeHlc } from '@otherbench/core/domain/hlc.js';
import { InMemoryStore } from '@otherbench/core/testing/fakes.js';
import { createBlobStore, type BlobStore } from '@otherbench/store-sqlite/blob-store.js';
import { ABANDONED_ATTACHMENT_GRACE_MS } from '@otherbench/store-sqlite/blob-gc.js';
import { openDatabase } from '@otherbench/store-sqlite/db.js';
import { createApp } from '../src/app.js';
import { createContainer, type Container } from '../src/container.js';
import { ABANDONED_SWEEP_INTERVAL_MS, startAbandonedAttachmentSweep } from '../src/attachment-sweep.js';

const DAY = 24 * 60 * 60 * 1000;

let dir: string;
let blobStore: BlobStore;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'otherbench-abandoned-server-test-'));
  blobStore = createBlobStore(join(dir, 'attachments'));
});

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

async function unsent(store: Store, id: string, content: string): Promise<Attachment & { path: string }> {
  const { sha256, path } = await blobStore.put(Buffer.from(content));
  const row = store.attachments.create({
    id, chatId: 'chat-a', messageId: null, filename: `${id}.txt`, mime: 'text/plain', size: content.length, sha256, storagePath: path, extractedText: null,
  });
  return { ...row, path };
}

describe('startAbandonedAttachmentSweep', () => {
  it('runs once a day', () => {
    expect(ABANDONED_SWEEP_INTERVAL_MS).toBe(DAY);
  });

  it('deletes abandoned unsent attachments each time the interval passes, not before', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const store = new InMemoryStore();
    const old = await unsent(store, 'old', 'abandoned upload');
    const later = Date.now() + ABANDONED_ATTACHMENT_GRACE_MS + DAY;
    const sweeper = startAbandonedAttachmentSweep({ store, blobStore, now: () => later });
    try {
      vi.advanceTimersByTime(ABANDONED_SWEEP_INTERVAL_MS - 1);
      await sweeper.idle();
      expect(store.attachments.get('old')).not.toBeNull();

      vi.advanceTimersByTime(1);
      await sweeper.idle();
      expect(store.attachments.get('old')).toBeNull();
      await expect(stat(old.path)).rejects.toThrow();
    } finally {
      sweeper.stop();
    }
  });

  it('does nothing more once stopped', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const store = new InMemoryStore();
    await unsent(store, 'old', 'abandoned upload');
    const later = Date.now() + ABANDONED_ATTACHMENT_GRACE_MS + DAY;
    const sweeper = startAbandonedAttachmentSweep({ store, blobStore, now: () => later });

    sweeper.stop();
    vi.advanceTimersByTime(ABANDONED_SWEEP_INTERVAL_MS * 3);
    await sweeper.idle();

    expect(store.attachments.get('old')).not.toBeNull();
  });

  it('keeps attachments the caller says are held', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const store = new InMemoryStore();
    await unsent(store, 'held', 'on a waiting note');
    const later = Date.now() + ABANDONED_ATTACHMENT_GRACE_MS + DAY;
    const sweeper = startAbandonedAttachmentSweep({ store, blobStore, now: () => later, isHeld: (a) => a.id === 'held' });
    try {
      vi.advanceTimersByTime(ABANDONED_SWEEP_INTERVAL_MS);
      await sweeper.idle();
      expect(store.attachments.get('held')).not.toBeNull();
    } finally {
      sweeper.stop();
    }
  });

  it('logs a failed run and keeps going rather than throwing', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const store = new InMemoryStore();
    let calls = 0;
    vi.spyOn(store.attachments, 'abandoned').mockImplementation(() => {
      calls++;
      throw new Error('database is not open');
    });
    const sweeper = startAbandonedAttachmentSweep({ store, blobStore, now: () => Date.now() });
    try {
      vi.advanceTimersByTime(ABANDONED_SWEEP_INTERVAL_MS);
      await sweeper.idle();
      vi.advanceTimersByTime(ABANDONED_SWEEP_INTERVAL_MS);
      await sweeper.idle();
      expect(calls).toBe(2);
      expect(consoleError).toHaveBeenCalledTimes(2);
    } finally {
      sweeper.stop();
    }
  });
});

function uploadForm(filename: string, content: string, mime: string): FormData {
  const form = new FormData();
  form.append('file', new File([content], filename, { type: mime }));
  return form;
}

async function seedChat(container: Container): Promise<void> {
  container.store.connections.create({
    id: 'conn', name: 'Test Connection', kind: 'mock', baseUrl: null, secretRef: null,
    extraHeaders: {}, status: 'unknown', statusMessage: null, checkedAt: null,
  });
  container.store.models.create({
    id: 'model', connectionId: 'conn', modelId: 'mock-standard', displayName: 'Mock', source: 'manual',
    supportsVision: false, supportsTools: false, supportsReasoning: false, contextWindow: null,
    maxOutput: null, priceInPer1m: null, priceOutPer1m: null, priceCachedPer1m: null, currency: 'USD',
  });
  container.store.profiles.create({
    id: 'profile', name: 'Test Profile', description: null, colour: null, connectionId: 'conn', modelId: 'model',
    systemPrompt: null, params: {}, toolPolicy: { fs: 'off', shell: false, mcpServerIds: [], approvalMode: 'always_ask' },
    isDefault: false, archivedAt: null,
  });
  container.store.chats.create({ id: 'chat-a', title: 'A', profileId: 'profile', headMessageId: null, workspaceRoot: null, pinned: false, archivedAt: null });
}

/** Moves an attachment's last write back by `ms`, keeping its machine, with the server stopped. */
function backdate(dbPath: string, attachmentId: string, ms: number): void {
  const db = openDatabase(dbPath);
  try {
    const selfId = (db.prepare('SELECT id FROM node_self LIMIT 1').get() as { id: string }).id;
    db.prepare('UPDATE attachment SET hlc = ? WHERE id = ?').run(encodeHlc(Date.now() - ms, 0, selfId), attachmentId);
  } finally {
    db.close();
  }
}

describe('the server start', () => {
  it('deletes unsent attachments left for longer than the grace period, with their blobs, and keeps newer ones', async () => {
    const dbPath = join(dir, 'main.db');
    const secretsPath = join(dir, 'secrets.json');
    let container = await createContainer({ dbPath, secretsPath });
    let oldUpload: { id: string; sha256: string };
    let newUpload: { id: string; sha256: string };
    let root: string;
    try {
      await seedChat(container);
      const app = createApp(container);
      oldUpload = await (await app.request('/api/chats/chat-a/attachments', { method: 'POST', body: uploadForm('old.txt', 'left a month ago', 'text/plain') })).json();
      newUpload = await (await app.request('/api/chats/chat-a/attachments', { method: 'POST', body: uploadForm('new.txt', 'still a draft', 'text/plain') })).json();
      root = container.blobStore.root;
    } finally {
      container.close();
    }
    backdate(dbPath, oldUpload.id, ABANDONED_ATTACHMENT_GRACE_MS + DAY);
    backdate(dbPath, newUpload.id, ABANDONED_ATTACHMENT_GRACE_MS - DAY);

    container = await createContainer({ dbPath, secretsPath });
    try {
      expect(container.store.attachments.get(oldUpload.id)).toBeNull();
      await expect(stat(join(root, oldUpload.sha256.slice(0, 2), oldUpload.sha256))).rejects.toThrow();
      expect(container.store.attachments.get(newUpload.id)).not.toBeNull();
      await expect(stat(join(root, newUpload.sha256.slice(0, 2), newUpload.sha256))).resolves.toBeTruthy();
    } finally {
      container.close();
    }
  });
});
