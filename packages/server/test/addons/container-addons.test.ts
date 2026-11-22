import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { createContainer } from '../../src/container.js';

let dir: string;
beforeEach(() => {
  // The long name: on CI the temp folder is an 8.3 short name (RUNNER~1), and vitest's module loader can't import a
  // file URL holding its %7E (plain Node can, so the app is unaffected).
  dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'otherbench-container-addons-')));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('add-ons beside the database', () => {
  it('are loaded by createContainer, with their routes, secrets and job chats', async () => {
    const folder = join(dir, 'addons', 'probe');
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, 'addon.json'), JSON.stringify({ id: 'probe', name: 'Probe', version: '0.0.1', apiVersion: 1, main: 'main.mjs' }));
    // A tiny add-on: one route that says what it can see, using a Hono app the host hands it back through.
    writeFileSync(
      join(folder, 'main.mjs'),
      `export async function activate(host) {
  await host.secrets.set('k', 'v');
  host.routes({ fetch: async (req) => new Response(JSON.stringify({ path: new URL(req.url).pathname, secret: await host.secrets.get('k'), prefix: host.git.jobBranchFor('j') }), { headers: { 'Content-Type': 'application/json' } }) });
}`
    );
    const container = await createContainer({ dbPath: join(dir, 'otherbench.db'), secretsPath: join(dir, 'secrets.json') });
    try {
      expect(container.addons).toEqual([expect.objectContaining({ id: 'probe', status: 'loaded' })]);
      const res = await createApp(container).request('/api/addons/probe/hello');
      expect(await res.json()).toEqual({ path: '/hello', secret: 'v', prefix: 'probe/j' });
      await expect(container.secrets.get('addon:probe:k')).resolves.toBe('v');
    } finally {
      container.close();
    }
  });

  it("let an add-on's dispose finish with the database before it closes", async () => {
    const folder = join(dir, 'addons', 'probe');
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, 'addon.json'), JSON.stringify({ id: 'probe', name: 'Probe', version: '0.0.1', apiVersion: 1, main: 'main.mjs' }));
    // Its dispose waits a moment, then reads the store, as one saving its state on the way out would.
    writeFileSync(
      join(folder, 'main.mjs'),
      `let h;
export function activate(host) { h = host; }
export async function dispose() {
  await new Promise((r) => setTimeout(r, 30));
  try { globalThis.__disposeSaw?.({ apps: h.apps() }); } catch (err) { globalThis.__disposeSaw?.({ error: String(err) }); }
}`
    );
    const saw: unknown[] = [];
    (globalThis as { __disposeSaw?: unknown }).__disposeSaw = (x: unknown) => saw.push(x);
    const container = await createContainer({ dbPath: join(dir, 'otherbench.db'), secretsPath: join(dir, 'secrets.json') });
    container.close();
    await container.settled?.();
    expect(saw).toEqual([{ apps: [] }]);
  });

  it("keep the database's lock until the database has closed, which is after an add-on's dispose", async () => {
    const folder = join(dir, 'addons', 'probe');
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, 'addon.json'), JSON.stringify({ id: 'probe', name: 'Probe', version: '0.0.1', apiVersion: 1, main: 'main.mjs' }));
    writeFileSync(
      join(folder, 'main.mjs'),
      `export function activate() {}
export async function dispose() { await new Promise((r) => setTimeout(r, 30)); }`
    );
    const dbPath = join(dir, 'otherbench.db');
    const container = await createContainer({ dbPath, secretsPath: join(dir, 'secrets.json') });
    container.close();
    // The add-on is still stopping, so the database is still open: another server must not be let in yet.
    expect(container.store.chats.list()).toEqual([]);
    expect(existsSync(`${dbPath}.lock`)).toBe(true);
    await container.settled?.();
    expect(() => container.store.chats.list()).toThrow();
    expect(existsSync(`${dbPath}.lock`)).toBe(false);
  });

  it('close the database and release its lock even when a step of the close throws', async () => {
    const dbPath = join(dir, 'otherbench.db');
    const container = await createContainer({ dbPath, secretsPath: join(dir, 'secrets.json') });
    container.schedules!.dispose = () => {
      throw new Error('the scheduler would not stop');
    };
    expect(() => container.close()).toThrow('the scheduler would not stop');
    expect(() => container.store.chats.list()).toThrow();
    expect(existsSync(`${dbPath}.lock`)).toBe(false);
  });

  it("close the database after an add-on's dispose even when a step of the close throws, and settle without rejecting", async () => {
    const folder = join(dir, 'addons', 'probe');
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, 'addon.json'), JSON.stringify({ id: 'probe', name: 'Probe', version: '0.0.1', apiVersion: 1, main: 'main.mjs' }));
    writeFileSync(join(folder, 'main.mjs'), 'export function activate() {}\nexport async function dispose() {}');
    const dbPath = join(dir, 'otherbench.db');
    const container = await createContainer({ dbPath, secretsPath: join(dir, 'secrets.json') });
    container.schedules!.dispose = () => {
      throw new Error('the scheduler would not stop');
    };
    container.close();
    await expect(container.settled!()).resolves.toBeUndefined();
    expect(() => container.store.chats.list()).toThrow();
    expect(existsSync(`${dbPath}.lock`)).toBe(false);
  });

  it('start fine with no addons folder', async () => {
    const container = await createContainer({ dbPath: join(dir, 'otherbench.db'), secretsPath: join(dir, 'secrets.json') });
    try {
      expect(container.addons).toEqual([]);
    } finally {
      container.close();
    }
  });
});
