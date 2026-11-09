import type { ConnectionRepo, ModelRepo, ProfileRepo } from './store/config.js';
import type { ChatRepo } from './store/chats.js';
import type { ProjectRepo } from './store/projects.js';
import type { AppFolderRepo, AppNotesRepo, AppRepo, IssueTickRepo } from './store/apps.js';
import type { MediaWorkflowRepo } from './store/media-workflows.js';
import type { GlobalMemoryRepo, ProjectMemoryRepo } from './store/memory.js';
import type { SettingsRepo } from './store/settings.js';
import type { MessageRepo } from './store/messages.js';
import type { AttachmentRepo } from './store/attachments.js';
import type { UsageRepo } from './store/usage.js';
import type { McpServerRepo } from './store/mcp-servers.js';
import type { AuditRepo, GrantRepo } from './store/grants.js';
import type { LocationRepo, NodeRepo, PeerRepo } from './store/machines.js';
import type { SyncRepo } from './store/sync.js';
import type { ArtifactRepo } from './store/artifacts.js';
import type { ScheduleRepo } from './store/schedules.js';
import type { RemoteSessionRepo, PushSubscriptionRepo } from './store/remote-access.js';
import type { ChatSendRepo } from './store/chat-sends.js';

export type * from './store/config.js';
export type * from './store/chats.js';
export type * from './store/projects.js';
export type * from './store/apps.js';
export type * from './store/media-workflows.js';
export type * from './store/memory.js';
export type * from './store/settings.js';
export type * from './store/messages.js';
export type * from './store/attachments.js';
export type * from './store/usage.js';
export type * from './store/mcp-servers.js';
export type * from './store/grants.js';
export type * from './store/machines.js';
export type * from './store/sync.js';
export type * from './store/artifacts.js';
export type * from './store/schedules.js';
export type * from './store/remote-access.js';
export type * from './store/chat-sends.js';

// --- store ----------------------------------------------------------------

export interface Store {
  nodes: NodeRepo;
  locations: LocationRepo;
  peers: PeerRepo;
  /** Only stores that track changes (SQLite) have it. */
  sync?: SyncRepo;
  connections: ConnectionRepo;
  models: ModelRepo;
  profiles: ProfileRepo;
  chats: ChatRepo;
  projects: ProjectRepo;
  apps: AppRepo;
  appFolders: AppFolderRepo;
  issueTicks: IssueTickRepo;
  mediaWorkflows: MediaWorkflowRepo;
  projectMemory: ProjectMemoryRepo;
  globalMemory: GlobalMemoryRepo;
  appNotes: AppNotesRepo;
  settings: SettingsRepo;
  messages: MessageRepo;
  artifacts: ArtifactRepo;
  attachments: AttachmentRepo;
  usage: UsageRepo;
  mcpServers: McpServerRepo;
  grants: GrantRepo;
  audit: AuditRepo;
  /** Scheduled tasks (spec 2026-10-12-scheduled-tasks-design): local, never synced. */
  schedules: ScheduleRepo;
  /** Remote access's signed-in browsers (migration 037): local, never synced. */
  remoteSessions: RemoteSessionRepo;
  /** Signed-in devices' Web Push subscriptions (migration 040): local, never synced, deleted with their session. */
  pushSubscriptions: PushSubscriptionRepo;
  chatSends: ChatSendRepo;
  /**
   * Runs `fn` as one unit: SQLite commits everything it writes together, or
   * rolls it all back when it throws (the error is rethrown). Inside an open
   * transaction it just runs `fn`. `fn` must be synchronous, and must not
   * save memory notes or apply sync batches, which open their own.
   * `InMemoryStore` runs `fn` with no rollback.
   */
  transaction<T>(fn: () => T): T;
  close(): void;
}
