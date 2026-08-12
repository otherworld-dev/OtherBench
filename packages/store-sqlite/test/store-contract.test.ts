import { runStoreContract } from '@grunt/core/testing/store-contract.js';
import { openDatabase } from '../src/db.js';
import { runMigrations } from '../src/migrations/index.js';
import { SqliteStore } from '../src/store.js';

// Runs the IDENTICAL, unmodified shared contract suite (packages/core/src/
// testing/store-contract.ts) against the real SQLite-backed Store, so this
// adapter and InMemoryStore (packages/core/test/fakes.test.ts) cannot drift
// apart on behavioural policy -- see the brief for why this file must never
// edit store-contract.ts itself.
runStoreContract(
  'SqliteStore',
  () => {
    const db = openDatabase(':memory:');
    runMigrations(db);
    return new SqliteStore(db);
  },
  (store) => {
    store.close();
  }
);
