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

  describe('on a terminal', () => {
    const terminal = () => {
      const stdin = Object.assign(new PassThrough(), { setRawMode: vi.fn() });
      const out: string[] = [];
      return { stdin, out, io: { stdin, stdout: { write: (s: string) => out.push(s) }, isTTY: true } };
    };
    const tick = () => new Promise((r) => setImmediate(r));
    const noListeners = (stdin: PassThrough) => {
      for (const event of ['data', 'end', 'close', 'error']) expect(stdin.listenerCount(event), event).toBe(0);
    };

    it('cancels on Ctrl+C, leaving raw mode off and no listeners, and writes nothing', async () => {
      const path = join(dir, 'login.json');
      const t = terminal();
      const run = runPasswordCommand(path, t.io, FAST);
      t.stdin.write('half typed\u0003');

      await expect(run).rejects.toThrow('Cancelled. Nothing was changed.');
      expect(t.stdin.setRawMode).toHaveBeenLastCalledWith(false);
      noListeners(t.stdin);
      expect(new PasswordFile(path).read()).toBeNull();
    });

    it('lets backspace delete a character, which then is not in the stored password', async () => {
      const path = join(dir, 'login.json');
      const t = terminal();
      const run = runPasswordCommand(path, t.io, FAST);
      t.stdin.write('typed passwordX\u007f1\r');
      await tick();
      t.stdin.write('typed password1\r');
      await run;

      const record = new PasswordFile(path).read()!;
      expect(await verifyPassword('typed password1', record)).toBe(true);
      expect(await verifyPassword('typed passwordX1', record)).toBe(false);
    });

    it('ignores arrow keys, Delete and control characters, even when an escape sequence is split across chunks', async () => {
      const path = join(dir, 'login.json');
      const t = terminal();
      const run = runPasswordCommand(path, t.io, FAST);
      t.stdin.write('typed\u001b[A pass\u001b[3~\u0004word1\u001b');
      await tick();
      t.stdin.write('[D\ttyped\r');
      await tick();
      t.stdin.write('typed pass\u001bOCword1typed\r');
      await run;

      expect(await verifyPassword('typed password1typed', new PasswordFile(path).read()!)).toBe(true);
    });

    it('rejects when stdin ends mid-prompt, with raw mode off and no listeners', async () => {
      const path = join(dir, 'login.json');
      const t = terminal();
      const run = runPasswordCommand(path, t.io, FAST);
      t.stdin.write('half typed');
      await tick();
      t.stdin.end();

      await expect(run).rejects.toThrow(PasswordCommandError);
      await expect(run).rejects.toThrow('Input closed. Nothing was changed.');
      expect(t.stdin.setRawMode).toHaveBeenLastCalledWith(false);
      noListeners(t.stdin);
      expect(new PasswordFile(path).read()).toBeNull();
    });

    it('rejects, rather than crashing, when stdin errors mid-prompt', async () => {
      const t = terminal();
      const run = runPasswordCommand(join(dir, 'login.json'), t.io, FAST);
      await tick();
      t.stdin.emit('error', new Error('boom'));

      await expect(run).rejects.toThrow(PasswordCommandError);
      expect(t.stdin.setRawMode).toHaveBeenLastCalledWith(false);
      noListeners(t.stdin);
    });
  });

  it('turns a piped stdin error into a PasswordCommandError and removes its listeners', async () => {
    const stdin = new PassThrough();
    const run = runPasswordCommand(join(dir, 'login.json'), { stdin, stdout: { write: () => {} }, isTTY: false }, FAST);
    await new Promise((r) => setImmediate(r));
    stdin.emit('error', new Error('boom'));

    await expect(run).rejects.toThrow(PasswordCommandError);
    for (const event of ['data', 'end', 'error']) expect(stdin.listenerCount(event), event).toBe(0);
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
