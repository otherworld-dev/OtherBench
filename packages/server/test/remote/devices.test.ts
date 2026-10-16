import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEVICE_MS, type DeviceKeyIo, DeviceKeys } from '../../src/remote/devices.js';

let dir: string;
let path: string;
const clock = { now: 1_800_000_000_000 };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'otherbench-devices-'));
  path = join(dir, 'device-key.json');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const keys = () => new DeviceKeys(path, () => clock.now, () => {});

describe('DeviceKeys', () => {
  it('accepts its own cookie under the same password, across a restart', () => {
    const { value, maxAgeSec } = keys().issue('epoch1');
    expect(maxAgeSec).toBe(DEVICE_MS / 1000);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({ version: 1, key: expect.stringMatching(/^[0-9a-f]{64}$/) });

    expect(keys().valid(value, 'epoch1')).toBe(true);
  });

  it('refuses one made under another password, expired, tampered with, malformed or absent', () => {
    const k = keys();
    const { value } = k.issue('epoch1');
    const [id, at, mac] = value.split('.') as [string, string, string];

    expect(k.valid(value, 'epoch2')).toBe(false);
    expect(k.valid(value, null)).toBe(false);
    expect(k.valid(`${id}.${Number(at) + 1}.${mac}`, 'epoch1')).toBe(false);
    expect(k.valid(`${id}.${at}.${mac.slice(0, -1)}${mac.endsWith('A') ? 'B' : 'A'}`, 'epoch1')).toBe(false);
    expect(k.valid('nonsense', 'epoch1')).toBe(false);
    expect(k.valid(undefined, 'epoch1')).toBe(false);

    clock.now += DEVICE_MS;
    expect(k.valid(value, 'epoch1')).toBe(false);
    clock.now -= DEVICE_MS;
  });

  it('forgets every cookie when the key is rotated, in this process and the next', () => {
    const k = keys();
    const { value } = k.issue('epoch1');
    k.rotate();

    expect(k.valid(value, 'epoch1')).toBe(false);
    expect(keys().valid(value, 'epoch1')).toBe(false);
  });

  it('gives the id of a valid cookie, and null for anything else', () => {
    const k = keys();
    const { value } = k.issue('epoch1');

    expect(k.idOf(value, 'epoch1')).toBe(value.split('.')[0]);
    expect(k.idOf(value, 'epoch2')).toBeNull();
  });

  it('deletes the old key file when a new key cannot be saved, so a restart keeps the devices forgotten', () => {
    const log = vi.fn();
    let failWrites = false;
    const io: DeviceKeyIo = {
      write: (p, data) => {
        if (failWrites) throw new Error('disk full');
        writeFileSync(p, data);
      },
      rename: (from, to) => renameSync(from, to),
      unlink: (p) => unlinkSync(p),
    };
    const k = new DeviceKeys(path, () => clock.now, log, io);
    const { value } = k.issue('epoch1');
    failWrites = true;

    k.rotate();

    expect(k.valid(value, 'epoch1')).toBe(false);
    expect(existsSync(path)).toBe(false);
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/so the old one was deleted/));
    // After a restart, a new key: the cookie stays worthless.
    expect(keys().valid(value, 'epoch1')).toBe(false);
  });

  it('says loudly when it can neither save a new key nor delete the old one', () => {
    const log = vi.fn();
    const io: DeviceKeyIo = {
      write: (p, data) => writeFileSync(p, data),
      rename: (from, to) => renameSync(from, to),
      unlink: (p) => unlinkSync(p),
    };
    const k = new DeviceKeys(path, () => clock.now, log, io);
    k.issue('epoch1');
    const broken: DeviceKeyIo = {
      write: () => {
        throw new Error('disk full');
      },
      rename: () => {},
      unlink: () => {
        throw Object.assign(new Error('access denied'), { code: 'EPERM' });
      },
    };
    const stuck = new DeviceKeys(path, () => clock.now, log, broken);

    stuck.rotate();

    expect(log).toHaveBeenCalledWith(expect.stringMatching(/COULDN'T SAVE OR DELETE .*Delete the file by hand/));
  });

  it('replaces a broken key file, which only forgets the devices', () => {
    writeFileSync(path, 'not json');
    const { value } = keys().issue('epoch1');

    expect(keys().valid(value, 'epoch1')).toBe(true);
  });
});
