import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PeerFolderListing } from '@otherbench/core/types/workspace.js';
import { createApp } from '../../src/app.js';
import { createContainer, type Container } from '../../src/container.js';
import { peerFolderListingOf } from '../../src/peer/location-dirs.js';
import { PeerError } from '../../src/peer/service.js';

/**
 * Browsing the folders of the machine a chat runs on (HANDOVER "What is NOT
 * built", now built): two real servers over real TLS on loopback. The PC lists
 * directories only inside its own locations, every path through containPath;
 * `GET /api/fs/dirs`, which lists anywhere, is still not on its listener.
 */

interface Machine {
  id: string;
  container: Container;
  api: (method: string, path: string, body?: unknown) => Promise<Response>;
}

const cleanup: (() => void)[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const c of cleanup.splice(0).reverse()) c();
});

function tempDir(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `otherbench-location-dirs-${label}-`));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function machine(name: string): Promise<Machine> {
  const dir = tempDir(name);
  const container = await createContainer({ dbPath: ':memory:', secretsPath: join(dir, 'secrets.json'), peerPort: 0, peerHosts: ['127.0.0.1'] });
  container.store.nodes.rename(name);
  const app = createApp(container);
  cleanup.push(() => container.close());
  return {
    id: container.store.nodes.self().id,
    container,
    api: async (method, path, body) => app.request(path, { method, headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }),
  };
}

/**
 * The PC has a location "Projects" at `root` holding `alpha` (with `deep` inside), `beta`, a file, and a junction
 * leading out to `outside`, which is no location of the PC's. The laptop has a location of its own at `laptopRoot`.
 */
async function setup(): Promise<{ pc: Machine; laptop: Machine; root: string; outside: string; laptopRoot: string }> {
  const pc = await machine('PC');
  const laptop = await machine('Laptop');
  const root = join(tempDir('pc-root'), 'Projects');
  mkdirSync(join(root, 'alpha', 'deep'), { recursive: true });
  mkdirSync(join(root, 'beta'));
  writeFileSync(join(root, 'secret.txt'), 'not for listing');
  const outside = tempDir('outside');
  mkdirSync(join(outside, 'private'));
  symlinkSync(outside, join(root, 'link-out'), 'junction');
  expect((await pc.api('POST', '/api/locations', { name: 'Projects', path: root })).status).toBe(201);
  const laptopRoot = tempDir('laptop-root');
  mkdirSync(join(laptopRoot, 'notes'));
  expect((await laptop.api('POST', '/api/locations', { name: 'Laptop only', path: laptopRoot })).status).toBe(201);

  const view = await pc.container.peers!.startPairing();
  await laptop.container.peers!.pairWith(view.addresses[0]!, view.code);
  await expect.poll(() => laptop.container.peers!.status(pc.id).status).toBe('reachable');
  // Both have each other's locations by sync: the PC knows the laptop's path, and must still never list it.
  await laptop.container.peers!.syncerOrNull()!.pullFrom(pc.id);
  await pc.container.peers!.syncerOrNull()!.pullFrom(laptop.id);
  expect(pc.container.store.locations.allPaths().some((p) => p.path === laptopRoot)).toBe(true);
  return { pc, laptop, root, outside, laptopRoot };
}

const dirsOn = async (laptop: Machine, pc: Machine, path?: string): Promise<Response> =>
  laptop.api('GET', `/api/peers/${pc.id}/dirs${path === undefined ? '' : `?path=${encodeURIComponent(path)}`}`);

describe("browsing the folders of another machine's locations", () => {
  it("starts at that machine's own locations, and never this one's", async () => {
    const { pc, laptop, root } = await setup();
    const res = await dirsOn(laptop, pc);
    expect(res.status).toBe(200);
    const listing = (await res.json()) as PeerFolderListing;
    expect(listing.path).toBeNull();
    expect(listing.dirs).toEqual([]);
    expect(listing.locations).toEqual([{ id: expect.any(String), name: 'Projects', root }]);
  });

  it('lists sub-folder names inside a location: no files, no links out, and nothing above the location', async () => {
    const { pc, laptop, root } = await setup();
    const top = (await (await dirsOn(laptop, pc, root)).json()) as PeerFolderListing;
    expect(top.path).toBe(root);
    expect(top.parent).toBeNull();
    expect(top.location).toMatchObject({ name: 'Projects', root });
    expect(top.dirs).toEqual([
      { name: 'alpha', path: join(root, 'alpha') },
      { name: 'beta', path: join(root, 'beta') },
    ]);
    expect(top.truncated).toBe(false);
    expect(JSON.stringify(top)).not.toContain('secret.txt');
    expect(JSON.stringify(top)).not.toContain('link-out');

    const alpha = (await (await dirsOn(laptop, pc, join(root, 'alpha'))).json()) as PeerFolderListing;
    expect(alpha.parent).toBe(root);
    expect(alpha.dirs).toEqual([{ name: 'deep', path: join(root, 'alpha', 'deep') }]);
  });

  it('refuses every folder outside its locations: elsewhere, above, through a junction, and the laptop’s own location', async () => {
    const { pc, laptop, root, outside, laptopRoot } = await setup();
    for (const path of [outside, join(root, '..'), join(root, 'link-out'), join(root, 'link-out', 'private'), laptopRoot, tmpdir()]) {
      const res = await dirsOn(laptop, pc, path);
      expect(res.status, path).toBe(403);
      const body = (await res.json()) as { kind: string; error: string };
      expect(body.kind, path).toBe('outside_locations');
      expect(body.error).toContain("isn't in one of PC's locations");
      expect(JSON.stringify(body)).not.toContain('private');
    }
  });

  it('refuses a relative path, says a missing folder is missing, and a file is not a folder', async () => {
    const { pc, laptop, root } = await setup();
    expect((await dirsOn(laptop, pc, 'alpha')).status).toBe(400);
    expect((await dirsOn(laptop, pc, join(root, 'gone'))).status).toBe(404);
    expect((await dirsOn(laptop, pc, join(root, 'secret.txt'))).status).toBe(400);
  });

  it('a chat that runs on the PC takes a browsed folder as a folder in its location', async () => {
    const { pc, laptop, root } = await setup();
    const connection = (await (await pc.api('POST', '/api/connections', { name: 'Mock', kind: 'mock', availability: 'anywhere' })).json()) as { id: string };
    const profile = (await (await pc.api('POST', '/api/profiles', { name: 'Mock', connectionId: connection.id, modelId: 'mock' })).json()) as { id: string };
    const chat = (await (await pc.api('POST', '/api/chats', { profileId: profile.id })).json()) as { id: string };
    await laptop.container.peers!.syncerOrNull()!.pullFrom(pc.id);
    const picked = ((await (await dirsOn(laptop, pc, root)).json()) as PeerFolderListing).dirs[0]!.path;
    const res = await laptop.api('PATCH', `/api/chats/${chat.id}`, { workspacePath: picked });
    expect(res.status).toBe(200);
    expect(laptop.container.store.chats.get(chat.id)?.workspace).toEqual({ kind: 'location', locationId: expect.any(String), subpath: 'alpha' });
  });

  it("the PC's listener still has no general folder browser, and the narrow one needs a paired machine", async () => {
    const { pc, laptop, root } = await setup();
    for (const path of [`/api/fs/dirs?path=${encodeURIComponent(root)}`, '/api/fs/dirs']) {
      expect((await laptop.container.peers!.call(pc.id, { method: 'GET', path })).status, path).toBe(404);
    }
    expect((await laptop.container.peers!.call(pc.id, { method: 'GET', path: `/api/locations/dirs?path=${encodeURIComponent(root)}` })).status).toBe(200);
    const target = laptop.container.peers!.peer(pc.id)!;
    const asIs = await laptop.container.peers!.client.request(
      { addresses: target.addresses, fingerprint: target.fingerprint },
      { method: 'GET', path: `/api/locations/dirs?path=${encodeURIComponent(root)}`, token: 'not-the-token' }
    );
    expect(asIs.status).toBe(401);
  });

  it('says when the machine is unreachable, or on a build without the route', async () => {
    const { pc, laptop } = await setup();
    const peers = laptop.container.peers!;
    const spy = vi.spyOn(peers, 'call').mockRejectedValueOnce(new PeerError("PC isn't reachable.", 503));
    const unreachable = await dirsOn(laptop, pc);
    expect(unreachable.status).toBe(503);
    expect(await unreachable.json()).toMatchObject({ kind: 'peer_unreachable', nodeId: pc.id });
    spy.mockResolvedValueOnce({ status: 404, body: '404 Not Found', address: '', fingerprint: '' });
    const outdated = await dirsOn(laptop, pc);
    expect(outdated.status).toBe(501);
    expect(await outdated.json()).toMatchObject({ kind: 'peer_outdated', error: 'PC needs a newer OtherBench to browse its folders.' });
    spy.mockResolvedValueOnce({ status: 200, body: { path: 7 }, address: '', fingerprint: '' });
    expect((await dirsOn(laptop, pc)).status).toBe(502);
    expect((await laptop.api('GET', '/api/peers/no-such-machine/dirs')).status).toBe(404);
  });
});

describe('peerFolderListingOf', () => {
  const ok: PeerFolderListing = { path: 'E:\\P', parent: null, location: { id: 'l', name: 'P', root: 'E:\\P' }, dirs: [{ name: 'a', path: 'E:\\P\\a' }], truncated: false, locations: [{ id: 'l', name: 'P', root: 'E:\\P' }] };

  it('takes a well-formed listing as it is, and drops anything else in it', () => {
    expect(peerFolderListingOf(ok)).toEqual(ok);
    expect(peerFolderListingOf({ ...ok, extra: 'x', dirs: [{ name: 'a', path: 'E:\\P\\a', size: 3 }] })).toEqual(ok);
  });

  it('refuses what is not one, and bounds what is', () => {
    expect(peerFolderListingOf(null)).toBeNull();
    expect(peerFolderListingOf({ ...ok, path: 7 })).toBeNull();
    expect(peerFolderListingOf({ ...ok, dirs: 'a' })).toBeNull();
    expect(peerFolderListingOf({ ...ok, dirs: [{ name: 'a' }] })).toBeNull();
    expect(peerFolderListingOf({ ...ok, location: { id: 'l' } })).toBeNull();
    expect(peerFolderListingOf({ ...ok, dirs: [{ name: 'x'.repeat(300), path: 'p' }] })).toBeNull();
    const many = peerFolderListingOf({ ...ok, dirs: Array.from({ length: 1500 }, (_, i) => ({ name: `d${i}`, path: `E:\\P\\d${i}` })) });
    expect(many?.dirs).toHaveLength(1000);
    expect(many?.truncated).toBe(true);
  });
});
