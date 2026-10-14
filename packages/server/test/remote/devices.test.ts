import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEVICE_MS, DeviceKeys } from '../../src/remote/devices.js';

let dir: string;
let path: string;
const clock = { now: 1_800_000_000_000 };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'grunt-devices-'));
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

  it('replaces a broken key file, which only forgets the devices', () => {
    writeFileSync(path, 'not json');
    const { value } = keys().issue('epoch1');

    expect(keys().valid(value, 'epoch1')).toBe(true);
  });
});
