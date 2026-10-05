import { afterEach, describe, expect, it } from 'vitest';
import type { AppEvent } from '@grunt/core/types/events.js';
import { freezableProxy, makeNode, pair, type TestNode } from './helpers.js';

const nodes: TestNode[] = [];
function node(name: string, onMessage?: (nodeId: string, event: string, data: unknown) => void): TestNode {
  const n = makeNode(name, { minBackoffMs: 20, maxBackoffMs: 80, ...(onMessage ? { onMessage } : {}) });
  nodes.push(n);
  return n;
}

afterEach(async () => {
  await Promise.all(nodes.splice(0).map((n) => n.close()));
});

function statusEvents(n: TestNode, nodeId: string): string[] {
  return n.events.filter((e): e is Extract<AppEvent, { type: 'peer-status' }> => e.type === 'peer-status' && e.nodeId === nodeId).map((e) => e.status);
}

describe('PeerMonitor', () => {
  it('announces each status change once: reachable, unreachable through several retries, reachable again', async () => {
    const pc = node('PC');
    const laptop = node('Laptop');
    await pair(pc, laptop);
    laptop.service.startMonitoring();

    await expect.poll(() => laptop.service.status('node-PC').status).toBe('reachable');
    expect(statusEvents(laptop, 'node-PC')).toEqual(['reachable']);

    await pc.service.listener.stop();
    await expect.poll(() => laptop.service.status('node-PC').status).toBe('unreachable');
    await new Promise((r) => setTimeout(r, 250));
    expect(statusEvents(laptop, 'node-PC')).toEqual(['reachable', 'unreachable']);
    expect(laptop.service.status('node-PC').error).toBeTruthy();

    // Back on the same port it had: the stored address works again.
    await pc.service.listener.start();
    await expect.poll(() => laptop.service.status('node-PC').status).toBe('reachable');
    expect(statusEvents(laptop, 'node-PC')).toEqual(['reachable', 'unreachable', 'reachable']);
  });

  it('delivers what the other machine announces, but not its hello', async () => {
    const heard: { nodeId: string; event: string; data: unknown }[] = [];
    const pc = node('PC');
    const laptop = node('Laptop', (nodeId, event, data) => heard.push({ nodeId, event, data }));
    await pair(pc, laptop);
    laptop.service.startMonitoring();
    await expect.poll(() => laptop.service.status('node-PC').status).toBe('reachable');

    pc.service.announce('changes-available', { seq: 7 });

    await expect.poll(() => heard).toEqual([{ nodeId: 'node-PC', event: 'changes-available', data: { seq: 7 } }]);
  });

  it('treats a stream that goes silent as gone, but not one kept alive while quiet', async () => {
    const pc = makeNode('PC', undefined, { keepaliveMs: 50 });
    const laptop = makeNode('Laptop', { minBackoffMs: 20, maxBackoffMs: 80, idleTimeoutMs: 300 });
    nodes.push(pc, laptop);
    await pair(pc, laptop);
    const proxy = await freezableProxy(laptop.store.peers.get('node-PC')!.addresses[0]!);
    laptop.store.peers.update('node-PC', { addresses: [proxy.address] });
    laptop.service.startMonitoring();

    await expect.poll(() => laptop.service.status('node-PC').status).toBe('reachable');
    // Nothing announced for longer than the idle limit: the keepalives hold it.
    await new Promise((r) => setTimeout(r, 600));
    expect(statusEvents(laptop, 'node-PC')).toEqual(['reachable']);

    // The connection dies without closing (a laptop asleep, a network gone).
    proxy.freeze();
    await expect.poll(() => laptop.service.status('node-PC').status).toBe('unreachable');
    expect(laptop.service.status('node-PC').error).toMatch(/heard nothing/i);
    proxy.close();
  });

  it('stops watching a removed machine, and the removed machine is refused from then on', async () => {
    const pc = node('PC');
    const laptop = node('Laptop');
    await pair(pc, laptop);
    pc.service.startMonitoring();
    laptop.service.startMonitoring();
    await expect.poll(() => laptop.service.status('node-PC').status).toBe('reachable');
    await expect.poll(() => pc.service.status('node-Laptop').status).toBe('reachable');

    await laptop.service.remove('node-PC');

    expect(laptop.service.status('node-PC').status).toBe('unknown');
    await expect.poll(() => pc.store.peers.list().length).toBe(0);
    expect(pc.service.status('node-Laptop').status).toBe('unknown');
  });
});

describe('addresses', () => {
  it('tries the last address that worked first, moving a working one to the front', async () => {
    const pc = node('PC');
    const laptop = node('Laptop');
    await pair(pc, laptop);
    const good = laptop.store.peers.get('node-PC')!.addresses[0]!;
    laptop.store.peers.update('node-PC', { addresses: ['127.0.0.1:1', good] });

    const res = await laptop.service.call('node-PC', { method: 'GET', path: '/peer/info' });

    expect(res.address).toBe(good);
    expect(laptop.store.peers.get('node-PC')!.addresses).toEqual([good, '127.0.0.1:1']);
    expect(laptop.store.peers.get('node-PC')!.lastSeenAt).toBe(laptop.clock.now);
  });
});
