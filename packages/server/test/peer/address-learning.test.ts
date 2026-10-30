import { afterEach, describe, expect, it } from 'vitest';
import { makeNode, pair, type TestNode } from './helpers.js';

const nodes: TestNode[] = [];
function node(name: string): TestNode {
  const n = makeNode(name);
  nodes.push(n);
  return n;
}

afterEach(async () => {
  await Promise.all(nodes.splice(0).map((n) => n.close()));
});

/** Two paired machines, and where the PC can really reach the laptop. */
async function paired(): Promise<{ pc: TestNode; laptop: TestNode; laptopAt: string; port: number }> {
  const pc = node('PC');
  const laptop = node('Laptop');
  await pair(pc, laptop);
  const port = laptop.service.listener.listeningPort!;
  return { pc, laptop, laptopAt: `127.0.0.1:${port}`, port };
}

describe('learning a paired machine’s address from its calls', () => {
  it('a laptop that moved networks is reachable again once it has called this machine', async () => {
    const { pc, laptop, laptopAt, port } = await paired();
    // The address the PC knew is from another network: nothing answers there now.
    pc.store.peers.update('node-Laptop', { addresses: [`127.0.0.2:${port}`] });

    await laptop.service.call('node-PC', { method: 'GET', path: '/peer/info' });

    expect(pc.store.peers.get('node-Laptop')!.addresses).toEqual([`127.0.0.2:${port}`, laptopAt]);
    const res = await pc.service.call('node-Laptop', { method: 'GET', path: '/peer/info' });
    expect(res.status).toBe(200);
    // The address that worked goes first, so the next call doesn't wait on the dead one.
    expect(pc.store.peers.get('node-Laptop')!.addresses[0]).toBe(laptopAt);
  });

  it('a call from an address already known changes nothing', async () => {
    const { pc, laptop, laptopAt } = await paired();
    pc.store.peers.update('node-Laptop', { addresses: [laptopAt, '192.0.2.7:4748'] });

    await laptop.service.call('node-PC', { method: 'GET', path: '/peer/info' });

    expect(pc.store.peers.get('node-Laptop')!.addresses).toEqual([laptopAt, '192.0.2.7:4748']);
  });

  it('keeps at most five addresses, dropping the oldest', async () => {
    const { pc, laptop, laptopAt, port } = await paired();
    const old = [1, 2, 3, 4, 5].map((n) => `192.0.2.${n}:${port}`);
    pc.store.peers.update('node-Laptop', { addresses: old });

    await laptop.service.call('node-PC', { method: 'GET', path: '/peer/info' });

    expect(pc.store.peers.get('node-Laptop')!.addresses).toEqual([...old.slice(0, 4), laptopAt]);
  });

  it('learns nothing from a caller that isn’t a paired machine', async () => {
    const { pc } = await paired();
    const before = pc.store.peers.get('node-Laptop')!.addresses;
    const stranger = node('Stranger');

    const res = await stranger.service.client.request(
      { addresses: [`127.0.0.1:${pc.service.listener.listeningPort}`], fingerprint: null },
      { method: 'GET', path: '/peer/info', token: 'not-a-token-this-machine-issued' }
    );

    expect(res.status).toBe(401);
    expect(pc.store.peers.get('node-Laptop')!.addresses).toEqual(before);
  });
});
