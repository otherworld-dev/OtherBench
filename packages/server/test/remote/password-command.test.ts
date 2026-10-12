import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { main } from '../../src/cli.js';
import { PasswordCommandError, runPasswordCommand } from '../../src/remote/password-command.js';
import { PasswordFile, verifyPassword } from '../../src/remote/password.js';
import { FAST } from './helpers.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'grunt-password-cmd-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function piped(text: string) {
  const stdin = new PassThrough();
  stdin.end(text);
  const out: string[] = [];
  return { io: { stdin, stdout: { write: (s: string) => out.push(s) }, isTTY: false }, out };
}

describe('grunt password', () => {
  it('reads the first line of piped stdin, keeping spaces but not a Windows line ending, and says devices are signed out', async () => {
    const path = join(dir, 'login.json');
    const { io, out } = piped(' pässwörd with spaces \r\nsecond line\n');

    await runPasswordCommand(path, io, FAST);

    const record = new PasswordFile(path).read()!;
    expect(await verifyPassword(' pässwörd with spaces ', record)).toBe(true);
    expect(await verifyPassword(' pässwörd with spaces \r', record)).toBe(false);
    expect(out.join('')).toBe('Password set. Devices signed in to this server are signed out.\n');
  });

  it('refuses fewer than 12 characters and an empty stdin, writing nothing', async () => {
    const path = join(dir, 'login.json');

    await expect(runPasswordCommand(path, piped('short\n').io, FAST)).rejects.toThrow('The password must be at least 12 characters.');
    await expect(runPasswordCommand(path, piped('').io, FAST)).rejects.toThrow(PasswordCommandError);
    expect(new PasswordFile(path).read()).toBeNull();
  });

  it('asks twice without echo on a terminal, and refuses two different answers', async () => {
    const path = join(dir, 'login.json');
    const make = () => {
      const stdin = Object.assign(new PassThrough(), { setRawMode: vi.fn() });
      const out: string[] = [];
      return { stdin, out, io: { stdin, stdout: { write: (s: string) => out.push(s) }, isTTY: true } };
    };

    const ok = make();
    const done = runPasswordCommand(path, ok.io, FAST);
    ok.stdin.write('typed password1\r');
    await new Promise((r) => setImmediate(r));
    ok.stdin.write('typed password1\r');
    await done;
    expect(ok.stdin.setRawMode).toHaveBeenCalledWith(true);
    expect(ok.stdin.setRawMode).toHaveBeenLastCalledWith(false);
    expect(ok.out.join('')).not.toContain('typed password1');
    expect(await verifyPassword('typed password1', new PasswordFile(path).read()!)).toBe(true);

    const bad = make();
    const refused = runPasswordCommand(path, bad.io, FAST);
    bad.stdin.write('typed password1\r');
    await new Promise((r) => setImmediate(r));
    bad.stdin.write('typed password2\r');
    await expect(refused).rejects.toThrow("The passwords don't match.");
  });

  it('is wired into main() beside the database, and a live PasswordFile sees the change', async () => {
    const db = join(dir, 'grunt.db');
    let now = 1_000_000;
    const live = new PasswordFile(join(dir, 'login.json'), () => now, FAST);
    expect(live.epoch()).toBeNull();
    const { io, out } = piped('from the terminal 1\n');
    const exit = vi.fn();

    await main(['password', '--db', db], { stdin: io.stdin, stdout: io.stdout, isTTY: false, exit });

    expect(exit).not.toHaveBeenCalled();
    expect(out.join('')).toContain('Password set.');
    now += 1001;
    expect(live.epoch()).toMatch(/^[0-9a-f]{16}$/);
  });

  it('prints a refusal from main() as an error and exits 1', async () => {
    const { io } = piped('short\n');
    const exit = vi.fn();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await main(['password', '--db', join(dir, 'grunt.db')], { stdin: io.stdin, stdout: io.stdout, isTTY: false, exit });

    expect(exit).toHaveBeenCalledWith(1);
    expect(errorSpy).toHaveBeenCalledWith('Error: The password must be at least 12 characters.');
    errorSpy.mockRestore();
  });
});
