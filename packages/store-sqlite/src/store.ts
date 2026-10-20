import type { DatabaseSync } from 'node:sqlite';
import { SqliteArtifactRepo } from './repos/artifacts.js';
import type { AttachmentRepo, AuditRepo, ChatRepo, ConnectionRepo, GrantRepo, LocationRepo, McpServerRepo, MessageRepo, PeerRepo, SyncRepo, ModelRepo, ProfileRepo, ProjectMemoryRepo, GlobalMemoryRepo, ProjectRepo, AppRepo, SettingsRepo, Store, UsageRepo, ArtifactRepo, ScheduleRepo } from '@otherbench/core/ports/store.js';
import { SqliteAttachmentRepo } from './repos/attachments.js';
import { SqliteAuditRepo } from './repos/audit.js';
import { SqliteChatRepo } from './repos/chats.js';
import { SqliteConnectionRepo } from './repos/connections.js';
import { SqliteGrantRepo } from './repos/grants.js';
import { SqliteLocationRepo } from './repos/locations.js';
import { SqliteMcpServerRepo } from './repos/mcp-servers.js';
import { SqliteMessageRepo } from './repos/messages.js';
import { SqliteModelRepo } from './repos/models.js';
import { SqliteNodeRepo } from './repos/nodes.js';
import { SqlitePeerRepo } from './repos/peers.js';
import { clockOf } from './repos/clock.js';
import { SqliteSyncRepo } from './repos/sync.js';
import { SqliteProfileRepo } from './repos/profiles.js';
import { SqliteProjectMemoryRepo } from './repos/project-memory.js';
import { SqliteGlobalMemoryRepo } from './repos/global-memory.js';
import { SqliteAppRepo } from './repos/apps.js';
import { SqliteProjectRepo } from './repos/projects.js';
import { SqliteScheduleRepo } from './repos/schedules.js';
import { SqliteSettingsRepo } from './repos/settings.js';
import { SqliteUsageRepo } from './repos/usage.js';

/**
 * The `Store` port assembled over one open SQLite connection.
 *
 * Every repo shares the single `DatabaseSync` handle deliberately: SQLite
 * allows one writer at a time, and a shared handle keeps writes serialised
 * within the process rather than contending across handles. The caller owns
 * opening (and migrating) the database; this type owns closing it.
 */
export class SqliteStore implements Store {
  readonly nodes: SqliteNodeRepo;
  readonly locations: LocationRepo;
  readonly peers: PeerRepo;
  readonly sync: SyncRepo;
  readonly connections: ConnectionRepo;
  readonly models: ModelRepo;
  readonly profiles: ProfileRepo;
  readonly chats: ChatRepo;
  readonly projects: ProjectRepo;
  readonly apps: AppRepo;
  readonly projectMemory: ProjectMemoryRepo;
  readonly globalMemory: GlobalMemoryRepo;
  readonly settings: SettingsRepo;
  readonly messages: MessageRepo;
  readonly artifacts: ArtifactRepo;
  readonly attachments: AttachmentRepo;
  readonly usage: UsageRepo;
  readonly mcpServers: McpServerRepo;
  readonly grants: GrantRepo;
  readonly audit: AuditRepo;
  readonly schedules: ScheduleRepo;

  constructor(private readonly db: DatabaseSync) {
    this.nodes = new SqliteNodeRepo(db);
    const selfId = () => this.nodes.selfId();
    // One clock for every synced table, so stamps are ordered across them.
    const clock = clockOf(db, selfId);
    this.sync = new SqliteSyncRepo(db, selfId, clock);
    this.locations = new SqliteLocationRepo(db, clock);
    this.peers = new SqlitePeerRepo(db);
    this.connections = new SqliteConnectionRepo(db, clock);
    this.models = new SqliteModelRepo(db, clock);
    this.profiles = new SqliteProfileRepo(db, clock);
    this.chats = new SqliteChatRepo(db, selfId, clock);
    this.projects = new SqliteProjectRepo(db, selfId, clock);
    this.apps = new SqliteAppRepo(db, selfId, clock);
    this.projectMemory = new SqliteProjectMemoryRepo(db, clock);
    this.globalMemory = new SqliteGlobalMemoryRepo(db, clock);
    this.settings = new SqliteSettingsRepo(db);
    this.messages = new SqliteMessageRepo(db, selfId, clock);
    this.artifacts = new SqliteArtifactRepo(db, clock);
    this.attachments = new SqliteAttachmentRepo(db, clock);
    this.usage = new SqliteUsageRepo(db, clock);
    this.mcpServers = new SqliteMcpServerRepo(db);
    this.grants = new SqliteGrantRepo(db);
    this.audit = new SqliteAuditRepo(db, selfId);
    this.schedules = new SqliteScheduleRepo(db);
  }

  transaction<T>(fn: () => T): T {
    if (this.db.isTransaction) return fn();
    this.db.exec('BEGIN');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      // SQLite may have rolled back already (a full disk, an I/O error): a second ROLLBACK would hide `err`.
      if (this.db.isTransaction) this.db.exec('ROLLBACK');
      throw err;
    }
  }

  close(): void {
    this.db.close();
  }
}
