import { TurnRunner } from '@grunt/core/domain/turn.js';
import { FakeChatEngine, FakeSecretStore, InMemoryStore } from '@grunt/core/testing/fakes.js';
import type { Container } from '../../src/container.js';
import type { ScryptParams } from '../../src/remote/password.js';
import { StreamRegistry } from '../../src/stream/registry.js';

/** Cheap scrypt parameters so the tests stay fast; a record carries its own, so verifying uses them too. */
export const FAST: ScryptParams = { N: 2 ** 10, r: 8, p: 1 };
export const PASSWORD = 'correct horse battery';

export function makeContainer(): Container {
  const store = new InMemoryStore();
  const engine = new FakeChatEngine([]);
  const turnRunner = new TurnRunner(store, engine);
  return {
    store,
    secrets: new FakeSecretStore(),
    engine,
    registry: {} as never,
    toolProvider: {} as never,
    mcpManager: {} as never,
    turnRunner,
    streamRegistry: new StreamRegistry(turnRunner, store),
    blobStore: {} as never,
    close: () => {},
  };
}

/** `app.request`'s third argument: what @hono/node-server passes as `c.env`, with the socket's address. */
export const from = (address: string) => ({ incoming: { socket: { remoteAddress: address } } });
