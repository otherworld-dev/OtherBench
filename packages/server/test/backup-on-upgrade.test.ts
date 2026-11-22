import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '@otherbench/store-sqlite/db.js';
import { MIGRATIONS, NewerDatabaseError, runMigrations, SCHEMA_VERSION } from '@otherbench/store-sqlite/migrations/index.js';
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

    // The version the older build left: the highest one below SCHEMA_VERSION, which needn't be SCHEMA_VERSION - 1.
    const previous = Math.max(...MIGRATIONS.filter((m) => m.version < SCHEMA_VERSION).map((m) => m.version));
    const copy = `${dbPath}.before-schema-${previous}`;
    expect(existsSync(copy)).toBe(true);
    const opened = openDatabase(copy);
    try {
      expect((opened.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(previous);
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

describe('starting on a database from a newer build', () => {
  it('refuses to open it, and leaves it as it was', async () => {
    dir = await mkdtemp(join(tmpdir(), 'otherbench-newer-'));
    const dbPath = join(dir, 'otherbench.db');
    const newer = openDatabase(dbPath);
    runMigrations(newer);
    newer.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
    newer.close();

    await expect(createContainer({ dbPath, secretsPath: join(dir, 'secrets.json') })).rejects.toBeInstanceOf(NewerDatabaseError);

    const after = openDatabase(dbPath);
    try {
      expect((after.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(SCHEMA_VERSION + 1);
    } finally {
      after.close();
    }
  });
});
