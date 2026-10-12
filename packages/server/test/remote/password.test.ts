import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LoginFileError } from '../../src/remote/errors.js';
import { hashPassword, passwordProblem, PasswordFile, verifyPassword } from '../../src/remote/password.js';
import { FAST } from './helpers.js';

// Passes through to the real readFileSync; one test makes a single call fail.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, readFileSync: vi.fn(actual.readFileSync) };
});

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'grunt-password-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('hashPassword and verifyPassword', () => {
  it('pass the right password and fail a wrong one', async () => {
    const record = await hashPassword('correct horse battery', FAST);

    expect(record).toMatchObject({ version: 1, scrypt: FAST });
    expect(record.salt).toMatch(/^[0-9a-f]{32}$/);
    expect(record.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(record.epoch).toMatch(/^[0-9a-f]{16}$/);
    expect(await verifyPassword('correct horse battery', record)).toBe(true);
    expect(await verifyPassword('correct horse batterY', record)).toBe(false);
  });

  it("read scrypt's parameters from the record, so they can rise later", async () => {
    const record = await hashPassword('correct horse battery', FAST);

    expect(await verifyPassword('correct horse battery', { ...record, scrypt: { ...FAST, N: 2 ** 11 } })).toBe(false);
  });

  it('match the same accented password typed composed (Windows) or decomposed (iPhone)', async () => {
    const record = await hashPassword('caf\u00e9 au lait 99', FAST);

    expect(await verifyPassword('cafe\u0301 au lait 99', record)).toBe(true);
  });
});

describe('passwordProblem', () => {
  it('wants 12 to 1,024 characters, counting characters rather than UTF-16 units', () => {
    expect(passwordProblem('a'.repeat(11))).toBe('The password must be at least 12 characters.');
    expect(passwordProblem('a'.repeat(12))).toBeNull();
    expect(passwordProblem('\u{1F512}'.repeat(11))).toBe('The password must be at least 12 characters.');
    expect(passwordProblem('\u{1F512}'.repeat(12))).toBeNull();
    expect(passwordProblem('a'.repeat(1025))).toBe('The password can be at most 1,024 characters.');
  });
});

describe('PasswordFile', () => {
  it('reads null when there is no file, and writes a record it can read back', async () => {
    const file = new PasswordFile(join(dir, 'login.json'), Date.now, FAST);
    expect(file.read()).toBeNull();

    const written = await file.write('correct horse battery');

    expect(file.read()).toEqual(written);
    expect(JSON.parse(readFileSync(join(dir, 'login.json'), 'utf8'))).toEqual(written);
    expect(await verifyPassword('correct horse battery', file.read()!)).toBe(true);
  });

  it('refuses to write a short password', async () => {
    await expect(new PasswordFile(join(dir, 'login.json'), Date.now, FAST).write('short')).rejects.toThrow(/at least 12/);
  });

  it("throws LoginFileError for a file that isn't a password record", () => {
    writeFileSync(join(dir, 'login.json'), '{"version":2}');

    expect(() => new PasswordFile(join(dir, 'login.json')).read()).toThrow(LoginFileError);
  });

  it("sees another process's rewrite within a second, and no sooner", async () => {
    let now = 1_000_000;
    const path = join(dir, 'login.json');
    const writer = new PasswordFile(path, () => now, FAST);
    const server = new PasswordFile(path, () => now, FAST);
    await writer.write('first password 1');
    const before = server.epoch();
    expect(before).toMatch(/^[0-9a-f]{16}$/);

    await writer.write('second password 2');
    expect(server.epoch()).toBe(before);

    now += 1001;
    expect(server.epoch()).toBe(writer.read()!.epoch);
    expect(server.epoch()).not.toBe(before);
  });

  it('keeps the last good epoch through an I/O error on a read, and looks again a second later', async () => {
    let now = 1_000_000;
    const path = join(dir, 'login.json');
    const writer = new PasswordFile(path, () => now, FAST);
    const first = await writer.write('first password 1');
    const server = new PasswordFile(path, () => now, FAST);
    expect(server.epoch()).toBe(first.epoch);

    const second = await writer.write('second password 2');
    vi.mocked(readFileSync).mockImplementationOnce(() => {
      throw Object.assign(new Error('resource busy or locked'), { code: 'EBUSY' });
    });
    now += 1001;
    expect(server.epoch()).toBe(first.epoch);

    now += 1001;
    expect(server.epoch()).toBe(second.epoch);
  });

  it('has no epoch to keep when the first read fails with an I/O error, and retries a second later', async () => {
    let now = 1_000_000;
    const path = join(dir, 'login.json');
    const written = await new PasswordFile(path, () => now, FAST).write('correct horse battery');
    const server = new PasswordFile(path, () => now, FAST);
    vi.mocked(readFileSync).mockImplementationOnce(() => {
      throw Object.assign(new Error('resource busy or locked'), { code: 'EBUSY' });
    });

    expect(server.epoch()).toBeNull();

    now += 1001;
    expect(server.epoch()).toBe(written.epoch);
  });

  it('has no epoch when the file is missing or broken, so every session ends', async () => {
    let now = 1_000_000;
    const path = join(dir, 'login.json');
    const file = new PasswordFile(path, () => now, FAST);
    expect(file.epoch()).toBeNull();

    await file.write('correct horse battery');
    expect(file.epoch()).not.toBeNull();

    writeFileSync(path, 'not json');
    now += 1001;
    expect(file.epoch()).toBeNull();
  });
});
