import { Console } from 'node:console';
import { randomBytes } from 'node:crypto';
import { createServer as createHttpsServer } from 'node:https';
import { isIP } from 'node:net';
import { parseArgs } from 'node:util';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve as nodeServe } from '@hono/node-server';
import type { ComputerDriver } from '@otherbench/core/ports/computer.js';
import { createApp } from './app.js';
import { DesktopChannel } from './computer/desktop-channel.js';
import { DesktopComputerDriver } from './computer/desktop-driver.js';
import { createContainer, type Container } from './container.js';
import { DatabaseLockedError } from './db-lock.js';
import { adoptLegacyData, DATA_DIR, DB_NAME, LegacyDataError } from './legacy-data.js';
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
import { isServerOnlyEnvVar } from '@otherbench/core/domain/child-env.js';

/** Arbitrary default port for `otherbench serve`; overridable with `--port`. */
const DEFAULT_PORT = 4747;
const DEFAULT_HOST = '127.0.0.1';
/**
 * How long an announce-mode shutdown waits for the container's background work (the sandbox closing its agents
 * and taking its folders down in the VM) before exiting anyway. Under the desktop shell's 3 s grace
 * (desktop/src-tauri/src/sidecar.rs), after which it kills the server.
 */
export const SHUTDOWN_WAIT_MS = 2500;

function defaultDbPath(): string {
  return join(homedir(), DATA_DIR, DB_NAME);
}

function defaultSecretsPath(dbPath: string): string {
  return dbPath === ':memory:' ? join(homedir(), DATA_DIR, 'secrets.json') : join(dirname(dbPath), 'secrets.json');
}

/** Grunt's data moved to OtherBench's names (legacy-data.ts), only for the default database: `--db` names its own. */
function adoptForDefault(dbPath: string, adopt: () => string | null): void {
  if (dbPath !== defaultDbPath()) return;
  const moved = adopt();
  if (moved) console.error(moved);
}

/** Where `otherbench password` writes and `otherbench serve` reads the sign-in password. */
export function defaultLoginPath(dbPath: string): string {
  return loginPathFor(defaultSecretsPath(dbPath));
}

/**
 * `@otherbench/web`'s built bundle lives at `packages/web/dist` -- a sibling of
 * this package, `packages/server`, regardless of the working directory
 * `otherbench serve` is launched from. Computed from `import.meta.url` (this
 * file's own compiled location, `packages/server/dist/cli.js`) rather than
 * `process.cwd()`, since a globally-installed `otherbench` binary may be
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
  /**
   * The desktop shell speaks the OTHERBENCH-RPC channel on this process's stdio
   * (computer use, computer/desktop-channel.ts). Only with `announce`, and
   * refused without it (`DesktopRpcWithoutAnnounceError`): a server started
   * by hand, and one that takes sign-ins, has no channel.
   */
  desktopRpc: boolean;
  corsOrigins: string[];
  /** The peer listener's port; unset uses the default (4748). */
  peerPort?: number;
  /** Addresses the peer listener binds; empty means every interface. */
  peerHosts: string[];
  /** `--public-url`, repeatable: turns sign-in on (spec 2026-10-12-remote-access §1). */
  publicUrls: string[];
  /** `--tls auto`: OtherBench's own CA and certificate. */
  tls: 'auto' | null;
  tlsCert: string | null;
  tlsKey: string | null;
  /** `--trust-proxy`, repeatable: exact IPs of HTTPS proxies in front. */
  trustProxies: string[];
}

/**
 * `--token` wins; otherwise `OTHERBENCH_TOKEN`. The desktop shell always uses
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
      'desktop-rpc': { type: 'boolean' },
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
  const envToken = env['OTHERBENCH_TOKEN'];
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
    desktopRpc: values['desktop-rpc'] === true,
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
 * server through -- the only hosts `otherbench serve` will bind to without a
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

/**
 * Whether this server may offer the Code tab's terminals (spec 2026-10-21-code-terminal-design): a shell with no
 * approval card, so only on a server nothing else can reach -- open or token mode, bound to loopback. Never in
 * sign-in mode, never on a token server listening on the network.
 */
export function terminalsAllowed(mode: ServeMode, host: string): boolean {
  return mode !== 'login' && isLoopbackHost(host);
}

type SecurityOptions = Pick<ServeOptions, 'host' | 'token'> &
  Partial<Pick<ServeOptions, 'announce' | 'desktopRpc' | 'publicUrls' | 'tls' | 'tlsCert' | 'tlsKey' | 'trustProxies'>>;

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
  // The desktop channel exists only for the shell's own launch (--announce), which is never a sign-in server.
  if (options.desktopRpc === true && options.announce !== true) throw new DesktopRpcWithoutAnnounceError();
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
    super('Refusing to start: --announce requires a token. Set OTHERBENCH_TOKEN in the environment (preferred) or pass --token.');
    this.name = 'AnnounceWithoutTokenError';
  }
}

/**
 * `--desktop-rpc` opens the computer-use channel on this process's stdio,
 * which only the desktop shell that started it holds. Without `--announce`
 * (the shell's launch) there is no such shell, so the flag is refused rather
 * than ignored. A sign-in server can't have `--announce`, so it can't have
 * the channel either.
 */
export class DesktopRpcWithoutAnnounceError extends Error {
  constructor() {
    super("Refusing to start: --desktop-rpc only works with --announce (the desktop app's own launch).");
    this.name = 'DesktopRpcWithoutAnnounceError';
  }
}

/**
 * In `--desktop-rpc` mode stdout carries the channel to the shell, and
 * nothing but the channel may write a line there. Every console method that
 * would write to stdout writes to stderr instead (`warn`, `error` and
 * `trace` already do). Something that writes to `process.stdout` itself is
 * not caught here; the launch's word in every request (`rpc` in the
 * announce line) is what keeps such a line from passing for one.
 */
export function consoleToStderr(target: Console = console, stream: NodeJS.WritableStream = process.stderr): void {
  const toStderr = new Console({ stdout: stream, stderr: stream });
  const methods = ['log', 'info', 'debug', 'dir', 'dirxml', 'table', 'count', 'countReset', 'group', 'groupCollapsed', 'groupEnd', 'time', 'timeLog', 'timeEnd'] as const;
  for (const name of methods) {
    const method = toStderr[name] as (...args: unknown[]) => void;
    (target as unknown as Record<string, unknown>)[name] = (...args: unknown[]) => method.apply(toStderr, args);
  }
}

export interface ServeDeps {
  createContainer: (opts: {
    dbPath: string;
    secretsPath: string;
    apiPort?: number;
    peerPort?: number;
    peerHosts?: string[];
    serverPort?: () => number | null;
    computer?: ComputerDriver;
  }) => Promise<Container>;
  createApp: typeof createApp;
  serve: typeof nodeServe;
  /** Where the announce line goes. Defaults to `process.stdout`. */
  stdout: { write(chunk: string): unknown };
  /** Watched for close in announce mode. Defaults to `process.stdin`. */
  stdin: NodeJS.ReadableStream;
  /** Called with 0 after an announce-mode shutdown. Defaults to `process.exit`. */
  exit: (code: number) => void;
  /** In `--desktop-rpc` mode, sends what the console would write to stdout to stderr. Defaults to `consoleToStderr()`. */
  consoleToStderr: () => void;
  /** Moves Grunt's data to OtherBench's names before the default database opens. Defaults to `adoptLegacyData(homedir())`. */
  adoptLegacyData: () => string | null;
}

const defaultDeps: ServeDeps = {
  createContainer,
  createApp,
  serve: nodeServe,
  stdout: process.stdout,
  stdin: process.stdin,
  exit: (code) => process.exit(code),
  consoleToStderr: () => consoleToStderr(),
  adoptLegacyData: () => {
    const claudeConfigDir = process.env['CLAUDE_CONFIG_DIR'];
    return adoptLegacyData(homedir(), claudeConfigDir ? { claudeConfigDir } : {});
  },
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
  /** Ends every terminal's shell and what it started (Ctrl+C on `otherbench serve`). */
  stopTerminals: () => Promise<void>;
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
    consoleToStderr: quietStdout,
    adoptLegacyData: adopt,
  } = { ...defaultDeps, ...deps };

  const options = parseServeArgs(argv, env);
  adoptForDefault(options.dbPath, adopt);
  // The token is in `options` now. Nothing this server starts (a shell command, Claude Code, an MCP server, the
  // sandbox's wsl.exe, the model's browser, a worker) may inherit it: on the desktop server it is the real barrier
  // against anything else on the machine driving the API. Every spawn also leaves it out (core/domain/child-env.ts).
  for (const name of Object.keys(env)) if (isServerOnlyEnvVar(name)) delete env[name];
  const mode = assertServeSecurity(options);
  const secretsPath = defaultSecretsPath(options.dbPath);
  const signInOptions = { ...options, loopback: isLoopbackHost(options.host) };
  // Sign-in's file checks come before anything is built, so a refusal leaves nothing behind.
  const check = mode === 'login' ? checkSignIn(signInOptions, secretsPath) : null;

  // Filled in by the listening callback; the Host check reads it per request,
  // and no request can arrive before the port is bound. The sandbox's
  // self-test reads it too (0 asks the OS for a port: not known until bound).
  let boundPort = options.port;
  // The shell's own channel (spec 2026-10-12-computer-use-design section 2),
  // only when the shell asks for it: requests go out on stdout after the
  // announce line and answers come back on stdin. A server started by hand
  // has none, so it has no computer-use driver and offers no such tool.
  // `rpc` is this launch's word: every request carries it, and it reaches the
  // shell only in the announce line, so no other line on stdout passes for one.
  const rpcWord = options.announce && options.desktopRpc ? randomBytes(16).toString('hex') : null;
  if (rpcWord !== null) quietStdout();
  const desktop = rpcWord !== null ? new DesktopComputerDriver(new DesktopChannel(stdin, stdout, { nonce: rpcWord })) : null;

  const container = await buildContainer({
    dbPath: options.dbPath,
    secretsPath,
    apiPort: options.port,
    ...(options.peerPort !== undefined ? { peerPort: options.peerPort } : {}),
    peerHosts: options.peerHosts,
    serverPort: () => (boundPort > 0 ? boundPort : null),
    ...(desktop ? { computer: desktop } : {}),
  });

  let signIn: SignIn | null = null;
  try {
    if (check) signIn = startSignIn(signInOptions, check, container.store.nodes.self().name);
  } catch (err) {
    container.close();
    throw err;
  }
  const remote = signIn?.remote ?? null;

  const app = buildApp(container, {
    token: options.token,
    webDistDir: defaultWebDistDir(),
    corsOrigins: options.corsOrigins,
    hostCheckPort: isLoopbackHost(options.host) || remote ? () => boundPort : undefined,
    oauthCallbackPort: () => boundPort,
    remote,
    terminals: terminalsAllowed(mode, options.host),
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
    stdout.write(announceLine(boundPort, rpcWord));
    exitOnStdinClose(stdin, () => {
      close();
      // Exiting at once would leave the sandbox's folders mounted in the VM (and undeletable on Windows) until WSL stops it.
      let timer: ReturnType<typeof setTimeout> | undefined;
      const waited = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, SHUTDOWN_WAIT_MS);
      });
      void Promise.race([container.settled?.() ?? Promise.resolve(), waited]).then(() => {
        clearTimeout(timer);
        exit(0);
      });
    });
    // Only now, after the announce line, may anything else go to stdout. Until
    // the shell answers that computer use is on, the driver is not available
    // and the tool is not offered; `hello` never throws.
    if (desktop) void desktop.hello();
  }

  return {
    port: boundPort,
    host: options.host,
    announce: options.announce,
    scheme: tls ? 'https' : 'http',
    publicUrls: remote?.publicOrigins ?? [],
    notes: signIn?.notes ?? [],
    close,
    stopTerminals: () => container.terminals?.closeAll() ?? Promise.resolve(),
  };
}

export interface MainDeps extends Partial<ServeDeps> {
  env?: NodeJS.ProcessEnv;
  /** Whether stdin is a terminal, for `otherbench password`. Defaults to `process.stdin.isTTY`. */
  isTTY?: boolean;
  /** Where Ctrl+C and SIGTERM are heard. Defaults to `process.once`. */
  onSignal?: (signal: 'SIGINT' | 'SIGTERM', handler: () => void) => void;
}

const USAGE = [
  'Usage:',
  '  otherbench serve [--port <n>] [--host <addr>] [--db <path>] [--token <secret>] [--announce [--desktop-rpc]] [--cors-origin <origin>]... [--peer-port <n>] [--peer-host <addr>]...',
  '              [--public-url https://<host>[:<port>]]... [--tls auto | --tls-cert <file> --tls-key <file>] [--trust-proxy <ip>]...',
  '  otherbench password [--db <path>]',
].join('\n');

/** The CLI entry point: `otherbench serve` or `otherbench password`. */
export async function main(argv: string[], deps: MainDeps = {}): Promise<void> {
  const exit = deps.exit ?? ((code: number) => { process.exitCode = code; });
  const [command, ...rest] = argv;

  if (command === 'password') {
    const { values } = parseArgs({ args: rest, options: { db: { type: 'string' } }, strict: false });
    const dbPath = typeof values['db'] === 'string' ? values['db'] : defaultDbPath();
    try {
      adoptForDefault(dbPath, deps.adoptLegacyData ?? defaultDeps.adoptLegacyData);
      await runPasswordCommand(defaultLoginPath(dbPath), {
        stdin: deps.stdin ?? process.stdin,
        stdout: deps.stdout ?? process.stdout,
        isTTY: deps.isTTY ?? Boolean(process.stdin.isTTY),
      });
    } catch (err) {
      if (err instanceof PasswordCommandError || err instanceof LegacyDataError) {
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
    log(`OtherBench server listening on ${handle.scheme}://${handle.host}:${handle.port}${signIn}`);
    for (const note of handle.notes) log(note);
    // Ctrl+C or SIGTERM: the terminals' shells and what they started go first (a dev server would keep its port),
    // then the process exits as it always has, without the rest of the shutdown (spec "Which exits clean up"). A real
    // exit: with a handler installed Node no longer exits by itself, and main's default `exit` only sets the code.
    const onSignal = deps.onSignal ?? ((signal, handler) => void process.once(signal, handler));
    for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143]] as const) {
      onSignal(signal, () => {
        void handle
          .stopTerminals()
          .catch(() => undefined)
          .finally(() => (deps.exit ?? ((c: number) => process.exit(c)))(code));
      });
    }
  } catch (err) {
    if (
      err instanceof NonLoopbackWithoutTokenError ||
      err instanceof AnnounceWithoutTokenError ||
      err instanceof DesktopRpcWithoutAnnounceError ||
      err instanceof RemoteStartError ||
      err instanceof DatabaseLockedError ||
      err instanceof LegacyDataError
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
