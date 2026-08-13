import type { Chat } from '@grunt/core/ports/store.js';
import type { UsageRollup } from '@grunt/core/domain/usage-rollup.js';
import type { Connection, ConnectionKind, ModelInfo, ModelParams, Profile, ToolPolicy } from '@grunt/core/types/config.js';
import type { CanonMessage, Part } from '@grunt/core/types/messages.js';

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

/**
 * Thin typed wrapper over `/api/*`. Every shape here is read off the actual
 * route handlers in packages/server/src/routes/*.ts (task 19/20 brief:
 * "read the API surface you are consuming... do not guess"), not
 * reconstructed from the briefs.
 */
export const api = {
  health: () => request<{ status: string; time: string }>('/health'),

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

  /** Not fetched via `request` -- consumed directly by `state/sse.ts` as an `EventSource` URL. */
  streamUrl: (chatId: string) => `/api/chats/${chatId}/stream`,
};
