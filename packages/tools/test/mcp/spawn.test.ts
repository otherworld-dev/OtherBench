import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { ExecutableNotFoundError, resolveExecutable } from '../../src/mcp/spawn.js';

// This whole suite is the "Windows trap" regression test the task explicitly
// requires: `spawn('npx', ..., { shell: false })` fails with ENOENT on
// Windows because `npx` is really `npx.cmd`/`npx.exe` on PATH, and
// `CreateProcess` (unlike `cmd.exe`) never consults PATHEXT itself. It can
// only genuinely fail (rather than vacuously pass) when actually run on
// Windows -- gated below, not skipped on this dev box, since we ARE on
// Windows here.
describe('resolveExecutable', () => {
  describe('non-Windows platforms', () => {
    it('returns the bare command unchanged -- POSIX PATH search has no PATHEXT ambiguity to resolve', () => {
      expect(resolveExecutable('npx', { platform: 'linux' })).toBe('npx');
      expect(resolveExecutable('uvx', { platform: 'darwin' })).toBe('uvx');
    });
  });

  describe('any platform', () => {
    it('returns an already-path-shaped command unchanged, without touching `where`', () => {
      expect(resolveExecutable('./local/npx', { platform: 'win32' })).toBe('./local/npx');
      expect(resolveExecutable('C:\\tools\\npx.cmd', { platform: 'win32' })).toBe('C:\\tools\\npx.cmd');
    });
  });

  // Deliberately does NOT depend on `npx`/`uvx` actually being installed on
  // whatever box runs this suite -- a synthetic PATH with hand-built
  // `.cmd`/`.exe` shims makes the assertion on the *resolved extension*
  // deterministic regardless of this machine's toolchain. Only runs its
  // real assertions on win32 (the one platform this code path can execute
  // on at all -- `where` isn't invoked elsewhere); everywhere else this is a
  // structural no-op so `npm test` still passes cross-platform in CI.
  (process.platform === 'win32' ? describe : describe.skip)('on Windows, against a synthetic PATH', () => {
    let dir: string;
    let originalPath: string | undefined;

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'grunt-spawn-test-'));
      writeFileSync(join(dir, 'grunt-fixture-cmd.cmd'), '@echo off\r\necho hi\r\n');
      writeFileSync(join(dir, 'grunt-fixture-exe.exe'), Buffer.from([0x4d, 0x5a])); // MZ header stub -- never executed, only resolved
      try {
        chmodSync(join(dir, 'grunt-fixture-cmd.cmd'), 0o755);
        chmodSync(join(dir, 'grunt-fixture-exe.exe'), 0o755);
      } catch {
        /* mode bits are a no-op on Windows anyway */
      }
      originalPath = process.env['PATH'];
      process.env['PATH'] = `${dir}${delimiter}${originalPath ?? ''}`;
    });

    afterEach(() => {
      process.env['PATH'] = originalPath;
      rmSync(dir, { recursive: true, force: true });
    });

    it('resolves an npm-style launcher (bare name -> real .cmd shim), exactly the npx case', () => {
      const resolved = resolveExecutable('grunt-fixture-cmd');
      expect(resolved.toLowerCase()).toContain('grunt-fixture-cmd.cmd');
      expect(resolved).toMatch(/^[A-Za-z]:[\\/]/); // absolute -- the whole point, so a later shell:false spawn can find it
    });

    it('resolves a uv-style launcher (bare name -> real .exe binary), exactly the uvx case', () => {
      const resolved = resolveExecutable('grunt-fixture-exe');
      expect(resolved.toLowerCase()).toContain('grunt-fixture-exe.exe');
      expect(resolved).toMatch(/^[A-Za-z]:[\\/]/);
    });

    it('throws ExecutableNotFoundError (not ENOENT from a downstream spawn) for a command missing from PATH', () => {
      expect(() => resolveExecutable('grunt-fixture-does-not-exist-anywhere')).toThrow(ExecutableNotFoundError);
    });
  });
});
