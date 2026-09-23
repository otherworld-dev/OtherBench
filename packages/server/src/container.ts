import { randomBytes } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { PermissionBroker } from '@grunt/core/domain/permissions.js';
import { reconcileInterruptedTurns } from '@grunt/core/domain/reconcile.js';
import { TurnRunner } from '@grunt/core/domain/turn.js';
import type { ChatEngine } from '@grunt/core/ports/chat-engine.js';
import type { SecretStore } from '@grunt/core/ports/secret-store.js';
import type { Store } from '@grunt/core/ports/store.js';
import type { ToolProvider } from '@grunt/core/ports/tool-provider.js';
import { AiSdkChatEngine } from '@grunt/engine-aisdk/engine.js';
import { ProviderRegistry } from '@grunt/engine-aisdk/registry.js';
import { sweepOrphanedBlobs } from '@grunt/store-sqlite/blob-gc.js';
import { createBlobStore, resolveAttachmentsRoots, type BlobStore } from '@grunt/store-sqlite/blob-store.js';
import { openDatabase } from '@grunt/store-sqlite/db.js';
import { runMigrations } from '@grunt/store-sqlite/migrations/index.js';
import { createSecretStore } from '@grunt/store-sqlite/secret-store.js';
import { SqliteStore } from '@grunt/store-sqlite/store.js';
import { McpServerManager } from '@grunt/tools/mcp/manager.js';
import { GruntToolProvider } from '@grunt/tools/provider.js';
import { subscribeAutoTitle } from './routes/chats.js';
import { StreamRegistry } from './stream/registry.js';

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
  /** Owns live MCP server connections; `toolProvider` reads its cached tools, routes/tools.ts calls `sync()` after any write to the `mcp_server` table. */
  mcpManager: McpServerManager;
  /** Content-addressed blob storage for attachments (task 21) -- `routes/attachments.ts` writes to it on upload; `TurnRunner`'s `loadAttachment` (wired below) reads from it to embed real bytes for a vision-capable model. */
  blobStore: BlobStore;
  close(): void;
}

export interface ContainerOptions {
  dbPath: string;
  secretsPath: string;
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

/** Opens (migrating if needed) the real SQLite-backed `Container` the CLI serves from. */
export async function createContainer(options: ContainerOptions): Promise<Container> {
  if (options.dbPath !== ':memory:') {
    await mkdir(dirname(options.dbPath), { recursive: true });
  }
  const db = openDatabase(options.dbPath);
  runMigrations(db);
  const store = new SqliteStore(db);

  // A message row left `status: 'streaming'` means the process that was
  // writing it is gone -- ASSUMING a single Grunt server process per
  // database: this process's own `TurnRunner.controllers` (the only thing
  // that could still be driving one) is empty on every fresh start, so any
  // such row found here looks orphaned to it. That assumption isn't
  // enforced anywhere -- `openDatabase`'s WAL mode and `busy_timeout`
  // actively allow a second process to open the same database, and this
  // runs before the port bind, so a second launch (even one about to fail
  // with `EADDRINUSE`) can reconcile out from under a still-live first
  // process's stream, flipping its row to `error` while it's genuinely
  // streaming. The first process's own terminal `updateStatus` call
  // overwrites that with the real outcome once its stream finishes, but in
  // the window before then a client can see a false error, and a
  // same-window Retry can start a second concurrent run on the same row.
  // Reconciled synchronously, before anything else can reach the store, so
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
      `[grunt-server] legacy shared attachments directory "${roots.legacyRoot}" still exists -- it is no longer ` +
        `written to or swept. Blobs already there stay readable; new uploads for this database go to ` +
        `"${roots.writeRoot}" instead.`
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
  const engine = new AiSdkChatEngine(registry);

  const broker = new PermissionBroker(store);
  const mcpManager = new McpServerManager(store, secrets);
  const toolProvider = new GruntToolProvider(store, broker, mcpManager);
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

  const container: Container = {
    store,
    secrets,
    engine,
    registry,
    turnRunner,
    streamRegistry,
    toolProvider,
    mcpManager,
    blobStore,
    close: () => {
      store.close();
      // Best-effort, not awaited: `close()` is a synchronous port method
      // used throughout the test suite without an await, and disconnecting
      // MCP clients is cleanup, not something anything downstream of
      // `close()` depends on having finished.
      void toolProvider.shutdown().catch((err: unknown) => {
        console.error('[grunt-server] error shutting down tool provider:', err);
      });
    },
  };
  // Exactly once per container -- see subscribeAutoTitle's doc comment for
  // why calling it more than once would be a bug (duplicate title-gen races).
  subscribeAutoTitle(container);

  return container;
}
