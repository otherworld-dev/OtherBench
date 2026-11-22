import { afterEach, describe, expect, it, vi } from 'vitest';
import { InMemoryStore } from '@otherbench/core/testing/fakes.js';
import { openDatabase } from '@otherbench/store-sqlite/db.js';
import { runMigrations } from '@otherbench/store-sqlite/migrations/index.js';
import { SqliteStore } from '@otherbench/store-sqlite/store.js';
import { runSyncLogSweep, startSyncLogSweep } from '../src/sync-log-sweep.js';

const stores: SqliteStore[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) s.close();
  vi.restoreAllMocks();
});

/** A store with `locations` locations, each renamed `renames` times: plenty of superseded log entries. */
function busyStore(locations: number, renames: number): { store: SqliteStore; logSize: () => number } {
  const db = openDatabase(':memory:');
  runMigrations(db);
  const store = new SqliteStore(db);
  stores.push(store);
  for (let i = 0; i < locations; i++) {
    store.locations.create({ id: `l${i}`, name: 'made' });
    for (let r = 0; r < renames; r++) store.locations.update(`l${i}`, { name: `renamed ${r}` });
  }
  return { store, logSize: () => (db.prepare("SELECT COUNT(*) AS c FROM change_log WHERE tbl = 'location'").get() as { c: number }).c };
}

describe('the change log sweep', () => {
  it('tidies the whole log in short steps, letting the server run between them', async () => {
    const { store, logSize } = busyStore(20, 5);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    let pauses = 0;
    const seenBetween: number[] = [];

    const total = await runSyncLogSweep({
      store,
      step: 3,
      pause: () => {
        pauses++;
        seenBetween.push(logSize());
        return Promise.resolve();
      },
    });

    // First and last entry of each location are kept.
    expect(logSize()).toBe(40);
    expect(total.entries).toBeGreaterThanOrEqual(80);
    expect(pauses).toBeGreaterThan(5);
    // It really was done bit by bit: the log shrank between pauses.
    expect(new Set(seenBetween).size).toBeGreaterThan(3);
  });

  it('stops at the next step when told to, and a later pass finishes the job', async () => {
    const { store, logSize } = busyStore(20, 5);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    let steps = 0;
    await runSyncLogSweep({ store, step: 3, pause: () => Promise.resolve() }, () => ++steps > 2);
    expect(logSize()).toBeGreaterThan(40);

    await runSyncLogSweep({ store, step: 3 });
    expect(logSize()).toBe(40);
  });

  it('does nothing on a store that keeps no change log, and a failure is logged, never thrown', async () => {
    expect(await runSyncLogSweep({ store: new InMemoryStore() })).toEqual({ entries: 0, tombstones: 0 });

    const { store } = busyStore(1, 1);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(store.sync, 'pruneLog').mockImplementation(() => {
      throw new Error('disk full');
    });
    await expect(runSyncLogSweep({ store })).resolves.toEqual({ entries: 0, tombstones: 0 });
    expect(error).toHaveBeenCalledWith(expect.stringContaining('change log tidy failed'), expect.any(Error));
  });

  it('runs a little after the start and then on its interval, and not after it is stopped', async () => {
    const { store, logSize } = busyStore(4, 5);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const sweeper = startSyncLogSweep({ store }, { firstMs: 5, intervalMs: 40 });
    await vi.waitFor(() => expect(logSize()).toBe(8));

    for (let r = 0; r < 3; r++) store.locations.update('l0', { name: `again ${r}` });
    await vi.waitFor(() => expect(logSize()).toBe(8));

    sweeper.stop();
    await sweeper.idle();
    for (let r = 0; r < 3; r++) store.locations.update('l0', { name: `after the stop ${r}` });
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(logSize()).toBe(11);
  });
});
