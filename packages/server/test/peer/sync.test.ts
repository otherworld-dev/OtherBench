import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FakeSecretStore } from '@otherbench/core/testing/fakes.js';
import type { AppEvent } from '@otherbench/core/types/events.js';
import { createBlobStore, type BlobStore } from '@otherbench/store-sqlite/blob-store.js';
import { openDatabase } from '@otherbench/store-sqlite/db.js';
import { runMigrations, SCHEMA_VERSION } from '@otherbench/store-sqlite/migrations/index.js';
import { SqliteStore } from '@otherbench/store-sqlite/store.js';
import { createPeerApp } from '../../src/peer/app.js';
import { IdentityStore } from '../../src/peer/identity.js';
import { PeerService } from '../../src/peer/service.js';
import { Syncer } from '../../src/peer/syncer.js';
import { AppEventBus } from '../../src/stream/events.js';

interface SyncNode {
  name: string;
  db: DatabaseSync;
  store: SqliteStore;
  secrets: FakeSecretStore;
  blobs: BlobStore;
  service: PeerService;
  syncer: Syncer;
  events: AppEvent[];
  close(): Promise<void>;
}

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanup.splice(0).reverse()) await c();
});

function syncNode(name: string, options: { schemaVersion?: number; appVersion?: string; fallbackMs?: number; changeCheckMs?: number } = {}): SyncNode {
  const db = openDatabase(':memory:');
  runMigrations(db);
  db.prepare('UPDATE node_self SET id = ?, name = ?').run(`node-${name}`, name);
  const store = new SqliteStore(db);
  const secrets = new FakeSecretStore();
  const dir = mkdtempSync(join(tmpdir(), `otherbench-sync-${name}-`));
  const blobs = createBlobStore(join(dir, 'blobs'));
  const bus = new AppEventBus();
  const events: AppEvent[] = [];
  bus.subscribe((e) => events.push(e));
  const service = new PeerService({
    store,
    secrets,
    events: bus,
    identity: new IdentityStore(() => store.nodes.self().id, null),
    createApp: (s) => createPeerApp(s) as never,
    port: 0,
    hosts: ['127.0.0.1'],
    schemaVersion: options.schemaVersion ?? SCHEMA_VERSION,
    ...(options.appVersion ? { appVersion: options.appVersion } : {}),
    platform: 'win32',
    monitor: { minBackoffMs: 20, maxBackoffMs: 100 },
  });
  const syncer = new Syncer({ store, secrets, blobStore: blobs, peers: service, events: bus, fallbackMs: options.fallbackMs ?? 60_000, changeCheckMs: options.changeCheckMs ?? 50 });
  service.attachSyncer(syncer);
  const node: SyncNode = {
    name,
    db,
    store,
    secrets,
    blobs,
    service,
    syncer,
    events,
    close: async () => {
      syncer.stop();
      await service.close();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
  cleanup.push(() => node.close());
  return node;
}

async function pairNodes(a: SyncNode, b: SyncNode): Promise<void> {
  const view = await a.service.startPairing();
  await b.service.pairWith(view.addresses[0]!, view.code);
}

function seed(n: SyncNode, over: { syncSecret?: boolean } = {}): void {
  n.store.connections.create({ id: 'c1', name: 'Anthropic', kind: 'anthropic', baseUrl: null, secretRef: 'conn:c1', extraHeaders: {}, status: 'ok', statusMessage: 'fine', checkedAt: 5, ...(over.syncSecret === false ? { syncSecret: false } : {}) });
  n.store.models.create({
    id: 'm1', connectionId: 'c1', modelId: 'm', displayName: 'M', source: 'manual', supportsVision: false, supportsTools: false,
    supportsReasoning: false, contextWindow: null, maxOutput: null, priceInPer1m: null, priceOutPer1m: null, priceCachedPer1m: null, currency: 'USD',
  });
  n.store.profiles.create({
    id: 'p1', name: 'P', description: null, colour: null, connectionId: 'c1', modelId: 'm1', systemPrompt: null, params: {},
    toolPolicy: { fs: 'off', shell: false, mcpServerIds: [], approvalMode: 'always_ask' }, isDefault: true, archivedAt: null,
  });
  n.store.chats.create({ id: 'chat', title: 'From the PC', profileId: 'p1', headMessageId: null, workspace: null, pinned: false, archivedAt: null });
  n.store.messages.create({ id: 'u1', chatId: 'chat', parentId: null, role: 'user', parts: [{ type: 'text', text: 'hello' }], status: 'complete', error: null, producedBy: null });
}

describe('syncing two machines over the peer listener', () => {
  it('pulls chats, messages, profiles and connections, with the API key re-stored here and health left behind', async () => {
    const pc = syncNode('PC');
    const laptop = syncNode('Laptop');
    seed(pc);
    await pc.secrets.set('conn:c1', 'sk-secret');
    await pairNodes(pc, laptop);

    const written = await laptop.syncer.pullFrom('node-PC');

    expect(written).toBeGreaterThan(4);
    expect(laptop.store.chats.get('chat')).toMatchObject({ title: 'From the PC', runsOn: 'node-PC' });
    expect(laptop.store.messages.get('u1')).toMatchObject({ originNode: 'node-PC' });
    expect(laptop.store.connections.get('c1')).toMatchObject({ name: 'Anthropic', status: 'unknown', checkedAt: null });
    expect(await laptop.secrets.get('conn:c1')).toBe('sk-secret');
    expect(laptop.store.peers.get('node-PC')!.lastSyncSeq).toBe(pc.store.sync.latestSeq());
    expect(laptop.syncer.status('node-PC')).toMatchObject({ error: null, lastSyncedAt: expect.any(Number) });
    expect(laptop.events).toContainEqual({ type: 'sync-applied', nodeId: 'node-PC', changed: written });

    // Nothing new: nothing written, cursor unchanged.
    expect(await laptop.syncer.pullFrom('node-PC')).toBe(0);
  });

  it('keeps an API key home when the connection says so', async () => {
    const pc = syncNode('PC');
    const laptop = syncNode('Laptop');
    seed(pc, { syncSecret: false });
    await pc.secrets.set('conn:c1', 'sk-home-only');
    await pairNodes(pc, laptop);

    await laptop.syncer.pullFrom('node-PC');

    expect(await laptop.secrets.get('conn:c1')).toBeNull();
    // Whether to share a key is each machine's own setting: the laptop can't
    // switch the PC's back on (or re-point it) to be sent the key.
    laptop.store.connections.update('c1', { name: 'Renamed', baseUrl: 'https://evil.example', syncSecret: true });
    await pc.syncer.pullFrom('node-Laptop');
    expect(pc.store.connections.get('c1')).toMatchObject({ name: 'Anthropic', baseUrl: null, syncSecret: false });
    expect(JSON.stringify(await pc.syncer.changesFor(0, 1000))).not.toContain('sk-home-only');
  });

  it("never stores a key under, or sends one from, any reference but the connection's own", async () => {
    const pc = syncNode('PC');
    const laptop = syncNode('Laptop');
    seed(pc);
    await pc.secrets.set('conn:c1', 'sk-c1');
    await pc.secrets.set('peer-token:node-Other', 'token-for-another-machine');
    await pairNodes(pc, laptop);
    await laptop.syncer.pullFrom('node-PC');

    // The laptop points the connection at another secret and sends a key with it.
    laptop.store.connections.update('c1', { secretRef: 'peer-token:node-Other' });
    await laptop.secrets.set('peer-token:node-Other', 'overwritten');
    await pc.syncer.pullFrom('node-Laptop');

    expect(await pc.secrets.get('peer-token:node-Other')).toBe('token-for-another-machine');
    expect(pc.store.connections.get('c1')!.secretRef).toBe('conn:c1');
    expect(JSON.stringify(await pc.syncer.changesFor(0, 1000))).not.toContain('token-for-another-machine');
  });

  it("fetches a sent file's blob and checks it; an unsent file's blob never leaves; a corrupt one is refused and retried", async () => {
    const pc = syncNode('PC');
    const laptop = syncNode('Laptop');
    seed(pc);
    const good = await pc.blobs.put(Buffer.from('the real bytes'));
    const bad = await pc.blobs.put(Buffer.from('bytes about to be corrupted'));
    const unsent = await pc.blobs.put(Buffer.from('never sent'));
    for (const [id, blob, messageId] of [['a-good', good, 'u1'], ['a-bad', bad, 'u1'], ['a-unsent', unsent, null]] as const) {
      pc.store.attachments.create({ id, chatId: 'chat', messageId: null, filename: id, mime: 'image/png', size: blob.size, sha256: blob.sha256, storagePath: blob.path, extractedText: null });
      if (messageId) pc.store.attachments.update(id, { messageId });
    }
    writeFileSync(bad.path, 'tampered');
    await pairNodes(pc, laptop);

    await laptop.syncer.pullFrom('node-PC');

    expect((await laptop.blobs.get(good.sha256)).toString()).toBe('the real bytes');
    expect(laptop.store.attachments.get('a-good')!.storagePath).not.toBe('');
    expect(laptop.store.attachments.get('a-bad')!.storagePath).toBe('');
    expect(laptop.store.attachments.get('a-unsent')).toBeNull();
    expect(laptop.store.sync.missingBlobs()).toEqual([{ id: 'a-bad', sha256: bad.sha256, size: bad.size }]);
    expect((await laptop.service.call('node-PC', { method: 'GET', path: `/peer/blobs/${unsent.sha256}` })).status).toBe(404);

    // The PC's copy is mended: the next sync fetches it.
    writeFileSync(bad.path, 'bytes about to be corrupted');
    await laptop.syncer.pullFrom('node-PC');
    expect(laptop.store.sync.missingBlobs()).toEqual([]);
  });

  it('drops a blob longer than its row says it is, whether it comes from the peer or is already here', async () => {
    const pc = syncNode('PC');
    const laptop = syncNode('Laptop');
    seed(pc);
    const honest = await pc.blobs.put(Buffer.from('exactly as long'));
    const liar = await pc.blobs.put(Buffer.from('this blob is much longer than its row claims'));
    const known = await pc.blobs.put(Buffer.from('this one is already on the laptop, and also too long'));
    await laptop.blobs.put(Buffer.from('this one is already on the laptop, and also too long'));
    const make = (id: string, blob: { sha256: string; path: string }, size: number) =>
      pc.store.attachments.create({ id, chatId: 'chat', messageId: 'u1', filename: `${id}.png`, mime: 'image/png', size, sha256: blob.sha256, storagePath: blob.path, extractedText: null });
    make('a-honest', honest, honest.size);
    make('a-liar', liar, 3);
    make('a-known', known, 3);
    await pairNodes(pc, laptop);

    await laptop.syncer.pullFrom('node-PC');

    expect(laptop.store.attachments.get('a-honest')!.storagePath).not.toBe('');
    expect(laptop.store.attachments.get('a-liar')!.storagePath).toBe('');
    expect(laptop.store.attachments.get('a-known')!.storagePath).toBe('');
    expect(laptop.store.sync.missingBlobs().map((m) => m.id)).toEqual(['a-known', 'a-liar']);
  });

  it('asks for no blob, and keeps none, for a row that does not state a usable size (text, a fraction, negative, not finite, over the cap)', async () => {
    const pc = syncNode('PC');
    const laptop = syncNode('Laptop');
    seed(pc);
    // Blobs the PC would serve (each is sent in a message there); one of them is also on the laptop already.
    const blobs = [];
    for (let i = 0; i < 7; i++) {
      const blob = await pc.blobs.put(Buffer.from(`file number ${i}, which the PC really has`));
      pc.store.attachments.create({ id: `pc-${i}`, chatId: 'chat', messageId: 'u1', filename: `f${i}.png`, mime: 'image/png', size: blob.size, sha256: blob.sha256, storagePath: blob.path, extractedText: null });
      blobs.push(blob);
    }
    await laptop.blobs.put(Buffer.from('file number 6, which the PC really has'));
    await pairNodes(pc, laptop);

    // What a store could hand over from old rows: the syncer itself must not act on any of these sizes.
    const sizes: unknown[] = ['big', Number.NaN, 1.5, -1, Number.POSITIVE_INFINITY, 64 * 1024 * 1024 + 1, 'big'];
    const rows = sizes.map((size, i) => ({ id: `pc-${i}`, sha256: blobs[i]!.sha256, size: size as number }));
    const sync = laptop.store.sync!;
    const realMissing = sync.missingBlobs.bind(sync);
    sync.missingBlobs = () => rows;
    const asked: string[] = [];
    const realCall = laptop.service.call.bind(laptop.service);
    laptop.service.call = ((nodeId: string, request: { method: string; path: string }, limits?: unknown) => {
      asked.push(request.path);
      return (realCall as (...args: unknown[]) => unknown)(nodeId, request, limits);
    }) as typeof laptop.service.call;

    await laptop.syncer.pullFrom('node-PC');

    expect(asked.filter((p) => p.startsWith('/peer/blobs/'))).toEqual([]);
    for (let i = 0; i < 7; i++) expect(laptop.store.attachments.get(`pc-${i}`)!.storagePath, `pc-${i}`).toBe('');
    for (let i = 0; i < 6; i++) await expect(laptop.blobs.get(blobs[i]!.sha256), `pc-${i}`).rejects.toThrow();

    // With its real rows back (sizes as the PC stated them), the same pull fetches every one.
    sync.missingBlobs = realMissing;
    await laptop.syncer.pullFrom('node-PC');
    expect(asked.filter((p) => p.startsWith('/peer/blobs/'))).toHaveLength(6);
    expect(laptop.store.sync!.missingBlobs()).toEqual([]);
  });

  it('offers no file row and serves no blob for a file that is not bound to a message of its own chat', async () => {
    const pc = syncNode('PC');
    const laptop = syncNode('Laptop');
    seed(pc);
    pc.store.chats.create({ id: 'other', title: 'Another chat', profileId: 'p1', headMessageId: null, workspace: null, pinned: false, archivedAt: null });
    const fine = await pc.blobs.put(Buffer.from('sent in its own chat'));
    const wrong = await pc.blobs.put(Buffer.from('filed under another chat'));
    const insert = pc.db.prepare('INSERT INTO attachment (id, chat_id, message_id, filename, mime, size, sha256, storage_path, extracted_text) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)');
    // Written past the repo (which refuses a mismatch), as a row from an older build would be.
    insert.run('a-fine', 'chat', 'u1', 'fine.png', 'image/png', fine.size, fine.sha256, fine.path);
    insert.run('a-wrong', 'other', 'u1', 'wrong.png', 'image/png', wrong.size, wrong.sha256, wrong.path);
    await pairNodes(pc, laptop);

    await laptop.syncer.pullFrom('node-PC');

    expect(JSON.stringify(await pc.syncer.changesFor(0, 1000))).toContain('a-fine');
    expect(JSON.stringify(await pc.syncer.changesFor(0, 1000))).not.toContain('a-wrong');
    expect(laptop.store.attachments.get('a-fine')).not.toBeNull();
    expect(laptop.store.attachments.get('a-wrong')).toBeNull();
    expect(await pc.syncer.blob(fine.sha256)).not.toBeNull();
    expect(await pc.syncer.blob(wrong.sha256)).toBeNull();
    expect((await laptop.service.call('node-PC', { method: 'GET', path: `/peer/blobs/${wrong.sha256}` })).status).toBe(404);
    expect((await laptop.service.call('node-PC', { method: 'GET', path: `/peer/blobs/${'0'.repeat(64)}` })).status).toBe(404);
  });

  it('refuses to sync with a machine on a different schema, saying which to update', async () => {
    const pc = syncNode('PC', { schemaVersion: SCHEMA_VERSION + 1 });
    const laptop = syncNode('Laptop');
    seed(pc);
    await pairNodes(pc, laptop);

    await expect(laptop.syncer.pullFrom('node-PC')).rejects.toThrow(/different version of OtherBench.*Update Laptop/);
    expect(laptop.store.chats.get('chat')).toBeNull();
    expect(laptop.syncer.status('node-PC').error).toMatch(/different version/);
  });

  it('says which build each machine runs, and which side is older', async () => {
    const pc = syncNode('PC', { schemaVersion: SCHEMA_VERSION + 1, appVersion: '0.2.0-beta.44' });
    const laptop = syncNode('Laptop', { appVersion: '0.2.0-beta.41' });
    await pairNodes(pc, laptop);

    await expect(laptop.syncer.pullFrom('node-PC')).rejects.toThrow(
      'PC runs a different version of OtherBench (0.2.0-beta.44; this machine 0.2.0-beta.41). Update Laptop to sync.'
    );
    expect(laptop.syncer.status('node-PC').versionMismatch).toEqual({
      peerAppVersion: '0.2.0-beta.44',
      peerSchemaVersion: SCHEMA_VERSION + 1,
      peerProtocolVersion: expect.any(Number),
      thisMachineOlder: true,
      at: expect.any(Number),
    });

    await expect(pc.syncer.pullFrom('node-Laptop')).rejects.toThrow(/Update Laptop to sync/);
    expect(pc.syncer.status('node-Laptop').versionMismatch).toMatchObject({ peerAppVersion: '0.2.0-beta.41', thisMachineOlder: false });
  });

  it('still reports a version mismatch after a restart', async () => {
    const pc = syncNode('PC', { schemaVersion: SCHEMA_VERSION + 1, appVersion: '0.2.0-beta.44' });
    const laptop = syncNode('Laptop');
    await pairNodes(pc, laptop);
    await expect(laptop.syncer.pullFrom('node-PC')).rejects.toThrow(/different version/);

    const restarted = new Syncer({ store: laptop.store, secrets: laptop.secrets, peers: laptop.service });
    expect(restarted.status('node-PC').versionMismatch).toMatchObject({ peerAppVersion: '0.2.0-beta.44', thisMachineOlder: true });
    expect(restarted.status('node-PC').error).toMatch(/different version/);
  });

  it('forgets a stored mismatch once this machine has caught up', async () => {
    const laptop = syncNode('Laptop');
    laptop.store.settings.setValue('sync-version-mismatch:node-PC', {
      peerAppVersion: '0.2.0-beta.44', peerSchemaVersion: SCHEMA_VERSION, peerProtocolVersion: laptop.service.info().protocolVersion, thisMachineOlder: true, at: 1, message: 'old',
    });
    expect(laptop.syncer.status('node-PC')).toEqual({ lastSyncedAt: null, error: null, versionMismatch: null });
    expect(laptop.store.settings.getValue('sync-version-mismatch:node-PC')).toBeNull();
  });

  it('a successful pull clears a version mismatch', async () => {
    const pc = syncNode('PC');
    const laptop = syncNode('Laptop');
    seed(pc);
    await pairNodes(pc, laptop);
    laptop.store.settings.setValue('sync-version-mismatch:node-PC', {
      peerAppVersion: '0.1.0', peerSchemaVersion: 1, peerProtocolVersion: 1, thisMachineOlder: false, at: 1, message: 'old',
    });
    expect(laptop.syncer.status('node-PC').versionMismatch).not.toBeNull();

    await laptop.syncer.pullFrom('node-PC');
    expect(laptop.syncer.status('node-PC').versionMismatch).toBeNull();
    expect(laptop.store.settings.getValue('sync-version-mismatch:node-PC')).toBeNull();
  });

  it('a change on one machine reaches the other within a second, by announcement', async () => {
    const pc = syncNode('PC');
    const laptop = syncNode('Laptop');
    seed(pc);
    await pairNodes(pc, laptop);
    pc.syncer.start();
    laptop.syncer.start();
    laptop.service.startMonitoring();
    await expect.poll(() => laptop.store.chats.get('chat')?.title).toBe('From the PC');

    // About a second here (announcements are checked every 50 ms in this test); a little slack for a slow CI runner.
    pc.store.chats.update('chat', { title: 'Renamed on the PC' });
    await expect.poll(() => laptop.store.chats.get('chat')?.title, { timeout: 1500 }).toBe('Renamed on the PC');
  });

  it('pulls every so often anyway while the other machine is reachable', async () => {
    const pc = syncNode('PC');
    const laptop = syncNode('Laptop', { fallbackMs: 100 });
    seed(pc);
    await pairNodes(pc, laptop);
    laptop.service.startMonitoring();
    laptop.syncer.start();
    await expect.poll(() => laptop.service.status('node-PC').status).toBe('reachable');
    // The PC never announces (its syncer isn't started): only the fallback can bring this.
    pc.store.chats.update('chat', { title: 'Quietly renamed' });
    await expect.poll(() => laptop.store.chats.get('chat')?.title, { timeout: 2000 }).toBe('Quietly renamed');
  });

  it('a sync request makes the other machine pull now, and answers when it has', async () => {
    const pc = syncNode('PC');
    const laptop = syncNode('Laptop');
    await pairNodes(pc, laptop);
    seed(laptop);

    const res = await laptop.service.call('node-PC', { method: 'POST', path: '/peer/sync-request' });

    expect(res.status).toBe(200);
    expect((res.body as { applied: number }).applied).toBeGreaterThan(0);
    expect(pc.store.chats.get('chat')).toMatchObject({ title: 'From the PC' });
  });
});
