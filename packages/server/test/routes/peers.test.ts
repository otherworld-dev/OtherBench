import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import type { Container } from '../../src/container.js';
import { makeNode, type TestNode } from '../peer/helpers.js';

const nodes: TestNode[] = [];

afterEach(async () => {
  await Promise.all(nodes.splice(0).map((n) => n.close()));
});

/** A node whose local API is the real app over its store and peer service. */
function machine(name: string): TestNode & { api: (method: string, path: string, body?: unknown) => Promise<Response> } {
  const n = makeNode(name);
  nodes.push(n);
  const container = { store: n.store, secrets: n.secrets, peers: n.service } as unknown as Container;
  const app = createApp(container);
  return {
    ...n,
    api: async (method, path, body) =>
      app.request(path, { method, headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }),
  };
}

describe('/api/peers', () => {
  it('shows a code on one machine, pairs from the other with it, and lists the pair on both', async () => {
    const pc = machine('PC');
    const laptop = machine('Laptop');

    expect(await (await pc.api('GET', '/api/peers/pairing')).json()).toBeNull();
    const shown = (await (await pc.api('POST', '/api/peers/pairing')).json()) as { code: string; addresses: string[]; fingerprint: string };
    expect(await (await pc.api('GET', '/api/peers/pairing')).json()).toMatchObject({ code: shown.code });

    const added = await laptop.api('POST', '/api/peers', { address: shown.addresses[0], code: shown.code.toLowerCase() });
    expect(added.status).toBe(201);
    expect(await added.json()).toMatchObject({ nodeId: 'node-PC', name: 'PC' });

    const listed = (await (await pc.api('GET', '/api/peers')).json()) as { self: { name: string; fingerprint: string }; listening: { running: boolean }; peers: unknown[] };
    expect(listed.self).toMatchObject({ id: 'node-PC', name: 'PC', fingerprint: shown.fingerprint });
    expect(listed.listening.running).toBe(true);
    expect(listed.peers).toEqual([expect.objectContaining({ nodeId: 'node-Laptop', name: 'Laptop' })]);
    expect(JSON.stringify(listed)).not.toMatch(/issuedTokenHash|heldTokenRef/);
  });

  it('a wrong code or an unreachable address is a readable error, and nothing is stored', async () => {
    const pc = machine('PC');
    const laptop = machine('Laptop');
    const shown = (await (await pc.api('POST', '/api/peers/pairing')).json()) as { code: string; addresses: string[] };
    const wrongCode = shown.code.startsWith('A') ? `B${shown.code.slice(1)}` : `A${shown.code.slice(1)}`;

    const wrong = await laptop.api('POST', '/api/peers', { address: shown.addresses[0], code: wrongCode });
    expect(wrong.status).toBe(403);
    expect(((await wrong.json()) as { error: string }).error).toContain('Wrong code');
    const away = await laptop.api('POST', '/api/peers', { address: '127.0.0.1:1', code: shown.code });
    expect(away.status).toBe(502);
    expect((await laptop.api('POST', '/api/peers', { address: '', code: shown.code })).status).toBe(400);
    expect(laptop.store.peers.list()).toEqual([]);
  });

  it('renames, re-addresses and removes a machine', async () => {
    const pc = machine('PC');
    const laptop = machine('Laptop');
    const shown = (await (await pc.api('POST', '/api/peers/pairing')).json()) as { code: string; addresses: string[] };
    await laptop.api('POST', '/api/peers', { address: shown.addresses[0], code: shown.code });

    const patched = await laptop.api('PATCH', '/api/peers/node-PC', { name: 'Desktop', addresses: ['pc.lan:4748', shown.addresses[0]] });
    expect(await patched.json()).toMatchObject({ name: 'Desktop', addresses: ['pc.lan:4748', shown.addresses[0]] });
    expect((await laptop.api('PATCH', '/api/peers/node-PC', { addresses: [''] })).status).toBe(400);

    const removed = await laptop.api('DELETE', '/api/peers/node-PC');
    expect(await removed.json()).toEqual({ notified: true });
    expect((await laptop.api('DELETE', '/api/peers/node-PC')).status).toBe(404);
    await expect.poll(() => pc.store.peers.list().length).toBe(0);
  });
});
