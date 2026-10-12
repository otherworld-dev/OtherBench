import { createServer as createHttpsServer } from 'node:https';
import { isIP } from 'node:net';
import { parseArgs } from 'node:util';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve as nodeServe } from '@hono/node-server';
import { createApp } from './app.js';
import { createContainer, type Container } from './container.js';
import { DatabaseLockedError } from './db-lock.js';
import { announceLine, exitOnStdinClose } from './desktop.js';
import {
  InvalidTrustProxyError,
  RemoteNeedsHttpsError,
  RemoteStartError,
  RemoteWithAnnounceError,
  TlsConflictError,
  TlsWithoutPublicUrlError,
} from './remote/errors.js';
import { PasswordCommandError, runPasswordCommand } from './remote/password-command.js';
import { parsePublicUrl } from './remote/public-url.js';
import { checkSignIn, loginPathFor, startSignIn, type SignIn } from './remote/startup.js';
import { expiryWarning } from './remote/tls.js';

/** Arbitrary default port for `grunt serve`; overridable with `--port`. */
const DEFAULT_PORT = 4747;
const DEFAULT_HOST = '127.0.0.1';

function defaultDbPath(): string {
  return join(homedir(), '.grunt', 'grunt.db');
}

function defaultSecretsPath(dbPath: string): string {
  return dbPath === ':memory:' ? join(homedir(), '.grunt', 'secrets.json') : join(dirname(dbPath), 'secrets.json');
}

/** Where `grunt password` writes and `grunt serve` reads the sign-in password. */
export function defaultLoginPath(dbPath: string): string {
  return loginPathFor(defaultSecretsPath(dbPath));
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
  /** `--public-url`, repeatable: turns sign-in on (spec 2026-10-12-remote-access §1). */
  publicUrls: string[];
  /** `--tls auto`: Grunt's own CA and certificate. */
  tls: 'auto' | null;
  tlsCert: string | null;
  tlsKey: string | null;
  /** `--trust-proxy`, repeatable: exact IPs of HTTPS proxies in front. */
  trustProxies: string[];
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
      'public-url': { type: 'string', multiple: true },
      'trust-proxy': { type: 'string', multiple: true },
      tls: { type: 'string' },
      'tls-cert': { type: 'string' },
      'tls-key': { type: 'string' },
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
  const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : []);
  const tls = values['tls'];
  if (tls !== undefined && tls !== 'auto') {
    throw new TlsConflictError(`Invalid --tls "${String(tls)}": the only value is "auto". For your own certificate use --tls-cert <file> --tls-key <file>.`);
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
    publicUrls: strings(values['public-url']),
    trustProxies: strings(values['trust-proxy']),
    tls: tls === 'auto' ? 'auto' : null,
    tlsCert: typeof values['tls-cert'] === 'string' ? values['tls-cert'] : null,
    tlsKey: typeof values['tls-key'] === 'string' ? values['tls-key'] : null,
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

export type ServeMode = 'open' | 'token' | 'login';

type SecurityOptions = Pick<ServeOptions, 'host' | 'token'> &
  Partial<Pick<ServeOptions, 'announce' | 'publicUrls' | 'tls' | 'tlsCert' | 'tlsKey' | 'trustProxies'>>;

/**
 * The non-negotiable startup gate (task 15, decision #4; spec
 * 2026-10-12-remote-access §1). Pure and synchronous (no I/O, no
 * process.exit) so it can be asserted on directly. Open and token modes are
 * exactly as before; one or more `--public-url` turns sign-in on, which
 * needs an HTTPS route and allows a non-loopback bind without a token.
 */
export function assertServeSecurity(options: SecurityOptions): ServeMode {
  const publicUrls = options.publicUrls ?? [];
  const trustProxies = options.trustProxies ?? [];
  const tls = options.tls ?? null;
  const tlsCert = options.tlsCert ?? null;
  const tlsKey = options.tlsKey ?? null;
  if (publicUrls.length === 0) {
    if (tls !== null || tlsCert !== null || tlsKey !== null || trustProxies.length > 0) throw new TlsWithoutPublicUrlError();
    if (!isLoopbackHost(options.host) && !options.token) throw new NonLoopbackWithoutTokenError(options.host);
    if (options.announce && !options.token) throw new AnnounceWithoutTokenError();
    return options.token ? 'token' : 'open';
  }
  if (options.announce) throw new RemoteWithAnnounceError();
  for (const url of publicUrls) parsePublicUrl(url);
  if (tls === 'auto' && (tlsCert !== null || tlsKey !== null)) throw new TlsConflictError('Refusing to start: use --tls auto or --tls-cert/--tls-key, not both.');
  if ((tlsCert === null) !== (tlsKey === null)) throw new TlsConflictError('Refusing to start: --tls-cert and --tls-key go together.');
  for (const proxy of trustProxies) if (isIP(proxy) === 0) throw new InvalidTrustProxyError(proxy);
  if (tls !== 'auto' && tlsCert === null && trustProxies.length === 0) throw new RemoteNeedsHttpsError();
  return 'login';
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
  scheme: 'http' | 'https';
  /** Sign-in mode's public URLs; empty otherwise. */
  publicUrls: string[];
  /** Lines to print after the listening line (certificate fingerprint, warnings). */
  notes: string[];
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
  const mode = assertServeSecurity(options);
  const secretsPath = defaultSecretsPath(options.dbPath);
  const signInOptions = { ...options, loopback: isLoopbackHost(options.host) };
  // Sign-in's file checks come before anything is built, so a refusal leaves nothing behind.
  const check = mode === 'login' ? checkSignIn(signInOptions, secretsPath) : null;

  const container = await buildContainer({
    dbPath: options.dbPath,
    secretsPath,
    ...(options.peerPort !== undefined ? { peerPort: options.peerPort } : {}),
    peerHosts: options.peerHosts,
  });

  let signIn: SignIn | null = null;
  try {
    if (check) signIn = startSignIn(signInOptions, check, container.store.nodes.self().name);
  } catch (err) {
    container.close();
    throw err;
  }
  const remote = signIn?.remote ?? null;

  // Filled in by the listening callback; the Host check reads it per request,
  // and no request can arrive before the port is bound.
  let boundPort = options.port;
  const app = buildApp(container, {
    token: options.token,
    webDistDir: defaultWebDistDir(),
    corsOrigins: options.corsOrigins,
    hostCheckPort: isLoopbackHost(options.host) || remote ? () => boundPort : undefined,
    oauthCallbackPort: () => boundPort,
    remote,
  });

  const tls = signIn?.tls ?? null;
  const serveOptions = tls
    ? { fetch: app.fetch, port: options.port, hostname: options.host, createServer: createHttpsServer, serverOptions: { key: tls.key, cert: tls.cert, minVersion: 'TLSv1.2' as const } }
    : { fetch: app.fetch, port: options.port, hostname: options.host };

  let server: ReturnType<typeof nodeServe>;
  try {
    await new Promise<void>((resolve, reject) => {
      server = startServer(serveOptions, (info) => {
        boundPort = info.port;
        resolve();
      });
      // A real server reports a failed bind (EADDRINUSE) as an 'error' event
      // rather than throwing; test doubles have no `once`.
      (server as { once?: (event: string, fn: (err: Error) => void) => void }).once?.('error', reject);
    });
  } catch (err) {
    remote?.close();
    container.close();
    throw err;
  }

  // A long-running server says so in the log when its certificate is near its end; nothing renews mid-run.
  const notAfter = signIn?.notAfter ?? null;
  const expiryTimer =
    notAfter !== null
      ? setInterval(() => {
          const warning = expiryWarning(notAfter, Date.now());
          if (warning) console.error(warning);
        }, 86_400_000)
      : null;
  expiryTimer?.unref?.();

  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    if (expiryTimer) clearInterval(expiryTimer);
    remote?.close();
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

  return {
    port: boundPort,
    host: options.host,
    announce: options.announce,
    scheme: tls ? 'https' : 'http',
    publicUrls: remote?.publicOrigins ?? [],
    notes: signIn?.notes ?? [],
    close,
  };
}

export interface MainDeps extends Partial<ServeDeps> {
  env?: NodeJS.ProcessEnv;
  /** Whether stdin is a terminal, for `grunt password`. Defaults to `process.stdin.isTTY`. */
  isTTY?: boolean;
}

const USAGE = [
  'Usage:',
  '  grunt serve [--port <n>] [--host <addr>] [--db <path>] [--token <secret>] [--announce] [--cors-origin <origin>]... [--peer-port <n>] [--peer-host <addr>]...',
  '              [--public-url https://<host>[:<port>]]... [--tls auto | --tls-cert <file> --tls-key <file>] [--trust-proxy <ip>]...',
  '  grunt password [--db <path>]',
].join('\n');

/** The CLI entry point: `grunt serve` or `grunt password`. */
export async function main(argv: string[], deps: MainDeps = {}): Promise<void> {
  const exit = deps.exit ?? ((code: number) => { process.exitCode = code; });
  const [command, ...rest] = argv;

  if (command === 'password') {
    const { values } = parseArgs({ args: rest, options: { db: { type: 'string' } }, strict: false });
    const dbPath = typeof values['db'] === 'string' ? values['db'] : defaultDbPath();
    try {
      await runPasswordCommand(defaultLoginPath(dbPath), {
        stdin: deps.stdin ?? process.stdin,
        stdout: deps.stdout ?? process.stdout,
        isTTY: deps.isTTY ?? Boolean(process.stdin.isTTY),
      });
    } catch (err) {
      if (err instanceof PasswordCommandError) {
        console.error(`Error: ${err.message}`);
        exit(1);
        return;
      }
      throw err;
    }
    return;
  }

  if (command !== 'serve') {
    console.error(USAGE);
    exit(1);
    return;
  }

  try {
    const handle = await runServe(rest, deps, deps.env ?? process.env);
    // In announce mode stdout belongs to the handshake alone.
    const log = handle.announce ? console.error : console.log;
    const signIn = handle.publicUrls.length > 0 ? `; sign-in on ${handle.publicUrls.join(', ')}` : '';
    log(`Grunt server listening on ${handle.scheme}://${handle.host}:${handle.port}${signIn}`);
    for (const note of handle.notes) log(note);
  } catch (err) {
    if (
      err instanceof NonLoopbackWithoutTokenError ||
      err instanceof AnnounceWithoutTokenError ||
      err instanceof RemoteStartError ||
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
