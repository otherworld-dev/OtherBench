/** Tool calls and shapes: MCP servers, grants, the audit trail, approvals and asks. */
import type { AuditEntry, Grant, McpServer } from '@otherbench/core/ports/store.js';
import type { ApprovalChoice, AskReply } from '@otherbench/core/ports/tool-provider.js';
import type { Profile } from '@otherbench/core/types/config.js';
import type { McpServerHealth } from '@otherbench/tools/mcp/manager.js';
import { request, post, patch, del } from './http.js';

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

export const mcpServersApi = {
  /**
   * Live health only (status/toolCount/lastError) -- NOT full config (no command/args/url/env/headers). See `get` below for that.
   * With `chatId`, those of the machine the chat runs on (the server asks a paired machine for them), as `refresh` reconnects there.
   */
  list: (chatId?: string) => request<McpServerHealth[]>(chatId === undefined ? '/mcp-servers' : `/chats/${chatId}/mcp-servers`),
  /** Full stored config for one server, for the edit form -- `envRefs`/`headerRefs` are reference ids, never the plaintext values they point at. */
  get: (id: string) => request<McpServer>(`/mcp-servers/${id}`),
  create: (body: CreateMcpServerBody) => post<McpServer>('/mcp-servers', body),
  patch: (id: string, body: Partial<CreateMcpServerBody>) => patch<McpServer>(`/mcp-servers/${id}`, body),
  delete: (id: string) => del(`/mcp-servers/${id}`),
  refresh: (id: string, chatId?: string) => post<void>(chatId === undefined ? `/mcp-servers/${id}/refresh` : `/chats/${chatId}/mcp-servers/${id}/refresh`),
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
};

export const grantsApi = {
  /**
   * Chat-scoped grants for `chatId` PLUS every global ('always') grant -- see routes/tools.ts for why both belong in one
   * "active for this chat" view. Those of the machine the chat runs on, as are its audit trail's.
   */
  list: (chatId: string) => request<Grant[]>(`/chats/${chatId}/grants`),
  /** With `chatId`, revoked on the machine the chat runs on: only a grant that chat lists. */
  revoke: (id: string, chatId?: string) => del(chatId === undefined ? `/grants/${id}` : `/chats/${chatId}/grants/${id}`),
};

export const auditApi = {
  list: (chatId: string) => request<AuditEntry[]>(`/chats/${chatId}/audit`),
};

export const approvalsApi = {
  resolve: (requestId: string, choice: ApprovalChoice) => post<{ resolved: boolean }>(`/approvals/${requestId}/resolve`, choice),
};

export const asksApi = {
  /** Answers a question or plan card; 404 once it's settled, 400 when the reply doesn't fit it. */
  answer: (askId: string, reply: AskReply) => post<{ answered: boolean }>(`/asks/${askId}/answer`, reply),
};
