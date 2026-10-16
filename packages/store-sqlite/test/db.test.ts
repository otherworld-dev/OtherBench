import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  openDatabase,
  assertLocalDatabasePath,
  assertLocalLinux,
  NonLocalDatabaseError,
  isUncPath,
  isNetworkResolvedPath,
  findMountFsType,
  isNetworkFsType,
} from '../src/db.js';

const base = mkdtempSync(join(tmpdir(), 'otherbench-db-'));
afterAll(() => {
  try {
    rmSync(base, { recursive: true, force: true });
  } catch {
    // ignore cleanup races
  }
});

describe('openDatabase', () => {
  it('opens a temp file and enables WAL journal mode', () => {
    const dbPath = join(base, 'g.db');
    const db = openDatabase(dbPath);
    try {
      const row = db.prepare('PRAGMA journal_mode').get() as { journal_mode: string };
      expect(row.journal_mode).toBe('wal');
    } finally {
      db.close();
    }
  });

  it('enables foreign_keys and sets busy_timeout', () => {
    const dbPath = join(base, 'g2.db');
    const db = openDatabase(dbPath);
    try {
      const fk = db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number };
      expect(fk.foreign_keys).toBe(1);
      const bt = db.prepare('PRAGMA busy_timeout').get() as { timeout: number };
      expect(bt.timeout).toBe(5000);
    } finally {
      db.close();
    }
  });

  it('bypasses the local-path guard for :memory:', () => {
    const db = openDatabase(':memory:');
    db.close();
  });

  it.skipIf(process.platform !== 'win32')(
    'rejects a UNC path (backslash form) on Windows',
    () => {
      expect(() => openDatabase('\\\\server\\share\\g.db')).toThrow(NonLocalDatabaseError);
    }
  );

  it.skipIf(process.platform !== 'win32')(
    'rejects a UNC path (forward-slash form) on Windows',
    () => {
      expect(() => openDatabase('//server/share/g.db')).toThrow(NonLocalDatabaseError);
    }
  );
});

describe('assertLocalDatabasePath', () => {
  it('does not throw for :memory:', () => {
    expect(() => assertLocalDatabasePath(':memory:')).not.toThrow();
  });

  it.skipIf(process.platform !== 'win32')('throws for a UNC path on Windows', () => {
    expect(() => assertLocalDatabasePath('\\\\nas\\share\\g.db')).toThrow(NonLocalDatabaseError);
  });

  it.skipIf(process.platform !== 'win32')('allows an ordinary local path on Windows', () => {
    expect(() => assertLocalDatabasePath(join(base, 'ok.db'))).not.toThrow();
  });
});

// --- pure helpers: platform-independent, run everywhere -------------------

describe('isUncPath', () => {
  it('detects a backslash UNC path', () => {
    expect(isUncPath('\\\\server\\share\\g.db')).toBe(true);
  });

  it('detects a forward-slash UNC path', () => {
    expect(isUncPath('//server/share/g.db')).toBe(true);
  });

  it('does not flag an ordinary drive-letter path', () => {
    expect(isUncPath('C:\\Users\\adam\\g.db')).toBe(false);
  });

  it('does not flag a Windows extended-length local path (\\\\?\\C:\\...)', () => {
    expect(isUncPath('\\\\?\\C:\\Users\\adam\\g.db')).toBe(false);
  });

  it('flags an extended-length UNC path (\\\\?\\UNC\\server\\share)', () => {
    expect(isUncPath('\\\\?\\UNC\\server\\share\\g.db')).toBe(true);
  });

  it('does not flag a POSIX absolute path', () => {
    expect(isUncPath('/home/adam/g.db')).toBe(false);
  });
});

describe('isNetworkResolvedPath', () => {
  it('flags a realpath that resolves to a UNC form', () => {
    expect(isNetworkResolvedPath('\\\\fileserver\\data\\g.db')).toBe(true);
  });

  it('does not flag a realpath on a plain local drive', () => {
    expect(isNetworkResolvedPath('C:\\Users\\adam\\g.db')).toBe(false);
  });
});

// Shared /proc/mounts fixture covering all five network filesystem types the
// brief names (nfs, nfs4, cifs, smbfs, fuse.sshfs) plus three distinct local
// types (ext4 at root, xfs at /home, btrfs at /data) -- distinct local types
// matter because a longest-match bug that wrongly falls back to the root
// mount would otherwise go unnoticed when every local mount reports the same
// fs type. Used by both the findMountFsType tests below and the
// assertLocalLinux tests further down, so the two suites can't drift apart
// on what the fixture actually contains.
const LINUX_MOUNTS_FIXTURE = [
  'sysfs /sys sysfs rw,nosuid,nodev,noexec,relatime 0 0',
  'proc /proc proc rw,nosuid,nodev,noexec,relatime 0 0',
  '/dev/sda1 / ext4 rw,relatime 0 0',
  '/dev/sda2 /home xfs rw,relatime 0 0',
  '/dev/sda3 /data btrfs rw,relatime 0 0',
  'nas.local:/export /mnt/nas nfs4 rw,relatime,vers=4.2 0 0',
  'legacy.local:/export /mnt/nfsv3 nfs rw,relatime,vers=3 0 0',
  '//192.168.1.5/share /mnt/smb cifs rw,relatime 0 0',
  '//192.168.1.6/share /mnt/smbfs-mount smbfs rw,relatime 0 0',
  'tmpfs /run tmpfs rw,nosuid,nodev 0 0',
  'sshfs#user@host: /mnt/remote fuse.sshfs rw,nosuid,nodev,relatime 0 0',
].join('\n');

describe('findMountFsType (Linux /proc/mounts parsing, fixture-driven)', () => {
  it('finds the fs type of the root mount', () => {
    expect(findMountFsType(LINUX_MOUNTS_FIXTURE, '/etc/g.db')).toBe('ext4');
  });

  it('prefers the longest (most specific) matching mount point over root', () => {
    // /home is a DIFFERENT fs type (xfs) than root (ext4) specifically so
    // this assertion discriminates: if the longest-match logic wrongly fell
    // back to the root mount, this would fail rather than passing by
    // coincidence (both being the same type would let that bug through).
    expect(findMountFsType(LINUX_MOUNTS_FIXTURE, '/home/adam/project/g.db')).toBe('xfs');
    expect(findMountFsType(LINUX_MOUNTS_FIXTURE, '/mnt/nas/db/g.db')).toBe('nfs4');
    expect(findMountFsType(LINUX_MOUNTS_FIXTURE, '/mnt/smb/x/g.db')).toBe('cifs');
    expect(findMountFsType(LINUX_MOUNTS_FIXTURE, '/mnt/remote/g.db')).toBe('fuse.sshfs');
  });

  it('returns null when nothing matches', () => {
    expect(findMountFsType('', '/some/path/g.db')).toBeNull();
  });
});

describe('assertLocalLinux (fixture-driven Linux network-mount rejection, no platform gating)', () => {
  // Deliberately NOT gated behind it.skipIf(process.platform !== 'linux').
  // assertLocalLinux takes /proc/mounts content as a plain string argument
  // and does no real filesystem I/O, so it is fully exercisable -- including
  // the actual throw, not just fixture parsing -- on any OS. This is what
  // closes the gap the coordinator flagged: CI's ubuntu-latest runner has no
  // real NFS/CIFS/sshfs mount, so without tests like these the rejection
  // branch would never execute anywhere, on any platform.

  it.each([
    ['/mnt/nas/db/g.db', 'nfs4'],
    ['/mnt/nfsv3/db/g.db', 'nfs'],
    ['/mnt/smb/db/g.db', 'cifs'],
    ['/mnt/smbfs-mount/db/g.db', 'smbfs'],
    ['/mnt/remote/db/g.db', 'fuse.sshfs'],
  ])('throws NonLocalDatabaseError for a path under a %s (%s) mount', (dbPath) => {
    expect(() => assertLocalLinux(dbPath, LINUX_MOUNTS_FIXTURE)).toThrow(NonLocalDatabaseError);
  });

  it.each([
    ['/etc/g.db', 'ext4 (root)'],
    ['/home/adam/project/g.db', 'xfs'],
    ['/data/project/g.db', 'btrfs'],
  ])('does not throw for a path under a local %s mount', (dbPath) => {
    expect(() => assertLocalLinux(dbPath, LINUX_MOUNTS_FIXTURE)).not.toThrow();
  });
});

describe('isNetworkFsType', () => {
  it('flags known network filesystem types', () => {
    for (const t of ['nfs', 'nfs4', 'cifs', 'smbfs', 'fuse.sshfs', 'ncpfs']) {
      expect(isNetworkFsType(t)).toBe(true);
    }
  });

  it('does not flag local filesystem types', () => {
    for (const t of ['ext4', 'xfs', 'btrfs', 'tmpfs', 'ntfs']) {
      expect(isNetworkFsType(t)).toBe(false);
    }
  });
});
