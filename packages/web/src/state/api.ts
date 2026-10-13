import type { AppSettings, Artifact, ArtifactKind, ArtifactVersion, AuditEntry, Chat, GlobalMemory, GlobalMemoryVersion, Grant, McpServer, Project, ProjectMemoryVersion, PublicAttachment } from '@grunt/core/ports/store.js';
import type { MemoryFailure, MemoryUpdateOutcome, MemoryVersionSummary, ProjectMemoryView } from '@grunt/core/domain/memory.js';
import type { UsageRollup } from '@grunt/core/domain/usage-rollup.js';
import type { ApprovalChoice } from '@grunt/core/ports/tool-provider.js';
import type { ClaudeEffort, Connection, ConnectionKind, ModelInfo, ModelParams, Profile, ToolPolicy } from '@grunt/core/types/config.js';
import type { ImportPreview, ImportStart, ImportStatus } from '@grunt/core/types/claude-import.js';
import type { CanonMessage, Part } from '@grunt/core/types/messages.js';
import type { PlanUsage, RecordedUsage } from '@grunt/core/types/usage.js';
import type { FolderAccess, Location, LocationPath, NodeInfo, Workspace } from '@grunt/core/types/workspace.js';
import type { InferredMapping } from '@grunt/core/domain/workspace.js';
import type { PublicPeer } from '@grunt/core/types/peer.js';
import type { McpServerHealth } from '@grunt/tools/mcp/manager.js';
import { apiFetch, apiUrl } from './transport.js';

/** What `GET /api/auth/status` says (packages/server/src/remote/auth.ts's `AuthStatusBody`). */
export interface AuthStatus {
  mode: 'open' | 'token' | 'login';
  signedIn: boolean;
  /** Sign-in with Grunt's own certificate: the login page offers it. */
  caDownload?: boolean;
  session?: { expiresAt: number; remember: boolean };
  remote?: {
    publicUrls: string[];
    tls: { mode: 'auto' | 'files' | 'proxy'; notAfter?: number; caFingerprint?: string; names?: string[] };
    trustProxies: string[];
  };
}

export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

async function extractErrorMessage(res: Response): Promise<string> {
  const body: unknown = await res.json().catch(() => null);
  if (body && typeof body === 'object' && 'error' in body && typeof (body as { error: unknown }).error === 'string') {
    return (body as { error: string }).error;
  }
  return res.statusText || `HTTP ${res.status}`;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await apiFetch(path, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
  if (!res.ok) throw new ApiError(res.status, await extractErrorMessage(res));
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
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
export interface ArtifactSummary { id: string; slug: string; kind: ArtifactKind; language: string | null; title: string; versionId: string; number: number; madeBy: 'model' | 'user' }

/** One artifact with every version, each marked on or off the chat's branch. */
export interface ArtifactDetail {
  artifact: Artifact;
  fileName: string;
  currentVersionId: string | null;
  /** Each version is its own kind (a note made into a page), with its own file name. */
  versions: { id: string; number: number; title: string; madeBy: 'model' | 'user'; createdAt: number; onBranch: boolean; kind: ArtifactKind; language: string | null; fileName: string }[];
}
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

export interface CreateProfileBody {
  name: string;
  description?: string | null;
  colour?: string | null;
  connectionId: string;
  modelId: string;
  systemPrompt?: string | null;
  params?: ModelParams;
  toolPolicy?: ToolPolicy;
  isDefault?: boolean;
  /** Absent means on. */
  useGlobalMemory?: boolean;
}

/** `PATCH /api/profiles/:id`: any `CreateProfileBody` field, and only the `toolPolicy` fields to change (the server keeps the rest). */
export type ProfilePatchBody = Partial<Omit<CreateProfileBody, 'toolPolicy'>> & { toolPolicy?: Partial<ToolPolicy> };

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
  /** Grunt already has a server with this name. */
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
  /** Pinned at the top of its own project's group; refused (400) for a chat with no project. */
  projectPinned: boolean;
  archivedAt: number | null;
  autoMode: boolean;
  /** Claude Code's effort from the next message; null follows the user's Claude Code settings. */
  effort: ClaudeEffort | null;
  /** The chat's extra folders, the whole list (spec 2026-10-07-extra-folders). */
  folders: FolderEntry[];
  /** Moves the chat between projects (null = No project); never changes its folder or profile. */
  projectId: string | null;
  /** "Don't add to project memory": the summariser skips this chat. Never changes its place in the list. */
  memoryExcluded: boolean;
  /** Its place in its sidebar section, higher first (#823). Not chat activity: leaves updatedAt alone. */
  sortOrder: number;
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

  /** Import from claude.ai (spec 2026-10-09-claude-import-design §5): the running or last import, a preview, and a start (202). */
  claudeImport: {
    status: () => request<ImportStatus>('/import/claude'),
    preview: (folder: string, profileId: string | null) => post<ImportPreview>('/import/claude/preview', { folder, profileId }),
    start: (body: ImportStart) => post<ImportStatus>('/import/claude', body),
  },

  search: (q: string, limit?: number) =>
    request<SearchResult[]>(`/search?q=${encodeURIComponent(q)}${limit ? `&limit=${limit}` : ''}`),

  usage: {
    /** Omit `chatId` for the global (every-chat) rollup the usage/pricing settings view shows. */
    get: (chatId?: string) => request<UsageRollup>(`/usage${chatId ? `?chatId=${encodeURIComponent(chatId)}` : ''}`),
  },

  claude: {
    /** The Claude login's plan usage (Deck #825), null when there's no plan to show. `refresh` asks for a fresher reading, as after a reply. */
    planUsage: (refresh = false) => request<{ usage: PlanUsage | null }>(`/claude/plan-usage${refresh ? '?refresh=1' : ''}`),
  },

  artifacts: {
    list: (chatId: string) => request<{ artifacts: ArtifactSummary[] }>(`/chats/${chatId}/artifacts`),
    get: (chatId: string, artifactId: string) => request<ArtifactDetail>(`/chats/${chatId}/artifacts/${artifactId}`),
    version: (chatId: string, artifactId: string, versionId: string) => request<ArtifactVersion>(`/chats/${chatId}/artifacts/${artifactId}/versions/${versionId}`),
    edit: (chatId: string, artifactId: string, body: { content: string; title?: string; fromVersionId?: string }) => put<ArtifactVersion>(`/chats/${chatId}/artifacts/${artifactId}`, body),
    save: (chatId: string, artifactId: string, body: { versionId: string; path: string; replace?: boolean }) => post<{ path: string }>(`/chats/${chatId}/artifacts/${artifactId}/save`, body),
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
