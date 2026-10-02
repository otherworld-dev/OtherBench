import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireDbLock, DatabaseLockedError } from '../src/db-lock.js';
import { createContainer } from '../src/container.js';

let dir: string;
let dbPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'grunt-dblock-'));
  dbPath = join(dir, 'grunt.db');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('acquireDbLock', () => {
  it('writes <db>.lock holding this process id, and release removes it', () => {
    const lock = acquireDbLock(dbPath);

    expect(lock).not.toBeNull();
    const held = JSON.parse(readFileSync(`${dbPath}.lock`, 'utf8')) as { pid: number; startedAt: number };
    expect(held.pid).toBe(process.pid);
    expect(typeof held.startedAt).toBe('number');

    lock!.release();
    expect(existsSync(`${dbPath}.lock`)).toBe(false);
  });

  it('refuses a second lock while the holder is alive, naming the holder and the lock file', () => {
    const lock = acquireDbLock(dbPath);

    let thrown: unknown;
    try {
      acquireDbLock(dbPath);
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(DatabaseLockedError);
    expect((thrown as DatabaseLockedError).holderPid).toBe(process.pid);
    expect((thrown as Error).message).toContain(`${dbPath}.lock`);
    lock!.release();
  });

  it('takes over a stale lock whose holder is dead', () => {
    writeFileSync(`${dbPath}.lock`, JSON.stringify({ pid: 999_999, startedAt: 1 }));

    const lock = acquireDbLock(dbPath, { isAlive: () => false });

    const held = JSON.parse(readFileSync(`${dbPath}.lock`, 'utf8')) as { pid: number };
    expect(held.pid).toBe(process.pid);
    lock!.release();
  });

  it('treats an unreadable lock file (a crash mid-write) as stale', () => {
    writeFileSync(`${dbPath}.lock`, '{"pid": 12');

    const lock = acquireDbLock(dbPath, { isAlive: () => true });

    expect(lock).not.toBeNull();
    lock!.release();
  });

  it('release never deletes a lock that now belongs to someone else', () => {
    const lock = acquireDbLock(dbPath);
    writeFileSync(`${dbPath}.lock`, JSON.stringify({ pid: 424242, startedAt: 2 }));

    lock!.release();

    expect(existsSync(`${dbPath}.lock`)).toBe(true);
  });

  it('release is idempotent', () => {
    const lock = acquireDbLock(dbPath);

    lock!.release();
    expect(() => lock!.release()).not.toThrow();
  });

  it('takes no lock for an in-memory database', () => {
    expect(acquireDbLock(':memory:')).toBeNull();
  });
});

describe('createContainer and the database lock', () => {
  it('refuses a second container on the same database until the first is closed', async () => {
    const secretsPath = join(dir, 'secrets.json');
    const first = await createContainer({ dbPath, secretsPath });

    await expect(createContainer({ dbPath, secretsPath })).rejects.toBeInstanceOf(DatabaseLockedError);

    first.close();
    const second = await createContainer({ dbPath, secretsPath });
    second.close();
    expect(existsSync(`${dbPath}.lock`)).toBe(false);
  });

  it('releases the lock if startup fails after taking it', async () => {
    // A directory where the database file should be makes `openDatabase`
    // throw -- after the lock is taken, before any container exists to be
    // closed, and without leaving an open SQLite handle behind (which
    // Windows would then refuse to let afterEach delete).
    mkdirSync(dbPath);

    await expect(createContainer({ dbPath, secretsPath: join(dir, 'secrets.json') })).rejects.toThrow();

    expect(existsSync(`${dbPath}.lock`)).toBe(false);
  });
});
