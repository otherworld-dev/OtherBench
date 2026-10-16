import { afterEach, describe, expect, it } from 'vitest';
import { PAIRING_CODE_TTL_MS, hashPeerToken } from '@otherbench/core/domain/pairing.js';
import { PeerClient } from '../../src/peer/client.js';
import { IdentityStore } from '../../src/peer/identity.js';
import { PeerError } from '../../src/peer/service.js';
import { interceptingProxy, makeNode, pair, type TestNode } from './helpers.js';

const nodes: TestNode[] = [];
function node(name: string): TestNode {
  const n = makeNode(name);
  nodes.push(n);
  return n;
}

afterEach(async () => {
  await Promise.all(nodes.splice(0).map((n) => n.close()));
});

/** A pairing failure's message and status. */
async function failure(p: Promise<unknown>): Promise<{ status: number; message: string }> {
  try {
    await p;
  } catch (err) {
    if (err instanceof PeerError) return { status: err.status, message: err.message };
    throw err;
  }
  throw new Error('expected the pairing to fail');
}

/** A wrong code that is still a plausible one. */
function wrong(code: string): string {
  return code.startsWith('A') ? `B${code.slice(1)}` : `A${code.slice(1)}`;
}

describe('the peer listener', () => {
  it('is off with no peers, on while a code is shown, and off again when it is cancelled', async () => {
    const pc = node('PC');
    await pc.service.refreshListener();
    expect(pc.service.listener.running).toBe(false);

    const view = await pc.service.startPairing();
    expect(pc.service.listener.running).toBe(true);
    expect(view.addresses).toEqual([`127.0.0.1:${pc.service.listener.listeningPort}`]);
    expect(view.code).toMatch(/^[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}$/);
    expect(view.fingerprint).toMatch(/^[0-9A-F]{4}( [0-9A-F]{4}){3}$/);

    await pc.service.cancelPairing();
    expect(pc.service.listener.running).toBe(false);
  });
});

describe('pairing', () => {
  it('two machines pair over real TLS: each stores the other, pinned, and can call it with the token it was given', async () => {
    const pc = node('PC');
    const laptop = node('Laptop');

    await pair(pc, laptop);

    const onLaptop = laptop.store.peers.get('node-PC')!;
    const onPc = pc.store.peers.get('node-Laptop')!;
    expect(onLaptop).toMatchObject({ name: 'PC', fingerprint: pc.service.fingerprint(), platform: 'win32' });
    expect(onPc).toMatchObject({ name: 'Laptop', fingerprint: laptop.service.fingerprint() });
    expect(onLaptop.addresses[0]).toBe(`127.0.0.1:${pc.service.listener.listeningPort}`);
    expect(onPc.addresses).toContain(`127.0.0.1:${laptop.service.listener.listeningPort}`);
    expect(laptop.service.listener.running).toBe(true);
    expect(pc.service.currentPairing()).toBeNull();

    expect((await laptop.service.call('node-PC', { method: 'GET', path: '/peer/info' })).body).toEqual({
      nodeId: 'node-PC',
      name: 'PC',
      protocolVersion: 1,
      schemaVersion: 12,
      platform: 'win32',
    });
    expect((await pc.service.call('node-Laptop', { method: 'GET', path: '/peer/info' })).body).toMatchObject({ nodeId: 'node-Laptop' });
    expect(pc.events).toContainEqual({ type: 'peers-changed' });
  });

  it('stores only the hash of the token it issued, and the token it holds in the secret store', async () => {
    const pc = node('PC');
    const laptop = node('Laptop');
    await pair(pc, laptop);

    const held = (await laptop.secrets.get('peer-token:node-PC'))!;
    expect(held.length).toBeGreaterThanOrEqual(43);
    const onPc = pc.store.peers.get('node-Laptop')!;
    expect(onPc.issuedTokenHash).toBe(hashPeerToken(held));
    expect(JSON.stringify(pc.store.peers.list())).not.toContain(held);
  });

  it('a wrong code fails, and five cancel the session so even the right code then fails', async () => {
    const pc = node('PC');
    const laptop = node('Laptop');
    const view = await pc.service.startPairing();
    const address = view.addresses[0]!;

    expect(await failure(laptop.service.pairWith(address, wrong(view.code)))).toMatchObject({ status: 403, message: expect.stringContaining('Wrong code') });
    for (let i = 0; i < 3; i++) await failure(laptop.service.pairWith(address, wrong(view.code)));
    expect(await failure(laptop.service.pairWith(address, wrong(view.code)))).toMatchObject({ message: expect.stringContaining('cancelled') });

    expect(pc.service.currentPairing()).toBeNull();
    await expect.poll(() => pc.service.listener.running).toBe(false);
    expect(laptop.store.peers.list()).toEqual([]);
    expect(pc.store.peers.list()).toEqual([]);
  });

  it('an expired code fails, and a used code cannot be used again', async () => {
    const pc = node('PC');
    const laptop = node('Laptop');
    const phone = node('Phone');

    const expiring = await pc.service.startPairing();
    pc.clock.now += PAIRING_CODE_TTL_MS;
    expect(await failure(laptop.service.pairWith(expiring.addresses[0]!, expiring.code))).toMatchObject({ message: expect.stringContaining('no pairing code open') });

    const view = await pc.service.startPairing();
    await laptop.service.pairWith(view.addresses[0]!, view.code);
    expect(await failure(phone.service.pairWith(view.addresses[0]!, view.code))).toMatchObject({ message: expect.stringContaining('no pairing code open') });
    expect(pc.store.peers.list().map((p) => p.nodeId)).toEqual(['node-Laptop']);
  });

  it('a TLS-terminating proxy with its own certificate makes pairing fail on both sides', async () => {
    const pc = node('PC');
    const laptop = node('Laptop');
    const view = await pc.service.startPairing();
    const proxy = await interceptingProxy(view.addresses[0]!);
    try {
      expect(await failure(laptop.service.pairWith(proxy.address, view.code))).toMatchObject({ status: 403 });
    } finally {
      proxy.close();
    }
    expect(laptop.store.peers.list()).toEqual([]);
    expect(pc.store.peers.list()).toEqual([]);
  });

  it("refuses a machine that knows the code but claims an already-paired machine's id, on either side", async () => {
    const pc = node('PC');
    const laptop = node('Laptop');
    await pair(pc, laptop);
    const original = laptop.store.peers.get('node-PC')!;
    // Another machine with the PC's node id, but its own certificate.
    const impostor = node('PC');

    // It enters the laptop's code...
    const shown = await laptop.service.startPairing();
    expect(await failure(impostor.service.pairWith(shown.addresses[0]!, shown.code))).toMatchObject({ status: 409 });
    expect(impostor.store.peers.list()).toEqual([]);
    // ...or shows one for the laptop to enter. (The impostor, answering first,
    // keeps its own one-sided record; the laptop stores nothing.)
    const offered = await impostor.service.startPairing();
    expect(await failure(laptop.service.pairWith(offered.addresses[0]!, offered.code))).toMatchObject({ status: 409, message: expect.stringContaining('already paired as PC') });

    expect(laptop.store.peers.list()).toEqual([original]);
  });

  it('caps the size of a pairing request', async () => {
    const pc = node('PC');
    const laptop = node('Laptop');
    const view = await pc.service.startPairing();
    const conn = await laptop.service.client.connectTo(view.addresses[0]!, null);
    const res = await laptop.service.client.requestOn(conn, { method: 'POST', path: '/peer/pair', body: { padding: 'x'.repeat(100 * 1024) } });
    expect(res.status).toBe(413);
    expect(pc.service.currentPairing()).not.toBeNull();
  });

  it('refuses a code that cannot be one, before connecting', async () => {
    const laptop = node('Laptop');
    expect(await failure(laptop.service.pairWith('127.0.0.1:1', 'O0I1'))).toMatchObject({ status: 400 });
  });
});

describe('who may call the peer listener', () => {
  async function paired(): Promise<{ pc: TestNode; laptop: TestNode; address: string; token: string }> {
    const pc = node('PC');
    const laptop = node('Laptop');
    await pair(pc, laptop);
    return { pc, laptop, address: laptop.store.peers.get('node-PC')!.addresses[0]!, token: (await laptop.secrets.get('peer-token:node-PC'))! };
  }

  it('refuses an unknown certificate even with a valid token, and a paired one with a wrong token', async () => {
    const { pc, laptop, address, token } = await paired();
    const stranger = new PeerClient(() => new IdentityStore(() => 'stranger', null).get());
    const asStranger = await stranger.request({ addresses: [address], fingerprint: pc.service.fingerprint() }, { method: 'GET', path: '/peer/info', token });
    expect(asStranger.status).toBe(401);

    const asLaptop = await laptop.service.client.request({ addresses: [address], fingerprint: pc.service.fingerprint() }, { method: 'GET', path: '/peer/info', token: `${token}x` });
    expect(asLaptop.status).toBe(401);
  });

  it('never serves desktop-only routes: attaching a file by path and the folder browser are 404', async () => {
    const { pc, laptop, address, token } = await paired();
    const target = { addresses: [address], fingerprint: pc.service.fingerprint() };
    for (const [method, path] of [
      ['POST', '/api/chats/c/attachments/from-path'],
      ['GET', '/api/fs/dirs?path=C%3A%5C'],
      ['GET', '/api/chats'],
      ['GET', '/api/chats/c/artifacts'],
      ['POST', '/api/chats/c/artifacts/a/save'],
    ] as const) {
      expect((await laptop.service.client.request(target, { method, path, token })).status).toBe(404);
    }
  });

  it('refuses to connect to an address presenting a different certificate than the pinned one', async () => {
    const { pc, laptop, address } = await paired();
    const proxy = await interceptingProxy(address);
    try {
      laptop.store.peers.update('node-PC', { addresses: [proxy.address] });
      expect(await failure(laptop.service.call('node-PC', { method: 'GET', path: '/peer/info' }))).toMatchObject({ status: 503, message: expect.stringContaining('different certificate') });
    } finally {
      proxy.close();
    }
    expect(pc.service.fingerprint()).not.toBe('');
  });
});

describe('removing a machine', () => {
  it('revokes on both sides when the other is reachable, and stops the listener with no peers left', async () => {
    const pc = node('PC');
    const laptop = node('Laptop');
    await pair(pc, laptop);

    expect(await laptop.service.remove('node-PC')).toEqual({ notified: true });

    expect(laptop.store.peers.list()).toEqual([]);
    expect(await laptop.secrets.get('peer-token:node-PC')).toBeNull();
    await expect.poll(() => pc.store.peers.list().length).toBe(0);
    await expect.poll(() => pc.service.listener.running).toBe(false);
    expect(laptop.service.listener.running).toBe(false);
  });

  it("refuses a removed machine's token even when the removal never reached it", async () => {
    const pc = node('PC');
    const laptop = node('Laptop');
    await pair(pc, laptop);

    // The laptop is away: the PC removes it and can't tell it.
    await laptop.service.listener.stop();
    expect(await pc.service.remove('node-Laptop')).toEqual({ notified: false });
    expect(laptop.store.peers.get('node-PC')).not.toBeNull();

    // Later the laptop calls with the token it still holds.
    const view = await pc.service.startPairing();
    laptop.store.peers.update('node-PC', { addresses: view.addresses });
    expect((await laptop.service.call('node-PC', { method: 'GET', path: '/peer/info' })).status).toBe(401);
  });
});
