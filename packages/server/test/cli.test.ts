import { describe, it, expect, vi } from 'vitest';
import { InMemoryStore, FakeSecretStore, FakeChatEngine } from '@grunt/core/testing/fakes.js';
import type { Container } from '../src/container.js';
import {
  assertServeSecurity,
  isLoopbackHost,
  main,
  NonLoopbackWithoutTokenError,
  parseServeArgs,
  runServe,
} from '../src/cli.js';

function fakeContainer(): Container {
  return { store: new InMemoryStore(), secrets: new FakeSecretStore(), engine: new FakeChatEngine([]), registry: {} as never, close: () => {} };
}

function fakeDeps() {
  const fakeServerHandle = { close: vi.fn() };
  return {
    createContainer: vi.fn(async () => fakeContainer()),
    createApp: vi.fn(() => ({ fetch: vi.fn() }) as never),
    serve: vi.fn(() => fakeServerHandle as never),
  };
}

describe('isLoopbackHost', () => {
  it.each(['127.0.0.1', 'localhost', '::1'])('treats %s as loopback', (host) => {
    expect(isLoopbackHost(host)).toBe(true);
  });

  it.each(['0.0.0.0', '192.168.1.5', '::', 'example.com'])('treats %s as non-loopback', (host) => {
    expect(isLoopbackHost(host)).toBe(false);
  });
});

describe('parseServeArgs', () => {
  it('defaults to a loopback host and no token', () => {
    const options = parseServeArgs([]);
    expect(isLoopbackHost(options.host)).toBe(true);
    expect(options.token).toBeNull();
    expect(options.port).toBeGreaterThan(0);
  });

  it('parses --port, --host, --db, --token', () => {
    const options = parseServeArgs(['--port', '9000', '--host', '0.0.0.0', '--db', '/tmp/x.db', '--token', 'abc123']);
    expect(options).toMatchObject({ port: 9000, host: '0.0.0.0', dbPath: '/tmp/x.db', token: 'abc123' });
  });
});

describe('assertServeSecurity', () => {
  it('throws NonLoopbackWithoutTokenError for a non-loopback host with no token', () => {
    expect(() => assertServeSecurity({ host: '0.0.0.0', token: null } as never)).toThrow(NonLoopbackWithoutTokenError);
  });

  it('does not throw for a non-loopback host with a token', () => {
    expect(() => assertServeSecurity({ host: '0.0.0.0', token: 'secret' } as never)).not.toThrow();
  });

  it('does not throw for a loopback host with no token', () => {
    expect(() => assertServeSecurity({ host: '127.0.0.1', token: null } as never)).not.toThrow();
  });
});

describe('runServe', () => {
  it('refuses to start (rejects) for --host 0.0.0.0 with no --token, and never builds the container or starts a server', async () => {
    const deps = fakeDeps();

    await expect(runServe(['--host', '0.0.0.0'], deps)).rejects.toThrow(NonLoopbackWithoutTokenError);

    expect(deps.createContainer).not.toHaveBeenCalled();
    expect(deps.serve).not.toHaveBeenCalled();
  });

  it('starts normally for --host 0.0.0.0 with a --token', async () => {
    const deps = fakeDeps();

    const handle = await runServe(['--host', '0.0.0.0', '--token', 'secret', '--port', '9001'], deps);

    expect(deps.serve).toHaveBeenCalledTimes(1);
    expect(handle.port).toBe(9001);
    expect(handle.host).toBe('0.0.0.0');
  });

  it('starts normally on the default loopback host with no token', async () => {
    const deps = fakeDeps();

    const handle = await runServe([], deps);

    expect(deps.serve).toHaveBeenCalledTimes(1);
    expect(isLoopbackHost(handle.host)).toBe(true);
  });
});

describe('main() CLI entry', () => {
  it('exits non-zero and never starts a server when "serve --host 0.0.0.0" is run without a token', async () => {
    const deps = fakeDeps();
    const exit = vi.fn();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await main(['serve', '--host', '0.0.0.0'], { ...deps, exit });

    expect(exit).toHaveBeenCalledWith(1);
    expect(deps.serve).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it('does not exit non-zero when a token is supplied for a non-loopback host', async () => {
    const deps = fakeDeps();
    const exit = vi.fn();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await main(['serve', '--host', '0.0.0.0', '--token', 'secret'], { ...deps, exit });

    expect(exit).not.toHaveBeenCalled();
    expect(deps.serve).toHaveBeenCalledTimes(1);
    logSpy.mockRestore();
  });

  it('exits non-zero for an unknown command', async () => {
    const deps = fakeDeps();
    const exit = vi.fn();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await main(['bogus'], { ...deps, exit });

    expect(exit).toHaveBeenCalledWith(1);
    errorSpy.mockRestore();
  });
});
