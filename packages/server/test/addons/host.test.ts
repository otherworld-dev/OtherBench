import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AddonManifest } from '@otherbench/addon-api';
import { FakeSecretStore, InMemoryStore } from '@otherbench/core/testing/fakes.js';
import type { AppEvent } from '@otherbench/core/types/events.js';
import { makeAddonHost, type AddonHostDeps } from '../../src/addons/host.js';
import { JobGit } from '../../src/jobs/git.js';
import type { JobRunner } from '../../src/jobs/runner.js';

let dataDir: string;
beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'otherbench-addon-host-'));
});
afterEach(() => rmSync(dataDir, { recursive: true, force: true }));

const manifest = (id: string, over: Partial<AddonManifest> = {}): AddonManifest => ({ id, name: id, version: '1', apiVersion: 1, main: 'main.mjs', ...over });

function deps(over: Partial<AddonHostDeps> = {}): AddonHostDeps & { emitted: AppEvent[] } {
  const emitted: AppEvent[] = [];
  const store = new InMemoryStore();
  return {
    store,
    secrets: new FakeSecretStore(),
    jobs: {} as JobRunner,
    jobGitFor: (prefix) => new JobGit({ root: join(dataDir, 'job-git'), branchPrefix: prefix }),
    emit: (e) => emitted.push(e),
    atThisMachine: () => true,
    dataRoot: join(dataDir, 'addon-data'),
    appFolder: () => null,
    emitted,
    ...over,
  };
}

describe('makeAddonHost', () => {
  it("gives each add-on its own data folder, made for it", () => {
    const host = makeAddonHost(deps(), manifest('glow'), () => {});
    expect(host.id).toBe('glow');
    expect(host.dataFolder).toBe(join(dataDir, 'addon-data', 'glow'));
    expect(existsSync(host.dataFolder)).toBe(true);
  });

  it("keeps each add-on's secrets apart from the others' and from OtherBench's own", async () => {
    const d = deps();
    await d.secrets.set('token', 'otherbench-own');
    const a = makeAddonHost(d, manifest('alpha'), () => {});
    const b = makeAddonHost(d, manifest('beta'), () => {});
    await a.secrets.set('token', 'alpha-secret');
    await expect(b.secrets.get('token')).resolves.toBeNull();
    await expect(a.secrets.get('token')).resolves.toBe('alpha-secret');
    await expect(d.secrets.get('token')).resolves.toBe('otherbench-own');
    await a.secrets.delete('token');
    await expect(a.secrets.get('token')).resolves.toBeNull();
  });

  it('refuses a secret key that could reach outside its own names', async () => {
    const a = makeAddonHost(deps(), manifest('alpha'), () => {});
    await expect(a.secrets.set('../token', 'x')).rejects.toThrow(/key/);
  });

  it("gives git under the add-on's branch prefix, its id unless the manifest says otherwise", () => {
    expect(makeAddonHost(deps(), manifest('glow'), () => {}).git.jobBranchFor('j1')).toBe('glow/j1');
    expect(makeAddonHost(deps(), manifest('glow', { branchPrefix: 'gl' }), () => {}).git.jobBranchFor('j1')).toBe('gl/j1');
  });

  it('notify tells the windows this add-on changed', () => {
    const d = deps();
    makeAddonHost(d, manifest('glow'), () => {}).notify();
    expect(d.emitted).toEqual([{ type: 'addon-changed', id: 'glow' }]);
  });

  it('passes its routes on once, and refuses a second set', () => {
    const onRoutes = vi.fn();
    const host = makeAddonHost(deps(), manifest('glow'), onRoutes);
    const app = new Hono();
    host.routes(app);
    expect(onRoutes).toHaveBeenCalledWith(app);
    expect(() => host.routes(new Hono())).toThrow(/once/);
  });

  it('lists apps with their folder here, and only live profiles', () => {
    const d = deps({ appFolder: (app) => (app.id === 'a1' ? 'E:\\Git\\One' : null) });
    d.store.apps.create({ id: 'a1', name: 'One' });
    d.store.apps.create({ id: 'a2', name: 'Two' });
    const host = makeAddonHost(d, manifest('glow'), () => {});
    expect(host.apps()).toEqual(expect.arrayContaining([{ id: 'a1', name: 'One', folder: 'E:\\Git\\One' }, { id: 'a2', name: 'Two', folder: null }]));
  });

  it("asks the app whether a request came from this machine", () => {
    const at = vi.fn(() => false);
    const host = makeAddonHost(deps({ atThisMachine: at }), manifest('glow'), () => {});
    expect(host.atThisMachine({} as never)).toBe(false);
    expect(at).toHaveBeenCalled();
  });
});
