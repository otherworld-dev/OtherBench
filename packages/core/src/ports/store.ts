import type { CanonMessage, EngineMeta, MessageStatus, Part, SerializedError, SubagentStatus } from '../types/messages.js';
import type { ClaudeEffort, Connection, ModelInfo, Profile, ToolSource } from '../types/config.js';
import type { PricingSnapshot } from '../types/usage.js';
import type { ExtraFolder, FolderView, Location, LocationPath, NodeInfo, Workspace, WorkspaceStatus } from '../types/workspace.js';
import type { MediaWorkflow } from '../domain/media-workflows.js';
import type { ChatHead } from '../types/overview.js';
import type { Peer } from '../types/peer.js';
import type { ChangeBatch, ChangeRow } from '../domain/sync.js';
import type { ScheduleRule, ScheduleRunStatus, ScheduleTarget, ScheduleTrigger } from '../domain/schedule.js';

// --- connections ---------------------------------------------------------

export interface ConnectionRepo {
  create(c: Connection): Connection;
  get(id: string): Connection | null;
  list(): Connection[];
  update(id: string, patch: Partial<Omit<Connection, 'id'>>): Connection;
  delete(id: string): void;
}

// --- models ----------------------------------------------------------------

export interface ModelRepo {
  create(m: ModelInfo): ModelInfo;
  get(id: string): ModelInfo | null;
  list(connectionId?: string): ModelInfo[];
  update(id: string, patch: Partial<Omit<ModelInfo, 'id'>>): ModelInfo;
  delete(id: string): void;
}

// --- profiles ----------------------------------------------------------------

export interface ProfileRepo {
  create(p: Profile): Profile;
  get(id: string): Profile | null;
  list(): Profile[];
  update(id: string, patch: Partial<Omit<Profile, 'id'>>): Profile;
  delete(id: string): void;
}

// --- chats ----------------------------------------------------------------

export interface Chat {
  id: string;
  title: string;
  profileId: string;
  headMessageId: string | null;
  /** The chat's folder, portable across machines (v2 spec §6); null for none. */
  workspace: Workspace | null;
  /** The machine (node id) this chat's turns run on: its folder, tools and node-bound models. */
  runsOn: string;
  /**
   * API only: the folder on THIS machine, resolved from `workspace` (null when
   * there is none or it doesn't resolve here), and why it did or didn't
   * resolve. The server fills both on every chat it returns
   * (server/src/workspace-view.ts); the store never does, so server code
   * must resolve `workspace` itself.
   */
  workspaceRoot?: string | null;
  workspaceStatus?: WorkspaceStatus;
  /**
   * Folders the chat may use besides its workspace (spec 2026-10-07-extra-folders),
   * on top of its project's; absent means none. `folderViews` is API only:
   * each of them resolved on the machine that runs the chat.
   */
  folders?: ExtraFolder[];
  folderViews?: FolderView[];
  pinned: boolean;
  /**
   * Kept at the top of its own project's group in the sidebar (spec
   * 2026-10-11-sidebar-layout-design §5), separate from `pinned`. Cleared
   * when the chat changes project, unless the same update sets it.
   */
  projectPinned: boolean;
  /**
   * A reply finished (or failed) here that the user hasn't had on screen
   * since: the sidebar marks the chat. Set by the server when a turn ends
   * complete or in error, cleared by the client once the chat is shown.
   */
  unread: boolean;
  /**
   * When the user ticked this chat off on the Overview ("dealt with"); it
   * needs them again only once a newer reply arrives. Absent is null.
   */
  dealtWithAt?: number | null;
  archivedAt: number | null;
  /**
   * Claude Code auto mode for this chat's turns (spec
   * 2026-10-03-claude-code-auto-mode-design): Claude Code's classifier decides
   * routine tool calls instead of an OtherBench card. Off by default; read fresh by
   * TurnRunner on every turn. Other engines ignore it.
   */
  autoMode: boolean;
  /**
   * Plan mode (spec 2026-10-12-thread-cards-design §4): every new message
   * plans first; tools that change things are refused until the user approves
   * the reply's plan. Read fresh by TurnRunner on every reply. Repositories
   * always fill it (false by default); optional only so older objects type-check.
   */
  planMode?: boolean;
  /**
   * Claude Code's effort for this chat's turns, chosen in the chat window;
   * absent or null follows the user's Claude Code settings. Read fresh by
   * TurnRunner on every turn, so a change applies from the next message.
   * Other engines ignore it.
   */
  effort?: ClaudeEffort | null;
  /**
   * The project this chat is filed under, or null for "No project" (spec
   * 2026-10-03-projects-design). Purely organisational: moving a chat never
   * changes its folder or profile. Set to null when the project is deleted.
   */
  projectId: string | null;
  /**
   * The app this chat is filed under in Code mode (spec 2026-10-20-code-tab-design), or null. A chat has an app or a
   * project, never both. Not a foreign key (sync order, migration 029): `AppRepo.delete` clears it.
   */
  appId: string | null;
  /**
   * Project memory (spec 2026-10-03-project-memory-design §1): the id of the
   * last message already folded into the project's note, or null when none
   * has been. `ChatRepo.update` resets it whenever `projectId` changes.
   */
  memoryCursor: string | null;
  /**
   * "Don't add to memory": the summariser folds this chat into neither its
   * project's note nor the global note (spec 2026-10-08-global-memory-design).
   * It still receives both.
   */
  memoryExcluded: boolean;
  /**
   * Global memory: the id of the last message already folded into the global
   * note, or null (also when absent) when none has been. Unlike `memoryCursor`
   * it survives a move between projects.
   */
  globalMemoryCursor?: string | null;
  /**
   * The chat's place in its sidebar section, higher first (#823). Set by
   * dragging or Move up/down; chat activity never changes it. Defaults to
   * `createdAt`, so a new chat lands at the top.
   */
  sortOrder: number;
  createdAt: number;
  updatedAt: number;
}

/**
 * What `ChatRepo.create` takes: timestamps default to now, `sortOrder` to
 * `createdAt`, `autoMode` and `memoryExcluded` to false, `projectId` and
 * `memoryCursor` to null, `runsOn` to this machine. `workspace` defaults to
 * null; a bare `workspaceRoot` is still accepted and stored as a folder
 * bound to this machine (callers that know about locations classify first).
 */
export type NewChat = Omit<
  Chat,
  'createdAt' | 'updatedAt' | 'autoMode' | 'projectId' | 'appId' | 'projectPinned' | 'unread' | 'memoryCursor' | 'memoryExcluded' | 'sortOrder' | 'workspace' | 'runsOn' | 'workspaceRoot' | 'workspaceStatus'
> & {
  workspace?: Workspace | null;
  workspaceRoot?: string | null;
  runsOn?: string;
  sortOrder?: number;
  createdAt?: number;
  updatedAt?: number;
  autoMode?: boolean;
  projectId?: string | null;
  appId?: string | null;
  memoryCursor?: string | null;
  memoryExcluded?: boolean;
  projectPinned?: boolean;
  unread?: boolean;
};

export interface ChatRepo {
  create(c: NewChat): Chat;
  get(id: string): Chat | null;
  list(): Chat[];
  /**
   * A patch that changes `projectId` also sets `memoryCursor: null`: the chat
   * starts over in its new project's memory. It also clears `projectPinned`,
   * unless the patch sets that too. A `workspaceRoot` in the patch
   * (and no `workspace`) is stored as a folder bound to this machine.
   */
  update(id: string, patch: Partial<Omit<Chat, 'id'>>): Chat;
  delete(id: string): void;
}

// --- projects ----------------------------------------------------------------

/**
 * A sidebar group of chats that can carry a workspace folder and a default
 * profile (spec 2026-10-03-projects-design). Both are copied onto a chat only
 * when it is created in the project; changing them later never touches
 * existing chats.
 */
export interface Project {
  id: string;
  name: string;
  /**
   * A line about the project, shown in the Inspector and, cut to 120 characters, in the project index
   * every chat with global memory gets (spec 2026-10-08-global-memory-design §1).
   */
  description: string;
  /** Added to the system prompt of every chat in the project, as the user's instructions (spec 2026-10-08-project-page-design §2). */
  instructions: string;
  /** The default folder for new chats, portable across machines like `Chat.workspace`. */
  workspace: Workspace | null;
  /** API only, as on `Chat`: `workspace` resolved on this machine, filled by the server. */
  workspaceRoot?: string | null;
  workspaceStatus?: WorkspaceStatus;
  /** Extra folders every chat in the project may use, as on `Chat`; `folderViews` is API only, resolved on this machine. */
  folders?: ExtraFolder[];
  folderViews?: FolderView[];
  /** Cleared (null) when that profile is archived (by the profiles route) or deleted (by the foreign key's ON DELETE SET NULL). */
  defaultProfileId: string | null;
  /**
   * The project this one is a sub-project of (spec 2026-10-15-sub-projects-design); absent or null for a top-level
   * project. The store always fills it. Not trusted on read: a synced row can name a missing or nested parent, so
   * read it through `projectParentOf` (domain/projects.ts).
   */
  parentId?: string | null;
  /** Ascending; ties break by name (ASCII case-insensitive), then id -- see `compareProjects`. */
  sortOrder: number;
  createdAt: number;
  updatedAt: number;
}

/** What `ProjectRepo.create` takes: timestamps default to now, `sortOrder` to 0; `workspace` and a bare `workspaceRoot` as on `NewChat`. */
export type NewProject = Omit<Project, 'createdAt' | 'updatedAt' | 'sortOrder' | 'workspace' | 'workspaceRoot' | 'workspaceStatus' | 'description' | 'instructions'> & {
  workspace?: Workspace | null;
  workspaceRoot?: string | null;
  sortOrder?: number;
  createdAt?: number;
  updatedAt?: number;
  /** Default ''. */
  description?: string;
  /** Default ''. */
  instructions?: string;
};

export interface ProjectRepo {
  create(p: NewProject): Project;
  get(id: string): Project | null;
  /** Every project, in sidebar order (`compareProjects`). */
  list(): Project[];
  /** A `workspaceRoot` in the patch (and no `workspace`) is stored as a folder bound to this machine. */
  update(id: string, patch: Partial<Omit<Project, 'id'>>): Project;
  /**
   * Deletes the project and its memory note and versions. Its chats move to
   * no project (`projectId: null`, `memoryCursor: null`); chats are never deleted.
   */
  delete(id: string): void;
}

// --- apps ----------------------------------------------------------------------

/**
 * A codebase the Code tab works on (spec 2026-10-20-code-tab-design, "Data"): a folder, optionally the GitHub repo
 * it came from, and optionally a project whose memory and instructions its chats borrow. Chats filed under an app
 * carry `appId`; a chat has an app or a project, never both.
 */
export interface App {
  id: string;
  name: string;
  /** The app's folder, portable across machines like `Project.workspace`. Unlike a project it has no extra folders: those come only from the linked project. */
  workspace: Workspace | null;
  /** API only, as on `Project`: `workspace` resolved on this machine, filled by the server. */
  workspaceRoot?: string | null;
  workspaceStatus?: WorkspaceStatus;
  /** "owner/name" on GitHub, or null. */
  githubRepo: string | null;
  /** Not trusted on read: a synced row can name a project that is missing here, and the column is not a foreign key (migration 029). */
  linkedProjectId: string | null;
  /** Cleared (null) when that profile is archived (by the profiles route) or deleted (by the foreign key's ON DELETE SET NULL). */
  defaultProfileId: string | null;
  /** The app's Nextcloud Deck board (numeric id), or null. */
  deckBoardId: number | null;
  /** The Collectives collective holding the app's wiki page, or null. */
  wikiCollective: string | null;
  /** Slash-separated page path within that collective, or null. */
  wikiPagePath: string | null;
  /** The Nextcloud Bookmarks tag that marks the app's links, or null. */
  bookmarkTag: string | null;
  /** The Code sidebar folder this app is in, or null for the top level. Not trusted on read: not a foreign key (migration 032), so a synced row can name a folder that is missing here, which shows as none. */
  folderId: string | null;
  /** Ascending; ties break by name (ASCII case-insensitive), then id -- see `compareApps`. */
  sortOrder: number;
  createdAt: number;
  updatedAt: number;
}

/** What `AppRepo.create` takes: timestamps default to now, `sortOrder` to 0, the links to null; `workspace` and a bare `workspaceRoot` as on `NewProject`. */
export type NewApp = Omit<
  App,
  'createdAt' | 'updatedAt' | 'sortOrder' | 'workspace' | 'workspaceRoot' | 'workspaceStatus' | 'githubRepo' | 'linkedProjectId' | 'defaultProfileId' | 'deckBoardId' | 'wikiCollective' | 'wikiPagePath' | 'bookmarkTag' | 'folderId'
> & {
  workspace?: Workspace | null;
  workspaceRoot?: string | null;
  githubRepo?: string | null;
  linkedProjectId?: string | null;
  defaultProfileId?: string | null;
  deckBoardId?: number | null;
  wikiCollective?: string | null;
  wikiPagePath?: string | null;
  bookmarkTag?: string | null;
  folderId?: string | null;
  sortOrder?: number;
  createdAt?: number;
  updatedAt?: number;
};

export interface AppRepo {
  create(a: NewApp): App;
  get(id: string): App | null;
  /** Every app, in sidebar order (`compareApps`). */
  list(): App[];
  /** A `workspaceRoot` in the patch (and no `workspace`) is stored as a folder bound to this machine. */
  update(id: string, patch: Partial<Omit<App, 'id'>>): App;
  /** Deletes the app. Its chats keep existing with `appId: null` (cleared through the chat repo so the change syncs); chats are never deleted. */
  delete(id: string): void;
}

// --- app folders -------------------------------------------------------------

/** A folder in the Code sidebar that groups apps (migration 032); one level, a synced table. */
export interface AppFolder {
  id: string;
  name: string;
  /** Ascending; ties break by name (ASCII case-insensitive), then id -- see `compareAppFolders`. */
  sortOrder: number;
  createdAt: number;
  updatedAt: number;
}

/** What `AppFolderRepo.create` takes: `sortOrder` defaults to 0, timestamps to now. */
export type NewAppFolder = { id: string; name: string; sortOrder?: number };

export interface AppFolderRepo {
  create(f: NewAppFolder): AppFolder;
  get(id: string): AppFolder | null;
  /** Every folder, in sidebar order (`compareAppFolders`). */
  list(): AppFolder[];
  update(id: string, patch: Partial<Pick<AppFolder, 'name' | 'sortOrder'>>): AppFolder;
  /** Deletes the folder. Its apps keep existing with `folderId: null` (cleared through the app repo so the change syncs); apps are never deleted. */
  delete(id: string): void;
}

// --- issue ticks -------------------------------------------------------------

/** How far the user has ticked a GitHub issue off in an app (migration 033); a synced table. */
export interface IssueTick {
  appId: string;
  number: number;
  /** ISO time of the issue activity ticked through. */
  through: string;
  updatedAt: number;
}

export interface IssueTickRepo {
  list(): IssueTick[];
  /** Upserts the tick for the issue; a later `through` replaces an earlier one. */
  set(appId: string, number: number, through: string): IssueTick;
  /** Deletes every tick of the app; each delete syncs as a tombstone. */
  deleteForApp(appId: string): void;
}

// --- media workflows ---------------------------------------------------------

/** Imported ComfyUI workflows (migration 031); a synced table. Stored rows are never `builtin`. */
export interface MediaWorkflowRepo {
  list(): MediaWorkflow[];
  get(id: string): MediaWorkflow | null;
  create(wf: MediaWorkflow): MediaWorkflow;
  update(id: string, patch: Partial<Omit<MediaWorkflow, 'id' | 'builtin'>>): MediaWorkflow;
  delete(id: string): void;
}

// --- project memory -----------------------------------------------------------

/** Who wrote a version of a project's memory note. */
export type MemoryAuthor = 'user' | 'summariser';

/**
 * A project's current memory note (spec 2026-10-03-project-memory-design §1).
 * `body` is markdown with the five fixed headings (`MEMORY_HEADINGS`).
 * `sourceChatId` is the chat the summariser folded in last, null for a user
 * save. A project that was never saved reads as `emptyProjectMemory()`
 * (`updatedAt: 0`).
 */
export interface ProjectMemory {
  projectId: string;
  body: string;
  updatedAt: number;
  updatedBy: MemoryAuthor;
  sourceChatId: string | null;
}

/** One saved version of a project's note; every save adds one. */
export interface ProjectMemoryVersion {
  id: string;
  projectId: string;
  body: string;
  createdAt: number;
  createdBy: MemoryAuthor;
  sourceChatId: string | null;
}

export interface ProjectMemoryRepo {
  /** The project's current note, or null if it has never been saved. */
  get(projectId: string): ProjectMemory | null;
  /**
   * Replaces the project's note, records it as a new version, and prunes the
   * project's versions beyond the newest `MEMORY_VERSIONS_KEPT` (ties on
   * `createdAt` break by save order). `at` defaults to now. Throws for a
   * project that doesn't exist.
   */
  save(projectId: string, body: string, by: MemoryAuthor, sourceChatId: string | null, at?: number): ProjectMemory;
  /** The project's versions, newest first. */
  versions(projectId: string): ProjectMemoryVersion[];
  version(id: string): ProjectMemoryVersion | null;
}

// --- global memory -----------------------------------------------------------------

/**
 * The user's global memory (spec 2026-10-08-global-memory-design): About you,
 * which the user writes, and the learned note the summariser keeps, each with
 * its last save. Never saved reads as '' with `*UpdatedAt: 0`.
 */
export interface GlobalMemory {
  about: string;
  aboutUpdatedAt: number;
  note: string;
  noteUpdatedAt: number;
  noteUpdatedBy: MemoryAuthor;
  noteSourceChatId: string | null;
}

/** One saved version of the learned note; every note save adds one. */
export interface GlobalMemoryVersion {
  id: string;
  body: string;
  createdAt: number;
  createdBy: MemoryAuthor;
  sourceChatId: string | null;
}

export interface GlobalMemoryRepo {
  get(): GlobalMemory;
  /** Replaces About you. `at` defaults to now. */
  saveAbout(about: string, at?: number): GlobalMemory;
  /** Replaces the learned note and records a version, keeping the newest `MEMORY_VERSIONS_KEPT`. `at` defaults to now. */
  saveNote(body: string, by: MemoryAuthor, sourceChatId: string | null, at?: number): GlobalMemory;
  /** The note's versions, newest first. */
  versions(): GlobalMemoryVersion[];
  version(id: string): GlobalMemoryVersion | null;
}

// --- app settings ----------------------------------------------------------------

/** App-wide settings (one set per database). Defaults: `DEFAULT_APP_SETTINGS`. */
export interface AppSettings {
  /** The profile both memory summarisers run on; null = the project's default profile (project notes), then the app default. */
  memoryProfileId: string | null;
}

export interface SettingsRepo {
  get(): AppSettings;
  /** Applies the keys `patch` defines and returns the full settings. */
  update(patch: Partial<AppSettings>): AppSettings;
  /**
   * A machine-local value kept beside the settings (the same `app_setting`
   * table, never synced and never in `get()`), e.g. the sandbox's state
   * (key `sandbox`). Null when unset or unreadable.
   */
  getValue(key: string): unknown;
  /** Stores `value` as JSON under `key`; null removes it. Throws for an AppSettings key, which `update()` owns. */
  setValue(key: string, value: unknown): void;
}

// --- messages ----------------------------------------------------------------

export interface MessageRepo {
  create(m: Omit<CanonMessage, 'createdAt'> & { createdAt?: number }): CanonMessage;
  get(id: string): CanonMessage | null;
  children(parentId: string): CanonMessage[];
  roots(chatId: string): CanonMessage[];
  pathToRoot(messageId: string): CanonMessage[];   // ordered root -> leaf
  /** A streaming reply's checkpoint: not a change paired machines are sent (the reply is sent once it finishes). */
  updateParts(id: string, parts: Part[]): void;
  /**
   * Changes a finished message's parts as a change paired machines are sent,
   * unlike `updateParts`: a background helper's card in an earlier reply
   * brought up to date, or closed at startup. Throws when the id does not exist.
   */
  reviseParts(id: string, parts: Part[]): void;
  updateStatus(id: string, status: MessageStatus, error?: SerializedError | null): void;
  /** Messages with every word of `query` in their text, best match first; `offset` skips that many, to page through. */
  searchText(query: string, limit: number, offset?: number): { messageId: string; chatId: string; snippet: string }[];
  /**
   * The chats with a message matching `query` (every word in one message, as
   * `searchText`), each once, best match first. The sidebar's search: unlike
   * `searchText`, one long chat can't use up the whole `limit`.
   */
  searchChats(query: string, limit: number): string[];
  /**
   * Every message across every chat currently at `status`, in no particular
   * order. Exists for startup reconciliation (see
   * `domain/reconcile.ts`'s `reconcileInterruptedTurns`), which needs to
   * find every orphaned `streaming` row without walking each chat's message
   * tree one at a time via `roots`/`children`.
   */
  listByStatus(status: MessageStatus): CanonMessage[];
  /**
   * Every message across every chat, at any status, with a top-level
   * `subagent` card at `status`, in no particular order. For startup
   * reconciliation too: a helper card left 'background' by a process that
   * died, found without reading every finished message.
   */
  listWithSubagentStatus(status: SubagentStatus): CanonMessage[];
  /** One row per non-archived chat that has a head message: the tip of the current branch (newest message at or below the head, by time then id): its role, status and time. For the Overview. */
  heads(): ChatHead[];
  /** Stores engine-owned state on a message. Throws when the id does not exist. */
  updateEngineMeta(id: string, meta: EngineMeta): void;
  /** The newest message in `chatId` whose `engineMeta.sessionId` is `sessionId` (by createdAt, then id), or null. */
  latestBySession(chatId: string, sessionId: string): CanonMessage | null;
  /** The id of the newest message in `chatId` (by createdAt, then id), or null: lets the memory sweeps skip an up-to-date chat without reading it. */
  latestId(chatId: string): string | null;
  /** Records that the user kept this compare variant at `at` (see `CanonMessage.keptAt`). Throws when the id does not exist. */
  markKept(id: string, at: number): void;
}

// --- attachments ----------------------------------------------------------------

export interface Attachment {
  id: string;
  chatId: string;
  messageId: string | null;
  filename: string;
  mime: string;
  size: number;
  sha256: string;
  storagePath: string;
  extractedText: string | null;
}

export interface AttachmentRepo {
  create(a: Attachment): Attachment;
  get(id: string): Attachment | null;
  list(chatId: string): Attachment[];
  update(id: string, patch: Partial<Omit<Attachment, 'id'>>): Attachment;
  delete(id: string): void;
  /**
   * True if at least one attachment row (in any chat -- upload dedupes by
   * content hash, so the same blob can be referenced from several chats,
   * see `BlobStore`) still has this sha256. Used by the blob GC sweep
   * (`@otherbench/store-sqlite/blob-gc.js`) to decide whether a blob on disk is
   * garbage: a blob is only ever removed once nothing references it.
   */
  isReferenced(sha256: string): boolean;
  /**
   * Every distinct sha256 referenced by at least one attachment row, across
   * every chat. Used by the startup blob sweep, which walks what is
   * physically on disk and needs the full referenced set to diff against --
   * see `@otherbench/store-sqlite/blob-gc.js`'s `sweepOrphanedBlobs`.
   */
  referencedShas(): Set<string>;
}

/**
 * The subset of `Attachment` ever serialised to a client (task 32 decision
 * #3): `storagePath` is a raw SERVER filesystem path -- the client has no
 * use for it (attachment bytes are always fetched via
 * `GET /attachments/:id/content`, never a filesystem path) and it should
 * never leave the server. `storagePath` stays on the full `Attachment` type
 * (and in the database) because the server itself needs it (`BlobStore.get`/
 * `remove`); every route response strips it down to this shape instead --
 * see `routes/attachments.ts`'s `toPublicAttachment`. The web client's own
 * `Attachment`-shaped state should be typed as this, not the full row, since
 * this is all it will ever actually receive.
 */
export type PublicAttachment = Omit<Attachment, 'storagePath'>;

// --- usage ----------------------------------------------------------------

export type UsagePurpose = 'title' | 'memory';

export interface UsageRecord {
  id: string;
  chatId: string;
  messageId: string;
  profileId: string;
  connectionId: string;
  modelId: string;
  tokensIn: number;
  tokensOut: number;
  tokensCached: number;
  /** Input tokens written to the provider's prompt cache (`Usage.tokensCacheWrite`). */
  tokensCacheWrite?: number;
  tokensReasoning: number;
  costEstimate: number | null;
  pricingSnapshot: PricingSnapshot;
  latencyMs: number;
  /**
   * Set on the row of a call OtherBench made by itself about a reply: naming
   * the chat after it (`title`), or folding it into project or global memory
   * (`memory`). The row hangs off that reply (`messageId`) but carries the
   * profile that made the call. Absent on a reply's own row.
   */
  purpose?: UsagePurpose;
  /**
   * Set on a sub-agent's own usage row (spec 2026-10-12-api-subagents-design):
   * the parent's `subagent` tool call id. The row hangs off the parent reply
   * (`messageId`) but carries the sub-agent's profile, connection and model.
   */
  subagentCallId?: string;
}

export interface UsageRepo {
  create(u: UsageRecord): UsageRecord;
  get(id: string): UsageRecord | null;
  list(chatId: string): UsageRecord[];
  update(id: string, patch: Partial<Omit<UsageRecord, 'id'>>): UsageRecord;
  delete(id: string): void;
}

// --- mcp servers ----------------------------------------------------------------

/**
 * An http MCP server's sign-in summary (spec 2026-10-12-mcp-oauth-design §2).
 * Never a token or a secret value: tokens, registered clients and a
 * hand-registered client's secret live in `SecretStore` under
 * `mcp:<id>:oauth:*` (`McpOAuthStore`, packages/tools/src/mcp/oauth-store.ts).
 */
export interface McpServerOAuth {
  /** A client ID registered by hand with the server's sign-in provider. Null: OtherBench registers itself. */
  clientId: string | null;
  /** SecretStore reference of that client's secret, if it has one. Never the value. */
  clientSecretRef: string | null;
  /** "Signed in as …": from the provider's id_token, when it sends one. Display only. */
  account: string | null;
  /** When the current sign-in completed (ms). Null: not signed in. */
  signedInAt: number | null;
}

export interface McpServer {
  id: string;
  name: string;
  transport: 'stdio' | 'http';
  command: string | null;
  args: string[];
  /**
   * `SecretStore` references, keyed by env var name -- NOT plaintext values.
   * A stdio server's environment variables are exactly as likely to carry a
   * credential as an HTTP server's headers (`headerRefs`, right below), so
   * this follows the identical "never plaintext at rest" discipline
   * `Connection.secretRef` established: the route layer
   * (routes/tools.ts) writes each value to `SecretStore` and persists only
   * the resulting reference here. Resolved back to real values only at
   * connect time (`McpServerManager.resolveTransportConfig`).
   */
  envRefs: Record<string, string>;
  url: string | null;
  headerRefs: Record<string, string>;
  enabled: boolean;
  status: 'unknown' | 'ok' | 'error';
  toolsCache: unknown;
  /** Null for stdio servers and for http servers that never signed in or set a client ID. */
  oauth: McpServerOAuth | null;
}

export interface McpServerRepo {
  create(s: McpServer): McpServer;
  get(id: string): McpServer | null;
  list(): McpServer[];
  update(id: string, patch: Partial<Omit<McpServer, 'id'>>): McpServer;
  delete(id: string): void;
}

// --- grants ----------------------------------------------------------------

export interface Grant {
  id: string;
  chatId: string | null;
  /**
   * The profile the grant was made under, or `null` for a grant that is
   * deliberately not profile-scoped. `PermissionBroker` always stamps the
   * calling profile's id here; `null` matches every profile and exists only
   * for grants created outside the broker (fixtures, hand-written rows).
   */
  profileId: string | null;
  toolName: string;
  /**
   * The `ToolSpec.source` of the tool this grant was made for. Matched
   * alongside `toolName`, never instead of it: keying on the name alone let
   * a tool from one source (say, one an MCP server chose to call
   * `run_command`) obtain a grant that a completely different tool with the
   * same name then satisfied.
   */
  source: ToolSource;
  scope: 'once' | 'chat' | 'always';
  /**
   * Narrows what the grant authorises. `null` means "no narrowing" -- only
   * ever valid for non-shell tools; `PermissionBroker` refuses to create an
   * unconstrained grant of any scope for the shell.
   *
   * - `pathPrefix`: matched against the RESOLVED path (`containPath`), not
   *   the raw argument, so `..` cannot walk out of the granted subtree.
   * - `commandPrefix`: argv-prefix match, no shell metacharacters. Broad --
   *   see `commandPrefixMatches` in domain/permissions.ts for exactly how
   *   broad, and why.
   * - `commandExact`: the command must equal this string exactly (modulo
   *   surrounding whitespace). What a `'chat'`-scope shell approval is
   *   stored as.
   * - `host`: one host, for a `sandbox_network` grant (`source: 'network'`)
   *   or a browser grant (`source: 'browser'`, spec
   *   2026-10-12-model-browser-design): exact on the canonical spelling (so
   *   case-insensitive), any port, never a subdomain. Every network and
   *   browser grant carries one; one without never matches. The grant's
   *   source is part of the match: a browser grant never covers the sandbox's
   *   network, and a network grant never covers the browser.
   *
   * - `live`: a live artifact's call (spec 2026-10-12-live-artifacts): only
   *   `PermissionBroker.grantLive` makes one, only a live call
   *   (`ToolContext.live`) can match it, and it matches nothing else.
   *   `serverId` is the MCP server the tool came from when it was allowed,
   *   so a server renamed or replaced into the tool's name doesn't inherit
   *   it. Grants stored before it existed have none and never match.
   *
   * - `app`: computer use's target app (`source: 'computer'`, spec
   *   2026-10-12-computer-use-design): its key, the program's canonical
   *   path exactly as the desktop shell resolved it (`appKey`,
   *   domain/computer-apps.ts, checks it and never changes it). Matched with
   *   `===`, never by name, case-folding or prefix, so `Downloads\EXCEL.EXE`
   *   can't ride on Excel's grant. A stored value that isn't a valid key
   *   matches nothing. A grant of one source never covers another: an `app`
   *   is only ever matched for a computer call, a `host` only for a network
   *   or browser call.
   *
   * Persisted as a JSON blob (`"constraint"` TEXT), so adding a key here
   * needs no migration.
   */
  constraint: {
    pathPrefix?: string;
    commandPrefix?: string;
    commandExact?: string;
    host?: string;
    app?: string;
    live?: { artifactId: string; callId: string; hash: string; serverId: string };
  } | null;
  expiresAt: number | null;
}

export interface GrantRepo {
  create(g: Grant): Grant;
  get(id: string): Grant | null;
  list(chatId?: string): Grant[];
  update(id: string, patch: Partial<Omit<Grant, 'id'>>): Grant;
  delete(id: string): void;
}

// --- audit ----------------------------------------------------------------

export interface AuditEntry {
  id: string;
  chatId: string;
  messageId: string;
  toolName: string;
  argsRedacted: unknown;
  resultSummary: string;
  durationMs: number;
  grantedBy: string;
  /** The machine the decision was made on (v2 spec §3): this one unless approved from a paired machine. Filled in by the store when not given. */
  decidedOnNode?: string;
  createdAt: number;
}

export interface AuditRepo {
  create(a: Omit<AuditEntry, 'createdAt'> & { createdAt?: number }): AuditEntry;
  get(id: string): AuditEntry | null;
  list(chatId: string): AuditEntry[];
  update(id: string, patch: Partial<Omit<AuditEntry, 'id'>>): AuditEntry;
  delete(id: string): void;
}

// --- store ----------------------------------------------------------------

// --- machines and locations (v2 spec §6) ------------------------------------

export interface NodeRepo {
  /** This machine: created once, with a random id, when the database is first opened. */
  self(): NodeInfo;
  rename(name: string): NodeInfo;
}

export interface LocationRepo {
  list(): Location[];
  get(id: string): Location | null;
  create(l: Location): Location;
  update(id: string, patch: Partial<Omit<Location, 'id'>>): Location;
  /** Also removes its paths; chats using it lose their folder (ON DELETE SET NULL). */
  delete(id: string): void;
  /** Every machine's path for every location. */
  allPaths(): LocationPath[];
  paths(locationId: string): LocationPath[];
  pathsForNode(nodeId: string): LocationPath[];
  /** Creates or replaces `nodeId`'s path for the location. */
  setPath(p: LocationPath): LocationPath;
  deletePath(locationId: string, nodeId: string): void;
}

/** Paired machines (v2 spec §3). Never synced. */
export interface PeerRepo {
  list(): Peer[];
  get(nodeId: string): Peer | null;
  getByFingerprint(fingerprint: string): Peer | null;
  /** A second peer with the same node id or fingerprint throws. */
  create(p: Peer): Peer;
  update(nodeId: string, patch: Partial<Omit<Peer, 'nodeId'>>): Peer;
  delete(nodeId: string): void;
}

export interface SyncApplyResult {
  applied: number;
  skipped: number;
  /** Attachments written by this batch, whose blobs may need fetching. */
  attachments: { id: string; sha256: string }[];
  /** Every row written (connections among them have secrets to store). */
  written: { tbl: string; id: string }[];
}

/**
 * Change tracking and applying other machines' changes (v2 plan, Tasks
 * 49-50). Implemented by the SQLite store only, where triggers keep the
 * change log; the in-memory fake has none.
 */
export interface SyncRepo {
  /** The current state of each row changed after `since` (at most `limit` rows), oldest change first; rows that never leave this machine are left out. */
  changesSince(since: number, limit: number): ChangeBatch;
  /** Applies a batch from another machine in one transaction; `observe` sees every stamp so local stamps stay later. */
  apply(rows: ChangeRow[], observe?: (hlc: string) => void): SyncApplyResult;
  /** The newest change-log position. */
  latestSeq(): number;
  /** Where an attachment's blob is on this machine, recorded without counting as a change. */
  setStoragePath(attachmentId: string, path: string): void;
  /** Attachments that came from another machine whose blob isn't here yet. */
  missingBlobs(): { id: string; sha256: string; size: number }[];
  /** Whether a blob belongs to a file that has been sent in a message (only those leave this machine). */
  isSentBlob(sha256: string): boolean;
  /** Observes a stamp from another machine (its clock runs ahead, say). */
  observe(hlc: string): void;
}

/**
 * A value a live artifact's page may choose for one of its calls (spec
 * 2026-10-12-live-artifacts): one of a fixed list, or a whole number in a
 * range. Never free text.
 */
export type LiveParam =
  | { enum: (string | number | boolean)[]; default: string | number | boolean }
  | { type: 'integer'; minimum: number; maximum: number; default: number };

/**
 * One data call a live html artifact declares: a read-only MCP tool
 * (`mcp__<server>__<tool>`) with fixed arguments, where an argument that is
 * exactly `{ "$param": name }` takes that parameter's value.
 */
export interface LiveCall {
  id: string;
  tool: string;
  args: Record<string, unknown>;
  params: Record<string, LiveParam>;
}

/** The data calls an html artifact version declares; see `parseLiveSpec`. */
export interface LiveSpec {
  calls: LiveCall[];
}

/** What an artifact is (Deck #896): a web page, a Markdown document, a Mermaid or SVG diagram, a code file, or (Deck #928) a Word document, Excel spreadsheet or PowerPoint deck made from Markdown or JSON. */
export type ArtifactKind = 'html' | 'markdown' | 'mermaid' | 'svg' | 'code' | 'document' | 'spreadsheet' | 'presentation';

/** Standalone content the model made in a chat (spec 2026-10-07-artifacts); its content lives in its versions. */
export interface Artifact {
  id: string;
  chatId: string;
  /** The short id the model and the UI use; unique within the chat. */
  slug: string;
  kind: ArtifactKind;
  /** For `code`: its language, e.g. `ts`, `py`. */
  language: string | null;
  createdAt: number;
}

/** One version of an artifact; never changed once written. */
export interface ArtifactVersion {
  id: string;
  artifactId: string;
  /** 1, 2, … in the order made, across every branch. */
  number: number;
  title: string;
  content: string;
  /** This version's kind: a rewrite may change it (a note made into a page), so the artifact's own kind is only the one it was created as. */
  kind: ArtifactKind;
  /** A code version's language (ts, py), else null. */
  language: string | null;
  /**
   * The data calls this version's page may make each time it's opened (spec
   * 2026-10-12-live-artifacts), or null for a plain version. Only html
   * versions have one.
   */
  live: LiveSpec | null;
  madeBy: 'model' | 'user';
  /** The reply that made it (your edit: the newest message on the branch you were on). Not a foreign key: it may arrive by sync before its message. */
  messageId: string | null;
  parentVersionId: string | null;
  createdAt: number;
}

/** A version without its content: what lists and the branch's current version need. */
export type ArtifactVersionInfo = Omit<ArtifactVersion, 'content'>;

/** A version to add: everything but its number, with kind and language defaulting to the artifact's and `live` to null. */
export type NewArtifactVersion = Omit<ArtifactVersion, 'number' | 'kind' | 'language' | 'live'> & { kind?: ArtifactKind; language?: string | null; live?: LiveSpec | null };

export interface ArtifactRepo {
  create(a: Artifact): Artifact;
  get(id: string): Artifact | null;
  bySlug(chatId: string, slug: string): Artifact | null;
  /** Oldest first. */
  listByChat(chatId: string): Artifact[];
  /** Adds a version numbered after the artifact's highest. */
  /** Numbers the version next; its kind and language are the artifact's unless given. */
  addVersion(v: NewArtifactVersion): ArtifactVersion;
  /** Every version without its content (up to 1 MB each), oldest number first: for lists and finding the current one. */
  versionInfos(artifactId: string): ArtifactVersionInfo[];
  getVersion(id: string): ArtifactVersion | null;
  /** Oldest (lowest number) first. */
  versions(artifactId: string): ArtifactVersion[];
}

// --- schedules (spec 2026-10-12-scheduled-tasks-design) ------------------------

/**
 * A prompt run on a profile on a timetable, with nobody there. Lives and runs
 * only on the machine that made it (never synced in phase 1). `timezone` is
 * that machine's IANA zone when it was made. `nextRunAt` is null while paused.
 */
export interface Schedule {
  id: string;
  name: string;
  prompt: string;
  profileId: string;
  target: ScheduleTarget;
  rule: ScheduleRule;
  timezone: string;
  enabled: boolean;
  nextRunAt: number | null;
  createdAt: number;
  updatedAt: number;
  /**
   * Set only when the stored rule can't be read (a hand-edited row, say): why.
   * Such a schedule comes back disabled with a placeholder rule and never runs.
   */
  invalid?: string;
}

/** What `ScheduleRepo.create` takes: timestamps default to now. */
export type NewSchedule = Omit<Schedule, 'createdAt' | 'updatedAt' | 'invalid'> & { createdAt?: number; updatedAt?: number };

/** What `ScheduleRepo.update` may change. The target is fixed once made. */
export type SchedulePatch = Partial<Pick<Schedule, 'name' | 'prompt' | 'profileId' | 'rule' | 'enabled' | 'nextRunAt' | 'updatedAt'>>;

/** One run of a schedule, kept in its history (the newest `SCHEDULE_RUNS_KEPT`). */
export interface ScheduleRun {
  id: string;
  scheduleId: string;
  trigger: ScheduleTrigger;
  /** The slot it ran for; null for Run now. */
  dueAt: number | null;
  startedAt: number;
  finishedAt: number | null;
  status: ScheduleRunStatus;
  /** Why it didn't start, the reply's error, or "Stopped after 30 minutes."; else null. */
  detail: string | null;
  /** The chat it wrote in; null before it has one, or once that chat is deleted. */
  chatId: string | null;
  /** The run made `chatId` (a project target): auto-title leaves such chats alone. */
  createdChat: boolean;
  userMessageId: string | null;
  messageId: string | null;
  /** How many of the reply's tool calls were refused for needing an approval (`deny:unattended` audit rows). */
  refusedCalls: number;
}

export type NewScheduleRun = Pick<ScheduleRun, 'id' | 'scheduleId' | 'trigger' | 'dueAt' | 'startedAt' | 'status'> &
  Partial<Pick<ScheduleRun, 'finishedAt' | 'detail' | 'chatId' | 'createdChat' | 'userMessageId' | 'messageId' | 'refusedCalls'>>;

export type ScheduleRunPatch = Partial<Omit<ScheduleRun, 'id' | 'scheduleId'>>;

/** A schedule as the API returns it (server routes/schedules.ts): the row plus what the UI shows with it. */
export interface ScheduleView extends Schedule {
  /** The target chat's title or the project's name; '' if it's gone. */
  targetName: string;
  /** `describeRule(rule)`. */
  describe: string;
  /** A run of it is being set up or written right now. */
  running: boolean;
  /** The run whose reply is being written now (what Stop stops); null while none is, or one is still being set up. Not always `lastRun`: a slot it overran is recorded after it. */
  activeRun: { runId: string; messageId: string } | null;
  lastRun: ScheduleRun | null;
  /** `unattendedWarnings` for its profile and target. */
  warnings: string[];
}

/**
 * Schedules and their runs. Local only: no change tracking. Deleting a
 * schedule's target chat, project or profile deletes it (and its runs);
 * deleting a run's chat keeps the run with `chatId: null`.
 */
export interface ScheduleRepo {
  /** Throws on a duplicate id. */
  create(s: NewSchedule): Schedule;
  get(id: string): Schedule | null;
  /** Oldest made first. */
  list(): Schedule[];
  /** Throws for an unknown id. */
  update(id: string, patch: SchedulePatch): Schedule;
  /** Also deletes its runs. A no-op for an unknown id. */
  delete(id: string): void;
  /** Enabled schedules whose `nextRunAt` is at or before `now`, oldest due first (then oldest made, then id). */
  due(now: number): Schedule[];
  /** Adds a run (defaults: no finish, detail, chat, ids; 0 refused) and prunes the schedule's runs to the newest `SCHEDULE_RUNS_KEPT`. Throws for an unknown schedule. */
  addRun(r: NewScheduleRun): ScheduleRun;
  /** Merges `patch` into the run; null (and nothing written) when the run is gone. */
  updateRun(id: string, patch: ScheduleRunPatch): ScheduleRun | null;
  /** Newest first (by `startedAt`, then the order added). */
  runs(scheduleId: string): ScheduleRun[];
  lastRun(scheduleId: string): ScheduleRun | null;
  /** The newest run with status `complete`, or null. */
  lastCompleted(scheduleId: string): ScheduleRun | null;
  /** Every run with status `running`, across all schedules. */
  runningRuns(): ScheduleRun[];
  /** Whether some run created this chat. */
  madeChat(chatId: string): boolean;
}

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
