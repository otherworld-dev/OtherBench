import type { App, AppFolder, AppSettings, Artifact, ArtifactKind, ArtifactVersion, AuditEntry, Chat, GlobalMemory, GlobalMemoryVersion, Grant, LiveParam, McpServer, Project, ProjectMemoryVersion, PublicAttachment, ScheduleRun, ScheduleView } from '@otherbench/core/ports/store.js';
import type { CommandRow } from '@otherbench/core/domain/context-lines.js';
import type { CheckpointLoader, MediaWorkflow } from '@otherbench/core/domain/media-workflows.js';
import type { ComfyTemplate, RecentWorkflow } from '@otherbench/core/types/media-library.js';
import type { GhErrorCode, GitErrorCode, GitStatus, IssueDetail, IssueSummary } from '@otherbench/core/types/code.js';
import type { ScheduleRule } from '@otherbench/core/domain/schedule.js';
import type { MemoryFailure, MemoryUpdateOutcome, MemoryVersionSummary, ProjectMemoryView } from '@otherbench/core/domain/memory.js';
import type { UsageRollup } from '@otherbench/core/domain/usage-rollup.js';
import type { ApprovalChoice, AskReply, LiveCallOutcome, LiveCallStatus } from '@otherbench/core/ports/tool-provider.js';
import type { ClaudeEffort, Connection, ConnectionKind, ModelInfo, ModelParams, Profile, ToolPolicy } from '@otherbench/core/types/config.js';
import type { ImportPreview, ImportStart, ImportStatus } from '@otherbench/core/types/claude-import.js';
import type { CanonMessage, Part } from '@otherbench/core/types/messages.js';
import type { AccountView } from '@otherbench/core/types/claude-accounts.js';
import type { PlanUsage, RecordedUsage } from '@otherbench/core/types/usage.js';
import type { FolderAccess, Location, LocationPath, NodeInfo, Workspace } from '@otherbench/core/types/workspace.js';
import type { InferredMapping } from '@otherbench/core/domain/workspace.js';
import type { PublicPeer } from '@otherbench/core/types/peer.js';
import type { SandboxStatus } from '@otherbench/core/ports/sandbox.js';
import type { McpServerHealth } from '@otherbench/tools/mcp/manager.js';
import type { ReplyNote } from '@otherbench/core/types/notes.js';
import type { Bookmark, DeckBoardView, DeckCardDetail, NextcloudErrorCode, NextcloudSettingsView, NextcloudTestResult, ProjectLinksSuggestion, WikiPage, WikiTree } from '@otherbench/core/types/nextcloud.js';
import type { TerminalInfo, TerminalStatus } from '@otherbench/core/types/terminal.js';
import type { Overview } from '@otherbench/core/types/overview.js';
import { apiFetch, apiUrl } from './transport.js';

/** What `GET /api/auth/status` says (packages/server/src/remote/auth.ts's `AuthStatusBody`). */
export interface AuthStatus {
  mode: 'open' | 'token' | 'login';
  signedIn: boolean;
  /** Sign-in with OtherBench's own certificate: the login page offers it. */
  caDownload?: boolean;
  session?: { expiresAt: number; remember: boolean };
  remote?: {
    publicUrls: string[];
    tls: { mode: 'auto' | 'files' | 'proxy'; notAfter?: number; caFingerprint?: string; names?: string[] };
    trustProxies: string[];
  };
}

/**
 * The `code` a Code tab route's failure names (spec 2026-10-20-code-tab-design,
 * "Error states the panels must handle"; server `code/route-errors.ts`). The
 * panels pick their one-line copy by it.
 */
export type CodeErrorCode = GitErrorCode | GhErrorCode | 'not-on-this-machine' | 'no-github-repo' | NextcloudErrorCode;

export class ApiError extends Error {
  readonly status: number;
  /** The `kind` a refusal's body names (a note's 409: `idle`, `command`, `workspace_unresolved`), when it has one. */
  readonly kind?: string;
  /**
   * The `code` a Code tab route's failure names beside its message (a `CodeErrorCode`), when it has one.
   * A string, not the union: the server may name one this build doesn't know yet.
   */
  readonly code?: string;
  /** git's or gh's own stderr, as-is (already URL-redacted by the server), for `git-failed` and `gh-failed`. */
  readonly stderr?: string;
  constructor(status: number, message: string, kind?: string, extra?: { code?: string; stderr?: string }) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    if (kind !== undefined) this.kind = kind;
    if (extra?.code !== undefined) this.code = extra.code;
    if (extra?.stderr !== undefined) this.stderr = extra.stderr;
  }
}

/** A string field of an error body, or undefined. */
function bodyString(body: unknown, field: string): string | undefined {
  if (!body || typeof body !== 'object' || !(field in body)) return undefined;
  const value = (body as Record<string, unknown>)[field];
  return typeof value === 'string' ? value : undefined;
}

function errorMessageOf(res: Response, body: unknown): string {
  if (body && typeof body === 'object' && 'error' in body && typeof (body as { error: unknown }).error === 'string') {
    return (body as { error: string }).error;
  }
  return res.statusText || `HTTP ${res.status}`;
}

async function extractErrorMessage(res: Response): Promise<string> {
  return errorMessageOf(res, await res.json().catch(() => null));
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await apiFetch(path, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
  if (!res.ok) {
    const body: unknown = await res.json().catch(() => null);
    const code = bodyString(body, 'code');
    const stderr = bodyString(body, 'stderr');
    throw new ApiError(res.status, errorMessageOf(res, body), bodyString(body, 'kind'), {
      ...(code !== undefined ? { code } : {}),
      ...(stderr !== undefined ? { stderr } : {}),
    });
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

/** `POST /api/chats/:id/notes`: the server reads each attachment's type and name from its own row. */
export interface SendNoteBody {
  text: string;
  attachments: { attachmentId: string }[];
  parentId: string | null;
  profileIds: string[];
  clientId: string;
}

/** `POST /api/schedules` (spec 2026-10-12-scheduled-tasks-design). The server sets the time zone. */
export interface CreateScheduleBody {
  name: string;
  prompt: string;
  profileId: string;
  target: { chatId: string } | { projectId: string };
  rule: ScheduleRule;
  enabled?: boolean;
}

/** `PATCH /api/schedules/:id`: any of these; the target can't change. */
export interface PatchScheduleBody {
  name?: string;
  prompt?: string;
  profileId?: string;
  rule?: ScheduleRule;
  enabled?: boolean;
}

function post<T>(path: string, body?: unknown): Promise<T> {
  return request<T>(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) });
}
function put<T>(path: string, body: unknown): Promise<T> {
  return request<T>(path, { method: 'PUT', body: JSON.stringify(body) });
}
function patch<T>(path: string, body: unknown): Promise<T> {
  return request<T>(path, { method: 'PATCH', body: JSON.stringify(body) });
}
function boardQuery(board: number | null | undefined): string {
  return board === undefined || board === null ? '' : `?board=${board}`;
}

function del(path: string): Promise<void> {
  return request<void>(path, { method: 'DELETE' });
}

/**
 * Uploads a single file as `multipart/form-data`. Deliberately NOT built on
 * `request()`/`post()` above: those force `Content-Type: application/json`,
 * which would be wrong here -- a `FormData` body needs the browser's own
 * `multipart/form-data; boundary=...` header, set automatically only when
 * `fetch` is left to infer it from the body (i.e. when `Content-Type` is
 * NOT set explicitly at all).
 */
async function uploadFile<T>(path: string, file: File): Promise<T> {
  const form = new FormData();
  form.append('file', file);
  const res = await apiFetch(path, { method: 'POST', body: form });
  if (!res.ok) throw new ApiError(res.status, await extractErrorMessage(res));
  return (await res.json()) as T;
}

/** How the viewer shows a file (Deck #826); the server decides. */
export type ViewKind = 'image' | 'video' | 'pdf' | 'html' | 'markdown' | 'text' | 'other';
/** A file opened for the viewer: `url` is a short-lived `/view/` link for what the browser loads itself, else null. */
export interface ViewOpened { path: string; name: string; kind: ViewKind; url: string | null; size: number }

/** One artifact in a chat's list (Deck #896): its current version on the branch the chat shows. */
export interface ArtifactSummary { id: string; slug: string; kind: ArtifactKind; language: string | null; title: string; versionId: string; number: number; madeBy: 'model' | 'user';
  /** How many live calls it declares (spec 2026-10-12-live-artifacts); 0 for a plain one. */
  live: number }

/** One artifact with every version, each marked on or off the chat's branch. */
export interface ArtifactDetail {
  artifact: Artifact;
  fileName: string;
  currentVersionId: string | null;
  /** Each version is its own kind (a note made into a page), with its own file name. */
  versions: { id: string; number: number; title: string; madeBy: 'model' | 'user'; createdAt: number; onBranch: boolean; kind: ArtifactKind; language: string | null; fileName: string;
    /** How many live calls it declares (spec 2026-10-12-live-artifacts); 0 for a plain one. */
    live: number }[];
}

/** A live page's calls as the viewer shows them (spec 2026-10-12-live-artifacts). */
export interface LiveStatus {
  /** The machine the calls run on: the one serving this UI. */
  machine: { id: string; name: string };
  /** Set when the chat runs on another machine. */
  runsOn: { id: string; name: string } | null;
  profile: { id: string; name: string };
  calls: (LiveCallStatus & { args: Record<string, unknown>; params: Record<string, LiveParam> })[];
}

/** What one live call came back as: the server's outcome, or one the viewer gave itself. */
export type LiveOutcome = LiveCallOutcome | { ok: false; code: 'bad_params' | 'busy'; message: string };
export interface ViewText { path: string; content: string; truncated: boolean; size: number }
export interface ViewRoot { path: string; label: string; access: FolderAccess; workspace: boolean }
export interface ViewEntry { name: string; path: string; type: 'dir' | 'file' }
/** A chat's browser as the server reports it (spec 2026-10-12-model-browser-design §5); `elsewhere` names the machine running it. */
export interface BrowserLiveState {
  open: boolean;
  url?: string | null;
  title?: string | null;
  host?: string | null;
  holder?: string | null;
  elsewhere?: string;
}
export type BrowserLiveEvent = { type: 'state'; state: BrowserLiveState } | { type: 'frame'; seq: number; jpeg: string };

export interface MediaModelsResult {
  models: { id: string; label: string }[];
  checkpoints: string[];
  checkpointsError?: string;
}

export interface CreateConnectionBody {
  name: string;
  kind: ConnectionKind;
  baseUrl?: string | null;
  apiKey?: string | null;
  extraHeaders?: Record<string, string>;
  /** 'anywhere', or the node id of the one machine it works on. Omitted on create: the server decides from the address. */
  availability?: string;
  /** False keeps the API key on this machine when chats sync. */
  syncSecret?: boolean;
}

/** A tool policy as the profiles API takes it: `sandboxHosts: null` puts the default allowlist back. */
export type ToolPolicyBody = Omit<ToolPolicy, 'sandboxHosts'> & { sandboxHosts?: string[] | null };

export interface CreateProfileBody {
  name: string;
  description?: string | null;
  colour?: string | null;
  connectionId: string;
  modelId: string;
  systemPrompt?: string | null;
  params?: ModelParams;
  toolPolicy?: ToolPolicyBody;
  isDefault?: boolean;
  /** Absent means on. */
  useGlobalMemory?: boolean;
}

/** `PATCH /api/profiles/:id`: any `CreateProfileBody` field, and only the `toolPolicy` fields to change (the server keeps the rest). */
export type ProfilePatchBody = Partial<Omit<CreateProfileBody, 'toolPolicy'>> & { toolPolicy?: Partial<ToolPolicyBody> };

/** What `GET /api/memory/global` and its writes return (spec 2026-10-08-global-memory-design §3). */
export interface GlobalMemoryView {
  memory: GlobalMemory;
  lastError: MemoryFailure | null;
}

export interface CreateChatBody {
  title?: string;
  /** Required unless `projectId` is given: the server then uses the project's default profile, else the app default. */
  profileId?: string;
  /** An absolute path on this machine; stored relative to a location when it's inside one. */
  workspacePath?: string | null;
  workspaceRoot?: string | null;
  /** Files the new chat in this project; it starts with the project's folder unless a folder is given. */
  projectId?: string;
  /**
   * Files the new chat in this app (spec 2026-10-20-code-tab-design): it takes the app's folder and,
   * when usable, its default profile. Never with `projectId` or a folder (both 400).
   */
  appId?: string;
}

/** `POST /api/apps` (spec 2026-10-20-code-tab-design, "The New app form"). The folder is required. */
export interface CreateAppBody {
  /** Trimmed, 1 to 80 characters. */
  name: string;
  /** An absolute path on this machine. */
  workspacePath: string;
  /** "owner/name"; null or blank for none. */
  githubRepo?: string | null;
  linkedProjectId?: string | null;
  /** Not an archived profile. */
  defaultProfileId?: string | null;
  /** Left out: the new app goes to the bottom. */
  sortOrder?: number;
  /** The app folder it sits in; null for the top level. */
  folderId?: string | null;
  /** A Nextcloud Deck board id; null for none. */
  deckBoardId?: number | null;
  /** The Collectives collective and page path holding the app's wiki; null for none. */
  wikiCollective?: string | null;
  wikiPagePath?: string | null;
  /** The Nextcloud bookmark tag for the app's links; null for none. */
  bookmarkTag?: string | null;
}

/** `PATCH /api/apps/:id`: any of these. The folder can't be cleared; a new one moves every chat in the app with it. */
export type PatchAppBody = Partial<CreateAppBody>;

/** `GET /api/apps/detect-repo`: `isRepo` only for a repo's top level; its GitHub `origin`, when it has one. */
export interface DetectRepoResult {
  githubRepo: string | null;
  isRepo: boolean;
}

export interface GitBranch {
  name: string;
  current: boolean;
}

/** One server in Claude Desktop's config, as the import lists it (spec 2026-10-11-claude-code-clean-chat-and-mcp-design §3). */
export interface ClaudeDesktopServerView {
  name: string;
  transport: 'stdio' | 'http' | null;
  command: string | null;
  args: string[];
  url: string | null;
  envNames: string[];
  headerNames: string[];
  /** OtherBench already has a server with this name. */
  exists: boolean;
  supported: boolean;
  reason?: string;
}

export interface ClaudeDesktopListing {
  path: string;
  found: boolean;
  servers: ClaudeDesktopServerView[];
}

export interface ClaudeDesktopImportResult {
  imported: string[];
  skipped: { name: string; reason: string }[];
  /** The profiles the imported servers were turned on for, as they are now. */
  profiles: Profile[];
}

export type ChatPatchBody = Partial<{
  title: string;
  profileId: string;
  /** An absolute path on this machine; stored relative to a location when it's inside one. */
  workspacePath: string | null;
  workspaceRoot: string | null;
  /** Only null: no folder. */
  workspace: null;
  /** The machine its turns run on: this one or a paired one (v2 spec §5). */
  runsOn: string;
  pinned: boolean;
  /** Plan first, from the next message (spec 2026-10-12-thread-cards-design §4). */
  planMode: boolean;
  /** Pinned at the top of its own project's group; refused (400) for a chat with no project. */
  projectPinned: boolean;
  archivedAt: number | null;
  /** Ticks the chat off the Overview until it needs him again (spec 2026-10-26-overview). */
  dealtWithAt: number | null;
  autoMode: boolean;
  /** The Claude account slug the chat is pinned to; null = Default (main, overflowing to the others). */
  claudeAccount: string | null;
  /** Switch to another Claude account when this one hits its limit. */
  accountAutoSwitch: boolean;
  /** Claude Code's effort from the next message; null follows the user's Claude Code settings. */
  effort: ClaudeEffort | null;
  /** The chat's extra folders, the whole list (spec 2026-10-07-extra-folders). */
  folders: FolderEntry[];
  /** Moves the chat between projects (null = No project); never changes its folder or profile. A project also takes it out of its app. */
  projectId: string | null;
  /**
   * Moves the chat into an app ("Move to app"): it takes the app's folder, leaves its project and,
   * with no `profileId` here, takes the app's default profile. Null takes it out of its app and leaves the folder alone.
   */
  appId: string | null;
  /** "Don't add to project memory": the summariser skips this chat. Never changes its place in the list. */
  memoryExcluded: boolean;
  /** Its place in its sidebar section, higher first (#823). Not chat activity: leaves updatedAt alone. */
  sortOrder: number;
  /** False marks a finished reply as seen, clearing the sidebar's dot. Not chat activity either. */
  unread: boolean;
}>;

export interface CreateProjectBody {
  name: string;
  workspaceRoot?: string | null;
  defaultProfileId?: string | null;
  /** At most 500 characters (stored trimmed). */
  description?: string;
  /** At most 8,000 characters; added to every chat's system prompt in the project. */
  instructions?: string;
  /** Extra folders for every chat in the project, each new one by path. */
  folders?: FolderEntry[];
  /** A top-level project to make this a sub-project of (spec 2026-10-15-sub-projects-design). */
  parentId?: string | null;
}

export type PatchProjectBody = Partial<{
  name: string;
  workspaceRoot: string | null;
  defaultProfileId: string | null;
  sortOrder: number;
  /** Extra folders for every chat in the project, the whole list. */
  folders: FolderEntry[];
  description: string;
  instructions: string;
  /** Moves it under a top-level project, or (null) back to the top level. */
  parentId: string | null;
}>;

/**
 * One extra folder in a `folders` patch (spec 2026-10-07-extra-folders): a new
 * one by its path on the machine that runs the chat, or one it already has by
 * its stored form (which keeps a folder this machine can't see).
 */
export type FolderEntry = { path: string; access: FolderAccess } | { workspace: Workspace; access: FolderAccess };

/** A location with every machine's path for it (`GET /api/locations`). */
export interface LocationView extends Location {
  paths: LocationPath[];
}

export interface InferLocationResult {
  mapping: InferredMapping | null;
  /** A location that already has one of the two roots. */
  existing: Location | null;
  /** Chats and projects on that machine that adopting the mapping would move into it. */
  affected: number;
}

export interface AdoptLocationBody {
  /** An existing location; otherwise `name` creates one. */
  locationId?: string;
  name?: string;
  nodeId: string;
  fromRoot: string;
  toRoot: string;
}

/** A paired machine as Settings → Machines shows it: the stored peer plus whether it's reachable now. */
export interface PeerView extends PublicPeer {
  status: 'unknown' | 'reachable' | 'unreachable';
  since: number;
  error?: string;
  /** When the last pull from it finished, and why the last one failed (until one succeeds). */
  lastSyncedAt: number | null;
  syncError: string | null;
  /** Its own chats with a reply running there now, while it's reachable (#790); absent means none. */
  activeChats?: string[];
  /** Its own chats with background tasks running there now, while it's reachable; absent means none (or an older machine). */
  backgroundChats?: string[];
}

export interface PeersOverview {
  self: NodeInfo & { fingerprint: string };
  listening: { running: boolean; addresses: string[] };
  peers: PeerView[];
}

/** A pairing code this machine is showing. */
export interface PairingView {
  code: string;
  expiresAt: number;
  addresses: string[];
  fingerprint: string;
}

export interface CreateTurnBody {
  parentId: string | null;
  parts: Part[];
  profileIds: string[];
}

export interface TurnResult {
  userMessageId: string;
  assistantMessageIds: string[];
  /** The profiles actually run, in `assistantMessageIds` order (a /compact runs one, whatever was selected). */
  profileIds?: string[];
  /** The user message's parts as stored (a typed "/clear" becomes a context part). */
  userParts?: Part[];
}

/** What `POST /chats/:id/regenerate` returns: the new reply, under the same user message. */
export interface RegenerateResult {
  userMessageId: string;
  assistantMessageId: string;
}

export interface ChatMessagesResult {
  messages: CanonMessage[];
  headMessageId: string | null;
  /** Each finished reply's recorded usage, by message id (#819). */
  usage?: Record<string, RecordedUsage>;
}

export interface SearchResult {
  messageId: string;
  chatId: string;
  snippet: string;
}

/** See `api.attachments.previewable`'s doc -- must stay identical to the server's `INLINE_SAFE_MIME_TYPES`. */
const INLINE_PREVIEWABLE_MIME_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/bmp',
  'image/x-icon',
  'image/vnd.microsoft.icon',
  'image/avif',
]);

export interface CreateMcpServerBody {
  name: string;
  transport: 'stdio' | 'http';
  command?: string | null;
  args?: string[];
  /**
   * Plaintext env VAR VALUES -- the server stores each as a SecretStore ref
   * (`McpServer.envRefs`) and never echoes the value back, identically to
   * `headers` below (see routes/tools.ts). On `PATCH` only, a value may
   * also be `null`, meaning "keep whatever is already stored under this
   * name" -- see `optionalSecretPatchRecord` (server) and
   * `McpServerForm.rowsToSecretPatch` (client). `POST` (create) has nothing
   * to keep and rejects `null` with a 400.
   */
  env?: Record<string, string | null>;
  url?: string | null;
  /** Plaintext header VALUES -- same rules as `env` above, including the PATCH-only `null` ("keep") sentinel. */
  headers?: Record<string, string | null>;
  enabled?: boolean;
  /** Sign-in app: a hand-registered client ID (null clears it). Only sent when changed. */
  oauthClientId?: string | null;
  /** Its secret, write-only like headers: a string sets it, null removes it, absent keeps it. */
  oauthClientSecret?: string | null;
}

/**
 * Thin typed wrapper over `/api/*`. Every shape here is read off the actual
 * route handlers in packages/server/src/routes/*.ts (task 19/20 brief:
 * "read the API surface you are consuming... do not guess"), not
 * reconstructed from the briefs.
 */
export const api = {
  /** `platform` is the SERVER's `process.platform` (e.g. "win32"), not the browser's -- see routes/health.ts. Used to validate a chat's workspace root against the OS that will actually resolve it. */
  health: () => request<{ status: string; time: string; platform: string }>('/health'),
  /** Sign-in (spec 2026-10-12-remote-access §3). Asked only in a browser, never in the desktop app. */
  auth: {
    status: () => request<AuthStatus>('/auth/status'),
    login: (password: string, remember: boolean) => post<{ expiresAt: number }>('/auth/login', { password, remember }),
    logout: () => post<void>('/auth/logout'),
    logoutAll: () => post<void>('/auth/logout-all'),
    changePassword: (current: string, next: string) => post<{ expiresAt: number }>('/auth/password', { current, next }),
  },

  connections: {
    list: () => request<Connection[]>('/connections'),
    create: (body: CreateConnectionBody) => post<Connection>('/connections', body),
    get: (id: string) => request<Connection>(`/connections/${id}`),
    patch: (id: string, body: Partial<CreateConnectionBody>) => patch<Connection>(`/connections/${id}`, body),
    delete: (id: string) => del(`/connections/${id}`),
    test: (id: string) => post<{ ok: boolean; message: string; latencyMs: number }>(`/connections/${id}/test`),
    discoverModels: (id: string) => post<ModelInfo[]>(`/connections/${id}/discover-models`),
    /** Looks for ComfyUI on this PC's two usual addresses; only when asked. */
    findComfyui: () => post<{ baseUrl: string; version: string; gpu: string | null; vramGb: number | null } | { found: false }>('/connections/find-comfyui'),
    comfyRecent: (id: string) => request<RecentWorkflow[]>(`/connections/${encodeURIComponent(id)}/comfy/recent`),
    comfyTemplates: (id: string) => request<{ templates: ComfyTemplate[] } | { unsupported: true }>(`/connections/${encodeURIComponent(id)}/comfy/templates`),
    /**
     * A generation connection's models or workflows for the pickers; ComfyUI also lists the model files it has
     * (`checkpointsError` when it couldn't say), from `loader` (the one a workflow's model file is on), else the media's usual one.
     */
    mediaModels: (id: string, media: 'image' | 'video', loader?: CheckpointLoader) =>
      request<MediaModelsResult>(`/connections/${encodeURIComponent(id)}/media-models?media=${media}${loader ? `&loader=${encodeURIComponent(loader)}` : ''}`),
  },

  /** ComfyUI workflows, built-in (`builtin:` ids, read-only) and imported. */
  mediaWorkflows: {
    list: () => request<MediaWorkflow[]>('/media/workflows'),
    detect: (graph: unknown) => post<{ bindings: MediaWorkflow['bindings']; problem: string | null }>('/media/workflows/detect', { graph }),
    create: (body: { name: string; media: 'image' | 'video'; graph: unknown; bindings: MediaWorkflow['bindings']; checkpoint?: string }) =>
      post<MediaWorkflow>('/media/workflows', body),
    /** An imported workflow's name, media, bindings or model file (`checkpoint: null` goes back to the graph's own). */
    update: (id: string, body: { name?: string; media?: 'image' | 'video'; graph?: unknown; bindings?: MediaWorkflow['bindings']; checkpoint?: string | null }) =>
      patch<MediaWorkflow>(`/media/workflows/${encodeURIComponent(id)}`, body),
    delete: (id: string) => del(`/media/workflows/${encodeURIComponent(id)}`),
  },

  models: {
    list: (connectionId?: string) => request<ModelInfo[]>(`/models${connectionId ? `?connectionId=${encodeURIComponent(connectionId)}` : ''}`),
    get: (id: string) => request<ModelInfo>(`/models/${id}`),
    patch: (
      id: string,
      body: Partial<Pick<ModelInfo, 'displayName' | 'priceInPer1m' | 'priceOutPer1m' | 'priceCachedPer1m' | 'currency' | 'supportsVision' | 'supportsTools' | 'supportsReasoning' | 'contextWindow' | 'maxOutput'>>
    ) => patch<ModelInfo>(`/models/${id}`, body),
  },

  profiles: {
    list: () => request<Profile[]>('/profiles'),
    create: (body: CreateProfileBody) => post<Profile>('/profiles', body),
    get: (id: string) => request<Profile>(`/profiles/${id}`),
    patch: (id: string, body: ProfilePatchBody) => patch<Profile>(`/profiles/${id}`, body),
    delete: (id: string) => del(`/profiles/${id}`),
  },

  chats: {
    list: () => request<Chat[]>('/chats'),
    create: (body: CreateChatBody) => post<Chat>('/chats', body),
    get: (id: string) => request<Chat>(`/chats/${id}`),
    patch: (id: string, body: ChatPatchBody) => patch<Chat>(`/chats/${id}`, body),
    /** The commands the `/` menu offers in this chat; `warning` when the chat's own couldn't be loaded. */
    commands: (chatId: string, profileId: string) => request<{ commands: CommandRow[]; warning?: string }>(`/chats/${chatId}/commands?profileId=${encodeURIComponent(profileId)}`),
    /** Stops one of the chat's background tasks (spec 2026-10-17-claude-background-helpers-design). */
    stopHelper: (chatId: string, taskId: string) => post<{ stopped: boolean }>(`/chats/${chatId}/helpers/${encodeURIComponent(taskId)}/stop`, {}),
    /** Re-runs the reply to `messageId` on another Claude account (202). */
    continueOnAccount: (chatId: string, body: { messageId: string; account: string }) =>
      post<{ userMessageId: string; assistantMessageIds: string[] }>(`/chats/${chatId}/continue-on-account`, body),
    delete: (id: string) => del(`/chats/${id}`),
    messages: (id: string) => request<ChatMessagesResult>(`/chats/${id}/messages`),
    /** The chat as a file (#820): the shown conversation as Markdown, or the whole tree as JSON. */
    export: async (id: string, format: 'markdown' | 'json'): Promise<Blob> => {
      const res = await apiFetch(`/chats/${id}/export?format=${format}`);
      if (!res.ok) throw new ApiError(res.status, await extractErrorMessage(res));
      return res.blob();
    },
    /** Ends the chat's computer-use session and stops its reply (the banner's Stop): `POST /api/chats/:id/computer/stop`. */
    stopComputer: (id: string) => post<void>(`/chats/${encodeURIComponent(id)}/computer/stop`),
  },

  /** Computer use (spec 2026-10-12-computer-use-design section 7). */
  computer: {
    /** Whether this server can offer the computer tool (the desktop shell on Windows said it can). Authenticated. */
    status: () => request<{ computerUse: boolean }>('/computer/status'),
  },

  projects: {
    /** In sidebar order (sortOrder, then name). */
    list: () => request<Project[]>('/projects'),
    create: (body: CreateProjectBody) => post<Project>('/projects', body),
    patch: (id: string, body: PatchProjectBody) => patch<Project>(`/projects/${id}`, body),
    /** Its chats move to No project; none are deleted. */
    delete: (id: string) => del(`/projects/${id}`),
  },

  /** The Overview: what needs you across apps (server `routes/overview.ts`). Each call answers the whole Overview. */
  overview: {
    get: () => request<Overview>('/overview'),
    refresh: () => post<Overview>('/overview/refresh'),
    tickIssue: (appId: string, n: number) => post<Overview>(`/overview/issues/${encodeURIComponent(appId)}/${n}/tick`),
    tickOlder: (before: number) => post<{ chats: number; issues: number }>('/overview/tick-older', { before }),
  },

  /**
   * Nextcloud settings and cards (spec 2026-10-22-nextcloud-tabs; server `routes/nextcloud.ts`). The password is only
   * ever sent, never returned. `board` is optional on the card calls: without it the card is found on whichever board holds it.
   */
  nextcloud: {
    get: () => request<NextcloudSettingsView>('/nextcloud'),
    put: (body: { baseUrl: string; user: string; password?: string | null }) => put<NextcloudSettingsView>('/nextcloud', body),
    test: () => post<NextcloudTestResult>('/nextcloud/test'),
    boards: () => request<{ id: number; title: string }[]>('/nextcloud/boards'),
    collectives: () => request<string[]>('/nextcloud/collectives'),
    /** The collective's page paths (`Products/MyApp`), parents first, for picking an app's Collectives page. */
    collectivePages: (collective: string) => request<string[]>(`/nextcloud/collectives/${encodeURIComponent(collective)}/pages`),
    detectLinks: (path: string) => request<ProjectLinksSuggestion>(`/nextcloud/detect-links?path=${encodeURIComponent(path)}`),
    card: (cardId: number, board?: number | null) => request<DeckCardDetail>(`/nextcloud/cards/${cardId}${boardQuery(board)}`),
    updateCard: (cardId: number, change: { title?: string; description?: string; duedate?: string | null }, board?: number | null) =>
      patch<DeckCardDetail>(`/nextcloud/cards/${cardId}${boardQuery(board)}`, change),
    /** 204; refetch the card after. */
    cardAction: (cardId: number, action: 'done' | 'reopen' | 'archive', board?: number | null) =>
      post<void>(`/nextcloud/cards/${cardId}/${action}${boardQuery(board)}`),
    /** Moves in place; a move Deck ignores is a 409 `deck-move-ignored`, never a delete and recreate. */
    moveCard: (cardId: number, stackId: number, board?: number | null) => post<void>(`/nextcloud/cards/${cardId}/move${boardQuery(board)}`, { stackId }),
    labels: (cardId: number, change: { add?: number[]; remove?: number[] }, board?: number | null) =>
      post<void>(`/nextcloud/cards/${cardId}/labels${boardQuery(board)}`, change),
    deleteCard: (cardId: number, board?: number | null) => del(`/nextcloud/cards/${cardId}${boardQuery(board)}`),
  },

  /** Folders for apps in the Code sidebar (plan 2026-10-25-app-folders; server `routes/app-folders.ts`). */
  appFolders: {
    /** In sidebar order. */
    list: () => request<AppFolder[]>('/app-folders'),
    create: (body: { name?: string; sortOrder?: number } = {}) => post<AppFolder>('/app-folders', body),
    patch: (id: string, body: { name?: string; sortOrder?: number }) => patch<AppFolder>(`/app-folders/${encodeURIComponent(id)}`, body),
    /** Its apps move to the top level; none are deleted. */
    delete: (id: string) => del(`/app-folders/${encodeURIComponent(id)}`),
  },

  /**
   * Apps and their git, GitHub issues and files (spec 2026-10-20-code-tab-design; server `routes/apps.ts`).
   * Each failure's `code` (a `CodeErrorCode`) and, for git-failed/gh-failed, `stderr` are on the ApiError.
   * The git and files routes answer 409 `not-on-this-machine` when the app's folder isn't here; the issue routes
   * work wherever the folder is, and answer 409 `no-github-repo` for an app with none.
   */
  apps: {
    /** In sidebar order. */
    list: () => request<App[]>('/apps'),
    get: (id: string) => request<App>(`/apps/${encodeURIComponent(id)}`),
    create: (body: CreateAppBody) => post<App>('/apps', body),
    patch: (id: string, body: PatchAppBody) => patch<App>(`/apps/${encodeURIComponent(id)}`, body),
    /** Its chats go back to Chat mode (`appId: null`); none are deleted. */
    delete: (id: string) => del(`/apps/${encodeURIComponent(id)}`),
    /** What the New app form pre-fills from a folder: an absolute path on this machine. */
    detectRepo: (path: string) => request<DetectRepoResult>(`/apps/detect-repo?path=${encodeURIComponent(path)}`),
    git: {
      status: (id: string) => request<GitStatus>(`/apps/${encodeURIComponent(id)}/git/status`),
      /** One file's diff, or the whole tree's without `path`. */
      diff: (id: string, path?: string) =>
        request<{ diff: string }>(`/apps/${encodeURIComponent(id)}/git/diff${path !== undefined ? `?path=${encodeURIComponent(path)}` : ''}`),
      /** `paths` defaults to 'all' (every change); a list commits only those. */
      commit: (id: string, body: { message: string; paths?: string[] | 'all' }) => post<{ sha: string }>(`/apps/${encodeURIComponent(id)}/git/commit`, body),
      pull: (id: string) => post<{ output: string }>(`/apps/${encodeURIComponent(id)}/git/pull`),
      /** `setUpstream` for a branch with no upstream yet ("Push and set upstream"). */
      push: (id: string, opts: { setUpstream?: boolean } = {}) => post<{ output: string }>(`/apps/${encodeURIComponent(id)}/git/push`, opts),
      branches: (id: string) => request<{ branches: GitBranch[] }>(`/apps/${encodeURIComponent(id)}/git/branches`),
      /** Switches to an existing branch (204); refetch the status after. */
      checkout: (id: string, branch: string) => post<void>(`/apps/${encodeURIComponent(id)}/git/checkout`, { branch }),
      /** Creates the branch and switches to it (204); refetch the status after. */
      branch: (id: string, branch: string) => post<void>(`/apps/${encodeURIComponent(id)}/git/branch`, { branch }),
    },
    issues: {
      /** Open issues unless `state` says closed. */
      list: (id: string, state?: 'open' | 'closed') =>
        request<{ repo: string; issues: IssueSummary[] }>(`/apps/${encodeURIComponent(id)}/issues${state !== undefined ? `?state=${state}` : ''}`),
      get: (id: string, n: number) => request<IssueDetail>(`/apps/${encodeURIComponent(id)}/issues/${n}`),
      /** A blank comment is a 400 (204 otherwise); refetch the issue after. */
      comment: (id: string, n: number, body: string) => post<void>(`/apps/${encodeURIComponent(id)}/issues/${n}/comment`, { body }),
      close: (id: string, n: number) => post<void>(`/apps/${encodeURIComponent(id)}/issues/${n}/close`),
      reopen: (id: string, n: number) => post<void>(`/apps/${encodeURIComponent(id)}/issues/${n}/reopen`),
    },
    deck: {
      /** The app's Deck board; 409 `no-deck-board` for an app with none. */
      board: (id: string) => request<DeckBoardView>(`/apps/${encodeURIComponent(id)}/deck`),
      create: (id: string, body: { stackId: number; title: string; description?: string }) =>
        post<DeckCardDetail>(`/apps/${encodeURIComponent(id)}/deck/cards`, body),
    },
    wiki: {
      /** The page tree under the app's wiki page; 409 `no-wiki-page` for an app with none. */
      tree: (id: string) => request<WikiTree>(`/apps/${encodeURIComponent(id)}/wiki`),
      page: (id: string, pageId: number) => request<WikiPage>(`/apps/${encodeURIComponent(id)}/wiki/pages/${pageId}`),
    },
    links: {
      /** The bookmarks under the app's tag; 409 `no-bookmark-tag` for an app with none. */
      list: (id: string) => request<{ tag: string; bookmarks: Bookmark[] }>(`/apps/${encodeURIComponent(id)}/links`),
      add: (id: string, body: { url: string; title?: string; description?: string; tags?: string[] }) =>
        post<Bookmark>(`/apps/${encodeURIComponent(id)}/links`, body),
      /** `tags` replaces the tag set (the server keeps the app's own tag on it). */
      update: (id: string, bookmarkId: number, body: { url?: string; title?: string; description?: string; tags?: string[] }) =>
        patch<Bookmark>(`/apps/${encodeURIComponent(id)}/links/${bookmarkId}`, body),
      remove: (id: string, bookmarkId: number) => del(`/apps/${encodeURIComponent(id)}/links/${bookmarkId}`),
    },
    /** A folder's entries; the app's root without `path`. A relative path is read inside the root. */
    files: (id: string, path?: string) =>
      request<{ path: string; entries: ViewEntry[] }>(`/apps/${encodeURIComponent(id)}/files${path !== undefined ? `?path=${encodeURIComponent(path)}` : ''}`),
    /** A file's text inside the app's folder, as `view.text` reads one for a chat. */
    text: (id: string, path: string) => request<ViewText>(`/apps/${encodeURIComponent(id)}/text?path=${encodeURIComponent(path)}`),
  },

  /**
   * The Code tab's terminals (spec 2026-10-21-code-terminal-design; server `routes/terminals.ts`). Only a local server
   * has them: `status()` says whether this one does, and why not.
   */
  terminals: {
    status: () => request<TerminalStatus>('/terminal/status'),
    list: (appId: string) => request<TerminalInfo[]>(`/apps/${encodeURIComponent(appId)}/terminals`),
    /** The default shell without `shell`. A folder not on this machine is a 409 `not-on-this-machine`. */
    create: (appId: string, body: { shell?: string; cols: number; rows: number }) => post<TerminalInfo>(`/apps/${encodeURIComponent(appId)}/terminals`, body),
    rename: (appId: string, id: string, name: string) => patch<TerminalInfo>(`/apps/${encodeURIComponent(appId)}/terminals/${encodeURIComponent(id)}`, { name }),
    kill: (appId: string, id: string) => del(`/apps/${encodeURIComponent(appId)}/terminals/${encodeURIComponent(id)}`),
    /** At most 64 KiB a call. */
    input: (appId: string, id: string, data: string) => post<void>(`/apps/${encodeURIComponent(appId)}/terminals/${encodeURIComponent(id)}/input`, { data }),
    resize: (appId: string, id: string, cols: number, rows: number) =>
      post<void>(`/apps/${encodeURIComponent(appId)}/terminals/${encodeURIComponent(id)}/resize`, { cols, rows }),
    restart: (appId: string, id: string) => post<TerminalInfo>(`/apps/${encodeURIComponent(appId)}/terminals/${encodeURIComponent(id)}/restart`),
    /** The output after offset `from` (an earlier answer's `next`), for a page that polls; `reset`: start the screen again from `data`. */
    output: (appId: string, id: string, from: number) =>
      request<{ data: string; next: number; reset: boolean; exitCode: number | null }>(
        `/apps/${encodeURIComponent(appId)}/terminals/${encodeURIComponent(id)}/output?from=${from}`
      ),
    /** Not fetched via `request` -- opened by `state/sse.ts`'s streaming reader, for the terminal on screen only. */
    streamUrl: (appId: string, id: string) => apiUrl(`/apps/${encodeURIComponent(appId)}/terminals/${encodeURIComponent(id)}/stream`),
  },

  /** A project's shared memory note (spec 2026-10-03-project-memory-design §4). */
  memory: {
    get: (projectId: string) => request<ProjectMemoryView>(`/projects/${projectId}/memory`),
    /** Saves as the user. The server checks the headings and the 4,000-character cap; Pinned may change. */
    save: (projectId: string, body: string) => put<ProjectMemoryView>(`/projects/${projectId}/memory`, { body }),
    /** Newest first. */
    versions: (projectId: string) => request<MemoryVersionSummary[]>(`/projects/${projectId}/memory/versions`),
    version: (projectId: string, versionId: string) => request<ProjectMemoryVersion>(`/projects/${projectId}/memory/versions/${versionId}`),
    /** Saves that version's body as a new user version. */
    restore: (projectId: string, versionId: string) => post<ProjectMemoryView>(`/projects/${projectId}/memory/versions/${versionId}/restore`),
    /** Folds this chat's new turns in now. Resolves when the update has finished; 409 when the chat isn't in a project or is excluded. */
    updateNow: (chatId: string) => post<MemoryUpdateOutcome>(`/chats/${chatId}/memory/update`),
    /** About you and the learned global note (spec 2026-10-08-global-memory-design §3). */
    global: {
      get: () => request<GlobalMemoryView>('/memory/global'),
      /** At most 4,000 characters. */
      saveAbout: (about: string) => put<GlobalMemoryView>('/memory/global/about', { about }),
      /** Saves the note as the user. The server checks the headings and the 4,000-character cap; Pinned may change. */
      saveNote: (body: string) => put<GlobalMemoryView>('/memory/global', { body }),
      /** Newest first. */
      versions: () => request<MemoryVersionSummary[]>('/memory/global/versions'),
      version: (versionId: string) => request<GlobalMemoryVersion>(`/memory/global/versions/${versionId}`),
      /** Saves that version's body as a new user version. */
      restore: (versionId: string) => post<GlobalMemoryView>(`/memory/global/versions/${versionId}/restore`),
    },
  },

  /** Named places each machine keeps at its own path (v2 spec §6). */
  locations: {
    list: () => request<LocationView[]>('/locations'),
    create: (body: { name: string; path?: string | null }) => post<LocationView>('/locations', body),
    rename: (id: string, name: string) => patch<LocationView>(`/locations/${id}`, { name }),
    /** This machine's path for it; null removes it. */
    setPath: (id: string, path: string | null) => put<LocationView>(`/locations/${id}/path`, { path }),
    delete: (id: string) => del(`/locations/${id}`),
    infer: (body: { nodeId: string; fromPath: string; toPath: string }) => post<InferLocationResult>('/locations/infer', body),
    adopt: (body: AdoptLocationBody) => post<{ location: LocationView; converted: number }>('/locations/adopt', body),
  },

  /** Paired machines (v2 spec §3). */
  peers: {
    overview: () => request<PeersOverview>('/peers'),
    /** Shows a code here for the other machine to enter. */
    startPairing: () => post<PairingView>('/peers/pairing'),
    currentPairing: () => request<PairingView | null>('/peers/pairing'),
    cancelPairing: () => del('/peers/pairing'),
    /** Enters the code the other machine is showing. */
    add: (address: string, code: string) => post<PublicPeer>('/peers', { address, code }),
    patch: (nodeId: string, body: { name?: string; addresses?: string[] }) => patch<PublicPeer>(`/peers/${nodeId}`, body),
    remove: (nodeId: string) => request<{ notified: boolean }>(`/peers/${nodeId}`, { method: 'DELETE' }),
    sync: (nodeId: string) => post<{ applied: number }>(`/peers/${nodeId}/sync`),
  },

  /** This machine. */
  node: {
    get: () => request<NodeInfo>('/node'),
    rename: (name: string) => patch<NodeInfo>('/node', { name }),
  },

  settings: {
    get: () => request<AppSettings>('/settings'),
    patch: (body: Partial<AppSettings>) => patch<AppSettings>('/settings', body),
  },

  /** Settings > Sandbox (spec 2026-10-12-sandbox-design): Set up and Repair start a job (202; poll status), Remove, the extra packages (202). */
  sandbox: {
    status: () => request<SandboxStatus>('/sandbox'),
    setup: () => post<SandboxStatus>('/sandbox/setup'),
    remove: () => post<SandboxStatus>('/sandbox/remove'),
    setPackages: (packages: string[]) => put<SandboxStatus>('/sandbox/packages', { packages }),
  },

  /** Import from claude.ai (spec 2026-10-09-claude-import-design §5): the running or last import, a preview, and a start (202). */
  claudeImport: {
    status: () => request<ImportStatus>('/import/claude'),
    preview: (folder: string, profileId: string | null) => post<ImportPreview>('/import/claude/preview', { folder, profileId }),
    start: (body: ImportStart) => post<ImportStatus>('/import/claude', body),
  },

  search: (q: string, limit?: number) =>
    request<SearchResult[]>(`/search?q=${encodeURIComponent(q)}${limit ? `&limit=${limit}` : ''}`),
  /** The chats with a message matching `q`, each once, best match first (the sidebar's search). */
  searchChats: (q: string) => request<{ chatId: string }[]>(`/search?scope=chats&q=${encodeURIComponent(q)}`),

  usage: {
    /** Omit `chatId` for the global (every-chat) rollup the usage/pricing settings view shows. */
    get: (chatId?: string) => request<UsageRollup>(`/usage${chatId ? `?chatId=${encodeURIComponent(chatId)}` : ''}`),
  },

  /** Scheduled tasks: local to the server machine. Run now answers 409 with a reason when it can't start. */
  schedules: {
    list: () => request<ScheduleView[]>('/schedules'),
    create: (body: CreateScheduleBody) => post<ScheduleView>('/schedules', body),
    patch: (id: string, body: PatchScheduleBody) => patch<ScheduleView>(`/schedules/${id}`, body),
    delete: (id: string) => del(`/schedules/${id}`),
    /** Newest first. */
    runs: (id: string) => request<ScheduleRun[]>(`/schedules/${id}/runs`),
    run: (id: string) => post<ScheduleRun>(`/schedules/${id}/run`),
  },

  claude: {
    /** The Claude login's plan usage (Deck #825), null when there's no plan to show. `refresh` asks for a fresher reading, as after a reply. */
    planUsage: (refresh = false, account?: string) => {
      const q = [...(account ? [`account=${encodeURIComponent(account)}`] : []), ...(refresh ? ['refresh=1'] : [])];
      return request<{ usage: PlanUsage | null }>(`/claude/plan-usage${q.length ? `?${q.join('&')}` : ''}`);
    },
    /** Claude account logins: each its own config folder. Main comes first. */
    accounts: {
      list: () => request<{ accounts: AccountView[] }>('/claude/accounts'),
      add: (body: { name: string; colour: string; configDir?: string }) => post<{ account: AccountView }>('/claude/accounts', body),
      update: (slug: string, body: { colour: string }) => patch<{ account: AccountView }>(`/claude/accounts/${encodeURIComponent(slug)}`, body),
      remove: (slug: string) => del(`/claude/accounts/${encodeURIComponent(slug)}`),
      /** Starts the CLI's sign-in (202); `url` is the page to open, null if none came. */
      signIn: (slug: string) => post<{ url: string | null }>(`/claude/accounts/${encodeURIComponent(slug)}/sign-in`),
      /** The code the sign-in page shows, for a CLI that can't be reached by its callback. */
      submitCode: (slug: string, code: string) => post<void>(`/claude/accounts/${encodeURIComponent(slug)}/sign-in/code`, { code }),
      signOut: (slug: string) => post<void>(`/claude/accounts/${encodeURIComponent(slug)}/sign-out`),
    },
  },

  artifacts: {
    list: (chatId: string) => request<{ artifacts: ArtifactSummary[] }>(`/chats/${chatId}/artifacts`),
    get: (chatId: string, artifactId: string) => request<ArtifactDetail>(`/chats/${chatId}/artifacts/${artifactId}`),
    version: (chatId: string, artifactId: string, versionId: string) => request<ArtifactVersion>(`/chats/${chatId}/artifacts/${artifactId}/versions/${versionId}`),
    edit: (chatId: string, artifactId: string, body: { content: string; title?: string; fromVersionId?: string }) => put<ArtifactVersion>(`/chats/${chatId}/artifacts/${artifactId}`, body),
    save: (chatId: string, artifactId: string, body: { versionId: string; path: string; replace?: boolean }) => post<{ path: string }>(`/chats/${chatId}/artifacts/${artifactId}/save`, body),
    /** The version as the file it downloads as (spec 2026-10-12-office-files §4): the made .docx/.xlsx/.pptx, or the text. */
    file: async (chatId: string, artifactId: string, versionId: string): Promise<Blob> => {
      const res = await apiFetch(`/chats/${chatId}/artifacts/${artifactId}/versions/${versionId}/file`);
      if (!res.ok) throw new ApiError(res.status, await extractErrorMessage(res));
      return res.blob();
    },
    live: {
      status: (chatId: string, artifactId: string, versionId: string) => request<LiveStatus>(`/chats/${chatId}/artifacts/${artifactId}/versions/${versionId}/live`),
      allow: (chatId: string, artifactId: string, versionId: string) => post<LiveStatus>(`/chats/${chatId}/artifacts/${artifactId}/versions/${versionId}/live/allow`, {}),
      revoke: (chatId: string, artifactId: string) => del(`/chats/${chatId}/artifacts/${artifactId}/live`),
      call: (chatId: string, artifactId: string, versionId: string, callId: string, body: { params?: Record<string, unknown>; fresh?: boolean }) =>
        post<LiveOutcome>(`/chats/${chatId}/artifacts/${artifactId}/versions/${versionId}/live/calls/${encodeURIComponent(callId)}`, body),
    },
  },
  view: {
    open: (chatId: string, path: string) => post<ViewOpened>('/view/links', { chatId, path }),
    openArtifact: (chatId: string, artifactVersionId: string) => post<ViewOpened>('/view/links', { chatId, artifactVersionId }),
    text: (chatId: string, path: string) => request<ViewText>(`/view/text?chatId=${encodeURIComponent(chatId)}&path=${encodeURIComponent(path)}`),
    roots: (chatId: string) => request<{ roots: ViewRoot[] }>(`/view/dirs?chatId=${encodeURIComponent(chatId)}`),
    dir: (chatId: string, path: string) => request<{ path: string; entries: ViewEntry[] }>(`/view/dirs?chatId=${encodeURIComponent(chatId)}&path=${encodeURIComponent(path)}`),
  },
  browser: {
    state: (chatId: string) => request<BrowserLiveState>(`/chats/${chatId}/browser`),
    close: (chatId: string) => del(`/chats/${chatId}/browser`),
  },

  turns: {
    create: (chatId: string, body: CreateTurnBody) => post<TurnResult>(`/chats/${chatId}/turns`, body),
    cancel: (messageId: string) => post<void>(`/messages/${messageId}/cancel`),
    retry: (messageId: string) => post<{ messageId: string }>(`/messages/${messageId}/retry`),
    setHead: (chatId: string, messageId: string) => post<Chat>(`/chats/${chatId}/head`, { messageId }),
    /** One more reply under the user message `messageId` answers, by the profile that wrote `messageId` (or `profileId`). Makes the new reply the head. */
    regenerate: (chatId: string, messageId: string, profileId?: string) =>
      post<RegenerateResult>(`/chats/${chatId}/regenerate`, { messageId, ...(profileId ? { profileId } : {}) }),
  },

  mcpServers: {
    /** Live health only (status/toolCount/lastError) -- NOT full config (no command/args/url/env/headers). See `get` below for that. */
    list: () => request<McpServerHealth[]>('/mcp-servers'),
    /** Full stored config for one server, for the edit form -- `envRefs`/`headerRefs` are reference ids, never the plaintext values they point at. */
    get: (id: string) => request<McpServer>(`/mcp-servers/${id}`),
    create: (body: CreateMcpServerBody) => post<McpServer>('/mcp-servers', body),
    patch: (id: string, body: Partial<CreateMcpServerBody>) => patch<McpServer>(`/mcp-servers/${id}`, body),
    delete: (id: string) => del(`/mcp-servers/${id}`),
    refresh: (id: string) => post<void>(`/mcp-servers/${id}/refresh`),
    /** Starts a browser sign-in (spec 2026-10-12-mcp-oauth-design §6); the caller opens `authorizationUrl`. */
    signIn: (id: string) => post<{ authorizationUrl: string }>(`/mcp-servers/${id}/sign-in`),
    cancelSignIn: (id: string) => post<void>(`/mcp-servers/${id}/sign-in/cancel`),
    /** Paste-back: finishes a sign-in from the address a browser on another device ended on. */
    completeSignIn: (id: string, url: string) => post<{ signedIn: true }>(`/mcp-servers/${id}/sign-in/complete`, { url }),
    /** Forgets the sign-in here; the provider isn't told. */
    signOut: (id: string) => post<void>(`/mcp-servers/${id}/sign-out`),
    signInRedirectUri: () => request<{ redirectUri: string | null }>('/mcp-servers/sign-in/redirect-uri'),
    /** The MCP servers in Claude Desktop's config: names, commands and the NAMES of their env vars and headers, never the values. */
    claudeDesktop: () => request<ClaudeDesktopListing>('/mcp-servers/import/claude-desktop'),
    /** Imports the named servers; their env and header values go server-side into the secret store. */
    /** Imports the named servers, and turns the ones imported on for `profileIds`. */
    importClaudeDesktop: (names: string[], profileIds: string[]) => post<ClaudeDesktopImportResult>('/mcp-servers/import/claude-desktop', { names, profileIds }),
  },

  grants: {
    /** Chat-scoped grants for `chatId` PLUS every global ('always') grant -- see routes/tools.ts for why both belong in one "active for this chat" view. */
    list: (chatId: string) => request<Grant[]>(`/chats/${chatId}/grants`),
    revoke: (id: string) => del(`/grants/${id}`),
  },

  audit: {
    list: (chatId: string) => request<AuditEntry[]>(`/chats/${chatId}/audit`),
  },

  approvals: {
    resolve: (requestId: string, choice: ApprovalChoice) => post<{ resolved: boolean }>(`/approvals/${requestId}/resolve`, choice),
  },

  asks: {
    /** Answers a question or plan card; 404 once it's settled, 400 when the reply doesn't fit it. */
    answer: (askId: string, reply: AskReply) => post<{ answered: boolean }>(`/asks/${askId}/answer`, reply),
  },

  notes: {
    /** Sends a message while a reply runs; 409 `kind` `idle` means nothing is running (send it as a normal turn). */
    send: async (chatId: string, body: SendNoteBody): Promise<ReplyNote> => (await post<{ note: ReplyNote }>(`/chats/${chatId}/notes`, body)).note,
    /** Takes a waiting note back; null when Claude has already read it or it has gone out (409 `read`). */
    withdraw: async (chatId: string, noteId: string): Promise<ReplyNote | null> => {
      try {
        return (await request<{ note: ReplyNote }>(`/chats/${chatId}/notes/${noteId}`, { method: 'DELETE' })).note;
      } catch (err) {
        if (err instanceof ApiError && err.status === 409 && err.kind === 'read') return null;
        throw err;
      }
    },
  },

  attachments: {
    upload: (chatId: string, file: File) => uploadFile<PublicAttachment>(`/chats/${chatId}/attachments`, file),
    list: (chatId: string) => request<PublicAttachment[]>(`/chats/${chatId}/attachments`),
    /** Attaches an image straight from a path on this machine (desktop `--send`). Images only, 25MB cap. */
    fromPath: (chatId: string, path: string) => post<PublicAttachment>(`/chats/${chatId}/attachments/from-path`, { path }),
    /**
     * Deletes an UNSENT attachment (server-enforced: 409 if it's already
     * part of a sent message -- see routes/attachments.ts decision #1).
     * Removes the row and, unless another attachment row still shares its
     * content hash, its on-disk blob too.
     */
    delete: (id: string) => del(`/attachments/${id}`),
    /** Not fetched via `request` -- rendered through `AuthedImage`, which adds the token when there is one. */
    contentUrl: (id: string) => apiUrl(`/attachments/${id}/content`),
    /**
     * An image a tool returned (a screenshot), by the chat and the reply that hold
     * it -- the server serves it only for that exact pair, and as a 404 otherwise.
     * Use this, not `contentUrl`, for the images in a tool result.
     */
    toolImageUrl: (chatId: string, messageId: string, attachmentId: string) =>
      apiUrl(`/chats/${encodeURIComponent(chatId)}/messages/${encodeURIComponent(messageId)}/tool-images/${encodeURIComponent(attachmentId)}`),
    /** The same scoped route serves a tool's video (it supports Range). */
    toolMediaUrl: (chatId: string, messageId: string, attachmentId: string) =>
      apiUrl(`/chats/${encodeURIComponent(chatId)}/messages/${encodeURIComponent(messageId)}/tool-images/${encodeURIComponent(attachmentId)}`),
    /**
     * True only for the narrow raster-image allowlist that
     * `GET /attachments/:id/content` (packages/server/src/routes/
     * attachments.ts's `INLINE_SAFE_MIME_TYPES`) will actually serve
     * `inline` with its real Content-Type -- kept in sync with that
     * allowlist deliberately. Everything else, including `image/svg+xml`
     * (SVG can carry script, so it's excluded there on purpose), now comes
     * back as an opaque `application/octet-stream` download regardless of
     * the mime string, so pointing an `<img src>` at it would only ever
     * show a broken-image icon -- callers should gate any inline preview
     * on this instead of a bare `mime.startsWith('image/')` check.
     */
    previewable: (mime: string): boolean => INLINE_PREVIEWABLE_MIME_TYPES.has((mime.split(';')[0] ?? '').trim().toLowerCase()),
  },

  /** Not fetched via `request` -- opened by `state/sse.ts`'s streaming reader. */
  streamUrl: (chatId: string) => apiUrl(`/chats/${chatId}/stream`),
  /** The app-wide event stream (v2 plan, Task 34). */
  eventsUrl: () => apiUrl('/events'),
};
