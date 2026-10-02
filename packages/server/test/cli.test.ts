import { describe, it, expect, vi } from 'vitest';
import { PassThrough } from 'node:stream';
import { TurnRunner } from '@grunt/core/domain/turn.js';
import { InMemoryStore, FakeSecretStore, FakeChatEngine } from '@grunt/core/testing/fakes.js';
import type { Container } from '../src/container.js';
import { StreamRegistry } from '../src/stream/registry.js';
import { DatabaseLockedError } from '../src/db-lock.js';
import {
  AnnounceWithoutTokenError,
  assertServeSecurity,
  isLoopbackHost,
  main,
  NonLoopbackWithoutTokenError,
  parseServeArgs,
  runServe,
} from '../src/cli.js';

function fakeContainer(): Container {
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

/** The port the fake `serve` reports as bound when asked for `--port 0`. */
const EPHEMERAL_PORT = 54321;

function fakeDeps() {
  const fakeServerHandle = { close: vi.fn() };
  const container = fakeContainer();
  const containerClose = vi.spyOn(container, 'close');
  return {
    fakeServerHandle,
    containerClose,
    createContainer: vi.fn(async () => container),
    createApp: vi.fn(() => ({ fetch: vi.fn() }) as never),
    // Mirrors @hono/node-server: the listening callback gets the real bound
    // address, which for port 0 is whatever the OS picked.
    serve: vi.fn((opts: { port: number }, onListening?: (info: { port: number }) => void) => {
      onListening?.({ port: opts.port === 0 ? EPHEMERAL_PORT : opts.port });
      return fakeServerHandle as never;
    }),
  };
}

function fakeStdio() {
  const writes: string[] = [];
  return {
    writes,
    stdout: { write: (s: string) => { writes.push(s); return true; } },
    stdin: new PassThrough(),
    exit: vi.fn(),
  };
}

function tick() {
  return new Promise((resolve) => setImmediate(resolve));
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

  it('accepts --port 0 (let the OS pick)', () => {
    expect(parseServeArgs(['--port', '0']).port).toBe(0);
  });

  it.each(['-1', '65536', '1.5', 'abc'])('still rejects --port=%s', (port) => {
    expect(() => parseServeArgs([`--port=${port}`])).toThrow(/Invalid --port/);
  });

  it('rejects a bare --port with no value', () => {
    expect(() => parseServeArgs(['--port'])).toThrow(/Invalid --port/);
  });

  it('defaults to no announce and no CORS origins', () => {
    expect(parseServeArgs([])).toMatchObject({ announce: false, corsOrigins: [] });
  });

  it('parses --announce and repeated --cors-origin', () => {
    const options = parseServeArgs(['--announce', '--cors-origin', 'http://tauri.localhost', '--cors-origin', 'tauri://localhost']);
    expect(options.announce).toBe(true);
    expect(options.corsOrigins).toEqual(['http://tauri.localhost', 'tauri://localhost']);
  });

  it('takes the token from GRUNT_TOKEN when --token is absent', () => {
    expect(parseServeArgs([], { GRUNT_TOKEN: 'from-env' }).token).toBe('from-env');
  });

  it('prefers --token over GRUNT_TOKEN', () => {
    expect(parseServeArgs(['--token', 'from-argv'], { GRUNT_TOKEN: 'from-env' }).token).toBe('from-argv');
  });

  it('ignores an empty GRUNT_TOKEN', () => {
    expect(parseServeArgs([], { GRUNT_TOKEN: '' }).token).toBeNull();
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

  it('throws AnnounceWithoutTokenError for --announce with no token, even on loopback', () => {
    expect(() => assertServeSecurity({ host: '127.0.0.1', token: null, announce: true })).toThrow(AnnounceWithoutTokenError);
  });

  it('does not throw for --announce with a token', () => {
    expect(() => assertServeSecurity({ host: '127.0.0.1', token: 't', announce: true })).not.toThrow();
  });
});

describe('runServe desktop mode', () => {
  it('writes the announce line as the first and only stdout output, carrying the port actually bound', async () => {
    const deps = fakeDeps();
    const io = fakeStdio();

    const handle = await runServe(['--port', '0', '--announce'], { ...deps, ...io }, { GRUNT_TOKEN: 'tok' });

    expect(io.writes).toEqual([`{"port":${EPHEMERAL_PORT}}\n`]);
    expect(handle.port).toBe(EPHEMERAL_PORT);
  });

  it('closes the server and the container, then exits 0, when stdin closes', async () => {
    const deps = fakeDeps();
    const io = fakeStdio();
    await runServe(['--port', '0', '--announce'], { ...deps, ...io }, { GRUNT_TOKEN: 'tok' });

    io.stdin.end();
    await tick();

    expect(deps.fakeServerHandle.close).toHaveBeenCalledTimes(1);
    expect(deps.containerClose).toHaveBeenCalledTimes(1);
    expect(io.exit).toHaveBeenCalledWith(0);
  });

  it('refuses --announce without a token and never builds the container', async () => {
    const deps = fakeDeps();
    const io = fakeStdio();

    await expect(runServe(['--announce'], { ...deps, ...io }, {})).rejects.toThrow(AnnounceWithoutTokenError);
    expect(deps.createContainer).not.toHaveBeenCalled();
  });

  it('passes the env token, the CORS origins and a loopback Host check through to createApp', async () => {
    const deps = fakeDeps();
    const io = fakeStdio();

    await runServe(['--port', '0', '--announce', '--cors-origin', 'http://tauri.localhost'], { ...deps, ...io }, { GRUNT_TOKEN: 'tok' });

    const appOptions = deps.createApp.mock.calls[0]![1] as { token: string; corsOrigins: string[]; hostCheckPort?: () => number };
    expect(appOptions.token).toBe('tok');
    expect(appOptions.corsOrigins).toEqual(['http://tauri.localhost']);
    expect(appOptions.hostCheckPort?.()).toBe(EPHEMERAL_PORT);
  });

  it('applies no Host check when bound to a non-loopback address', async () => {
    const deps = fakeDeps();
    const io = fakeStdio();

    await runServe(['--host', '0.0.0.0', '--token', 'secret'], { ...deps, ...io }, {});

    const appOptions = deps.createApp.mock.calls[0]![1] as { hostCheckPort?: () => number };
    expect(appOptions.hostCheckPort).toBeUndefined();
  });

  it('writes nothing to stdout and ignores stdin outside announce mode (browser mode unchanged)', async () => {
    const deps = fakeDeps();
    const io = fakeStdio();

    await runServe([], { ...deps, ...io }, {});
    io.stdin.end();
    await tick();

    expect(io.writes).toEqual([]);
    expect(deps.fakeServerHandle.close).not.toHaveBeenCalled();
    expect(io.exit).not.toHaveBeenCalled();
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

  it('logs the listening line to stderr, never stdout, in announce mode', async () => {
    const deps = fakeDeps();
    const io = fakeStdio();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await main(['serve', '--port', '0', '--announce'], { ...deps, ...io, env: { GRUNT_TOKEN: 'tok' } });

    expect(logSpy).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining(`127.0.0.1:${EPHEMERAL_PORT}`));
    expect(io.writes).toEqual([`{"port":${EPHEMERAL_PORT}}\n`]);
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it('exits non-zero with a message for --announce without a token', async () => {
    const deps = fakeDeps();
    const io = fakeStdio();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await main(['serve', '--announce'], { ...deps, ...io, env: {} });

    expect(io.exit).toHaveBeenCalledWith(1);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('GRUNT_TOKEN'));
    errorSpy.mockRestore();
  });

  it('exits non-zero with a message when the database is already in use', async () => {
    const deps = fakeDeps();
    deps.createContainer.mockRejectedValueOnce(new DatabaseLockedError('/x/grunt.db', 1234, 0));
    const io = fakeStdio();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await main(['serve'], { ...deps, ...io, env: {} });

    expect(io.exit).toHaveBeenCalledWith(1);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('already in use'));
    errorSpy.mockRestore();
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
