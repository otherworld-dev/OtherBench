import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TurnRunner } from '@grunt/core/domain/turn.js';
import { FakeChatEngine, FakeSecretStore, InMemoryStore } from '@grunt/core/testing/fakes.js';
import type { Container } from '../../src/container.js';
import { createRemoteAccess, type RemoteAccess, type RemoteTls } from '../../src/remote/index.js';
import { type Granted, LoginLimiter } from '../../src/remote/limiter.js';
import { PasswordFile, type ScryptParams } from '../../src/remote/password.js';
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

export interface RemoteFixture {
  dir: string;
  loginPath: string;
  remote: RemoteAccess;
  /** The clock the password file, sessions and limiter read; tests move it. */
  clock: { now: number };
  cleanup(): void;
}

/** A sign-in setup in a temp folder, with `PASSWORD` already set. */
export async function remoteFixture(opts: { tls?: RemoteTls; trustProxies?: string[]; publicUrls?: string[] } = {}): Promise<RemoteFixture> {
  const dir = mkdtempSync(join(tmpdir(), 'grunt-remote-'));
  const loginPath = join(dir, 'login.json');
  const clock = { now: 1_800_000_000_000 };
  await new PasswordFile(loginPath, () => clock.now, FAST).write(PASSWORD);
  const remote = createRemoteAccess({
    publicUrls: opts.publicUrls ?? ['https://grunt.test:4747'],
    trustProxies: opts.trustProxies ?? [],
    loginPath,
    tls: opts.tls ?? { mode: 'proxy' },
    now: () => clock.now,
    log: () => {},
    scrypt: FAST,
  });
  return {
    dir,
    loginPath,
    remote,
    clock,
    cleanup: () => {
      remote.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** A one-use password check from a limiter of its own, for tests that call `verifyPassword` directly. */
export async function granted(): Promise<Granted> {
  const a = await new LoginLimiter({ log: () => {} }).admit('192.0.2.1');
  if (a.kind !== 'go') throw new Error('expected a password check');
  return a.granted;
}
