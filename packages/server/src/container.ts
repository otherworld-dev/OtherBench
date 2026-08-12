import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { TurnRunner } from '@grunt/core/domain/turn.js';
import type { ChatEngine } from '@grunt/core/ports/chat-engine.js';
import type { SecretStore } from '@grunt/core/ports/secret-store.js';
import type { Store } from '@grunt/core/ports/store.js';
import { AiSdkChatEngine } from '@grunt/engine-aisdk/engine.js';
import { ProviderRegistry } from '@grunt/engine-aisdk/registry.js';
import { openDatabase } from '@grunt/store-sqlite/db.js';
import { runMigrations } from '@grunt/store-sqlite/migrations/index.js';
import { createSecretStore } from '@grunt/store-sqlite/secret-store.js';
import { SqliteStore } from '@grunt/store-sqlite/store.js';
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
  close(): void;
}

export interface ContainerOptions {
  dbPath: string;
  secretsPath: string;
}

function isEnoent(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as NodeJS.ErrnoException).code === 'ENOENT';
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

  const passphrase = await resolveSecretsPassphrase(options.secretsPath);
  const secrets = createSecretStore(options.secretsPath, passphrase);

  const registry = new ProviderRegistry();
  const engine = new AiSdkChatEngine(registry);
  const turnRunner = new TurnRunner(store, engine);
  const streamRegistry = new StreamRegistry(turnRunner, store);

  const container: Container = {
    store,
    secrets,
    engine,
    registry,
    turnRunner,
    streamRegistry,
    close: () => store.close(),
  };
  // Exactly once per container -- see subscribeAutoTitle's doc comment for
  // why calling it more than once would be a bug (duplicate title-gen races).
  subscribeAutoTitle(container);

  return container;
}
