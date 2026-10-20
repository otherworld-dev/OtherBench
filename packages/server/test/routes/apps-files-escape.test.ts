import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PathEscapeError } from '@otherbench/core/domain/paths.js';
import { TurnRunner } from '@otherbench/core/domain/turn.js';
import { FakeChatEngine, FakeSecretStore, InMemoryStore } from '@otherbench/core/testing/fakes.js';
import { createBlobStore } from '@otherbench/store-sqlite/blob-store.js';
import { createApp } from '../../src/app.js';
import type { Container } from '../../src/container.js';
import { StreamRegistry } from '../../src/stream/registry.js';

/**
 * A link swapped between containPath and the open: fs-tools' verified open and
 * listing then refuse with PathEscapeError. Making that race for real needs
 * symlink rights and luck, so the verified calls are made to refuse here; what
 * is under test is that the app's Files routes answer it as `bad-path`, like
 * an escape caught up front, and not as a code-less 404.
 */
vi.mock('@otherbench/tools/fs-tools.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('@otherbench/tools/fs-tools.js')>();
  const { PathEscapeError: Escape } = await import('@otherbench/core/domain/paths.js');
  return {
    ...real,
    openVerified: vi.fn(async (_root: string, target: string) => {
      throw new Escape(target);
    }),
    readdirVerified: vi.fn(async (_root: string, target: string) => {
      throw new Escape(target);
    }),
  };
});

let container: Container;
let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ob-apps-escape-'));
  writeFileSync(join(root, 'a.txt'), 'a\n');
  const store = new InMemoryStore('node-pc');
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
    blobStore: createBlobStore(join(root, '.attachments')),
    close: () => {},
  };
  store.apps.create({ id: 'a1', name: 'A', workspaceRoot: root });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('app Files routes, when the verified open or listing finds the path escaped', () => {
  it('answer 400 bad-path', async () => {
    expect(new PathEscapeError('x')).toBeInstanceOf(PathEscapeError);
    for (const path of ['/api/apps/a1/files', '/api/apps/a1/files?path=.', '/api/apps/a1/text?path=a.txt']) {
      const res = await createApp(container).request(path);
      expect(res.status, path).toBe(400);
      expect(await res.json()).toMatchObject({ code: 'bad-path' });
    }
  });
});
