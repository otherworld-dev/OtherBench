import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { AddonHost, AddonManifest, AddonModule, AddonRoutes } from '@otherbench/addon-api';
import { ADDON_ID, readManifest } from './manifest.js';

/** An add-on found in the addons folder, loaded or not. */
export interface LoadedAddon {
  id: string;
  name: string;
  version: string | null;
  status: 'loaded' | 'failed';
  /** Why it didn't load. */
  error: string | null;
  folder: string;
  /** Its settings page folder, checked to be inside its own folder. */
  pagePath: string | null;
  /** The routes it gave, served at /api/addons/<id>/ while it is loaded. */
  routes: AddonRoutes | null;
  module: AddonModule | null;
}

export interface LoadAddonsOptions {
  /** `<data dir>/addons`. */
  addonsDir: string;
  /** The host for one add-on; `onRoutes` keeps the routes it gives. */
  makeHost: (manifest: AddonManifest, folder: string, onRoutes: (app: AddonRoutes) => void) => AddonHost;
  /** How long `activate` may take. Default 10 s. */
  activateTimeoutMs?: number;
}

const DEFAULT_ACTIVATE_MS = 10_000;

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Loads every add-on in `addonsDir` (docs/features/addons.md), one at a time, in name order. Never throws: an add-on
 * that can't be read, imported or activated is listed as failed with the reason, and the rest still load. Only a
 * folder named like an id is looked at; files and other folders are left alone.
 */
export async function loadAddons(o: LoadAddonsOptions): Promise<LoadedAddon[]> {
  let names: string[];
  try {
    names = readdirSync(o.addonsDir).filter((n) => ADDON_ID.test(n)).sort();
  } catch {
    return [];
  }
  const out: LoadedAddon[] = [];
  for (const name of names) {
    const folder = join(o.addonsDir, name);
    try {
      if (!statSync(folder).isDirectory()) continue;
    } catch {
      continue;
    }
    out.push(await loadOne(o, name, folder));
  }
  return out;
}

async function loadOne(o: LoadAddonsOptions, name: string, folder: string): Promise<LoadedAddon> {
  const failed = (error: string, over: Partial<LoadedAddon> = {}): LoadedAddon => ({ id: name, name, version: null, status: 'failed', error, folder, pagePath: null, routes: null, module: null, ...over });
  const read = readManifest(folder);
  if (!read.ok) return failed(read.error);
  const { manifest } = read;
  const base = { name: manifest.name, version: manifest.version, pagePath: read.pagePath };
  let mod: Partial<AddonModule>;
  try {
    mod = (await import(pathToFileURL(read.mainPath).href)) as Partial<AddonModule>;
  } catch (err) {
    return failed(`Its main couldn't be loaded: ${message(err)}`, base);
  }
  if (typeof mod.activate !== 'function') return failed('Its main has no activate function.', base);
  let routes: AddonRoutes | null = null;
  const host = o.makeHost(manifest, folder, (app) => {
    routes = app;
  });
  const limit = o.activateTimeoutMs ?? DEFAULT_ACTIVATE_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.resolve().then(() => mod.activate!(host)),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`its activate didn't finish within ${Math.round(limit / 1000) || limit / 1000} s`)), limit);
      }),
    ]);
  } catch (err) {
    return failed(`It failed to start: ${message(err)}`, base);
  } finally {
    clearTimeout(timer);
  }
  return { id: manifest.id, ...base, status: 'loaded', error: null, folder, routes, module: mod as AddonModule };
}

/** Calls each loaded add-on's dispose; one that throws doesn't stop the rest. */
export async function disposeAddons(addons: readonly LoadedAddon[]): Promise<void> {
  for (const a of addons) {
    if (a.status !== 'loaded' || !a.module?.dispose) continue;
    try {
      await a.module.dispose();
    } catch (err) {
      console.warn(`[otherbench-server] add-on ${a.id} failed to stop:`, err);
    }
  }
}
