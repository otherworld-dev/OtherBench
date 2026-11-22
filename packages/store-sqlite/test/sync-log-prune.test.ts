import { describe, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { PULL_SETTLE_MS, SYNC_TABLES, TOMBSTONE_KEEP_MS } from '@otherbench/core/domain/sync.js';
import { openDatabase } from '../src/db.js';
import { runMigrations } from '../src/migrations/index.js';
import { SqliteStore } from '../src/store.js';

// Tidying the change log and the tombstones (SqliteSyncRepo.pruneLog). What it must never do: lose a change for a
// machine that is paired, or let a deleted row come back.

const DAY = 24 * 60 * 60_000;
/** The time every machine here reads; tests move it on. */
let clock = 1_800_000_000_000;

interface Node {
  id: string;
  db: DatabaseSync;
  store: SqliteStore;
  /** Where this machine has pulled to on each other machine. */
  cursors: Map<string, number>;
}

function node(id: string): Node {
  const db = openDatabase(':memory:');
  runMigrations(db);
  db.prepare('UPDATE node_self SET id = ?').run(id);
  return { id, db, store: new SqliteStore(db, { now: () => clock }), cursors: new Map() };
}

/** Makes `b` a paired machine of `a` (one way: `a` now waits for `b` before it forgets anything). */
function pairTo(a: Node, b: Node): void {
  a.store.peers.create({ nodeId: b.id, name: b.id, fingerprint: `fp-${b.id}`, addresses: [], issuedTokenHash: 'h', heldTokenRef: 'r', platform: 'win32', lastSeenAt: null, lastSyncSeq: 0, pairedAt: clock });
}

/** `to` pulls from `from` as the syncer does: `from` hears the cursor on each request. */
function pull(from: Node, to: Node, limit = 1000): string[] {
  const written: string[] = [];
  for (;;) {
    const since = to.cursors.get(from.id) ?? 0;
    from.store.sync.notePulled(to.id, since);
    const batch = from.store.sync.changesSince(since, limit);
    written.push(...to.store.sync.apply(batch.rows).written.map((w) => `${w.tbl}:${w.id}`));
    to.cursors.set(from.id, batch.nextSeq);
    if (!batch.more) {
      // The request that finds nothing more carries the final cursor.
      from.store.sync.notePulled(to.id, batch.nextSeq);
      return written;
    }
  }
}

/** One whole pass of the tidy, in steps of `limit` rows. */
function tidy(n: Node, limit = 1000): { entries: number; tombstones: number; steps: number } {
  const total = { entries: 0, tombstones: 0, steps: 0 };
  let after: string | null = null;
  do {
    const step = n.store.sync.pruneLog({ now: clock, limit, after });
    total.entries += step.entries;
    total.tombstones += step.tombstones;
    total.steps++;
    after = step.after;
  } while (after !== null);
  return total;
}

/** Two passes a settling time apart: what a machine has pulled counts only once it has stood that long. */
function settle(n: Node): void {
  tidy(n);
  clock += PULL_SETTLE_MS;
  tidy(n);
}

function seed(n: Node): void {
  n.store.connections.create({ id: 'c1', name: 'C', kind: 'mock', baseUrl: null, secretRef: null, extraHeaders: {}, status: 'unknown', statusMessage: null, checkedAt: null });
  n.store.models.create({
    id: 'm1', connectionId: 'c1', modelId: 'm', displayName: 'M', source: 'manual', supportsVision: false, supportsTools: false,
    supportsReasoning: false, contextWindow: null, maxOutput: null, priceInPer1m: null, priceOutPer1m: null, priceCachedPer1m: null, currency: 'USD',
  });
  n.store.profiles.create({
    id: 'p1', name: 'P', description: null, colour: null, connectionId: 'c1', modelId: 'm1', systemPrompt: null, params: {},
    toolPolicy: { fs: 'off', shell: false, mcpServerIds: [], approvalMode: 'always_ask' }, isDefault: true, archivedAt: null,
  });
}

function chat(n: Node, id: string): void {
  n.store.chats.create({ id, title: id, profileId: 'p1', headMessageId: null, workspace: null, pinned: false, archivedAt: null });
}

function message(n: Node, id: string, chatId: string, parentId: string | null): void {
  n.store.messages.create({ id, chatId, parentId, role: 'user', parts: [{ type: 'text', text: id }], status: 'complete', error: null, producedBy: null, createdAt: clock });
}

/** A chat with three messages, each changed a few times after it was made. */
function busyChat(n: Node, id: string): void {
  chat(n, id);
  let parent: string | null = null;
  for (const m of ['1', '2', '3']) {
    message(n, `${id}-m${m}`, id, parent);
    parent = `${id}-m${m}`;
  }
  // The chat comes to point at a row made after it: a machine reading the log from the start must still end with this.
  n.store.chats.update(id, { headMessageId: `${id}-m3` });
  for (let i = 0; i < 4; i++) {
    n.store.chats.update(id, { title: `${id} v${i}` });
    n.store.messages.markKept(`${id}-m1`, clock + i);
    n.store.messages.reviseParts(`${id}-m3`, [{ type: 'text', text: `edit ${i}` }]);
  }
}

/** Every synced row a machine holds, with its stamp: two machines that agree hold the same. */
function state(n: Node): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const tbl of SYNC_TABLES) {
    if (tbl === 'location_path') continue;
    const key = tbl === 'project_memory' ? 'project_id' : tbl === 'global_memory' ? 'key' : tbl === 'app_notes' ? 'app_id' : 'id';
    out[tbl] = (n.db.prepare(`SELECT ${key} AS k, hlc FROM ${tbl} ORDER BY ${key}`).all() as { k: string; hlc: string }[]).map((r) => `${r.k}@${r.hlc}`);
  }
  return out;
}

const logSize = (n: Node): number => (n.db.prepare('SELECT COUNT(*) AS c FROM change_log').get() as { c: number }).c;
const stones = (n: Node): string[] => (n.db.prepare('SELECT tbl, row_id FROM tombstone ORDER BY tbl, row_id').all() as { tbl: string; row_id: string }[]).map((r) => `${r.tbl}:${r.row_id}`);
/** What a machine at `cursor` would be sent, as `table:id:op`. */
const offered = (n: Node, cursor: number): string[] => n.store.sync.changesSince(cursor, 100_000).rows.map((r) => `${r.tbl}:${r.id}:${r.op}`).sort();

describe('tidying the change log', () => {
  it('drops superseded entries once every paired machine has stood past them, and every row still reaches each of them', () => {
    const a = node('a');
    const b = node('b');
    const c = node('c');
    pairTo(a, b);
    pairTo(a, c);
    seed(a);
    busyChat(a, 'one');
    pull(a, c);
    const behind = c.cursors.get('a')!;
    busyChat(a, 'two');
    pull(a, b);
    const before = logSize(a);
    const forBehind = offered(a, behind);
    const forNew = offered(a, 0);

    // c stood at `behind` and b at the end, so only what is at or below `behind` may go.
    settle(a);

    expect(logSize(a)).toBeLessThan(before);
    expect(offered(a, behind)).toEqual(forBehind);
    expect(offered(a, 0)).toEqual(forNew);
    // At most its first and last entry a row at or below where c stands; everything after it is as it was.
    expect((a.db.prepare('SELECT COUNT(*) AS c FROM (SELECT 1 FROM change_log WHERE seq <= ? GROUP BY tbl, row_id HAVING COUNT(*) > 2)').get(behind) as { c: number }).c).toBe(0);
    pull(a, c);
    expect(state(c)).toEqual(state(a));
    expect(state(b)).toEqual(state(a));
  });

  it('touches nothing a paired machine has not stood past for the settling time: a machine that lost its newest commits can pull them again', () => {
    const a = node('a');
    const b = node('b');
    pairTo(a, b);
    seed(a);
    busyChat(a, 'one');
    pull(a, b);
    const before = logSize(a);

    // Heard a moment ago is not enough.
    tidy(a);
    clock += PULL_SETTLE_MS - 1;
    tidy(a);
    expect(logSize(a)).toBe(before);

    // And a machine that comes back asking from further back (a power cut took its newest commits) moves the line back.
    const back = (a.db.prepare('SELECT seq FROM change_log ORDER BY seq LIMIT 1 OFFSET 5').get() as { seq: number }).seq;
    const after = (): number => (a.db.prepare('SELECT COUNT(*) AS c FROM change_log WHERE seq > ?').get(back) as { c: number }).c;
    const afterBefore = after();
    const forBack = offered(a, back);
    clock += 1;
    a.store.sync.notePulled('b', back);
    tidy(a);
    expect(after()).toBe(afterBefore);
    expect(offered(a, back)).toEqual(forBack);
  });

  it('a machine never heard from holds everything back', () => {
    const a = node('a');
    const b = node('b');
    const c = node('c');
    pairTo(a, b);
    pairTo(a, c);
    seed(a);
    busyChat(a, 'one');
    a.store.chats.delete('one');
    pull(a, b);
    const before = logSize(a);
    clock += 400 * DAY;
    settle(a);
    expect(logSize(a)).toBe(before);
    expect(stones(a).length).toBeGreaterThan(0);
  });

  it('with no machine paired, keeps the first and last entry of a row, in an order a machine pairing later can take a batch at a time', () => {
    const a = node('a');
    seed(a);
    busyChat(a, 'one');
    busyChat(a, 'two');
    const rows = (a.db.prepare('SELECT SUM(MIN(n, 2)) AS c FROM (SELECT COUNT(*) AS n FROM change_log GROUP BY tbl, row_id)').get() as { c: number }).c;

    expect(tidy(a).entries).toBeGreaterThan(0);
    expect(logSize(a)).toBe(rows);
    expect(tidy(a)).toMatchObject({ entries: 0, tombstones: 0 });

    for (const limit of [1, 3, 1000]) {
      const d = node(`d${limit}`);
      pull(a, d, limit);
      expect(state(d), `batches of ${limit}`).toEqual(state(a));
    }
  });

  it('works through a large log a bounded step at a time', () => {
    const a = node('a');
    seed(a);
    for (let i = 0; i < 12; i++) busyChat(a, `chat-${i}`);
    const expected = (a.db.prepare('SELECT SUM(MIN(n, 2)) AS c FROM (SELECT COUNT(*) AS n FROM change_log GROUP BY tbl, row_id)').get() as { c: number }).c;

    const first = a.store.sync.pruneLog({ now: clock, limit: 5, after: null });
    expect(first.after).not.toBeNull();
    expect(logSize(a)).toBeGreaterThan(expected);
    const rest = tidy(a, 5);

    expect(rest.steps).toBeGreaterThan(5);
    expect(logSize(a)).toBe(expected);
  });
});

describe('tidying tombstones', () => {
  /** a, b and c all hold chat `gone` and its messages; then a deletes it. */
  function deleted(): { a: Node; b: Node; c: Node } {
    const a = node('a');
    const b = node('b');
    const c = node('c');
    for (const [x, y] of [[a, b], [a, c], [b, a], [c, a]] as const) pairTo(x, y);
    seed(a);
    busyChat(a, 'gone');
    busyChat(a, 'kept');
    pull(a, b);
    pull(a, c);
    a.store.chats.delete('gone');
    return { a, b, c };
  }

  it('a delete still reaches a machine that was behind when the tidy ran, however long ago it was made', () => {
    const { a, b, c } = deleted();
    pull(a, b);
    clock += 400 * DAY;
    settle(a);

    // b has it, c has not: nothing about the delete may go.
    expect(stones(a)).toEqual(['chat:gone', 'message:gone-m1', 'message:gone-m2', 'message:gone-m3']);
    expect(c.store.chats.get('gone')).not.toBeNull();
    pull(a, c);
    expect(c.store.chats.get('gone')).toBeNull();
    expect(c.store.messages.get('gone-m2')).toBeNull();
    expect(state(c)).toEqual(state(a));
  });

  it("while it is kept, the old row can't come back from the machine that still has it", () => {
    const { a, b, c } = deleted();
    pull(a, b);
    clock += 400 * DAY;
    settle(a);

    // c, not having heard, edits the chat and sends everything it has.
    c.store.chats.update('gone', { title: 'still here on c' });
    pull(c, a);
    expect(a.store.chats.get('gone')).toBeNull();
    expect(a.store.messages.get('gone-m1')).toBeNull();
  });

  it('goes once every paired machine has stood past the delete and it is old enough, and then no machine has the row to send back', () => {
    const { a, b, c } = deleted();
    pull(a, b);
    pull(a, c);

    // Both have pulled it, but it is not old yet.
    settle(a);
    expect(stones(a).length).toBe(4);

    clock += TOMBSTONE_KEEP_MS;
    const pass = tidy(a);
    expect(pass.tombstones).toBe(4);
    expect(stones(a)).toEqual([]);
    expect(a.db.prepare("SELECT COUNT(*) AS c FROM change_log WHERE row_id LIKE 'gone%'").get()).toEqual({ c: 0 });

    // Each machine sends a everything it has ever logged: the chat does not come back.
    for (const peer of [b, c]) {
      peer.cursors.clear();
      a.cursors.delete(peer.id);
      const written = pull(peer, a);
      expect(written.filter((w) => w.includes('gone'))).toEqual([]);
    }
    expect(a.store.chats.get('gone')).toBeNull();
    expect(a.store.messages.get('gone-m1')).toBeNull();
    expect(state(b)).toEqual(state(a));
    expect(state(c)).toEqual(state(a));
  });

  it('a machine pairing after all that ends up the same as the rest', () => {
    const { a, b, c } = deleted();
    pull(a, b);
    pull(a, c);
    clock += TOMBSTONE_KEEP_MS;
    settle(a);
    expect(stones(a)).toEqual([]);

    for (const limit of [1, 1000]) {
      const d = node(`d${limit}`);
      pairTo(a, d);
      pull(a, d, limit);
      expect(state(d), `batches of ${limit}`).toEqual(state(a));
      expect(d.store.chats.get('gone')).toBeNull();
      expect(d.store.chats.get('kept')).not.toBeNull();
    }
  });

  it('with no machine paired, a tombstone is kept until it is old, for a machine paired before that still holds the row', () => {
    const a = node('a');
    seed(a);
    busyChat(a, 'gone');
    a.store.chats.delete('gone');

    clock += TOMBSTONE_KEEP_MS - DAY;
    tidy(a);
    expect(stones(a).length).toBe(4);
    // Its log is down to the delete alone.
    expect(a.db.prepare("SELECT op FROM change_log WHERE row_id = 'gone'").all()).toEqual([{ op: 'delete' }]);

    clock += 2 * DAY;
    expect(tidy(a).tombstones).toBe(4);
    expect(stones(a)).toEqual([]);
  });

  it("keeps a location path's tombstone (a path can be set again, so the newer of the two must still be told apart)", () => {
    const a = node('a');
    a.store.locations.create({ id: 'l', name: 'L' });
    a.store.locations.setPath({ locationId: 'l', nodeId: 'other', path: '/x' });
    a.store.locations.deletePath('l', 'other');
    clock += 2 * TOMBSTONE_KEEP_MS;
    settle(a);
    expect(stones(a)).toEqual(['location_path:l:other']);
  });

  it('keeps a tombstone that has no log entry: it was taken from another machine for a row never here, and guards against that row arriving late', () => {
    const a = node('a');
    seed(a);
    a.store.sync.apply([{ tbl: 'chat', id: 'elsewhere', op: 'delete', hlc: `${String(clock).padStart(13, '0')}-0000-z` }]);
    clock += 2 * TOMBSTONE_KEEP_MS;
    settle(a);
    expect(stones(a)).toEqual(['chat:elsewhere']);
  });

  it('forgets what it heard from a machine that is no longer paired', () => {
    const { a, b, c } = deleted();
    pull(a, b);
    a.store.peers.delete('c');
    clock += TOMBSTONE_KEEP_MS;
    settle(a);
    // c no longer holds anything back.
    expect(stones(a)).toEqual([]);
    expect(a.db.prepare('SELECT node_id FROM sync_peer_cursor').all()).toEqual([{ node_id: 'b' }]);
    expect(c.store.chats.get('gone')).not.toBeNull();
  });
});
