import { connect, createServer, type Server } from 'node:tls';
import { InMemoryStore, FakeSecretStore } from '@grunt/core/testing/fakes.js';
import { createPeerApp } from '../../src/peer/app.js';
import { IdentityStore } from '../../src/peer/identity.js';
import type { PeerMonitorOptions } from '../../src/peer/monitor.js';
import { PeerService } from '../../src/peer/service.js';
import { AppEventBus } from '../../src/stream/events.js';
import type { AppEvent } from '@grunt/core/types/events.js';

export interface TestNode {
  name: string;
  store: InMemoryStore;
  secrets: FakeSecretStore;
  service: PeerService;
  events: AppEvent[];
  clock: { now: number };
  close(): Promise<void>;
}

/** A node with its own store, secrets and identity, listening on a free loopback port while it needs to. */
export function makeNode(name: string, monitor: Omit<PeerMonitorOptions, 'events' | 'now'> = { minBackoffMs: 20, maxBackoffMs: 100 }): TestNode {
  const store = new InMemoryStore(`node-${name}`);
  store.nodes.rename(name);
  const secrets = new FakeSecretStore();
  const bus = new AppEventBus();
  const events: AppEvent[] = [];
  bus.subscribe((e) => events.push(e));
  const clock = { now: Date.now() };
  const service = new PeerService({
    store,
    secrets,
    events: bus,
    identity: new IdentityStore(() => store.nodes.self().id, null),
    createApp: (s) => createPeerApp(s) as never,
    port: 0,
    hosts: ['127.0.0.1'],
    schemaVersion: 12,
    platform: 'win32',
    now: () => clock.now,
    monitor,
  });
  return { name, store, secrets, service, events, clock, close: () => service.close() };
}

/** `a` shows a code and `b` enters it. */
export async function pair(a: TestNode, b: TestNode): Promise<void> {
  const view = await a.service.startPairing();
  await b.service.pairWith(view.addresses[0]!, view.code);
}

/**
 * A machine in the middle: terminates TLS with its own certificate on one
 * side and opens its own TLS connection (with its own certificate) to
 * `target` on the other, passing the bytes through.
 */
export async function interceptingProxy(target: string): Promise<{ address: string; close(): void }> {
  const own = new IdentityStore(() => 'mallory', null).get();
  const [host, port] = target.split(':') as [string, string];
  const server: Server = createServer({ key: own.keyPem, cert: own.certPem, requestCert: true, rejectUnauthorized: false }, (inbound) => {
    const outbound = connect({ host, port: Number(port), key: own.keyPem, cert: own.certPem, rejectUnauthorized: false });
    inbound.pipe(outbound).pipe(inbound);
    inbound.on('error', () => outbound.destroy());
    outbound.on('error', () => inbound.destroy());
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { address: `127.0.0.1:${(server.address() as { port: number }).port}`, close: () => server.close() };
}
