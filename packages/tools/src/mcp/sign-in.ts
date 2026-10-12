import { randomBytes } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { McpServer } from '@grunt/core/ports/store.js';
import { GruntOAuthProvider, hasAuthorizationHeader } from './oauth-provider.js';
import type { McpOAuthStore } from './oauth-store.js';

export type SignInStatus = 400 | 404 | 409 | 502 | 503;

/** A sign-in that can't go ahead, with the HTTP status the routes answer with. Its message is safe to show: never a code, token or URL. */
export class SignInError extends Error {
  constructor(
    readonly status: SignInStatus,
    message: string
  ) {
    super(message);
    this.name = 'SignInError';
  }
}

const DEFAULT_SIGN_IN_TIMEOUT_MS = 600_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

/** A provider's error code, reduced to [A-Za-z0-9_.-] and 64 characters before it is shown or stored. */
export function sanitiseErrorCode(code: string): string {
  return code.replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 64);
}

/** The browser is only ever sent to https, or to http on this machine (tests and local development). */
export function checkAuthorizationUrl(url: URL): void {
  if (url.protocol === 'https:') return;
  if (url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname)) return;
  throw new SignInError(502, "The sign-in provider gave an address Grunt won't open: it must be https.");
}

function fetchWithTimeout(ms: number): FetchLike {
  return (url, init) => {
    const timeout = AbortSignal.timeout(ms);
    return fetch(url, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout });
  };
}

function startFailureMessage(err: unknown, redirectUri: string): string {
  const message = err instanceof Error ? err.message : String(err);
  if (/does not support dynamic client registration/i.test(message)) {
    return `This server's sign-in provider doesn't let apps register themselves. Register Grunt with it (redirect address: ${redirectUri}) and enter the client ID under Sign-in app.`;
  }
  return `Couldn't start the sign-in: ${message}`;
}

interface PendingFlow {
  serverId: string;
  transport: StreamableHTTPClientTransport;
  expiresAt: number;
}

export interface McpSignInsOptions {
  now?: () => number;
  signInTimeoutMs?: number;
  requestTimeoutMs?: number;
}

/**
 * Browser sign-ins waiting for their redirect (spec 2026-10-12-mcp-oauth-design §5).
 * Keyed by `state` (32 random bytes): each flow is bound to one server,
 * single use, expires after 10 minutes, and a new start for a server
 * replaces its old flow. Expired flows are swept on each start and
 * completion; there is no timer. PKCE verifiers and discovery results live
 * on each flow's provider, in memory only.
 */
export class McpSignIns {
  private readonly flows = new Map<string, PendingFlow>();
  private readonly errors = new Map<string, string>();
  private readonly now: () => number;
  private readonly signInTimeoutMs: number;
  private readonly requestTimeoutMs: number;

  constructor(
    private readonly oauth: McpOAuthStore,
    options: McpSignInsOptions = {}
  ) {
    this.now = options.now ?? Date.now;
    this.signInTimeoutMs = options.signInTimeoutMs ?? DEFAULT_SIGN_IN_TIMEOUT_MS;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  }

  /** Starts a flow and returns the address to open in the browser. `headers` are the row's resolved headers (it has no Authorization header). */
  async start(row: McpServer, redirectUri: string, headers: Record<string, string>): Promise<{ authorizationUrl: string }> {
    if (row.transport !== 'http' || !row.url) throw new SignInError(400, 'Only an http server with a URL can sign in.');
    if (hasAuthorizationHeader(row)) {
      throw new SignInError(409, 'This server sends a fixed Authorization header. Remove it to sign in with a browser instead.');
    }
    this.sweep();
    this.cancel(row.id);
    this.errors.delete(row.id);

    const state = randomBytes(32).toString('base64url');
    const captured: { url: URL | null } = { url: null };
    const provider = new GruntOAuthProvider(row.id, this.oauth, {
      kind: 'sign-in',
      redirectUri,
      state,
      onAuthorizationUrl: (url) => {
        captured.url = url;
      },
    });
    const transport = new StreamableHTTPClientTransport(new URL(row.url), {
      authProvider: provider,
      requestInit: Object.keys(headers).length > 0 ? { headers } : undefined,
      fetch: fetchWithTimeout(this.requestTimeoutMs),
    });
    const client = new Client({ name: 'grunt', version: '1.0.0' }, { capabilities: {} });
    try {
      await client.connect(transport);
    } catch (err) {
      if (err instanceof UnauthorizedError && captured.url) {
        checkAuthorizationUrl(captured.url);
        this.flows.set(state, { serverId: row.id, transport, expiresAt: this.now() + this.signInTimeoutMs });
        return { authorizationUrl: captured.url.href };
      }
      console.warn(`[McpSignIns] couldn't start the sign-in for MCP server ${row.id}.`);
      throw new SignInError(502, startFailureMessage(err, redirectUri));
    }
    await client.close().catch(() => {});
    throw new SignInError(409, "This server didn't ask for a sign-in.");
  }

  /** Finishes the flow named by `state`. `serverId` (paste-back) must match the flow's server, or the flow is left untouched. */
  async complete(params: { serverId?: string; state: string; code?: string; error?: string }): Promise<{ serverId: string }> {
    this.sweep();
    const flow = this.flows.get(params.state);
    if (!flow) throw new SignInError(400, 'This sign-in has expired or was already used. Start it again from Grunt.');
    if (params.serverId !== undefined && params.serverId !== flow.serverId) {
      throw new SignInError(400, 'That address belongs to a sign-in for another server.');
    }
    this.flows.delete(params.state); // single use, before any network call
    if (params.error !== undefined) return this.fail(flow.serverId, 400, `The sign-in provider said: ${sanitiseErrorCode(params.error) || 'unknown_error'}`);
    if (!params.code) return this.fail(flow.serverId, 400, "The sign-in provider didn't send a code back.");
    try {
      await flow.transport.finishAuth(params.code);
    } catch (err) {
      return this.fail(flow.serverId, 502, `Couldn't finish the sign-in: ${err instanceof Error ? err.message : String(err)}`);
    }
    this.errors.delete(flow.serverId);
    return { serverId: flow.serverId };
  }

  cancel(serverId: string): void {
    for (const [state, flow] of this.flows) if (flow.serverId === serverId) this.flows.delete(state);
  }

  pending(serverId: string): boolean {
    const now = this.now();
    for (const flow of this.flows.values()) if (flow.serverId === serverId && flow.expiresAt > now) return true;
    return false;
  }

  lastError(serverId: string): string | null {
    return this.errors.get(serverId) ?? null;
  }

  dropAll(): void {
    this.flows.clear();
  }

  private sweep(): void {
    const now = this.now();
    for (const [state, flow] of this.flows) if (flow.expiresAt <= now) this.flows.delete(state);
  }

  private fail(serverId: string, status: SignInStatus, message: string): never {
    this.errors.set(serverId, message);
    console.warn(`[McpSignIns] the sign-in for MCP server ${serverId} failed.`);
    throw new SignInError(status, message);
  }
}
