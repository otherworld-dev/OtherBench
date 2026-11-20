import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AddonHost, AddonManifest } from '@otherbench/addon-api';
import { disposeAddons, loadAddons } from '../../src/addons/loader.js';
import { readManifest } from '../../src/addons/manifest.js';

let dataDir: string;
let addonsDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'otherbench-addons-'));
  addonsDir = join(dataDir, 'addons');
});
afterEach(() => rmSync(dataDir, { recursive: true, force: true }));

/** Writes an add-on folder: its manifest (merged over a good one) and a main module with the given body. */
function addon(id: string, manifest: Partial<AddonManifest> | string = {}, main = 'export function activate(host) { globalThis.__activated?.(host); }'): string {
  const folder = join(addonsDir, id);
  mkdirSync(folder, { recursive: true });
  const json = typeof manifest === 'string' ? manifest : JSON.stringify({ id, name: `Add-on ${id}`, version: '1.0.0', apiVersion: 1, main: 'main.mjs', ...manifest });
  writeFileSync(join(folder, 'addon.json'), json);
  writeFileSync(join(folder, 'main.mjs'), main);
  return folder;
}

function fakeHost(manifest: AddonManifest, folder: string): AddonHost {
  return { id: manifest.id, dataFolder: join(dataDir, 'addon-data', manifest.id), folder } as unknown as AddonHost;
}

describe('readManifest', () => {
  it('reads a good manifest, with main and the settings page inside the folder', () => {
    const folder = addon('glow', { settingsPage: 'page' });
    mkdirSync(join(folder, 'page'));
    const r = readManifest(folder);
    expect(r).toMatchObject({ ok: true, manifest: { id: 'glow', apiVersion: 1 }, mainPath: join(folder, 'main.mjs'), pagePath: join(folder, 'page') });
  });

  it.each([
    ['an id with capitals', { id: 'Glow' }, /id/],
    ['an id that is not its folder', { id: 'other' }, /folder/],
    ['main outside the folder', { main: '../x.mjs' }, /main/],
    ['main as an absolute path', { main: 'C:/x.mjs' }, /main/],
    ['a settings page outside the folder', { settingsPage: '../..' }, /settings page/i],
    ['another API version', { apiVersion: 2 }, /version 2/],
    ['no name', { name: '' }, /name/],
  ])('refuses %s', (_what, over, why) => {
    const r = readManifest(addon('glow', over));
    expect(r).toMatchObject({ ok: false, error: expect.stringMatching(why) });
  });

  it('refuses a manifest that is not JSON', () => {
    expect(readManifest(addon('glow', '{ not json'))).toMatchObject({ ok: false, error: expect.stringMatching(/addon\.json/) });
  });

  it('refuses main reached through a link out of the folder', () => {
    const folder = addon('glow', { main: 'out/main.mjs' });
    const outside = join(dataDir, 'outside');
    mkdirSync(outside);
    writeFileSync(join(outside, 'main.mjs'), '');
    try {
      symlinkSync(outside, join(folder, 'out'), 'junction');
    } catch {
      return; // no link support here
    }
    expect(readManifest(folder)).toMatchObject({ ok: false, error: expect.stringMatching(/main/) });
  });
});

describe('loadAddons', () => {
  it('has nothing to load when there is no addons folder', async () => {
    await expect(loadAddons({ addonsDir, makeHost: fakeHost })).resolves.toEqual([]);
  });

  it('loads a good add-on and calls activate with its own host', async () => {
    addon('glow');
    const seen = vi.fn();
    (globalThis as { __activated?: unknown }).__activated = seen;
    const [loaded] = await loadAddons({ addonsDir, makeHost: fakeHost });
    expect(loaded).toMatchObject({ id: 'glow', name: 'Add-on glow', status: 'loaded', error: null });
    expect(seen).toHaveBeenCalledWith(expect.objectContaining({ id: 'glow', dataFolder: join(dataDir, 'addon-data', 'glow') }));
  });

  it('marks an add-on whose activate throws as failed, and still loads the next one', async () => {
    addon('broken', {}, 'export function activate() { throw new Error("boom"); }');
    addon('fine', {}, 'export function activate() {}');
    const loaded = await loadAddons({ addonsDir, makeHost: fakeHost });
    expect(loaded.find((a) => a.id === 'broken')).toMatchObject({ status: 'failed', error: expect.stringMatching(/boom/) });
    expect(loaded.find((a) => a.id === 'fine')).toMatchObject({ status: 'loaded' });
  });

  it('fails an add-on whose activate never finishes', async () => {
    addon('stuck', {}, 'export function activate() { return new Promise(() => {}); }');
    const [loaded] = await loadAddons({ addonsDir, makeHost: fakeHost, activateTimeoutMs: 50 });
    expect(loaded).toMatchObject({ status: 'failed', error: expect.stringMatching(/didn't finish/) });
  });

  it('fails an add-on with a bad manifest or no activate, giving the reason', async () => {
    addon('badjson', '{');
    addon('noactivate', {}, 'export const x = 1;');
    const loaded = await loadAddons({ addonsDir, makeHost: fakeHost });
    expect(loaded.find((a) => a.id === 'badjson')).toMatchObject({ status: 'failed', name: 'badjson', error: expect.stringMatching(/addon\.json/) });
    expect(loaded.find((a) => a.id === 'noactivate')).toMatchObject({ status: 'failed', error: expect.stringMatching(/activate/) });
  });

  it('ignores files in the addons folder, and folders whose names could never be an id', async () => {
    mkdirSync(addonsDir, { recursive: true });
    writeFileSync(join(addonsDir, 'readme.txt'), 'x');
    mkdirSync(join(addonsDir, '.hidden'));
    await expect(loadAddons({ addonsDir, makeHost: fakeHost })).resolves.toEqual([]);
  });

  it('keeps the routes an add-on gave, and calls dispose on shutdown', async () => {
    addon('glow', {}, 'export function activate(host) { host.giveRoutes(); } export function dispose() { globalThis.__disposed?.(); }');
    const disposed = vi.fn();
    (globalThis as { __disposed?: unknown }).__disposed = disposed;
    const routes = { fetch: () => new Response('ok') };
    const loaded = await loadAddons({
      addonsDir,
      makeHost: (m, folder, onRoutes) => ({ ...fakeHost(m, folder), giveRoutes: () => onRoutes(routes) }) as unknown as AddonHost,
    });
    expect(loaded[0]!.routes).toBe(routes);
    await disposeAddons(loaded);
    expect(disposed).toHaveBeenCalledTimes(1);
  });
});
