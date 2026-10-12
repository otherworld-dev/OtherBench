import { describe, expect, it } from 'vitest';
import { hasBash, runMountScript as run, runMountScriptWithEnvPaths as runWithEnvPaths } from './helpers.js';

/** The dry-run line for the mount command: options first, then `--`, then the two paths. */
const mountLine = (win: string, target: string, mode: string): string => `mount|-t|drvfs|-o|${mode},uid=UID,gid=GID|--|${win}|${target}|`;

describe.skipIf(!hasBash)('mount.sh (dry run)', () => {
  it('mounts a folder at its /mnt path, read-only, owned by grunt', () => {
    const r = run(['mount', 'E:\\Git\\Grunt', '/mnt/e/Git/Grunt', 'ro']);
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    // Missing folders are made one level at a time, as root, with their mode set.
    expect(r.out.split('\n').filter(Boolean)).toEqual([
      'mkdir|-m|0755|--|/mnt/e|',
      'mkdir|-m|0755|--|/mnt/e/Git|',
      'mkdir|-m|0755|--|/mnt/e/Git/Grunt|',
      mountLine('E:\\Git\\Grunt', '/mnt/e/Git/Grunt', 'ro'),
    ]);
  });

  it('keeps spaces, apostrophes and accents as they are', () => {
    const r = run(['mount', "C:\\Users\\Zoë O'Brien\\My Project", "/mnt/c/Users/Zoë O'Brien/My Project", 'rw']);
    expect(r.code).toBe(0);
    expect(r.out).toContain(mountLine("C:\\Users\\Zoë O'Brien\\My Project", "/mnt/c/Users/Zoë O'Brien/My Project", 'rw'));
  });

  it('mounts a drive root at /mnt/<drive>', () => {
    expect(run(['mount', 'E:\\', '/mnt/e', 'ro']).out).toContain(mountLine('E:\\', '/mnt/e', 'ro'));
  });

  it('unmounts', () => {
    const r = run(['unmount', 'E:\\Git', '/mnt/e/Git']);
    expect(r.code).toBe(0);
    expect(r.out).toBe('umount|--|/mnt/e/Git|\n');
  });

  it.each(['ro', 'rw'] as const)('leaves a target that is already mounted %s alone', (mode) => {
    const r = run(['mount', 'E:\\Git', '/mnt/e/Git', mode], mode);
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    expect(r.out).toBe('');
  });

  it.each([
    ['ro', 'rw'],
    ['rw', 'ro'],
  ] as const)('unmounts and mounts again when the target is mounted %s and %s is wanted', (was, wanted) => {
    const r = run(['mount', 'E:\\Git', '/mnt/e/Git', wanted], was);
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    expect(r.out.split('\n').filter(Boolean)).toEqual(['umount|--|/mnt/e/Git|', mountLine('E:\\Git', '/mnt/e/Git', wanted)]);
  });

  it('takes a mount whose mode it cannot read off first, and mounts again', () => {
    const r = run(['mount', 'E:\\Git', '/mnt/e/Git', 'ro'], 'unknown');
    expect(r.code).toBe(0);
    expect(r.out.split('\n').filter(Boolean)).toEqual(['umount|--|/mnt/e/Git|', mountLine('E:\\Git', '/mnt/e/Git', 'ro')]);
  });

  describe('the folders on the way to the target', () => {
    const request = ['mount', 'E:\\Git\\Grunt', '/mnt/e/Git/Grunt', 'rw'];

    it('refuses a symbolic link', () => {
      const r = run(request, undefined, { SYMLINK: '/mnt/e/Git' });
      expect(r.code).toBe(2);
      expect(r.err).toMatch(/\/mnt\/e\/Git is a symbolic link/);
      expect(r.out).not.toContain('mount|');
    });

    it('refuses the target itself being a symbolic link', () => {
      const r = run(request, undefined, { SYMLINK: '/mnt/e/Git/Grunt' });
      expect(r.code).toBe(2);
      expect(r.err).toMatch(/symbolic link/);
    });

    it('refuses a folder the sandbox user owns on a writable mount', () => {
      const r = run(request, undefined, { GRUNT_OWNED: '/mnt/e/Git' });
      expect(r.code).toBe(2);
      expect(r.err).toMatch(/\/mnt\/e\/Git could be changed by the sandbox user/);
      expect(r.out).not.toContain('mount|');
    });

    it('accepts a folder the sandbox user owns when it lies on a read-only mount (a rw child inside a ro parent)', () => {
      const r = run(request, undefined, { GRUNT_OWNED: '/mnt/e/Git', READONLY: '1' });
      expect(r.err).toBe('');
      expect(r.code).toBe(0);
      expect(r.out.split('\n').filter(Boolean)).toContain(mountLine('E:\\Git\\Grunt', '/mnt/e/Git/Grunt', 'rw'));
    });

    it('refuses a root-owned folder that group or others can write to, unless it lies on a read-only mount', () => {
      const refused = run(request, undefined, { WRITABLE: '/mnt/e' });
      expect(refused.code).toBe(2);
      expect(refused.err).toMatch(/\/mnt\/e could be changed by the sandbox user/);
      expect(refused.out).not.toContain('mount|');
      const accepted = run(request, undefined, { WRITABLE: '/mnt/e', READONLY: '1' });
      expect(accepted.code).toBe(0);
      expect(accepted.out).toContain(mountLine('E:\\Git\\Grunt', '/mnt/e/Git/Grunt', 'rw'));
    });

    it("doesn't hold the target's own mount to the ownership rule", () => {
      const r = run(request, 'ro', { GRUNT_OWNED: '/mnt/e/Git/Grunt' });
      expect(r.err).toBe('');
      expect(r.code).toBe(0);
      expect(r.out.split('\n').filter(Boolean)).toEqual(['umount|--|/mnt/e/Git/Grunt|', mountLine('E:\\Git\\Grunt', '/mnt/e/Git/Grunt', 'rw')]);
    });

    it('checks the way to an unmount too', () => {
      const r = run(['unmount', 'E:\\Git\\Grunt', '/mnt/e/Git/Grunt'], undefined, { SYMLINK: '/mnt/e/Git' });
      expect(r.code).toBe(2);
      expect(r.err).toMatch(/symbolic link/);
      expect(r.out).toBe('');
    });
  });

  it('still checks a mount request for a target that looks mounted', () => {
    const r = run(['mount', 'E:\\Git', '/etc', 'ro'], 'ro');
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/doesn't match/);
  });

  it('refuses a path with a newline in it', () => {
    const r = runWithEnvPaths('E:\\Git\nx', '/mnt/e/Git\nx');
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/control/);
    expect(r.out).toBe('');
  });

  it.each([
    ['a target elsewhere', ['mount', 'E:\\Git', '/etc', 'ro'], /doesn't match/],
    ['a target for another folder', ['mount', 'E:\\Git', '/mnt/e/Windows', 'ro'], /doesn't match/],
    ['a UNC path', ['mount', '\\\\nas\\share', '/mnt/n/share', 'ro'], /drive-letter/],
    ['a .. segment', ['mount', 'E:\\Git\\..\\Windows', '/mnt/e/Windows', 'ro'], /segment/],
    ['forward slashes', ['mount', 'E:/Git', '/mnt/e/Git', 'ro'], /drive-letter/],
    ['an empty segment', ['mount', 'E:\\Git\\\\x', '/mnt/e/Git/x', 'ro'], /segment/],
    ['a trailing separator', ['mount', 'E:\\Git\\', '/mnt/e/Git', 'ro'], /trailing/],
    ['a bad mode', ['mount', 'E:\\Git', '/mnt/e/Git', 'rwx'], /mode/],
    ['an unknown action', ['format', 'E:\\Git', '/mnt/e/Git', 'ro'], /unknown action/],
    ['too few arguments', ['mount', 'E:\\Git'], /usage/],
    ['an argument that starts with a dash', ['mount', 'E:\\Git', '/mnt/e/Git', '-rw'], /starts with '-'/],
    ['a name with a colon', ['mount', 'E:\\a:b', '/mnt/e/a:b', 'ro'], /doesn't allow/],
    ['a name ending in a dot', ['mount', 'E:\\a.', '/mnt/e/a.', 'ro'], /dot or a space/],
  ])('refuses %s', (_name, args, message) => {
    const r = run(args as string[]);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(message);
    expect(r.out).toBe('');
  });
});
