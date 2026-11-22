import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { HLC_MAX_AHEAD_MS, HLC_MAX_WAIT_MS, compareHlc, encodeHlc, parseHlc } from '@otherbench/core/domain/hlc.js';
import type { ChangeRow } from '@otherbench/core/domain/sync.js';
import { openDatabase } from '../src/db.js';
import { MIGRATIONS, runMigrations } from '../src/migrations/index.js';
import { SqliteStore } from '../src/store.js';

interface Node {
  id: string;
  db: DatabaseSync;
  store: SqliteStore;
}

const dir = mkdtempSync(join(tmpdir(), 'otherbench-clock-'));
afterAll(() => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // ignore cleanup races
  }
});

/** A store reading the time from `now`; with `file`, on a database file, so closing it and calling this again is a restart. */
function node(id: string, now: () => number, file?: string): Node {
  const db = openDatabase(file ? join(dir, `${file}.db`) : ':memory:');
  runMigrations(db);
  db.prepare('UPDATE node_self SET id = ?').run(id);
  return { id, db, store: new SqliteStore(db, { now }) };
}

function seedChat(n: Node, title = 'c'): void {
  n.store.connections.create({ id: 'c1', name: 'C', kind: 'mock', baseUrl: null, secretRef: null, extraHeaders: {}, status: 'unknown', statusMessage: null, checkedAt: null });
  n.store.models.create({
    id: 'm1', connectionId: 'c1', modelId: 'm', displayName: 'M', source: 'manual', supportsVision: false, supportsTools: false,
    supportsReasoning: false, contextWindow: null, maxOutput: null, priceInPer1m: null, priceOutPer1m: null, priceCachedPer1m: null, currency: 'USD',
  });
  n.store.profiles.create({
    id: 'p1', name: 'P', description: null, colour: null, connectionId: 'c1', modelId: 'm1', systemPrompt: null, params: {},
    toolPolicy: { fs: 'off', shell: false, mcpServerIds: [], approvalMode: 'always_ask' }, isDefault: true, archivedAt: null,
  });
  n.store.chats.create({ id: 'c', title, profileId: 'p1', headMessageId: null, workspace: null, pinned: false, archivedAt: null });
}

function pull(from: Node, to: Node): void {
  to.store.sync.apply(from.store.sync.changesSince(0, 1000).rows);
}

const hlcOf = (n: Node, id: string): string => (n.db.prepare('SELECT hlc FROM chat WHERE id = ?').get(id) as { hlc: string }).hlc;

describe('the clock across restarts', () => {
  it('a restart with the wall clock set back still stamps later than what is stored', () => {
    let a = node('a', () => 50_000, 'back');
    seedChat(a);
    const before = hlcOf(a, 'c');
    expect(parseHlc(before).ms).toBe(50_000);
    a.store.close();

    a = node('a', () => 20_000, 'back');
    a.store.chats.update('c', { title: 'renamed after the restart' });
    expect(compareHlc(hlcOf(a, 'c'), before)).toBeGreaterThan(0);
    a.store.close();
  });

  it("a restart keeps this machine ahead of another machine's stamps it had taken, so its later edit wins there", () => {
    const wall = 1_000_000;
    // b's clock runs two minutes fast; a's is right.
    const b = node('b', () => wall + 120_000);
    let a = node('a', () => wall, 'ahead');
    seedChat(b, 'from b');
    pull(b, a);
    expect(a.store.chats.get('c')!.title).toBe('from b');
    a.store.close();

    a = node('a', () => wall + 1000, 'ahead');
    a.store.chats.update('c', { title: 'edited on a, later' });
    pull(a, b);
    expect(b.store.chats.get('c')!.title).toBe('edited on a, later');
    a.store.close();
  });

  it('with the wall clock past everything stored, stamps read the wall clock', () => {
    let a = node('a', () => 50_000, 'forward');
    seedChat(a);
    a.store.close();
    a = node('a', () => 90_000, 'forward');
    a.store.chats.update('c', { title: 'later' });
    expect(parseHlc(hlcOf(a, 'c')).ms).toBe(90_000);
    a.store.close();
  });

  it('a database from before the clock was kept starts from the newest stamp in it', () => {
    const db = openDatabase(':memory:');
    runMigrations(db, MIGRATIONS.filter((m) => m.version <= 52));
    db.prepare('UPDATE node_self SET id = ?').run('a');
    const old = { id: 'a', db, store: new SqliteStore(db, { now: () => 70_000 }) };
    seedChat(old);
    const before = hlcOf(old, 'c');

    runMigrations(db);
    const a = { id: 'a', db, store: new SqliteStore(db, { now: () => 10_000 }) };
    a.store.chats.update('c', { title: 'after the upgrade' });
    expect(compareHlc(hlcOf(a, 'c'), before)).toBeGreaterThan(0);
    db.close();
  });

  it('does not start from a kept time more than a day ahead: no other machine would take its stamps', () => {
    const wall = 5_000_000;
    // The date was wrong by a week when this ran last.
    let a = node('a', () => wall + 7 * HLC_MAX_WAIT_MS, 'wrong-date');
    seedChat(a);
    a.store.close();

    a = node('a', () => wall, 'wrong-date');
    a.store.locations.create({ id: 'l', name: 'made with the date put right' });
    const stamp = (a.db.prepare("SELECT hlc FROM location WHERE id = 'l'").get() as { hlc: string }).hlc;
    expect(parseHlc(stamp).ms).toBe(wall);
    // And a machine with the right time takes it.
    const b = node('b', () => wall);
    expect(b.store.sync.apply(a.store.sync.changesSince(0, 1000).rows.filter((r) => r.tbl === 'location'))).toMatchObject({ applied: 1, ahead: 0 });
    a.store.close();
  });
});

describe("a machine whose clock is wrong", () => {
  const wall = 1_000_000;
  const far = encodeHlc(wall + HLC_MAX_AHEAD_MS + 60_000, 0, 'b');

  it('a row stamped more than a day ahead is passed over for good: not taken, not waited for', () => {
    const a = node('a', () => wall);
    seedChat(a);
    const stored = a.db.prepare("SELECT * FROM chat WHERE id = 'c'").get() as Record<string, unknown>;
    const row = (id: string, hlc: string): ChangeRow => ({ tbl: 'chat', id, op: 'upsert', hlc, row: { ...stored, id, title: id }, fieldHlc: {} });

    const result = a.store.sync.apply([row('next-year', encodeHlc(wall + HLC_MAX_WAIT_MS + 1, 0, 'b')), row('made-up', 'zzz'), row('tomorrow', encodeHlc(wall + HLC_MAX_WAIT_MS, 0, 'b'))]);

    expect(result).toMatchObject({ applied: 0, skipped: 3, ahead: 1 });
    expect(a.store.chats.list().map((c) => c.id)).toEqual(['c']);
  });

  it('a row stamped further ahead than the limit is not taken, is counted, and does not move this clock', () => {
    const a = node('a', () => wall);
    seedChat(a);
    const stored = a.db.prepare("SELECT * FROM chat WHERE id = 'c'").get() as Record<string, unknown>;
    const row = (id: string, hlc: string): ChangeRow => ({ tbl: 'chat', id, op: 'upsert', hlc, row: { ...stored, id, title: id }, fieldHlc: {} });

    const result = a.store.sync.apply([row('far', far), row('near', encodeHlc(wall + 60_000, 0, 'b')), { tbl: 'chat', id: 'c', op: 'delete', hlc: far }]);

    expect(result).toMatchObject({ applied: 1, ahead: 2 });
    expect(a.store.chats.get('far')).toBeNull();
    expect(a.store.chats.get('near')).not.toBeNull();
    expect(a.store.chats.get('c')).not.toBeNull();
    expect(a.db.prepare('SELECT COUNT(*) AS n FROM tombstone').get()).toEqual({ n: 0 });
    // The clock followed the near stamp only: nowhere near the far one.
    a.store.chats.update('c', { title: 'local' });
    expect(parseHlc(hlcOf(a, 'c')).ms).toBe(wall + 60_000);
  });

  it('a chat with one field stamped too far ahead is not taken either', () => {
    const a = node('a', () => wall);
    seedChat(a);
    const offered = a.store.sync.changesSince(0, 1000).rows.find((r) => r.tbl === 'chat');
    if (offered?.op !== 'upsert') throw new Error('expected the chat');

    const result = a.store.sync.apply([{ ...offered, hlc: encodeHlc(wall + 1, 0, 'b'), row: { ...offered.row, title: 'theirs' }, fieldHlc: { ...offered.fieldHlc, title: far } }]);

    expect(result).toMatchObject({ applied: 0, ahead: 1 });
    expect(a.store.chats.get('c')!.title).toBe('c');
  });

  it('is taken once this machine reaches its time', () => {
    let now = wall;
    const a = node('a', () => now);
    const b = node('b', () => wall + HLC_MAX_AHEAD_MS + 60_000);
    seedChat(b, 'from b');
    const rows = b.store.sync.changesSince(0, 1000).rows;

    expect(a.store.sync.apply(rows)).toMatchObject({ applied: 0, ahead: rows.length });
    now = wall + 120_000;
    expect(a.store.sync.apply(rows)).toMatchObject({ applied: rows.length, ahead: 0 });
    expect(a.store.chats.get('c')!.title).toBe('from b');
  });
});
