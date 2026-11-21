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
  const limit = o.activateTimeoutMs ?? DEFAULT_ACTIVATE_MS;
  const seconds = Math.round(limit / 1000) || limit / 1000;
  let mod: Partial<AddonModule>;
  try {
    // Under the same limit as activate: a main whose top-level await never settles would otherwise hold up the server's start.
    mod = await withinLimit(import(pathToFileURL(read.mainPath).href) as Promise<Partial<AddonModule>>, limit, `it didn't finish loading within ${seconds} s`);
  } catch (err) {
    return failed(`Its main couldn't be loaded: ${message(err)}`, base);
  }
  if (typeof mod.activate !== 'function') return failed('Its main has no activate function.', base);
  let routes: AddonRoutes | null = null;
  try {
    const host = o.makeHost(manifest, folder, (app) => {
      routes = app;
    });
    await withinLimit(Promise.resolve().then(() => mod.activate!(host)), limit, `its activate didn't finish within ${seconds} s`);
  } catch (err) {
    return failed(`It failed to start: ${message(err)}`, base);
  }
  return { id: manifest.id, ...base, status: 'loaded', error: null, folder, routes, module: mod as AddonModule };
}

/** Settles as `p` does, or rejects with `why` once `ms` has passed. */
async function withinLimit<T>(p: Promise<T>, ms: number, why: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([p, new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error(why)), ms)))]);
  } finally {
    clearTimeout(timer);
  }
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
