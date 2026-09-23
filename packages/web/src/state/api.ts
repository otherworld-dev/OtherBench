import type { AuditEntry, Chat, Grant, McpServer, PublicAttachment } from '@grunt/core/ports/store.js';
import type { UsageRollup } from '@grunt/core/domain/usage-rollup.js';
import type { ApprovalChoice } from '@grunt/core/ports/tool-provider.js';
import type { Connection, ConnectionKind, ModelInfo, ModelParams, Profile, ToolPolicy } from '@grunt/core/types/config.js';
import type { CanonMessage, Part } from '@grunt/core/types/messages.js';
import type { McpServerHealth } from '@grunt/tools/mcp/manager.js';

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
  const res = await fetch(`/api${path}`, {
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
  const res = await fetch(`/api${path}`, { method: 'POST', body: form });
  if (!res.ok) throw new ApiError(res.status, await extractErrorMessage(res));
  return (await res.json()) as T;
}

export interface CreateConnectionBody {
  name: string;
  kind: ConnectionKind;
  baseUrl?: string | null;
  apiKey?: string | null;
  extraHeaders?: Record<string, string>;
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
}

export interface CreateChatBody {
  title?: string;
  profileId: string;
  workspaceRoot?: string | null;
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

export interface ChatMessagesResult {
  messages: CanonMessage[];
  headMessageId: string | null;
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
    patch: (id: string, body: Partial<CreateProfileBody>) => patch<Profile>(`/profiles/${id}`, body),
    delete: (id: string) => del(`/profiles/${id}`),
  },

  chats: {
    list: () => request<Chat[]>('/chats'),
    create: (body: CreateChatBody) => post<Chat>('/chats', body),
    get: (id: string) => request<Chat>(`/chats/${id}`),
    patch: (id: string, body: Partial<{ title: string; profileId: string; workspaceRoot: string | null; pinned: boolean; archivedAt: number | null }>) =>
      patch<Chat>(`/chats/${id}`, body),
    delete: (id: string) => del(`/chats/${id}`),
    messages: (id: string) => request<ChatMessagesResult>(`/chats/${id}/messages`),
  },

  search: (q: string, limit?: number) =>
    request<SearchResult[]>(`/search?q=${encodeURIComponent(q)}${limit ? `&limit=${limit}` : ''}`),

  usage: {
    /** Omit `chatId` for the global (every-chat) rollup the usage/pricing settings view shows. */
    get: (chatId?: string) => request<UsageRollup>(`/usage${chatId ? `?chatId=${encodeURIComponent(chatId)}` : ''}`),
  },

  turns: {
    create: (chatId: string, body: CreateTurnBody) => post<TurnResult>(`/chats/${chatId}/turns`, body),
    cancel: (messageId: string) => post<void>(`/messages/${messageId}/cancel`),
    retry: (messageId: string) => post<{ messageId: string }>(`/messages/${messageId}/retry`),
    setHead: (chatId: string, messageId: string) => post<Chat>(`/chats/${chatId}/head`, { messageId }),
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
    /**
     * Deletes an UNSENT attachment (server-enforced: 409 if it's already
     * part of a sent message -- see routes/attachments.ts decision #1).
     * Removes the row and, unless another attachment row still shares its
     * content hash, its on-disk blob too.
     */
    delete: (id: string) => del(`/attachments/${id}`),
    /** Not fetched via `request` -- consumed directly as an `<img src>`/download URL. */
    contentUrl: (id: string) => `/api/attachments/${id}/content`,
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

  /** Not fetched via `request` -- consumed directly by `state/sse.ts` as an `EventSource` URL. */
  streamUrl: (chatId: string) => `/api/chats/${chatId}/stream`,
};
