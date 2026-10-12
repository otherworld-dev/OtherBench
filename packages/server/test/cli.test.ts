import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer as createHttpsServer, request as httpsRequest } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  sameScriptPath,
  SHUTDOWN_WAIT_MS,
} from '../src/cli.js';
import {
  InsecurePublicUrlError,
  InvalidTrustProxyError,
  LoginFileError,
  NoPasswordError,
  RemoteNeedsHttpsError,
  RemoteWithAnnounceError,
  TlsConflictError,
  TlsWithoutPublicUrlError,
} from '../src/remote/errors.js';
import { PasswordFile } from '../src/remote/password.js';
import { FAST, PASSWORD } from './remote/helpers.js';

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

describe('sameScriptPath', () => {
  it('matches the same path, and on Windows ignores a \\\\?\\ prefix and case', () => {
    expect(sameScriptPath('/srv/grunt/cli.js', '/srv/grunt/cli.js')).toBe(true);
    expect(sameScriptPath('/srv/grunt/cli.js', '/srv/other/cli.js')).toBe(false);
    if (process.platform === 'win32') {
      expect(sameScriptPath('C:\\Program Files\\Grunt\\server\\cli.js', '\\\\?\\C:\\Program Files\\Grunt\\server\\cli.js')).toBe(true);
      expect(sameScriptPath('C:\\Grunt\\server\\cli.js', 'c:\\grunt\\SERVER\\cli.js')).toBe(true);
    }
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

  it('parses --peer-port and repeated --peer-host; neither is set by default', () => {
    expect(parseServeArgs(['--peer-port', '5000', '--peer-host', '192.168.1.2', '--peer-host', '10.0.0.2'])).toMatchObject({
      peerPort: 5000,
      peerHosts: ['192.168.1.2', '10.0.0.2'],
    });
    const defaults = parseServeArgs([]);
    expect(defaults.peerPort).toBeUndefined();
    expect(defaults.peerHosts).toEqual([]);
    expect(() => parseServeArgs(['--peer-port', '70000'])).toThrow(/Invalid --peer-port/);
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

  it("waits for the container's background shutdown (the sandbox's agents and mounts) before exiting", async () => {
    const deps = fakeDeps();
    const io = fakeStdio();
    const container = await deps.createContainer();
    let settle!: () => void;
    container.settled = () => new Promise<void>((resolve) => (settle = resolve));
    await runServe(['--port', '0', '--announce'], { ...deps, ...io }, { GRUNT_TOKEN: 'tok' });

    io.stdin.end();
    await tick();
    expect(deps.containerClose).toHaveBeenCalledTimes(1);
    expect(io.exit).not.toHaveBeenCalled();

    settle();
    await tick();
    expect(io.exit).toHaveBeenCalledWith(0);
  });

  it("exits anyway when the background shutdown takes longer than the desktop shell's grace", async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const deps = fakeDeps();
      const io = fakeStdio();
      const container = await deps.createContainer();
      container.settled = () => new Promise<void>(() => undefined);
      await runServe(['--port', '0', '--announce'], { ...deps, ...io }, { GRUNT_TOKEN: 'tok' });

      io.stdin.end();
      await tick();
      expect(io.exit).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(SHUTDOWN_WAIT_MS);
      expect(io.exit).toHaveBeenCalledWith(0);
    } finally {
      vi.useRealTimers();
    }
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

    const appOptions = deps.createApp.mock.calls[0]![1] as { token: string; corsOrigins: string[]; hostCheckPort?: () => number; oauthCallbackPort?: () => number };
    expect(appOptions.token).toBe('tok');
    expect(appOptions.corsOrigins).toEqual(['http://tauri.localhost']);
    expect(appOptions.hostCheckPort?.()).toBe(EPHEMERAL_PORT);
    expect(appOptions.oauthCallbackPort?.()).toBe(EPHEMERAL_PORT);
  });

  it('applies no Host check when bound to a non-loopback address', async () => {
    const deps = fakeDeps();
    const io = fakeStdio();

    await runServe(['--host', '0.0.0.0', '--token', 'secret'], { ...deps, ...io }, {});

    const appOptions = deps.createApp.mock.calls[0]![1] as { hostCheckPort?: () => number; oauthCallbackPort?: () => number };
    expect(appOptions.hostCheckPort).toBeUndefined();
    expect(appOptions.oauthCallbackPort).toBeDefined(); // the callback still works when 127.0.0.1 is among the bound addresses
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

describe('parseServeArgs: sign-in flags', () => {
  it('has none by default', () => {
    expect(parseServeArgs([])).toMatchObject({ publicUrls: [], tls: null, tlsCert: null, tlsKey: null, trustProxies: [] });
  });

  it('parses repeated --public-url and --trust-proxy, --tls auto, --tls-cert and --tls-key', () => {
    const o = parseServeArgs([
      '--public-url', 'https://grunt.lan:4747', '--public-url', 'https://192.168.1.5:4747',
      '--trust-proxy', '127.0.0.1', '--trust-proxy', '10.0.0.2',
      '--tls', 'auto', '--tls-cert', '/c.pem', '--tls-key', '/k.pem',
    ]);
    expect(o).toMatchObject({
      publicUrls: ['https://grunt.lan:4747', 'https://192.168.1.5:4747'],
      trustProxies: ['127.0.0.1', '10.0.0.2'],
      tls: 'auto',
      tlsCert: '/c.pem',
      tlsKey: '/k.pem',
    });
  });

  it.each([['--tls', 'files'], ['--tls']])('refuses %s with anything but "auto"', (...args) => {
    expect(() => parseServeArgs(args)).toThrow(TlsConflictError);
  });
});

describe('assertServeSecurity: the whole matrix', () => {
  const base = { host: '127.0.0.1', token: null, publicUrls: [] as string[], tls: null, tlsCert: null, tlsKey: null, trustProxies: [] as string[] };
  const signIn = { ...base, host: '0.0.0.0', publicUrls: ['https://grunt.lan:4747'] };

  it('keeps open and token modes as they were', () => {
    expect(assertServeSecurity(base)).toBe('open');
    expect(assertServeSecurity({ ...base, token: 't' })).toBe('token');
    expect(assertServeSecurity({ ...base, host: '0.0.0.0', token: 't' })).toBe('token');
    expect(() => assertServeSecurity({ ...base, host: '0.0.0.0' })).toThrow(NonLoopbackWithoutTokenError);
  });

  it('turns sign-in on for a public URL with an HTTPS route, even on a non-loopback bind with no token', () => {
    expect(assertServeSecurity({ ...signIn, tls: 'auto' })).toBe('login');
    expect(assertServeSecurity({ ...signIn, tlsCert: '/c', tlsKey: '/k' })).toBe('login');
    expect(assertServeSecurity({ ...signIn, host: '127.0.0.1', trustProxies: ['127.0.0.1'] })).toBe('login');
    expect(assertServeSecurity({ ...signIn, tls: 'auto', token: 't' })).toBe('login');
  });

  it('refuses each unsafe or contradictory combination by name', () => {
    expect(() => assertServeSecurity({ ...signIn, tls: 'auto', publicUrls: ['http://grunt.lan:4747'] })).toThrow(InsecurePublicUrlError);
    expect(() => assertServeSecurity({ ...signIn, tls: 'auto', publicUrls: ['https://grunt.lan/grunt'] })).toThrow(InsecurePublicUrlError);
    expect(() => assertServeSecurity(signIn)).toThrow(RemoteNeedsHttpsError);
    expect(() => assertServeSecurity({ ...signIn, tls: 'auto', token: 't', announce: true })).toThrow(RemoteWithAnnounceError);
    expect(() => assertServeSecurity({ ...base, tls: 'auto' })).toThrow(TlsWithoutPublicUrlError);
    expect(() => assertServeSecurity({ ...base, trustProxies: ['127.0.0.1'] })).toThrow(TlsWithoutPublicUrlError);
    expect(() => assertServeSecurity({ ...base, tlsCert: '/c', tlsKey: '/k' })).toThrow(TlsWithoutPublicUrlError);
    expect(() => assertServeSecurity({ ...signIn, tls: 'auto', tlsCert: '/c', tlsKey: '/k' })).toThrow(TlsConflictError);
    expect(() => assertServeSecurity({ ...signIn, tlsCert: '/c' })).toThrow(TlsConflictError);
    expect(() => assertServeSecurity({ ...signIn, trustProxies: ['10.0.0.0/8'] })).toThrow(InvalidTrustProxyError);
  });
});

describe('runServe in sign-in mode', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'grunt-cli-signin-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  const setPassword = () => new PasswordFile(join(dir, 'login.json'), Date.now, FAST).write(PASSWORD);

  it('refuses without a password and never builds the container', async () => {
    const deps = fakeDeps();

    await expect(runServe(['--db', join(dir, 'grunt.db'), '--public-url', 'https://grunt.test', '--tls', 'auto'], deps, {})).rejects.toThrow(NoPasswordError);
    expect(deps.createContainer).not.toHaveBeenCalled();
  });

  it('refuses with a plain LoginFileError, not a raw I/O error, when login.json cannot be read', async () => {
    const deps = fakeDeps();
    // A directory where the file should be: reading it fails with EISDIR, not ENOENT.
    mkdirSync(join(dir, 'login.json'));

    const run = runServe(['--db', join(dir, 'grunt.db'), '--public-url', 'https://grunt.test', '--tls', 'auto'], deps, {});

    await expect(run).rejects.toThrow(LoginFileError);
    await expect(run).rejects.toThrow(/login\.json is not a usable password file \(couldn't read it: /);
    expect(deps.createContainer).not.toHaveBeenCalled();
  });

  it('serves HTTPS with its own certificate, TLS 1.2 at least, and hands createApp the sign-in setup and a Host check', async () => {
    await setPassword();
    const deps = fakeDeps();

    const handle = await runServe(['--db', join(dir, 'grunt.db'), '--port', '0', '--public-url', 'https://grunt.test', '--tls', 'auto'], deps, {});

    const serveOpts = deps.serve.mock.calls[0]![0] as unknown as { createServer?: unknown; serverOptions?: { key: string; cert: string; minVersion: string } };
    expect(serveOpts.createServer).toBe(createHttpsServer);
    expect(serveOpts.serverOptions?.minVersion).toBe('TLSv1.2');
    expect(serveOpts.serverOptions?.key).toContain('PRIVATE KEY');
    expect(serveOpts.serverOptions?.cert).toBe(readFileSync(join(dir, 'https', 'server.crt'), 'utf8'));
    const appOptions = deps.createApp.mock.calls[0]![1] as { remote: { publicHosts: string[]; tls: { mode: string } } | null; hostCheckPort?: () => number };
    expect(appOptions.remote?.publicHosts).toEqual(['grunt.test']);
    expect(appOptions.remote?.tls.mode).toBe('auto');
    expect(appOptions.hostCheckPort?.()).toBe(EPHEMERAL_PORT);
    expect(handle.scheme).toBe('https');
    expect(handle.publicUrls).toEqual(['https://grunt.test']);
    expect(handle.notes.join('\n')).toMatch(/SHA-256 [0-9A-F]{2}(:[0-9A-F]{2}){31}/);
    expect(handle.notes.join('\n')).toMatch(/only listens on this machine/);
    handle.close();
  });

  it('serves plain HTTP behind a trusted proxy', async () => {
    await setPassword();
    const deps = fakeDeps();

    const handle = await runServe(['--db', join(dir, 'grunt.db'), '--public-url', 'https://box.tail.ts.net', '--trust-proxy', '127.0.0.1'], deps, {});

    const serveOpts = deps.serve.mock.calls[0]![0] as unknown as { createServer?: unknown };
    expect(serveOpts.createServer).toBeUndefined();
    expect(handle.scheme).toBe('http');
    expect(handle.notes.join('\n')).not.toMatch(/only listens on this machine/);
    handle.close();
  });

  it('gives createApp no sign-in setup in the desktop mode', async () => {
    const deps = fakeDeps();
    const io = fakeStdio();

    const handle = await runServe(['--port', '0', '--announce', '--cors-origin', 'http://tauri.localhost'], { ...deps, ...io }, { GRUNT_TOKEN: 'tok' });

    expect((deps.createApp.mock.calls[0]![1] as { remote: unknown }).remote).toBeNull();
    expect((deps.serve.mock.calls[0]![0] as unknown as { createServer?: unknown }).createServer).toBeUndefined();
    expect(handle.scheme).toBe('http');
  });

  it('answers /api/health over real HTTPS, trusting only the CA it made', async () => {
    await setPassword();
    const handle = await runServe(['--db', join(dir, 'grunt.db'), '--port', '0', '--public-url', 'https://grunt.test', '--tls', 'auto'], { createContainer: async () => fakeContainer() }, {});
    try {
      const ca = readFileSync(join(dir, 'https', 'grunt-ca.crt'), 'utf8');
      const answer = await new Promise<string>((resolve, reject) => {
        const req = httpsRequest({ host: '127.0.0.1', port: handle.port, path: '/api/health', ca, servername: 'grunt.test', agent: false }, (res) => {
          let body = '';
          res.on('data', (d: Buffer) => (body += d.toString()));
          res.on('end', () => resolve(`${res.statusCode} ${body}`));
        });
        req.on('error', reject);
        req.end();
      });
      expect(answer).toMatch(/^200 \{"status":"ok"/);
    } finally {
      handle.close();
    }
  });
});

describe('main() with sign-in', () => {
  it('prints a sign-in start-up refusal as an error and exits 1', async () => {
    const deps = fakeDeps();
    const exit = vi.fn();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await main(['serve', '--public-url', 'http://grunt.lan'], { ...deps, exit, env: {} });

    expect(exit).toHaveBeenCalledWith(1);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringMatching(/^Error: Refusing to start: --public-url/));
    errorSpy.mockRestore();
  });
});
