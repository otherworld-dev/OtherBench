import { randomBytes } from 'node:crypto';
import { mkdtempSync, realpathSync } from 'node:fs';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { runArtifactCommand } from '@grunt/core/domain/artifacts.js';
import { runRecallCommand } from '@grunt/core/domain/recall.js';
import { PermissionBroker } from '@grunt/core/domain/permissions.js';
import { reconcileInterruptedTurns } from '@grunt/core/domain/reconcile.js';
import { TurnRunner } from '@grunt/core/domain/turn.js';
import type { ChatEngine } from '@grunt/core/ports/chat-engine.js';
import type { Sandbox } from '@grunt/core/ports/sandbox.js';
import type { SecretStore } from '@grunt/core/ports/secret-store.js';
import type { Store } from '@grunt/core/ports/store.js';
import type { ToolProvider } from '@grunt/core/ports/tool-provider.js';
import { AiSdkChatEngine } from '@grunt/engine-aisdk/engine.js';
import { ProviderRegistry } from '@grunt/engine-aisdk/registry.js';
import { ClaudeCodeChatEngine, type QueryFn } from '@grunt/engine-claude-code/engine.js';
import { sweepOrphanedBlobs } from '@grunt/store-sqlite/blob-gc.js';
import { createBlobStore, resolveAttachmentsRoots, type BlobStore } from '@grunt/store-sqlite/blob-store.js';
import { openDatabase } from '@grunt/store-sqlite/db.js';
import { runMigrations, SCHEMA_VERSION } from '@grunt/store-sqlite/migrations/index.js';
import { createSecretStore } from '@grunt/store-sqlite/secret-store.js';
import { SqliteStore } from '@grunt/store-sqlite/store.js';
import { McpServerManager } from '@grunt/tools/mcp/manager.js';
import { GruntToolProvider } from '@grunt/tools/provider.js';
import { acquireDbLock } from './db-lock.js';
import { endpointModelLister, RoutingChatEngine } from './engine-router.js';
import { ClaudeImportService } from './import/claude-import.js';
import { defaultCoworkRoot } from './import/cowork-reader.js';
import { GlobalMemoryService } from './memory/global.js';
import { MemoryServices } from './memory/index.js';
import { ProjectMemoryService } from './memory/service.js';
import { MemoryQueue } from './memory/shared.js';
import { createPeerApp } from './peer/app.js';
import { DEFAULT_PEER_PORT } from './peer/client.js';
import { IdentityStore } from './peer/identity.js';
import { forwardedApi, RemoteRuns } from './peer/forward.js';
import { PeerService } from './peer/service.js';
import { Syncer } from './peer/syncer.js';
import { resolveProfile } from './profile-resolution.js';
import { createSandbox } from './sandbox.js';
import { subscribeAutoTitle } from './routes/chats.js';
import { ScheduleService } from './schedule/service.js';
import { AppEventBus, withChatEvents } from './stream/events.js';
import { StreamRegistry } from './stream/registry.js';
import type { StreamTimings } from './stream/sse.js';
import { startTurn } from './turn-start.js';
import { workspaceResolver } from './workspace-view.js';

/** The wired-up dependency set every route handler is given. */
export interface Container {
  store: Store;
  secrets: SecretStore;
  engine: ChatEngine;
  registry: ProviderRegistry;
  /** The turn lifecycle state machine (packages/core/src/domain/turn.ts) -- one instance per server process, shared by every chat. */
  turnRunner: TurnRunner;
  /** Live/recently-completed SSE buffers, fed by `turnRunner`'s events -- see src/stream/registry.ts. */
  streamRegistry: StreamRegistry;
  /** Assembles fs/shell/MCP tools and gates every call behind `PermissionBroker` (task 26) -- shared by `turnRunner` (via `TurnRunnerOptions.toolProvider`) and routes/tools.ts (approval resolution, MCP refresh). */
  toolProvider: ToolProvider;
  /**
   * This machine's sandbox for profiles whose shell runs there (spec
   * 2026-10-12-sandbox-design). Always set by `createContainer`; optional so
   * route tests can build a Container without one.
   */
  sandbox?: Sandbox;
  /** Owns live MCP server connections; `toolProvider` reads its cached tools, routes/tools.ts calls `sync()` after any write to the `mcp_server` table. */
  mcpManager: McpServerManager;
  /**
   * Where Claude Code clean chats (no folder) run, one folder per chat
   * (spec 2026-10-11-claude-code-clean-chat-and-mcp-design §1): next to the
   * database, or a private temp folder for `:memory:`. Deleting a chat
   * removes its folder. Optional so hand-built test containers can leave it out.
   */
  claudeScratchRoot?: string;
  /** Content-addressed blob storage for attachments (task 21) -- `routes/attachments.ts` writes to it on upload; `TurnRunner`'s `loadAttachment` (wired below) reads from it to embed real bytes for a vision-capable model. */
  blobStore: BlobStore;
  /**
   * The memory summarisers, project (spec 2026-10-03-project-memory-design §2)
   * and global (spec 2026-10-08-global-memory-design §2): quiet timers, the
   * one update queue they share and their last failures. Always set by
   * `createContainer`; optional only so route tests that never touch memory
   * can build a Container without one.
   */
  memory?: MemoryServices;
  /**
   * Scheduled tasks (spec 2026-10-12-scheduled-tasks-design): runs due
   * schedules unattended. Always set by `createContainer`; optional so route
   * tests can build a Container without one.
   */
  schedules?: ScheduleService;
  /**
   * Import from claude.ai (spec 2026-10-09-claude-import-design). Always set
   * by `createContainer`; optional so route tests can build a Container
   * without one.
   */
  claudeImport?: ClaudeImportService;
  /**
   * App-wide events behind `GET /api/events` (v2 plan, Task 34). Always set by
   * `createContainer`, whose store announces chat changes on it; optional
   * only so route tests can build a Container without one.
   */
  events?: AppEventBus;
  /** Whether a folder exists, for resolving chat folders; unset means the real disk. Tests set it. */
  pathExists?: (path: string) => boolean;
  /** Replies and approvals running on paired machines, for the calls this machine forwards (Task 52). */
  remoteRuns?: RemoteRuns;
  /**
   * Paired machines and the peer listener (v2 plan, Tasks 46-47). Always set
   * by `createContainer`; optional so route tests can build a Container
   * without one.
   */
  peers?: PeerService;
  /** Keepalive and idle limits for streams; unset means the defaults in stream/sse.ts. */
  streamTimings?: StreamTimings;
  close(): void;
  /**
   * After close(): settles (never rejects) once the shutdown work close() starts without waiting has finished:
   * the sandbox closing its agents and unmounting its folders in the VM. Always set by `createContainer`.
   */
  settled?(): Promise<void>;
}

export interface ContainerOptions {
  dbPath: string;
  secretsPath: string;
  /** The peer listener's port (default 4748; 0 = any free port). */
  peerPort?: number;
  /** Addresses the peer listener binds (default every interface). */
  peerHosts?: string[];
  /** Keepalive and idle limits for streams (defaults in stream/sse.ts); tests shorten them. */
  streamTimings?: StreamTimings;
  /** The port the API ends up on (cli.ts knows it after binding); the sandbox's self-test checks the VM can't reach it. */
  serverPort?: () => number | null;
}

/** A folder's real path (on-disk case, a mapped drive as its UNC path), as the sandbox mounts it; the path itself when that can't be read. */
export function realFolderPath(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return path;
  }
}

function isEnoent(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as NodeJS.ErrnoException).code === 'ENOENT';
}

/** True if `path` exists (any type), false for ENOENT specifically. Used only for the one-time "does the legacy attachments directory still exist" startup check below. */
async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (err) {
    if (isEnoent(err)) return false;
    throw err;
  }
}

/**
 * Resolves the passphrase `EncryptedFileSecretStore` (packages/store-sqlite)
 * derives its AES-256-GCM key from.
 *
 * `GRUNT_SECRETS_PASSPHRASE` wins if set -- an operator or the desktop shell
 * can supply and manage it explicitly. Otherwise a random 256-bit passphrase
 * is generated once and persisted next to the secrets file
 * (`<secretsPath>.key`, mode 0600 *on POSIX*; Node's `mode` option is a
 * documented no-op on Windows, whose ACL model `fs.chmod`/`fs.writeFile`'s
 * `mode` cannot express -- verified empirically on this machine, the
 * resulting file is 644-equivalent there. Stated here explicitly rather than
 * silently claimed as fact; see `EncryptedFileSecretStore`'s docstring in
 * secret-store.ts for the same caveat on the secrets file itself) so the
 * same key is reused across restarts without requiring Grunt's single local
 * user to remember or type one anywhere -- `grunt serve` has no
 * `--secrets-passphrase` flag in the brief, and the global constraint that
 * API keys must never sit in SQLite still needs *something* to key the
 * encrypted file with. This is a pragmatic default for a local, single-user
 * tool, not a substitute for a real secret manager; see
 * task-14-15-report.md for the full reasoning.
 *
 * Also worth being honest about: keeping this key file beside the ciphertext
 * it unlocks, under the same OS-user access boundary, adds no
 * confidentiality against anyone who can already read the encrypted secrets
 * file or the SQLite database on this machine -- whoever can read one can
 * read the other and decrypt everything. It only protects against casual
 * disclosure (e.g. the secrets file leaking on its own, without its key) and
 * backup/copy leakage where the key file is left behind by accident; it is
 * not a defense against local filesystem access.
 */
export async function resolveSecretsPassphrase(secretsPath: string): Promise<string> {
  const envPassphrase = process.env['GRUNT_SECRETS_PASSPHRASE'];
  if (envPassphrase) return envPassphrase;

  const keyPath = `${secretsPath}.key`;
  try {
    const existing = await readFile(keyPath, 'utf8');
    return existing.trim();
  } catch (err) {
    if (!isEnoent(err)) throw err;
  }

  const generated = randomBytes(32).toString('base64');
  await mkdir(dirname(keyPath), { recursive: true });
  // mode 0600 is honored on POSIX; a documented no-op on Windows -- see this
  // function's docstring above.
  await writeFile(keyPath, generated, { mode: 0o600 });
  return generated;
}

/**
 * Opens (migrating if needed) the real SQLite-backed `Container` the CLI
 * serves from, holding the database lock (db-lock.ts) for its whole life:
 * taken before anything reads the store -- in particular before
 * `reconcileInterruptedTurns` -- and released by `close()`, or straight
 * away if startup fails part-way.
 */
export async function createContainer(options: ContainerOptions): Promise<Container> {
  if (options.dbPath !== ':memory:') {
    await mkdir(dirname(options.dbPath), { recursive: true });
  }
  const lock = acquireDbLock(options.dbPath);
  let container: Container;
  try {
    container = await openContainer(options);
  } catch (err) {
    lock?.release();
    throw err;
  }
  const closeContainer = container.close;
  container.close = () => {
    closeContainer();
    lock?.release();
  };
  return container;
}

async function openContainer(options: ContainerOptions): Promise<Container> {
  const db = openDatabase(options.dbPath);
  runMigrations(db);
  // Every chat change, whoever makes it, is announced on the app-wide stream.
  const events = new AppEventBus();
  const store = withChatEvents(new SqliteStore(db), events);

  // A message row left `status: 'streaming'` means the process that was
  // writing it is gone -- ASSUMING a single Grunt server process per
  // database: this process's own `TurnRunner.controllers` (the only thing
  // that could still be driving one) is empty on every fresh start, so any
  // such row found here looks orphaned to it. `openDatabase`'s WAL mode
  // and `busy_timeout` would happily let a second process open the same
  // database, and this runs before the port bind, so without a guard a
  // second launch (even one about to fail with `EADDRINUSE`) could
  // reconcile out from under a still-live first process's stream,
  // flipping its row to `error` while it's genuinely streaming. The
  // database lock taken in `createContainer` is that guard: a second
  // process never gets this far. Reconciled synchronously, before anything else can reach the store, so
  // within a single well-behaved process no route or SSE client ever
  // observes a `streaming` row that process did not itself just start. See
  // reconcile.ts for the full reasoning and for why the dead end this closes
  // has no in-app escape otherwise.
  const reconciled = reconcileInterruptedTurns(store);
  if (reconciled.length > 0) {
    console.warn(
      `[grunt-server] reconciled ${reconciled.length} message(s) left "streaming" by a previous process: ` +
        reconciled.map((m) => m.id).join(', ')
    );
  }

  const passphrase = await resolveSecretsPassphrase(options.secretsPath);
  const secrets = createSecretStore(options.secretsPath, passphrase);

  // Per-database attachment roots (task 32 fix round 1, Critical #2):
  // derived from THIS database's own path, never shared with any other
  // database that happens to sit next to the same secrets.json (or, for
  // `:memory:`, the same default ~/.grunt directory) -- see
  // resolveAttachmentsRoots's doc for the incident this fixes. The legacy
  // shared root is read-only from here on: `blobStore.get()` falls back to
  // it, but nothing ever writes to or sweeps it again.
  const roots = resolveAttachmentsRoots(options.dbPath, options.secretsPath);
  const blobStore = createBlobStore(roots.writeRoot, roots.legacyRoot);

  if (await pathExists(roots.legacyRoot)) {
    console.warn(
      `[grunt-server] legacy shared attachments directory "${roots.legacyRoot}" still exists. New uploads for ` +
        `this database go to "${roots.writeRoot}" instead, and it is never written to or swept -- but it is ` +
        `STILL READ: any attachment uploaded before this change is served from there. Do NOT delete it -- doing ` +
        `so will make those older attachments 404.`
    );
  }

  // Startup blob sweep (task 32 decision #2c): reclaims anything orphaned
  // before this GC existed, or left behind by a crash between a row delete
  // and its blob cleanup. Enumerates disk and diffs it against the
  // `attachment` table, never the other way round -- see
  // `sweepOrphanedBlobs`'s own doc. Awaited (not fire-and-forget) so the
  // server never briefly serves with stale garbage still on disk. Only ever
  // touches `roots.writeRoot` -- see resolveAttachmentsRoots's doc for why
  // that's now safe to run unconditionally, even with another database's
  // own file sitting in the same parent directory.
  const swept = await sweepOrphanedBlobs(store, blobStore);
  if (swept.removed > 0) {
    console.warn(`[grunt-server] startup blob sweep removed ${swept.removed} orphaned attachment blob(s) (of ${swept.scanned} scanned).`);
  }

  const registry = new ProviderRegistry();
  const aisdkEngine = new AiSdkChatEngine(registry);

  const broker = new PermissionBroker(store);
  const mcpManager = new McpServerManager(store, secrets);
  // Next to the database, like its attachments; a :memory: database (tests) uses the temp folder.
  const dataDir = options.dbPath === ':memory:' ? join(tmpdir(), `grunt-data-${process.pid}`) : dirname(options.dbPath);
  const sandbox = await createSandbox({ store, dataDir, serverPort: options.serverPort ?? (() => null) });
  const toolProvider = new GruntToolProvider(store, broker, mcpManager, { sandbox });
  const claudeScratchRoot =
    options.dbPath === ':memory:' ? mkdtempSync(join(tmpdir(), 'grunt-claude-scratch-')) : join(dirname(options.dbPath), 'claude-scratch');
  const engine = new RoutingChatEngine(
    aisdkEngine,
    new ClaudeCodeChatEngine({
      query: query as unknown as QueryFn,
      approvals: toolProvider,
      listEndpointModels: endpointModelLister(aisdkEngine),
      // Artifacts (Deck #896) and recall: the same executors as the API engines' tools.
      artifactTool: async (ctx, args) => runArtifactCommand(store, ctx, args),
      recallTool: async (ctx, args) => runRecallCommand(store, ctx, args),
      // Clean chats; the profile's MCP servers and its sandboxed run_command, relayed through Grunt's own server.
      scratchRoot: claudeScratchRoot,
      relayTools: (policy) => toolProvider.relayTools(policy),
    })
  );
  // "Connect on enable" (task 25/26 brief): reconcile live MCP connections
  // against whatever `mcp_server` rows already exist as soon as the
  // container is up, not lazily on the first turn that needs one --
  // fire-and-forget so a slow/unreachable server doesn't delay server
  // startup; its status simply stays 'connecting'/'error' until it resolves.
  void mcpManager.sync().catch((err: unknown) => {
    console.error('[grunt-server] initial MCP server sync failed:', err);
  });

  const turnRunner = new TurnRunner(store, engine, {
    toolProvider,
    // The sandbox mounts a folder at its real path (on-disk case), so the prompt names that one.
    canonicalPath: realFolderPath,
    // Closes the gap `engine.ts`'s own docstring calls out (task 14):
    // `AiSdkChatEngine` has no filesystem/store access of its own, so
    // without this every real (vision-on) image/file part would fail with
    // "attachment loading not wired up" the moment a non-mock provider
    // actually tried to send one. Re-reads the `Attachment` row fresh on
    // every call rather than caching anything -- attachments are immutable
    // content-addressed blobs once written, so there's nothing to go stale.
    loadAttachment: async (id: string): Promise<Buffer> => {
      const attachment = store.attachments.get(id);
      if (!attachment) throw new Error(`loadAttachment: unknown attachment "${id}".`);
      try {
        return await blobStore.get(attachment.sha256);
      } catch (err) {
        // NEVER let the raw fs error through: `BlobStore.get`'s rejection
        // (a real Node `Error`, e.g. "ENOENT: no such file or directory,
        // open 'C:\...\attachments\92\922a...'") names an absolute SERVER
        // filesystem path. TurnRunner persists whatever this throws as
        // `message.error.message` (classifyProviderError copies it
        // verbatim), which `GET /chats/:id/messages` then returns straight
        // to the client -- exactly the leak `storagePath` was stripped from
        // API responses to prevent in the first place (task 32 decision
        // #3), reopened through a different door. This names the
        // attachment by id/filename instead -- never a path.
        console.error(`[grunt-server] failed to load attachment "${id}"'s blob:`, err);
        throw new Error(`Attachment "${attachment.filename}" (${id}) is missing or unreadable.`);
      }
    },
  });
  const streamRegistry = new StreamRegistry(turnRunner, store);
  events.attach(turnRunner, store);
  const memoryQueue = new MemoryQueue();
  const memoryDeps = { store, engine, resolveProfile: (id: string) => resolveProfile({ store, secrets }, id), queue: memoryQueue };
  const memory = new MemoryServices(new ProjectMemoryService(memoryDeps), new GlobalMemoryService(memoryDeps));
  memory.attach(turnRunner);
  // Imported project docs and claude.ai's memory files sit beside this database, like its attachments.
  const importRoot = options.dbPath === ':memory:' ? join(tmpdir(), `grunt-import-${process.pid}-${randomBytes(4).toString('hex')}`) : `${options.dbPath}.imported`;
  // Cowork sessions are read where Claude Desktop keeps them on this machine. GRUNT_COWORK_ROOT points
  // elsewhere (the e2e run's fixture) or, empty, nowhere; a :memory: database (tests) has none.
  const coworkOverride = process.env['GRUNT_COWORK_ROOT'];
  const coworkRoot = options.dbPath === ':memory:' ? null : coworkOverride !== undefined ? coworkOverride || null : defaultCoworkRoot();
  const claudeImport = new ClaudeImportService({ ...memoryDeps, events, blobStore, importRoot: join(importRoot, 'claude'), coworkRoot });

  // This machine's certificate lives beside the secrets file; an in-memory
  // database gets one that lasts only as long as the process.
  // Filled in once the container exists: the peer listener's view of this machine's API.
  let forwarded: ReturnType<typeof forwardedApi> | null = null;
  const identity = new IdentityStore(() => store.nodes.self().id, options.dbPath === ':memory:' ? null : dirname(options.secretsPath));
  const peers = new PeerService({
    store,
    secrets,
    events,
    identity,
    createApp: (service) =>
      createPeerApp(service, { forwardedApi: () => forwarded, ...(options.streamTimings ? { keepaliveMs: options.streamTimings.keepaliveMs } : {}) }) as never,
    port: options.peerPort ?? DEFAULT_PEER_PORT,
    hosts: options.peerHosts && options.peerHosts.length > 0 ? options.peerHosts : ['0.0.0.0'],
    schemaVersion: SCHEMA_VERSION,
    ...(options.streamTimings ? { monitor: { idleTimeoutMs: options.streamTimings.idleTimeoutMs } } : {}),
  });
  const syncer = new Syncer({ store, secrets, blobStore, peers, events });
  peers.attachSyncer(syncer);
  // Which of this machine's own chats have a reply running, for paired
  // machines' "also active" hint (#790); told again whenever one starts or ends.
  peers.attachActivity(() => {
    const self = store.nodes.self().id;
    return [...new Set(events.runningTurns().map((t) => t.chatId))].filter((id) => store.chats.get(id)?.runsOn === self);
  });
  events.subscribe((e) => {
    if (e.type === 'turn-started' || e.type === 'turn-finished') peers.announce('activity', peers.activity());
  });

  // What close() set going without waiting, for settled().
  let sandboxClosed: Promise<void> = Promise.resolve();
  const container: Container = {
    store,
    events,
    ...(options.streamTimings ? { streamTimings: options.streamTimings } : {}),
    secrets,
    peers,
    remoteRuns: new RemoteRuns(),
    engine,
    registry,
    turnRunner,
    streamRegistry,
    toolProvider,
    sandbox,
    mcpManager,
    claudeScratchRoot,
    blobStore,
    memory,
    claudeImport,
    close: () => {
      syncer.stop();
      // Not awaited (close is synchronous): stops accepting peers' calls.
      void peers.close().catch((err: unknown) => console.error('[grunt-server] error stopping the peer listener:', err));
      // First: aborts in-flight summariser and import calls and stops new ones before the store goes away.
      claudeImport.dispose();
      memory.dispose();
      // Before the engine and store go: stops the schedule timer and its reply listeners.
      container.schedules?.dispose();
      // Claude Code processes kept alive between replies.
      engine.dispose();
      // The sandbox's agents and mounts. Not awaited, like the tool provider below (settled() waits for it). Before the store closes: it may still write its state.
      sandboxClosed = sandbox.close().catch((err: unknown) => console.error('[grunt-server] error closing the sandbox:', err));
      store.close();
      // Best-effort, not awaited: `close()` is a synchronous port method
      // used throughout the test suite without an await, and disconnecting
      // MCP clients is cleanup, not something anything downstream of
      // `close()` depends on having finished.
      void toolProvider.shutdown().catch((err: unknown) => {
        console.error('[grunt-server] error shutting down tool provider:', err);
      });
      // A `:memory:` database's write root is an ephemeral per-process temp
      // directory (resolveAttachmentsRoots) that nothing else will ever
      // reuse or clean up -- without this it accumulates forever under
      // %TEMP%/$TMPDIR across restarts and test runs (task 32 fix round 2,
      // Minor #2: confirmed 28 stray `grunt-attachments-*` directories
      // already sitting there from exactly this). Removed here, best-effort
      // and not awaited, same reasoning as `toolProvider.shutdown()` above.
      // A real file database's write root is never touched -- it's the
      // user's own attachment storage, not this process's temp scratch.
      if (roots.isTemporary) {
        void rm(roots.writeRoot, { recursive: true, force: true }).catch((err: unknown) => {
          console.error(`[grunt-server] failed to remove temporary attachments directory "${roots.writeRoot}":`, err);
        });
        // Likewise the temporary import folder, if an import ever made it.
        void rm(importRoot, { recursive: true, force: true }).catch(() => undefined);
      }
    },
    settled: () => sandboxClosed,
  };
  // Exactly once per container -- see subscribeAutoTitle's doc comment for
  // why calling it more than once would be a bug (duplicate title-gen races).
  subscribeAutoTitle(container);
  // Re-queue project chats that went quiet while the server was down (spec §2, §6).
  try {
    memory.sweep();
  } catch (err) {
    // Never let the memory sweep stop the server starting.
    console.warn('[grunt-server] project memory startup sweep failed:', err);
  }
  // Scheduled tasks: built after the memory services, started after their sweep, and
  // after the app event bus is attached to the turn runner (events.runningTurns() is
  // what tells the service a chat is busy).
  container.schedules = new ScheduleService({
    store,
    turnRunner,
    startTurn: (input) => startTurn(container, input),
    resolveProfile: (id) => resolveProfile({ store, secrets }, id),
    resolveWorkspace: (ws) => workspaceResolver(container)(ws),
    isChatBusy: (chatId) => events.runningTurns().some((t) => t.chatId === chatId),
    emit: (e) => events.emit(e),
  });
  try {
    container.schedules.start();
  } catch (err) {
    // Never let the scheduler stop the server starting.
    console.warn('[grunt-server] scheduled tasks failed to start:', err);
  }
  // Listening for paired machines only if there are any. A failed bind
  // (another Grunt on this port, say) leaves this machine working alone
  // rather than stopping it starting.
  try {
    await peers.refreshListener();
  } catch (err) {
    console.error('[grunt-server] could not start the peer listener; paired machines cannot reach this one:', err);
  }
  forwarded = forwardedApi(container);
  peers.startMonitoring();
  syncer.start();

  return container;
}
