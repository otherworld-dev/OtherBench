import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'resources', 'mount.sh');
/** Git Bash on Windows (never System32\bash.exe, which would run in a WSL distro); /bin/bash elsewhere. */
const BASH = process.platform === 'win32' ? 'C:\\Program Files\\Git\\bin\\bash.exe' : '/bin/bash';
const hasBash = existsSync(BASH);

/** `mounted` pretends the target is already mounted in that mode (GRUNT_MOUNT_DRY_RUN_MOUNTED). */
function run(args: string[], mounted?: 'ro' | 'rw'): { code: number | null; out: string; err: string } {
  const env: NodeJS.ProcessEnv = { ...process.env, GRUNT_MOUNT_DRY_RUN: '1' };
  delete env['GRUNT_MOUNT_DRY_RUN_MOUNTED'];
  if (mounted) env['GRUNT_MOUNT_DRY_RUN_MOUNTED'] = mounted;
  const r = spawnSync(BASH, [SCRIPT, ...args], { env, encoding: 'utf8' });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

/** Like run(), but the paths travel in the environment: Git Bash splits a command-line argument at a newline. */
function runWithEnvPaths(win: string, target: string): { code: number | null; out: string; err: string } {
  const env: NodeJS.ProcessEnv = { ...process.env, GRUNT_MOUNT_DRY_RUN: '1', TEST_WIN: win, TEST_TARGET: target, TEST_SCRIPT: SCRIPT };
  const r = spawnSync(BASH, ['-c', 'bash "$TEST_SCRIPT" mount "$TEST_WIN" "$TEST_TARGET" ro'], { env, encoding: 'utf8' });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

describe.skipIf(!hasBash)('mount.sh (dry run)', () => {
  it('mounts a folder at its /mnt path, read-only, owned by grunt', () => {
    const r = run(['mount', 'E:\\Git\\Grunt', '/mnt/e/Git/Grunt', 'ro']);
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    expect(r.out.split('\n').filter(Boolean)).toEqual(['mkdir|-p|/mnt/e/Git/Grunt|', 'mount|-t|drvfs|E:\\Git\\Grunt|/mnt/e/Git/Grunt|-o|ro,uid=UID,gid=GID|']);
  });

  it('keeps spaces, apostrophes and accents as they are', () => {
    const r = run(['mount', "C:\\Users\\Zoë O'Brien\\My Project", "/mnt/c/Users/Zoë O'Brien/My Project", 'rw']);
    expect(r.code).toBe(0);
    expect(r.out).toContain("mount|-t|drvfs|C:\\Users\\Zoë O'Brien\\My Project|/mnt/c/Users/Zoë O'Brien/My Project|-o|rw,uid=UID,gid=GID|");
  });

  it('mounts a drive root at /mnt/<drive>', () => {
    expect(run(['mount', 'E:\\', '/mnt/e', 'ro']).out).toContain('mount|-t|drvfs|E:\\|/mnt/e|-o|ro,uid=UID,gid=GID|');
  });

  it('unmounts', () => {
    const r = run(['unmount', 'E:\\Git', '/mnt/e/Git']);
    expect(r.code).toBe(0);
    expect(r.out).toBe('umount|/mnt/e/Git|\n');
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
    expect(r.out.split('\n').filter(Boolean)).toEqual([
      'umount|/mnt/e/Git|',
      'mkdir|-p|/mnt/e/Git|',
      `mount|-t|drvfs|E:\\Git|/mnt/e/Git|-o|${wanted},uid=UID,gid=GID|`,
    ]);
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
  ])('refuses %s', (_name, args, message) => {
    const r = run(args as string[]);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(message);
    expect(r.out).toBe('');
  });
});
