import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '@otherbench/store-sqlite/db.js';
import { MIGRATIONS, runMigrations, SCHEMA_VERSION } from '@otherbench/store-sqlite/migrations/index.js';
import { createContainer } from '../src/container.js';

let dir: string;
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('starting on a database from an older build', () => {
  it('leaves a copy of the old database before migrating it', async () => {
    dir = await mkdtemp(join(tmpdir(), 'otherbench-upgrade-'));
    const dbPath = join(dir, 'otherbench.db');
    const old = openDatabase(dbPath);
    runMigrations(old, MIGRATIONS.filter((m) => m.version < SCHEMA_VERSION));
    old.close();

    const container = await createContainer({ dbPath, secretsPath: join(dir, 'secrets.json') });
    container.close();

    const copy = `${dbPath}.before-schema-${SCHEMA_VERSION - 1}`;
    expect(existsSync(copy)).toBe(true);
    const opened = openDatabase(copy);
    try {
      expect((opened.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(SCHEMA_VERSION - 1);
    } finally {
      opened.close();
    }
  });

  it('copies nothing on a first start', async () => {
    dir = await mkdtemp(join(tmpdir(), 'otherbench-upgrade-'));
    const dbPath = join(dir, 'otherbench.db');
    const container = await createContainer({ dbPath, secretsPath: join(dir, 'secrets.json') });
    container.close();
    expect(existsSync(`${dbPath}.before-schema-0`)).toBe(false);
  });
});
