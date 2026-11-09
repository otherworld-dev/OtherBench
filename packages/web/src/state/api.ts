/**
 * The web client's REST API. The calls and their shapes live by area in `./api/`; this module puts them together as
 * `api` and re-exports every shape, so components (and every `vi.mock` of this path) import from here only, never from
 * `./api/*` directly.
 */
import { streamApiUrl } from './transport.js';
import { request } from './api/http.js';
import { authApi, pushApi } from './api/auth.js';
import { connectionsApi, mediaWorkflowsApi, modelsApi } from './api/connections.js';
import { profilesApi } from './api/profiles.js';
import { chatsApi, chatSendsApi, computerApi, notesApi, search, searchChats, turnsApi } from './api/chats.js';
import { memoryApi, projectsApi } from './api/projects.js';
import { overviewApi } from './api/overview.js';
import { nextcloudApi } from './api/nextcloud.js';
import { appFoldersApi, appNotesApi, appsApi, terminalsApi } from './api/code.js';
import { locationsApi, nodeApi, peersApi } from './api/machines.js';
import { claudeApi, claudeImportApi, sandboxApi, settingsApi, usageApi } from './api/settings.js';
import { schedulesApi } from './api/schedules.js';
import { artifactsApi } from './api/artifacts.js';
import { viewApi } from './api/view.js';
import { browserApi } from './api/browser.js';
import { approvalsApi, asksApi, auditApi, grantsApi, mcpServersApi } from './api/tools.js';
import { attachmentsApi } from './api/attachments.js';

export { ApiError } from './api/http.js';
export type { AuthStatus, PushPrefs, PushStatus, SignedInDevice } from './api/auth.js';
export type { CreateConnectionBody, MediaModelsResult } from './api/connections.js';
export type { CreateProfileBody, ProfilePatchBody, ToolPolicyBody } from './api/profiles.js';
export type { ChatMessagesResult, ChatPatchBody, CreateChatBody, CreateTurnBody, RegenerateResult, SearchResult, SendNoteBody, TurnResult } from './api/chats.js';
export type { CreateProjectBody, FolderEntry, GlobalMemoryView, PatchProjectBody } from './api/projects.js';
export type { CodeErrorCode, CreateAppBody, DetectRepoResult, GitBranch, PatchAppBody } from './api/code.js';
export type { AdoptLocationBody, InferLocationResult, LocationView, PairingView, PeersOverview, PeerView, VersionMismatchView } from './api/machines.js';
export type { CreateScheduleBody, PatchScheduleBody } from './api/schedules.js';
export type { ArtifactDetail, ArtifactSummary, LiveOutcome, LiveStatus } from './api/artifacts.js';
export type { ViewEntry, ViewKind, ViewOpened, ViewRoot, ViewText } from './api/view.js';
export type { BrowserLiveEvent, BrowserLiveState, BrowserPanelInput } from './api/browser.js';
export type { ClaudeDesktopImportResult, ClaudeDesktopListing, ClaudeDesktopServerView, CreateMcpServerBody } from './api/tools.js';

/**
 * Thin typed wrapper over `/api/*`. Every shape here is read off the actual
 * route handlers in packages/server/src/routes/*.ts (task 19/20 brief:
 * "read the API surface you are consuming... do not guess"), not
 * reconstructed from the briefs.
 */
export const api = {
  /** `platform` is the SERVER's `process.platform` (e.g. "win32"), not the browser's -- see routes/health.ts. Used to validate a chat's workspace root against the OS that will actually resolve it. */
  health: () => request<{ status: string; time: string; platform: string }>('/health'),
  auth: authApi,
  push: pushApi,

  connections: connectionsApi,

  mediaWorkflows: mediaWorkflowsApi,

  models: modelsApi,

  profiles: profilesApi,

  chats: chatsApi,

  computer: computerApi,

  projects: projectsApi,

  overview: overviewApi,

  nextcloud: nextcloudApi,

  appFolders: appFoldersApi,

  apps: appsApi,

  terminals: terminalsApi,

  memory: memoryApi,

  appNotes: appNotesApi,

  locations: locationsApi,

  peers: peersApi,

  node: nodeApi,

  settings: settingsApi,

  sandbox: sandboxApi,

  claudeImport: claudeImportApi,

  search,
  searchChats,

  usage: usageApi,

  chatSends: chatSendsApi,

  schedules: schedulesApi,

  claude: claudeApi,

  artifacts: artifactsApi,
  view: viewApi,
  browser: browserApi,

  turns: turnsApi,

  mcpServers: mcpServersApi,

  grants: grantsApi,

  audit: auditApi,

  approvals: approvalsApi,

  asks: asksApi,

  notes: notesApi,

  attachments: attachmentsApi,

  /** Not fetched via `request` -- opened by `state/sse.ts`'s streaming reader. */
  streamUrl: (chatId: string) => streamApiUrl(`/chats/${chatId}/stream`),
  /** The app-wide event stream (v2 plan, Task 34). */
  eventsUrl: () => streamApiUrl('/events'),
};
