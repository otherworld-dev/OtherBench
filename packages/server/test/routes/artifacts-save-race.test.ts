import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// A file that appears between Save's check and its open: openVerified says so with AlreadyExistsError.
vi.mock('@otherbench/tools/fs-tools.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@otherbench/tools/fs-tools.js')>();
  return { ...actual, openVerified: vi.fn(async (_root: string, candidate: string) => Promise.reject(new actual.AlreadyExistsError(candidate))) };
});

import { TurnRunner } from '@otherbench/core/domain/turn.js';
import { FakeChatEngine, FakeSecretStore, InMemoryStore } from '@otherbench/core/testing/fakes.js';
import { createApp } from '../../src/app.js';
import type { Container } from '../../src/container.js';
import { StreamRegistry } from '../../src/stream/registry.js';

let container: Container;
let ws: string;

beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), 'otherbench-art-race-'));
  const store = new InMemoryStore();
  const engine = new FakeChatEngine([]);
  const turnRunner = new TurnRunner(store, engine);
  container = {
    store, secrets: new FakeSecretStore(), engine, registry: {} as never, toolProvider: {} as never, mcpManager: {} as never,
    turnRunner, streamRegistry: new StreamRegistry(turnRunner, store), blobStore: {} as never, close: () => {},
  };
  store.chats.create({ id: 'c1', title: 'C', profileId: 'p', headMessageId: null, workspace: { kind: 'machine', nodeId: 'node-self', root: ws }, pinned: false, archivedAt: null } as never);
  store.messages.create({ id: 'u1', chatId: 'c1', parentId: null, role: 'user', parts: [], status: 'complete', error: null, producedBy: null });
  store.artifacts.create({ id: 'art', chatId: 'c1', slug: 'calc', kind: 'html', language: null, createdAt: 1 });
  store.artifacts.addVersion({ id: 'v1', artifactId: 'art', title: 'Calc', content: '<p>1</p>', madeBy: 'model', messageId: 'u1', parentVersionId: null, createdAt: 2 });
});

afterEach(() => rmSync(ws, { recursive: true, force: true }));

describe('Save to workspace, racing another program', () => {
  it('asks before replacing a file that appeared between its check and its open, rather than failing', async () => {
    const res = await createApp(container).request('/api/chats/c1/artifacts/art/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ versionId: 'v1', path: 'calc.html' }),
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ exists: true });
  });
});
