import { mkdirSync } from 'node:fs';
import { lookup as dnsLookup } from 'node:dns/promises';
import { join } from 'node:path';
import type { Context } from 'hono';
import type { AddonHost, AddonJobGit, AddonJobRunner, AddonManifest, AddonRoutes } from '@otherbench/addon-api';
import type { App, Store } from '@otherbench/core/ports/store.js';
import type { SecretStore } from '@otherbench/core/ports/secret-store.js';
import type { AppEvent } from '@otherbench/core/types/events.js';
import type { JobGit } from '../jobs/git.js';
import { appDefaultProfileId } from '../profile-resolution.js';
import type { JobRunner } from '../jobs/runner.js';

export interface AddonHostDeps {
  store: Store;
  secrets: SecretStore;
  jobs: JobRunner;
  jobGitFor: (branchPrefix: string) => JobGit;
  emit: (e: AppEvent) => void;
  /** Whether a request came from this machine (set by createApp). */
  atThisMachine: (c: Context) => boolean;
  /** `<data dir>/addon-data`: each add-on's data lives in its own folder here, apart from its installed files. */
  dataRoot: string;
  /** An app's folder on this machine, or null. */
  appFolder: (app: App) => string | null;
  fetch?: typeof fetch;
  lookup?: (host: string) => Promise<{ address: string; family: number }[]>;
}

/** A secret key an add-on may use: no separators, so it never reaches another add-on's names or OtherBench's own. */
const SECRET_KEY = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * The host one add-on is handed (docs/features/addons.md). Everything it can reach on this machine goes through here:
 * its own data folder and secret names, the apps and profiles to choose from, job chats (always under the job rules)
 * and job git under its own branch prefix, its routes and a change notice.
 */
export function makeAddonHost(d: AddonHostDeps, manifest: AddonManifest, onRoutes: (app: AddonRoutes) => void): AddonHost {
  const dataFolder = join(d.dataRoot, manifest.id);
  mkdirSync(dataFolder, { recursive: true });
  const ref = (key: string): string => {
    if (!SECRET_KEY.test(key)) throw new Error(`"${key}" is not a secret key an add-on may use.`);
    return `addon:${manifest.id}:${key}`;
  };
  let routesGiven = false;
  // Both are structurally the add-on API's types; these assignments are where a drift would fail the build.
  const jobs: AddonJobRunner = d.jobs;
  const git: AddonJobGit = d.jobGitFor(manifest.branchPrefix ?? manifest.id);
  return {
    id: manifest.id,
    dataFolder,
    log: (msg, err) => (err === undefined ? console.log(`[addon ${manifest.id}] ${msg}`) : console.warn(`[addon ${manifest.id}] ${msg}`, err)),
    secrets: {
      get: async (key) => d.secrets.get(ref(key)),
      set: async (key, value) => d.secrets.set(ref(key), value),
      delete: async (key) => d.secrets.delete(ref(key)),
    },
    apps: () => d.store.apps.list().map((a) => ({ id: a.id, name: a.name, folder: d.appFolder(a) })),
    profiles: () => d.store.profiles.list().filter((p) => p.archivedAt === null).map((p) => ({ id: p.id, name: p.name })),
    defaultProfileId: () => appDefaultProfileId(d.store),
    machineName: () => d.store.nodes.self().name,
    jobs,
    git,
    routes(app) {
      if (routesGiven) throw new Error('An add-on gives its routes once.');
      routesGiven = true;
      onRoutes(app);
    },
    atThisMachine: (c) => d.atThisMachine(c),
    notify: () => d.emit({ type: 'addon-changed', id: manifest.id }),
    fetch: d.fetch ?? fetch,
    lookup: d.lookup ?? ((host) => dnsLookup(host, { all: true })),
  };
}
