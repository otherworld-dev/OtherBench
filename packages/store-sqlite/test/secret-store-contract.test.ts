import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSecretStoreContract } from '@otherbench/core/testing/secret-store-contract.js';
import { EncryptedFileSecretStore } from '../src/secret-store.js';

// The IDENTICAL shared contract (packages/core/src/testing/secret-store-contract.ts)
// that FakeSecretStore passes, run against the real encrypted-file store.
const dirs = new Map<unknown, string>();
runSecretStoreContract(
  'EncryptedFileSecretStore',
  () => {
    const dir = mkdtempSync(join(tmpdir(), 'otherbench-secret-contract-'));
    const store = new EncryptedFileSecretStore(join(dir, 'secrets.json'), 'contract passphrase');
    dirs.set(store, dir);
    return store;
  },
  (store) => {
    const dir = dirs.get(store);
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
);
