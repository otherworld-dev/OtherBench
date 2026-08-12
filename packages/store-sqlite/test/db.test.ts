import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  openDatabase,
  assertLocalDatabasePath,
  NonLocalDatabaseError,
  isUncPath,
  isNetworkResolvedPath,
  findMountFsType,
  isNetworkFsType,
} from '../src/db.js';

const base = mkdtempSync(join(tmpdir(), 'grunt-db-'));
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

describe('findMountFsType (Linux /proc/mounts parsing, fixture-driven)', () => {
  const fixture = [
    'sysfs /sys sysfs rw,nosuid,nodev,noexec,relatime 0 0',
    'proc /proc proc rw,nosuid,nodev,noexec,relatime 0 0',
    '/dev/sda1 / ext4 rw,relatime 0 0',
    '/dev/sda2 /home ext4 rw,relatime 0 0',
    'nas.local:/export /mnt/nas nfs4 rw,relatime,vers=4.2 0 0',
    '//192.168.1.5/share /mnt/smb cifs rw,relatime 0 0',
    'tmpfs /run tmpfs rw,nosuid,nodev 0 0',
    'sshfs#user@host: /mnt/remote fuse.sshfs rw,nosuid,nodev,relatime 0 0',
  ].join('\n');

  it('finds the fs type of the root mount', () => {
    expect(findMountFsType(fixture, '/etc/g.db')).toBe('ext4');
  });

  it('prefers the longest (most specific) matching mount point over root', () => {
    expect(findMountFsType(fixture, '/home/adam/project/g.db')).toBe('ext4');
    expect(findMountFsType(fixture, '/mnt/nas/db/g.db')).toBe('nfs4');
    expect(findMountFsType(fixture, '/mnt/smb/x/g.db')).toBe('cifs');
    expect(findMountFsType(fixture, '/mnt/remote/g.db')).toBe('fuse.sshfs');
  });

  it('returns null when nothing matches', () => {
    expect(findMountFsType('', '/some/path/g.db')).toBeNull();
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
