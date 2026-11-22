import { describe, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../src/db.js';
import { MIGRATIONS, runMigrations } from '../src/migrations/index.js';
import { SqliteStore } from '../src/store.js';

// Before usage was logged again behind its reply (repos/messages.ts, `relogDependents`), a usage row written while
// the reply was streaming could be turned down by a paired machine for good. Migration 056 offers every usage row
// once more, so those machines get the ones they are missing.

interface Node {
  db: DatabaseSync;
  store: SqliteStore;
}

/** A machine as it was before migration 056. */
function before056(id: string): Node {
  const db = openDatabase(':memory:');
  runMigrations(db, MIGRATIONS.filter((m) => m.version <= 55));
  db.prepare('UPDATE node_self SET id = ?').run(id);
  return { db, store: new SqliteStore(db) };
}

function pull(from: Node, to: Node, cursor: { seq: number }, limit = 1000): { written: string[] } {
  const written: string[] = [];
  for (;;) {
    const batch = from.store.sync.changesSince(cursor.seq, limit);
    written.push(...to.store.sync.apply(batch.rows).written.map((w) => `${w.tbl}:${w.id}`));
    cursor.seq = batch.nextSeq;
    if (!batch.more) return { written };
  }
}

function usage(n: Node, id: string, messageId: string): void {
  n.store.usage.create({
    id, chatId: 'c', messageId, profileId: 'p1', connectionId: 'c1', modelId: 'm1', tokensIn: 3, tokensOut: 4, tokensCached: 0,
    tokensReasoning: 0, costEstimate: null, pricingSnapshot: { priceInPer1m: null, priceOutPer1m: null, priceCachedPer1m: null, currency: 'USD' }, latencyMs: 0,
  });
}

function seed(a: Node): void {
  a.store.connections.create({ id: 'c1', name: 'C', kind: 'mock', baseUrl: null, secretRef: null, extraHeaders: {}, status: 'unknown', statusMessage: null, checkedAt: null });
  a.store.models.create({
    id: 'm1', connectionId: 'c1', modelId: 'm', displayName: 'M', source: 'manual', supportsVision: false, supportsTools: false,
    supportsReasoning: false, contextWindow: null, maxOutput: null, priceInPer1m: null, priceOutPer1m: null, priceCachedPer1m: null, currency: 'USD',
  });
  a.store.profiles.create({
    id: 'p1', name: 'P', description: null, colour: null, connectionId: 'c1', modelId: 'm1', systemPrompt: null, params: {},
    toolPolicy: { fs: 'off', shell: false, mcpServerIds: [], approvalMode: 'always_ask' }, isDefault: true, archivedAt: null,
  });
  a.store.chats.create({ id: 'c', title: 'c', profileId: 'p1', headMessageId: null, workspace: null, pinned: false, archivedAt: null });
  a.store.messages.create({ id: 'u', chatId: 'c', parentId: null, role: 'user', parts: [], status: 'complete', error: null, producedBy: null, createdAt: 10 });
  a.store.messages.create({ id: 'r', chatId: 'c', parentId: 'u', role: 'assistant', parts: [], status: 'streaming', error: null, producedBy: null, createdAt: 20 });
}

const stamps = (n: Node): Record<string, string> => Object.fromEntries((n.db.prepare('SELECT id, hlc FROM usage ORDER BY id').all() as { id: string; hlc: string }[]).map((r) => [r.id, r.hlc]));

describe('usage rows a paired machine was refused before the fix (migration 056)', () => {
  it('are offered again: the machine takes the ones it lacks and writes nothing for the ones it has', () => {
    const a = before056('a');
    const b = before056('b');
    const cursor = { seq: 0 };
    seed(a);
    usage(a, 'had', 'u');
    // The old loss: a sub-agent's usage offered mid-reply and turned down, then the reply stopping the way it used
    // to, with nothing logged again behind it.
    usage(a, 'lost-1', 'r');
    usage(a, 'lost-2', 'r');
    pull(a, b, cursor);
    a.db.prepare("UPDATE message SET status = 'complete', hlc = ? WHERE id = 'r'").run(`${String(Date.now() + 1000).padStart(13, '0')}-0001-a`);
    pull(a, b, cursor);
    expect(b.store.messages.get('r')).toMatchObject({ status: 'complete' });
    expect(Object.keys(stamps(b))).toEqual(['had']);
    const hadBefore = stamps(b)['had'];

    runMigrations(a.db);
    const { written } = pull(a, b, cursor, 2);

    expect(written.sort()).toEqual(['usage:lost-1', 'usage:lost-2']);
    // Every stamp is the one the row was written with: nothing was re-stamped to be offered.
    expect(stamps(b)).toEqual(stamps(a));
    expect(stamps(b)['had']).toBe(hadBefore);
    expect(b.store.usage.get('lost-1')).toMatchObject({ messageId: 'r', tokensOut: 4 });
  });

  it("does not bring back a usage row the other machine changed or deleted since", () => {
    const a = before056('a');
    const b = before056('b');
    seed(a);
    a.store.messages.updateStatus('r', 'complete');
    usage(a, 'edited', 'r');
    usage(a, 'gone', 'r');
    const toB = { seq: 0 };
    const toA = { seq: 0 };
    pull(a, b, toB);
    b.store.usage.update('edited', { tokensOut: 99 });
    b.store.usage.delete('gone');

    // Offered again by a before it has heard of either change.
    runMigrations(a.db);
    pull(a, b, toB);
    expect(b.store.usage.get('edited')).toMatchObject({ tokensOut: 99 });
    expect(b.store.usage.get('gone')).toBeNull();

    pull(b, a, toA);
    expect(a.store.usage.get('edited')).toMatchObject({ tokensOut: 99 });
    expect(a.store.usage.get('gone')).toBeNull();
  });

  it('logs each usage row once, and a database with none logs nothing', () => {
    const a = before056('a');
    seed(a);
    usage(a, 'one', 'u');
    usage(a, 'two', 'u');
    const empty = before056('e');
    const seqA = a.store.sync.latestSeq();
    const seqE = empty.store.sync.latestSeq();

    runMigrations(a.db);
    runMigrations(empty.db);

    expect((a.db.prepare('SELECT tbl, row_id, op FROM change_log WHERE seq > ? ORDER BY seq').all(seqA) as { row_id: string }[]).map((r) => r.row_id).sort()).toEqual(['one', 'two']);
    expect(empty.store.sync.latestSeq()).toBe(seqE);
  });
});
