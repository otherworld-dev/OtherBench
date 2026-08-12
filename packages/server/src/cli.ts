import { parseArgs } from 'node:util';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve as nodeServe } from '@hono/node-server';
import { createApp } from './app.js';
import { createContainer, type Container } from './container.js';

/** Arbitrary default port for `grunt serve`; overridable with `--port`. */
const DEFAULT_PORT = 4747;
const DEFAULT_HOST = '127.0.0.1';

function defaultDbPath(): string {
  return join(homedir(), '.grunt', 'grunt.db');
}

function defaultSecretsPath(dbPath: string): string {
  return dbPath === ':memory:' ? join(homedir(), '.grunt', 'secrets.json') : join(dirname(dbPath), 'secrets.json');
}

export interface ServeOptions {
  port: number;
  host: string;
  dbPath: string;
  token: string | null;
}

export function parseServeArgs(argv: string[]): ServeOptions {
  const { values } = parseArgs({
    args: argv,
    options: {
      port: { type: 'string' },
      host: { type: 'string' },
      db: { type: 'string' },
      token: { type: 'string' },
    },
    strict: false,
  });
  const port = values['port'] ? Number(values['port']) : DEFAULT_PORT;
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`Invalid --port "${String(values['port'])}": must be an integer between 1 and 65535.`);
  }
  const dbPath = typeof values['db'] === 'string' ? values['db'] : defaultDbPath();
  return {
    port,
    host: typeof values['host'] === 'string' ? values['host'] : DEFAULT_HOST,
    dbPath,
    token: typeof values['token'] === 'string' ? values['token'] : null,
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
export function assertServeSecurity(options: Pick<ServeOptions, 'host' | 'token'>): void {
  if (!isLoopbackHost(options.host) && !options.token) {
    throw new NonLoopbackWithoutTokenError(options.host);
  }
}

export interface ServeDeps {
  createContainer: (opts: { dbPath: string; secretsPath: string }) => Promise<Container>;
  createApp: typeof createApp;
  serve: typeof nodeServe;
}

const defaultDeps: ServeDeps = {
  createContainer,
  createApp,
  serve: nodeServe,
};

export interface ServerHandle {
  port: number;
  host: string;
  close: () => void;
}

/**
 * Parses args, enforces the security gate, wires the container/app, and
 * starts listening. Dependencies are injectable (defaulting to the real
 * `createContainer`/`createApp`/`@hono/node-server` `serve`) so tests can
 * verify the security gate and the "what gets called when" wiring without
 * touching a real filesystem, database, or network port.
 */
export async function runServe(argv: string[], deps: Partial<ServeDeps> = {}): Promise<ServerHandle> {
  const { createContainer: buildContainer, createApp: buildApp, serve: startServer } = { ...defaultDeps, ...deps };

  const options = parseServeArgs(argv);
  assertServeSecurity(options);

  const container = await buildContainer({ dbPath: options.dbPath, secretsPath: defaultSecretsPath(options.dbPath) });
  const app = buildApp(container, { token: options.token });
  const server = startServer({ fetch: app.fetch, port: options.port, hostname: options.host });

  return {
    port: options.port,
    host: options.host,
    close: () => {
      server.close();
      container.close();
    },
  };
}

export interface MainDeps extends Partial<ServeDeps> {
  exit?: (code: number) => void;
}

/** The CLI entry point: `grunt <command> [options]`. Currently only `serve` exists. */
export async function main(argv: string[], deps: MainDeps = {}): Promise<void> {
  const exit = deps.exit ?? ((code: number) => { process.exitCode = code; });
  const [command, ...rest] = argv;

  if (command !== 'serve') {
    console.error('Usage: grunt serve [--port <n>] [--host <addr>] [--db <path>] [--token <secret>]');
    exit(1);
    return;
  }

  try {
    const handle = await runServe(rest, deps);
    console.log(`Grunt server listening on http://${handle.host}:${handle.port}`);
  } catch (err) {
    if (err instanceof NonLoopbackWithoutTokenError) {
      console.error(`Error: ${err.message}`);
      exit(1);
      return;
    }
    throw err;
  }
}

const isMainModule = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];
if (isMainModule) {
  main(process.argv.slice(2)).catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  });
}
