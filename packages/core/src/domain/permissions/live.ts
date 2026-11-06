/**
 * Live artifacts' branch of the permission broker (`../permissions.ts`,
 * spec 2026-10-12-live-artifacts): a call with `ctx.live` is one a page asked
 * for while someone has it open, never a model's. It gets the policy ceiling
 * plus "MCP, read-only, artifacts on", and then only a live grant for exactly
 * that call, made by `grantLive` when the user allowed the page in the
 * viewer. It never asks, and no other call ever matches a live grant
 * (`grant-matching.ts` refuses one).
 */
import { randomUUID } from 'node:crypto';
import type { LiveCallRef, ToolContext, ToolSpec } from '../../ports/tool-provider.js';
import type { Grant, Store } from '../../ports/store.js';
import type { ToolPolicy } from '../../types/config.js';
import type { Decision } from './decision.js';
import { checkPolicy } from './policy.js';

/** Why `tool` can't feed a live artifact under `policy`, or null when it can. Also what the viewer shows for an unavailable call. */
export function liveIneligibility(tool: ToolSpec, policy: ToolPolicy): string | null {
  const denial = checkPolicy(tool, policy);
  if (denial) return denial;
  if (policy.artifacts === false) return 'Artifacts are turned off for this profile.';
  if (tool.source !== 'mcp') return 'Only MCP tools can feed a live artifact.';
  if (tool.risk !== 'read') return `"${tool.name}" can change things; live artifacts can only use tools their server marks read-only.`;
  return null;
}

/**
 * The live grant for exactly this call in this chat under this profile, or
 * null. The grant's server id must be the tool's current server's: a server
 * renamed or replaced into the tool's name never inherits it. A grant made
 * before grants carried a server id has none, so it never matches.
 */
export function liveGrant(store: Store, tool: ToolSpec, ctx: { chatId: string; profileId: string; live: LiveCallRef }): Grant | null {
  const now = Date.now();
  for (const grant of store.grants.list(ctx.chatId)) {
    const live = grant.constraint?.live;
    if (!live || grant.toolName !== tool.name || grant.source !== 'mcp' || grant.chatId !== ctx.chatId || grant.profileId !== ctx.profileId) continue;
    if (grant.expiresAt !== null && grant.expiresAt <= now) continue;
    if (typeof live.serverId !== 'string' || typeof ctx.live.serverId !== 'string') continue;
    if (live.artifactId === ctx.live.artifactId && live.callId === ctx.live.callId && live.hash === ctx.live.hash && live.serverId === ctx.live.serverId) return grant;
  }
  return null;
}

export function decideLive(store: Store, tool: ToolSpec, policy: ToolPolicy, ctx: ToolContext, live: LiveCallRef): Decision {
  const why = liveIneligibility(tool, policy);
  if (why) return { kind: 'deny', reason: why };
  const grant = liveGrant(store, tool, { chatId: ctx.chatId, profileId: ctx.profileId, live });
  if (grant) return { kind: 'allow', grantedBy: 'grant', grantId: grant.id };
  return { kind: 'deny', code: 'not_approved', reason: "You haven't allowed this live artifact's calls on this machine." };
}

/**
 * The user allowed a live page's calls in the viewer: one chat grant per
 * call, bound to its declaration's hash and to the id of the MCP server its
 * tool comes from now. Every call must be eligible, or none is granted (an
 * Error names the first that isn't), so this can never mint a grant the
 * live branch would then deny. A call that already has its grant (same
 * server too) is skipped. Returns the grants it made.
 */
export function grantLive(store: Store, input: { chatId: string; profileId: string; artifactId: string; policy: ToolPolicy; calls: { tool: ToolSpec; callId: string; hash: string; serverId: string }[] }): Grant[] {
  for (const call of input.calls) {
    const why = liveIneligibility(call.tool, input.policy);
    if (why) throw new Error(`Live call "${call.callId}" can't be allowed: ${why}`);
  }
  const made: Grant[] = [];
  for (const call of input.calls) {
    const live = { artifactId: input.artifactId, callId: call.callId, hash: call.hash, serverId: call.serverId };
    if (liveGrant(store, call.tool, { chatId: input.chatId, profileId: input.profileId, live })) continue;
    made.push(
      store.grants.create({
        id: randomUUID(),
        chatId: input.chatId,
        profileId: input.profileId,
        toolName: call.tool.name,
        source: 'mcp',
        scope: 'chat',
        constraint: { live },
        expiresAt: null,
      })
    );
  }
  return made;
}

/** Stop live data: deletes the chat's live grants for that artifact. Returns how many. */
export function revokeLive(store: Store, chatId: string, artifactId: string): number {
  let removed = 0;
  for (const grant of store.grants.list(chatId)) {
    if (grant.constraint?.live?.artifactId !== artifactId) continue;
    store.grants.delete(grant.id);
    removed += 1;
  }
  return removed;
}
