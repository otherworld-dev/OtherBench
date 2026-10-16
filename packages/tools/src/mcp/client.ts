import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, type StdioServerParameters } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { FetchLike, Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import { isSignInRequired, SIGN_IN_REQUIRED_MESSAGE } from './oauth-provider.js';
import { looksSecret, redactMessage } from './redact.js';
import { sameOrigin } from './url.js';
import { resolveExecutable } from './spawn.js';
import { withoutServerSecrets } from '@otherbench/core/domain/child-env.js';

export type McpTransportConfig =
  | { transport: 'stdio'; command: string; args: string[]; env: Record<string, string> }
  | {
      transport: 'http';
      url: string;
      headers: Record<string, string>;
      /** Sign-in (spec 2026-10-12-mcp-oauth-design §4): attached by `McpServerManager` to http servers without a fixed Authorization header. */
      authProvider?: OAuthClientProvider;
      /** Secret strings the provider holds right now (tokens), so an error that echoes one is redacted before `lastError` shows it. */
      secrets?: () => string[];
    };

export interface McpToolDescriptor {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** MCP's own behaviour hints, when the server declares them -- used by `@otherbench/tools`'s `provider.ts` to classify risk (e.g. `readOnlyHint` -> our 'read' RiskClass). */
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
}

/** `needs_auth`: the server answered 401 and only a browser sign-in can fix it. No reconnect is scheduled; `refresh()` starts over. */
export type McpStatus = 'connecting' | 'ok' | 'error' | 'needs_auth';

export const NEEDS_SIGN_IN_CALL_MESSAGE = 'This MCP server needs you to sign in again (Settings > MCP servers).';

export interface McpCallResult {
  content: unknown;
  isError: boolean;
  /** The result's `structuredContent`, when the server sent one (live artifacts pass it to the page). */
  structured?: unknown;
}

/** Per-call options: the caller's abort signal and a timeout, passed to the SDK's own request options. */
export interface McpCallOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface McpClientOptions {
  /** How often (ms) a healthy connection is re-verified by re-listing tools. Default 30_000 (task 25 brief). */
  healthCheckIntervalMs?: number;
  /** Initial reconnect backoff in ms, doubling on each further consecutive failure. Default 1_000. */
  initialBackoffMs?: number;
  /** Reconnect backoff cap in ms. Default 60_000 (task 25 brief). */
  maxBackoffMs?: number;
  /** Overridable timer primitives so tests don't wait real seconds/minutes for health-check/backoff timing. */
  setTimeout?: typeof setTimeout;
  clearTimeout?: typeof clearTimeout;
}

const DEFAULT_HEALTH_CHECK_INTERVAL_MS = 30_000;
const DEFAULT_INITIAL_BACKOFF_MS = 1_000;
const DEFAULT_MAX_BACKOFF_MS = 60_000;

/**
 * A fetch that adds an http server's configured headers only to requests for
 * the MCP server's own origin. They are not passed as the transport's
 * `requestInit`, because the SDK's `auth()` merges those into discovery,
 * registration and token requests, which go to whatever authorization server
 * the server's metadata names: a configured `X-Api-Key` must not follow them
 * there. A configured header replaces the SDK's own of the same name, as
 * `requestInit` did.
 */
export function fetchWithServerHeaders(serverUrl: string, headers: Record<string, string>, base: FetchLike = (url, init) => fetch(url, init)): FetchLike {
  if (Object.keys(headers).length === 0) return base;
  return (url, init) => {
    // Compared by `url.ts` (parsed, normalised; userinfo refused): origin is origin, whatever the path.
    if (!sameOrigin(url, serverUrl)) return base(url, init);
    const merged = new Headers(init?.headers);
    for (const [name, value] of Object.entries(headers)) merged.set(name, value);
    return base(url, { ...init, headers: merged });
  };
}

interface RawListedTool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
}

function mapTools(tools: RawListedTool[]): McpToolDescriptor[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description ?? '',
    inputSchema: t.inputSchema,
    readOnlyHint: t.annotations?.readOnlyHint,
    destructiveHint: t.annotations?.destructiveHint,
  }));
}

/**
 * Owns the lifecycle of ONE MCP server connection: connect, list + cache
 * tools, health-check every `healthCheckIntervalMs` (default 30s), and
 * reconnect with exponential backoff (default 1s, doubling, capped at 60s)
 * whenever the connection is lost -- whether that loss is discovered by a
 * failed health check or reported eagerly by the transport itself (e.g. a
 * stdio child process dying, which fires `onclose`/`onerror` immediately
 * rather than waiting for the next scheduled health check).
 *
 * Deliberately does not build on MCP protocol-level sessions: a fresh
 * `Client` + `Transport` pair is created on every (re)connect rather than
 * attempting to resume a prior session via `Mcp-Session-Id` continuity (both
 * removed/deprecated as of protocol revision 2026-07-28 per this task's
 * brief -- see task-25-26-report.md for how that compares to this installed
 * SDK's own `LATEST_PROTOCOL_VERSION`). Nor does it declare or use sampling:
 * `ClientCapabilities` is left empty.
 *
 * `connectSeq` guards every async continuation (a connect attempt's success
 * path, a health check's result, an unexpected-close callback) against
 * acting on a now-stale generation -- e.g. `disconnect()` called while a
 * `connect()` is still in flight, or a health check's `listTools()` resolving
 * after a `refresh()` already tore down and rebuilt the connection. Every
 * such continuation captures the sequence number in effect when it started
 * and compares it against the current one before mutating any state.
 */
export class McpClient {
  status: McpStatus = 'connecting';
  lastError: string | null = null;
  tools: McpToolDescriptor[] = [];

  private client: Client | null = null;
  private readonly listeners = new Set<(status: McpStatus, error: string | null) => void>();
  private healthTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private backoffMs: number;
  private closed = true;
  private connectSeq = 0;

  private readonly healthCheckIntervalMs: number;
  private readonly initialBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly setTimeoutFn: typeof setTimeout;
  private readonly clearTimeoutFn: typeof clearTimeout;

  constructor(
    public readonly id: string,
    private readonly config: McpTransportConfig,
    options: McpClientOptions = {}
  ) {
    this.healthCheckIntervalMs = options.healthCheckIntervalMs ?? DEFAULT_HEALTH_CHECK_INTERVAL_MS;
    this.initialBackoffMs = options.initialBackoffMs ?? DEFAULT_INITIAL_BACKOFF_MS;
    this.maxBackoffMs = options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
    this.backoffMs = this.initialBackoffMs;
    this.setTimeoutFn = options.setTimeout ?? setTimeout;
    this.clearTimeoutFn = options.clearTimeout ?? clearTimeout;
  }

  /**
   * An error's text as `lastError` (and so the Inspector) or a failed tool call
   * may show it. A response body or header an SDK error embeds can carry a token
   * or a fixed credential, so the provider's tokens and every configured header
   * and env value that looks like a secret (`looksSecret`) are redacted.
   */
  private errorMessage(err: unknown): string {
    const message = err instanceof Error ? err.message : String(err);
    const configured = Object.values(this.config.transport === 'http' ? this.config.headers : this.config.env).filter(looksSecret);
    const held = this.config.transport === 'http' ? (this.config.secrets?.() ?? []) : [];
    return redactMessage(message, [...configured, ...held]);
  }

  /** Subscribes to status transitions ('connecting' | 'ok' | 'error' | 'needs_auth'). Returns an unsubscribe function. */
  onStatusChange(cb: (status: McpStatus, error: string | null) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  async connect(): Promise<void> {
    this.closed = false;
    const seq = ++this.connectSeq;
    this.clearTimer('reconnect');
    this.setStatus('connecting');

    try {
      const transport = this.buildTransport();
      const client = new Client({ name: 'otherbench', version: '1.0.0' }, { capabilities: {} });
      client.onclose = () => this.handleUnexpectedClose(seq);
      client.onerror = (err) => this.handleUnexpectedClose(seq, err);
      await client.connect(transport);

      if (seq !== this.connectSeq || this.closed) {
        await client.close().catch(() => {});
        return; // superseded by a later connect()/refresh(), or disconnect() ran while this was in flight
      }
      this.client = client;
      const listed = await client.listTools();
      if (seq !== this.connectSeq || this.closed) return;
      this.tools = mapTools(listed.tools);
      this.backoffMs = this.initialBackoffMs; // a genuine success resets the backoff ladder
      this.setStatus('ok');
      this.scheduleHealthCheck(seq);
    } catch (err) {
      if (seq !== this.connectSeq || this.closed) return;
      if (this.signInRequired(err)) {
        this.enterNeedsAuth();
        return;
      }
      this.client = null;
      this.setStatus('error', this.errorMessage(err));
      this.scheduleReconnect(seq);
    }
  }

  async disconnect(): Promise<void> {
    this.closed = true;
    this.connectSeq++;
    this.clearTimer('health');
    this.clearTimer('reconnect');
    const client = this.client;
    this.client = null;
    if (client) await client.close().catch(() => {});
  }

  /** Forces an immediate reconnect + tool re-list, bypassing any pending backoff. Backs `ToolProvider.refreshMcp`. */
  async refresh(): Promise<void> {
    await this.disconnect();
    await this.connect();
  }

  async callTool(name: string, args: unknown, opts: McpCallOptions = {}): Promise<McpCallResult> {
    if (this.status === 'needs_auth') throw new Error(NEEDS_SIGN_IN_CALL_MESSAGE);
    if (!this.client || this.status !== 'ok') {
      throw new Error(`MCP server "${this.id}" is not connected (status: ${this.status}).`);
    }
    const request = {
      ...(opts.signal ? { signal: opts.signal } : {}),
      ...(opts.timeoutMs !== undefined ? { timeout: opts.timeoutMs } : {}),
    };
    let result: Awaited<ReturnType<Client['callTool']>>;
    try {
      result = await this.client.callTool({ name, arguments: args as Record<string, unknown> | undefined }, undefined, request);
    } catch (err) {
      // The same redaction as `lastError`: the message reaches the model, the chat and a live page.
      if (this.signInRequired(err)) throw new Error(NEEDS_SIGN_IN_CALL_MESSAGE);
      // The SDK's numeric error code (a live call's timeout, -32001) carries no secret, so it stays.
      const code = (err as { code?: unknown } | null)?.code;
      throw Object.assign(new Error(this.errorMessage(err)), typeof code === 'number' ? { code } : {});
    }
    const content = 'content' in result ? result.content : result['toolResult'];
    const structured = 'structuredContent' in result ? result.structuredContent : undefined;
    return { content, isError: 'isError' in result && result.isError === true, ...(structured !== undefined ? { structured } : {}) };
  }

  private buildTransport(): Transport {
    if (this.config.transport === 'stdio') {
      const params: StdioServerParameters = {
        // The Windows trap (task 25 brief): resolves e.g. `npx` -> the real
        // `npx.cmd` absolute path via `where` before this ever reaches
        // `spawn`. See spawn.ts's module doc for why this is safe to layer
        // on top of `StdioClientTransport`'s own cross-spawn-based spawning
        // rather than fighting it.
        command: resolveExecutable(this.config.command),
        args: this.config.args,
        // The SDK adds only a short list of safe variables to this; the server's API token is never one, nor set here.
        env: withoutServerSecrets(this.config.env),
        stderr: 'pipe',
      };
      return new StdioClientTransport(params);
    }
    const headers = this.config.headers;
    // No timeout of our own here: the background transport keeps the SDK's defaults.
    return new StreamableHTTPClientTransport(new URL(this.config.url), {
      fetch: Object.keys(headers).length > 0 ? fetchWithServerHeaders(this.config.url, headers) : undefined,
      authProvider: this.config.authProvider,
    });
  }

  private handleUnexpectedClose(seq: number, err?: Error): void {
    if (seq !== this.connectSeq || this.closed) return; // stale event from an already-superseded/closed connection
    // A failed connect fires onerror (with the sign-in error), then onclose (with none). Stay in needs_auth until refresh()/connect().
    if (this.status === 'needs_auth') return;
    if (err && this.signInRequired(err)) {
      this.enterNeedsAuth();
      return;
    }
    this.client = null;
    this.clearTimer('health');
    this.setStatus('error', err ? this.errorMessage(err) : 'The MCP server connection closed unexpectedly.');
    this.scheduleReconnect(seq);
  }

  private scheduleHealthCheck(seq: number): void {
    this.clearTimer('health');
    this.healthTimer = this.setTimeoutFn(() => void this.runHealthCheck(seq), this.healthCheckIntervalMs);
    this.healthTimer.unref?.();
  }

  private async runHealthCheck(seq: number): Promise<void> {
    if (seq !== this.connectSeq || this.closed || !this.client) return;
    try {
      const listed = await this.client.listTools();
      if (seq !== this.connectSeq || this.closed) return;
      this.tools = mapTools(listed.tools);
      this.scheduleHealthCheck(seq);
    } catch (err) {
      if (seq !== this.connectSeq || this.closed) return;
      if (this.signInRequired(err)) {
        this.enterNeedsAuth();
        return;
      }
      this.client = null;
      this.setStatus('error', this.errorMessage(err));
      this.scheduleReconnect(seq);
    }
  }

  private scheduleReconnect(seq: number): void {
    this.clearTimer('reconnect');
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, this.maxBackoffMs);
    this.reconnectTimer = this.setTimeoutFn(() => {
      if (seq !== this.connectSeq || this.closed) return;
      void this.connect();
    }, delay);
    this.reconnectTimer.unref?.();
  }

  /** Only a server we attached a sign-in provider to can need a sign-in; a 401 with a fixed Authorization header stays an ordinary error. */
  private signInRequired(err: unknown): boolean {
    return this.config.transport === 'http' && this.config.authProvider !== undefined && isSignInRequired(err);
  }

  private enterNeedsAuth(): void {
    const stale = this.client;
    this.client = null;
    this.clearTimer('health');
    this.clearTimer('reconnect');
    this.backoffMs = this.initialBackoffMs;
    if (stale) void stale.close().catch(() => {});
    if (this.status !== 'needs_auth') this.setStatus('needs_auth', SIGN_IN_REQUIRED_MESSAGE);
  }

  private clearTimer(which: 'health' | 'reconnect'): void {
    if (which === 'health' && this.healthTimer) {
      this.clearTimeoutFn(this.healthTimer);
      this.healthTimer = null;
    }
    if (which === 'reconnect' && this.reconnectTimer) {
      this.clearTimeoutFn(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private setStatus(status: McpStatus, error: string | null = null): void {
    this.status = status;
    this.lastError = error;
    for (const cb of this.listeners) {
      try {
        cb(status, error);
      } catch (err) {
        console.error(`[McpClient:${this.id}] a status listener threw while handling '${status}':`, err);
      }
    }
  }
}
