import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FakeSecretStore } from '@grunt/core/testing/fakes.js';
import type { AppEvent } from '@grunt/core/types/events.js';
import { createBlobStore, type BlobStore } from '@grunt/store-sqlite/blob-store.js';
import { openDatabase } from '@grunt/store-sqlite/db.js';
import { runMigrations, SCHEMA_VERSION } from '@grunt/store-sqlite/migrations/index.js';
import { SqliteStore } from '@grunt/store-sqlite/store.js';
import { createPeerApp } from '../../src/peer/app.js';
import { IdentityStore } from '../../src/peer/identity.js';
import { PeerService } from '../../src/peer/service.js';
import { Syncer } from '../../src/peer/syncer.js';
import { AppEventBus } from '../../src/stream/events.js';

interface SyncNode {
  name: string;
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

function syncNode(name: string, options: { schemaVersion?: number; fallbackMs?: number; changeCheckMs?: number } = {}): SyncNode {
  const db = openDatabase(':memory:');
  runMigrations(db);
  db.prepare('UPDATE node_self SET id = ?, name = ?').run(`node-${name}`, name);
  const store = new SqliteStore(db);
  const secrets = new FakeSecretStore();
  const dir = mkdtempSync(join(tmpdir(), `grunt-sync-${name}-`));
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
    platform: 'win32',
    monitor: { minBackoffMs: 20, maxBackoffMs: 100 },
  });
  const syncer = new Syncer({ store, secrets, blobStore: blobs, peers: service, events: bus, fallbackMs: options.fallbackMs ?? 60_000, changeCheckMs: options.changeCheckMs ?? 50 });
  service.attachSyncer(syncer);
  const node: SyncNode = {
    name,
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
    expect(laptop.store.sync.missingBlobs()).toEqual([{ id: 'a-bad', sha256: bad.sha256 }]);
    expect((await laptop.service.call('node-PC', { method: 'GET', path: `/peer/blobs/${unsent.sha256}` })).status).toBe(404);

    // The PC's copy is mended: the next sync fetches it.
    writeFileSync(bad.path, 'bytes about to be corrupted');
    await laptop.syncer.pullFrom('node-PC');
    expect(laptop.store.sync.missingBlobs()).toEqual([]);
  });

  it('refuses to sync with a machine on a different schema, saying which to update', async () => {
    const pc = syncNode('PC', { schemaVersion: SCHEMA_VERSION + 1 });
    const laptop = syncNode('Laptop');
    seed(pc);
    await pairNodes(pc, laptop);

    await expect(laptop.syncer.pullFrom('node-PC')).rejects.toThrow(/different version of Grunt.*Update Laptop/);
    expect(laptop.store.chats.get('chat')).toBeNull();
    expect(laptop.syncer.status('node-PC').error).toMatch(/different version/);
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
