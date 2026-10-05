import { parseArgs } from 'node:util';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve as nodeServe } from '@hono/node-server';
import { createApp } from './app.js';
import { createContainer, type Container } from './container.js';
import { DatabaseLockedError } from './db-lock.js';
import { announceLine, exitOnStdinClose } from './desktop.js';

/** Arbitrary default port for `grunt serve`; overridable with `--port`. */
const DEFAULT_PORT = 4747;
const DEFAULT_HOST = '127.0.0.1';

function defaultDbPath(): string {
  return join(homedir(), '.grunt', 'grunt.db');
}

function defaultSecretsPath(dbPath: string): string {
  return dbPath === ':memory:' ? join(homedir(), '.grunt', 'secrets.json') : join(dirname(dbPath), 'secrets.json');
}

/**
 * `@grunt/web`'s built bundle lives at `packages/web/dist` -- a sibling of
 * this package, `packages/server`, regardless of the working directory
 * `grunt serve` is launched from. Computed from `import.meta.url` (this
 * file's own compiled location, `packages/server/dist/cli.js`) rather than
 * `process.cwd()`, since a globally-installed `grunt` binary may be
 * invoked from anywhere. `static.ts` degrades to a placeholder page if
 * nothing has been built there yet -- this function only computes the
 * path, it never asserts the bundle exists.
 */
function defaultWebDistDir(): string {
  const serverDistDir = dirname(fileURLToPath(import.meta.url));
  return join(serverDistDir, '..', '..', 'web', 'dist');
}

export interface ServeOptions {
  /** 0 asks the OS for a free port; the bound port is what `ServerHandle.port` reports. */
  port: number;
  host: string;
  dbPath: string;
  token: string | null;
  /** Desktop handshake: print `{"port":N}` as the only stdout line, exit when stdin closes. */
  announce: boolean;
  corsOrigins: string[];
  /** The peer listener's port; unset uses the default (4748). */
  peerPort?: number;
  /** Addresses the peer listener binds; empty means every interface. */
  peerHosts: string[];
}

/**
 * `--token` wins; otherwise `GRUNT_TOKEN`. The desktop shell always uses
 * the environment variable, because a command line is readable by every
 * other process on the machine and an environment block is not.
 */
export function parseServeArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): ServeOptions {
  const { values } = parseArgs({
    args: argv,
    options: {
      port: { type: 'string' },
      host: { type: 'string' },
      db: { type: 'string' },
      token: { type: 'string' },
      announce: { type: 'boolean' },
      'cors-origin': { type: 'string', multiple: true },
      'peer-port': { type: 'string' },
      'peer-host': { type: 'string', multiple: true },
    },
    strict: false,
  });
  const port = values['port'] !== undefined ? Number(values['port']) : DEFAULT_PORT;
  if (typeof values['port'] === 'boolean' || !Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`Invalid --port "${String(values['port'])}": must be an integer between 0 and 65535 (0 = any free port).`);
  }
  const dbPath = typeof values['db'] === 'string' ? values['db'] : defaultDbPath();
  const envToken = env['GRUNT_TOKEN'];
  const corsOrigins = values['cors-origin'];
  const peerHosts = values['peer-host'];
  const peerPort = values['peer-port'] !== undefined ? Number(values['peer-port']) : undefined;
  if (peerPort !== undefined && (typeof values['peer-port'] === 'boolean' || !Number.isInteger(peerPort) || peerPort < 0 || peerPort > 65535)) {
    throw new Error(`Invalid --peer-port "${String(values['peer-port'])}": must be an integer between 0 and 65535.`);
  }
  return {
    ...(peerPort !== undefined ? { peerPort } : {}),
    peerHosts: Array.isArray(peerHosts) ? peerHosts.filter((h): h is string => typeof h === 'string') : [],
    port,
    host: typeof values['host'] === 'string' ? values['host'] : DEFAULT_HOST,
    dbPath,
    token: typeof values['token'] === 'string' ? values['token'] : envToken ? envToken : null,
    announce: values['announce'] === true,
    corsOrigins: Array.isArray(corsOrigins) ? corsOrigins.filter((o): o is string => typeof o === 'string') : [],
  };
}

/**
 * True for the loopback addresses a client on the SAME machine reaches the
 * server through -- the only hosts `grunt serve` will bind to without a
 * `--token` (see {@link assertServeSecurity}).
 */
export function isLoopbackHost(host: string): boolean {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1';
}

export class NonLoopbackWithoutTokenError extends Error {
  constructor(host: string) {
    super(
      `Refusing to start: host "${host}" is not loopback and no --token was provided. ` +
        'Binding to a non-loopback address without a bearer token would expose the whole API ' +
        '(including provider API keys stored via SecretStore) to anything that can reach that address. ' +
        'Pass --token <secret> to bind non-loopback, or omit --host (or pass 127.0.0.1/localhost) to stay local-only.'
    );
    this.name = 'NonLoopbackWithoutTokenError';
  }
}

/**
 * The non-negotiable startup gate (task 15, decision #4): `grunt serve` must
 * refuse to bind to a non-loopback host unless a `--token` was supplied.
 * Kept as a small, pure, synchronous function (no I/O, no process.exit) so
 * it can be asserted on directly without spinning up a real server.
 */
export function assertServeSecurity(options: Pick<ServeOptions, 'host' | 'token'> & { announce?: boolean }): void {
  if (!isLoopbackHost(options.host) && !options.token) {
    throw new NonLoopbackWithoutTokenError(options.host);
  }
  if (options.announce && !options.token) {
    throw new AnnounceWithoutTokenError();
  }
}

/**
 * `--announce` is the desktop shell's mode, where the UI is served from the
 * webview's own origin and reaches this server cross-origin. Without a token
 * any other local process -- or any web page the CORS allowlist doesn't
 * cover but a simple request gets through -- could drive the API, so the
 * shell must always supply one.
 */
export class AnnounceWithoutTokenError extends Error {
  constructor() {
    super('Refusing to start: --announce requires a token. Set GRUNT_TOKEN in the environment (preferred) or pass --token.');
    this.name = 'AnnounceWithoutTokenError';
  }
}

export interface ServeDeps {
  createContainer: (opts: { dbPath: string; secretsPath: string; peerPort?: number; peerHosts?: string[] }) => Promise<Container>;
  createApp: typeof createApp;
  serve: typeof nodeServe;
  /** Where the announce line goes. Defaults to `process.stdout`. */
  stdout: { write(chunk: string): unknown };
  /** Watched for close in announce mode. Defaults to `process.stdin`. */
  stdin: NodeJS.ReadableStream;
  /** Called with 0 after an announce-mode shutdown. Defaults to `process.exit`. */
  exit: (code: number) => void;
}

const defaultDeps: ServeDeps = {
  createContainer,
  createApp,
  serve: nodeServe,
  stdout: process.stdout,
  stdin: process.stdin,
  exit: (code) => process.exit(code),
};

export interface ServerHandle {
  /** The port actually bound -- differs from the requested one for `--port 0`. */
  port: number;
  host: string;
  announce: boolean;
  close: () => void;
}

/**
 * Parses args, enforces the security gate, wires the container/app, and
 * starts listening. Dependencies are injectable (defaulting to the real
 * `createContainer`/`createApp`/`@hono/node-server` `serve`) so tests can
 * verify the security gate and the "what gets called when" wiring without
 * touching a real filesystem, database, or network port.
 */
export async function runServe(
  argv: string[],
  deps: Partial<ServeDeps> = {},
  env: NodeJS.ProcessEnv = process.env
): Promise<ServerHandle> {
  const {
    createContainer: buildContainer,
    createApp: buildApp,
    serve: startServer,
    stdout,
    stdin,
    exit,
  } = { ...defaultDeps, ...deps };

  const options = parseServeArgs(argv, env);
  assertServeSecurity(options);

  const container = await buildContainer({
    dbPath: options.dbPath,
    secretsPath: defaultSecretsPath(options.dbPath),
    ...(options.peerPort !== undefined ? { peerPort: options.peerPort } : {}),
    peerHosts: options.peerHosts,
  });

  // Filled in by the listening callback; the Host check reads it per request,
  // and no request can arrive before the port is bound.
  let boundPort = options.port;
  const app = buildApp(container, {
    token: options.token,
    webDistDir: defaultWebDistDir(),
    corsOrigins: options.corsOrigins,
    hostCheckPort: isLoopbackHost(options.host) ? () => boundPort : undefined,
  });

  let server: ReturnType<typeof nodeServe>;
  try {
    await new Promise<void>((resolve, reject) => {
      server = startServer({ fetch: app.fetch, port: options.port, hostname: options.host }, (info) => {
        boundPort = info.port;
        resolve();
      });
      // A real server reports a failed bind (EADDRINUSE) as an 'error' event
      // rather than throwing; test doubles have no `once`.
      (server as { once?: (event: string, fn: (err: Error) => void) => void }).once?.('error', reject);
    });
  } catch (err) {
    container.close();
    throw err;
  }

  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    server.close();
    container.close();
  };

  if (options.announce) {
    stdout.write(announceLine(boundPort));
    exitOnStdinClose(stdin, () => {
      close();
      exit(0);
    });
  }

  return { port: boundPort, host: options.host, announce: options.announce, close };
}

export interface MainDeps extends Partial<ServeDeps> {
  env?: NodeJS.ProcessEnv;
}

/** The CLI entry point: `grunt <command> [options]`. Currently only `serve` exists. */
export async function main(argv: string[], deps: MainDeps = {}): Promise<void> {
  const exit = deps.exit ?? ((code: number) => { process.exitCode = code; });
  const [command, ...rest] = argv;

  if (command !== 'serve') {
    console.error(
      'Usage: grunt serve [--port <n>] [--host <addr>] [--db <path>] [--token <secret>] [--announce] [--cors-origin <origin>]... [--peer-port <n>] [--peer-host <addr>]...'
    );
    exit(1);
    return;
  }

  try {
    const handle = await runServe(rest, deps, deps.env ?? process.env);
    // In announce mode stdout belongs to the handshake alone.
    const log = handle.announce ? console.error : console.log;
    log(`Grunt server listening on http://${handle.host}:${handle.port}`);
  } catch (err) {
    if (
      err instanceof NonLoopbackWithoutTokenError ||
      err instanceof AnnounceWithoutTokenError ||
      err instanceof DatabaseLockedError
    ) {
      console.error(`Error: ${err.message}`);
      exit(1);
      return;
    }
    throw err;
  }
}

/**
 * Whether two paths name the same file, allowing for how the desktop shell
 * can pass this script's path on Windows: with a `\\?\` prefix, or in
 * another case.
 */
export function sameScriptPath(a: string, b: string): boolean {
  const norm = (p: string): string => {
    const plain = resolve(p.replace(/^\\\\\?\\/, ''));
    return process.platform === 'win32' ? plain.toLowerCase() : plain;
  };
  return norm(a) === norm(b);
}

const isMainModule = process.argv[1] !== undefined && sameScriptPath(fileURLToPath(import.meta.url), process.argv[1]);
if (isMainModule) {
  main(process.argv.slice(2)).catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  });
}
