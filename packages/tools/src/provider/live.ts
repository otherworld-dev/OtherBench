/**
 * Live artifacts' calls for `OtherBenchToolProvider` (`../provider.ts`,
 * spec 2026-10-12-live-artifacts): what the viewer shows for a page's
 * declared calls, the user allowing or stopping them, and running one.
 *
 * `runLiveCall` is a second entry point into the provider, not a second
 * path: it asks `broker.decide` exactly as `gate()` and `requestApproval()`
 * do (with `ctx.live` set, so the broker takes its live branch), audits every
 * decision, and only then calls the server, through the cache and the
 * per-artifact limits. The live grants themselves are the broker's
 * (`liveIneligibility`, `liveGrant`, `grantLive`, `revokeLive`).
 */
import { canonicalJson } from '@otherbench/core/domain/live-artifacts.js';
import type { PermissionBroker } from '@otherbench/core/domain/permissions.js';
import type { LiveCallOutcome, LiveCallStatus, LiveRunRequest, LiveStatusRequest, ToolContext } from '@otherbench/core/ports/tool-provider.js';
import type { Store } from '@otherbench/core/ports/store.js';
import { LiveCallCache, LiveCallLimiter, LiveRefusalAudit, shapeLiveResult } from '../live-calls.js';
import type { McpCallResult } from '../mcp/client.js';
import type { McpServerManager } from '../mcp/manager.js';
import { summarizeResult } from './audit.js';
import { liveTarget, splitToolName, summarizeMcpContent, whyUnavailable, type McpEntry } from './mcp-tools.js';
import { toolError } from './outcomes.js';

export const LIVE_TIMEOUT_MS = 30_000;
/** The MCP SDK's error code for a request that timed out (ErrorCode.RequestTimeout). */
const MCP_REQUEST_TIMEOUT = -32001;

/** A failure's message for the page, cut to the length tool_error messages get. */
function boundMessage(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 500);
}

/** What the live calls need from the provider: its store, broker and MCP servers, its clock, and its one audit writer. */
export interface LiveCallDeps {
  store: Store;
  broker: PermissionBroker;
  mcp: Pick<McpServerManager, 'listFor'>;
  now: () => number;
  timeoutMs: number;
  /** The provider's `writeAudit`: one row, `args` already as the audit may keep them. */
  writeAudit: (ctx: ToolContext, toolName: string, args: unknown, result: unknown, durationMs: number, grantedBy: string, summaryOverride?: string) => void;
}

export class LiveArtifactCalls {
  private readonly liveCache: LiveCallCache;
  private readonly liveLimiter: LiveCallLimiter;
  private readonly liveRefusals: LiveRefusalAudit;

  constructor(private readonly deps: LiveCallDeps) {
    this.liveCache = new LiveCallCache(deps.now);
    this.liveLimiter = new LiveCallLimiter(deps.now);
    this.liveRefusals = new LiveRefusalAudit(deps.now);
  }

  liveStatus(req: LiveStatusRequest): LiveCallStatus[] {
    const { store, mcp, broker } = this.deps;
    return req.calls.map(({ call, hash }): LiveCallStatus => {
      const found = liveTarget(store, mcp, req.policy, call.tool);
      if (!found || 'reason' in found) {
        const [serverName, toolName] = splitToolName(call.tool);
        return { callId: call.id, tool: call.tool, serverName, toolName, description: '', state: 'unavailable', reason: found ? found.reason : whyUnavailable(store, mcp, req.policy, call.tool) };
      }
      const target = found.entry;
      const base = { callId: call.id, tool: call.tool, serverName: target.origin.serverName, toolName: target.origin.toolName, description: target.spec.description.slice(0, 300) };
      const why = broker.liveIneligibility(target.spec, req.policy);
      if (why) return { ...base, state: 'unavailable', reason: why };
      // Against the tool's current server: a grant made under a server since renamed or replaced doesn't count.
      const live = { artifactId: req.artifactId, callId: call.id, hash, serverId: target.origin.serverId };
      const granted = broker.liveGrant(target.spec, { chatId: req.chatId, profileId: req.profileId, live });
      return { ...base, state: granted ? 'allowed' : 'needs_ok' };
    });
  }

  allowLive(req: LiveStatusRequest): LiveCallStatus[] {
    const before = this.liveStatus(req);
    const calls = req.calls.flatMap(({ call, hash }, i) => {
      if (before[i]!.state !== 'needs_ok') return [];
      const found = liveTarget(this.deps.store, this.deps.mcp, req.policy, call.tool);
      return found && 'entry' in found ? [{ tool: found.entry.spec, callId: call.id, hash, serverId: found.entry.origin.serverId }] : [];
    });
    if (calls.length > 0) this.deps.broker.grantLive({ chatId: req.chatId, profileId: req.profileId, artifactId: req.artifactId, policy: req.policy, calls });
    return this.liveStatus(req);
  }

  revokeLive(chatId: string, artifactId: string): number {
    return this.deps.broker.revokeLive(chatId, artifactId);
  }

  /** Never throws: anything unexpected comes back as a `failed` outcome. */
  async runLiveCall(req: LiveRunRequest): Promise<LiveCallOutcome> {
    try {
      return await this.runLive(req);
    } catch (err) {
      return { ok: false, code: 'failed', message: boundMessage(err) };
    }
  }

  private async runLive(req: LiveRunRequest): Promise<LiveCallOutcome> {
    const { store, mcp, broker, now } = this.deps;
    const startedAt = now();
    const found = liveTarget(store, mcp, req.policy, req.toolName);
    if (!found) return { ok: false, code: 'not_available', message: whyUnavailable(store, mcp, req.policy, req.toolName) };
    if ('reason' in found) return { ok: false, code: 'not_available', message: found.reason };
    const target = found.entry;
    const ctx: ToolContext = {
      chatId: req.chatId,
      messageId: req.messageId,
      profileId: req.profileId,
      workspaceRoot: null,
      signal: req.signal,
      // The server id comes from the lookup above, never from the request.
      live: { artifactId: req.artifactId, callId: req.callId, hash: req.hash, serverId: target.origin.serverId },
    };
    const decision = broker.decide(target.spec, req.args, req.policy, ctx);
    if (decision.kind !== 'allow') {
      // The live branch never asks; should it ever, drop the request rather than leave a card nobody can see.
      if (decision.kind === 'ask') broker.discard(decision.request.id);
      const message = decision.kind === 'deny' ? decision.reason : 'A live call was asked about, which never happens; it did not run.';
      const code = decision.kind === 'deny' && decision.code === 'not_approved' ? 'not_approved' : 'refused';
      this.auditLive(this.liveRefusals.take(req.artifactId), ctx, target.spec.name, req.args, toolError(code, message), now() - startedAt, 'deny:policy');
      return { ok: false, code, message };
    }
    const grantedBy = `live:${decision.grantId ?? ''}`;
    // The server is part of the key; canonical args last, so the fields before them can't be confused with them.
    const key = [req.chatId, req.profileId, req.artifactId, req.callId, req.hash, target.origin.serverId, canonicalJson(req.args)].join('|');
    if (!req.fresh) {
      const hit = this.liveCache.get(key);
      // A copy: the cache hands back the stored object itself.
      if (hit) return { ok: true, ...hit, cached: true };
    }
    if (!this.liveLimiter.tryStart(req.artifactId)) {
      const message = 'This page asked for live data too often. Wait a minute, then refresh it.';
      const unaudited = this.liveRefusals.rateLimited(req.artifactId);
      if (unaudited !== null) this.auditLive(unaudited, ctx, target.spec.name, req.args, toolError('rate_limited', message), now() - startedAt, grantedBy);
      return { ok: false, code: 'rate_limited', message };
    }
    try {
      const outcome = await this.callLive(target, req);
      const audited = outcome.ok ? outcome : toolError(outcome.code, outcome.message);
      this.auditLive(this.liveRefusals.take(req.artifactId), ctx, target.spec.name, req.args, audited, now() - startedAt, grantedBy);
      if (outcome.ok) {
        const { ok: _ok, cached: _cached, ...result } = outcome;
        this.liveCache.set(key, result);
      }
      return outcome;
    } finally {
      this.liveLimiter.finish(req.artifactId);
    }
  }

  /** A live call's audit row, noting the artifact's rate_limited refusals that weren't given one of their own. */
  private auditLive(unaudited: number, ctx: ToolContext, toolName: string, args: unknown, result: unknown, durationMs: number, grantedBy: string): void {
    const note = unaudited > 0 ? ` (+${unaudited} rate_limited call${unaudited === 1 ? '' : 's'} not audited)` : '';
    this.deps.writeAudit(ctx, toolName, args, result, durationMs, grantedBy, `${summarizeResult(result)}${note}`);
  }

  /** Calls the server for an allowed live call, within the timeout, and shapes its result for the page. */
  private async callLive(target: McpEntry, req: LiveRunRequest): Promise<LiveCallOutcome> {
    const timeoutMs = this.deps.timeoutMs;
    const client = this.deps.mcp.listFor([target.origin.serverId])[0]?.client;
    if (!client) return { ok: false, code: 'not_available', message: `MCP server "${target.origin.serverName}" isn't connected.` };
    const signal = AbortSignal.any([req.signal, AbortSignal.timeout(timeoutMs)]);
    let result: McpCallResult;
    try {
      result = await client.callTool(target.origin.toolName, req.args, { signal, timeoutMs });
    } catch (err) {
      const timedOut = !req.signal.aborted && (signal.aborted || (err as { code?: unknown }).code === MCP_REQUEST_TIMEOUT);
      if (timedOut) return { ok: false, code: 'timeout', message: `"${target.origin.toolName}" didn't answer within ${Math.round(timeoutMs / 1000)} seconds.` };
      return { ok: false, code: 'failed', message: boundMessage(err) };
    }
    if (result.isError) return { ok: false, code: 'tool_error', message: summarizeMcpContent(result.content) };
    const shaped = shapeLiveResult(result.content, result.structured);
    if (!shaped.ok) return shaped;
    return { ...shaped, cached: false, at: this.deps.now() };
  }
}
