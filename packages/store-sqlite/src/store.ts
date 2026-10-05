import type { DatabaseSync } from 'node:sqlite';
import type {
  AttachmentRepo,
  AuditRepo,
  ChatRepo,
  ConnectionRepo,
  GrantRepo,
  LocationRepo,
  McpServerRepo,
  MessageRepo,
  ModelRepo,
  ProfileRepo,
  ProjectMemoryRepo,
  ProjectRepo,
  SettingsRepo,
  Store,
  UsageRepo,
} from '@grunt/core/ports/store.js';
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
import { SqliteProfileRepo } from './repos/profiles.js';
import { SqliteProjectMemoryRepo } from './repos/project-memory.js';
import { SqliteProjectRepo } from './repos/projects.js';
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
  readonly connections: ConnectionRepo;
  readonly models: ModelRepo;
  readonly profiles: ProfileRepo;
  readonly chats: ChatRepo;
  readonly projects: ProjectRepo;
  readonly projectMemory: ProjectMemoryRepo;
  readonly settings: SettingsRepo;
  readonly messages: MessageRepo;
  readonly attachments: AttachmentRepo;
  readonly usage: UsageRepo;
  readonly mcpServers: McpServerRepo;
  readonly grants: GrantRepo;
  readonly audit: AuditRepo;

  constructor(private readonly db: DatabaseSync) {
    this.nodes = new SqliteNodeRepo(db);
    const selfId = () => this.nodes.selfId();
    this.locations = new SqliteLocationRepo(db);
    this.connections = new SqliteConnectionRepo(db);
    this.models = new SqliteModelRepo(db);
    this.profiles = new SqliteProfileRepo(db);
    this.chats = new SqliteChatRepo(db, selfId);
    this.projects = new SqliteProjectRepo(db, selfId);
    this.projectMemory = new SqliteProjectMemoryRepo(db);
    this.settings = new SqliteSettingsRepo(db);
    this.messages = new SqliteMessageRepo(db, selfId);
    this.attachments = new SqliteAttachmentRepo(db);
    this.usage = new SqliteUsageRepo(db);
    this.mcpServers = new SqliteMcpServerRepo(db);
    this.grants = new SqliteGrantRepo(db);
    this.audit = new SqliteAuditRepo(db);
  }

  close(): void {
    this.db.close();
  }
}
