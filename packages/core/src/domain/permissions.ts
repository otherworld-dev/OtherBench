/**
 * The permission broker: the one place every tool call is decided
 * (`PermissionBroker`, below). Everything else imports it, and every public
 * name of the broker's modules, from here.
 *
 * The broker's rules live in `./permissions/`, one concern per module, and
 * `PermissionBroker` delegates to them in the order its comment sets out:
 *
 *   - `policy.ts`: tier 1, the profile's `ToolPolicy` as a hard ceiling;
 *   - `modes.ts`: Plan mode's rule, auto mode's hand-off and the unattended
 *     reason;
 *   - `sources.ts`, `browser.ts`, `computer.ts`: tier 2, each source's
 *     refusals and shortcuts before the grants;
 *   - `grant-matching.ts`: tier 3, whether a stored grant covers a call;
 *   - `grant-minting.ts`: what an answer to a card may store;
 *   - `live.ts`: live artifacts' separate branch and their grants;
 *   - `pending.ts`: the pending approvals and their backstop;
 *   - `summaries.ts`: the line a card shows;
 *   - `decision.ts` and `fields.ts`: the answer type and argument reading
 *     they all share.
 */
import { randomUUID } from 'node:crypto';
import type { ApprovalChoice, ApprovalRequest, LiveCallRef, ToolContext, ToolSpec } from '../ports/tool-provider.js';
import type { Grant, Store } from '../ports/store.js';
import type { ToolPolicy } from '../types/config.js';
import { PLAN_REFUSAL } from './thread-tools.js';
import { isHighRiskComputerCall } from './permissions/computer.js';
import type { Decision } from './permissions/decision.js';
import { findMatchingGrant } from './permissions/grant-matching.js';
import { persistAnswer } from './permissions/grant-minting.js';
import { decideLive, grantLive, liveGrant, liveIneligibility, revokeLive } from './permissions/live.js';
import { allowedWhilePlanning, UNATTENDED_REASON } from './permissions/modes.js';
import { DEFAULT_MAX_PENDING, PendingApprovals } from './permissions/pending.js';
import { checkPolicy } from './permissions/policy.js';
import { askOnMutateReadPass, isProtectedAgentWrite, sourceDecision, workspaceDenial } from './permissions/sources.js';
import { cardSummary } from './permissions/summaries.js';

export type { ApprovalChoice, ApprovalRequest } from '../ports/tool-provider.js';
export { auditGrantedBy, type Decision } from './permissions/decision.js';
export { SUBAGENT_COMPUTER_REFUSAL } from './permissions/computer.js';
export { allowedWhilePlanning, isDeferrableInAutoMode, UNATTENDED_REASON } from './permissions/modes.js';
export { MEDIA_OFF_REASON } from './permissions/policy.js';
export { SUBAGENT_MEDIA_REFUSAL, SUBAGENT_THREAD_REFUSAL } from './permissions/sources.js';

export interface PermissionBrokerOptions {
  /** Hard cap on simultaneously pending approvals; the oldest is evicted past it. Default 200. */
  maxPending?: number;
  /** Tests only (`OTHERBENCH_BROWSER_ALLOW_LOOPBACK_PORTS`): the browser may use 127.0.0.1; the proxy holds it to these ports. */
  allowLoopbackPorts?: readonly number[];
}

/**
 * Decides whether a tool call may proceed, deferring to a stored `Grant`
 * where one applies and otherwise producing an `ApprovalRequest` for a human
 * to answer via `resolve()`.
 *
 * Three-tier model, checked in this order:
 *   1. Policy is a hard ceiling. A `source`/`risk` combination the profile's
 *      `ToolPolicy` disallows is denied outright -- no approval request is
 *      ever created for it, and no grant can override it (grants operate
 *      only within what policy already permits).
 *   2. Auto-approval is a narrow, deliberate exception to "always ask":
 *      read-risk filesystem tools (workspace-scoped) and read-risk MCP
 *      tools from a server this profile has actually enabled (tier 1 above
 *      verifies `tool.serverId` is in `policy.mcpServerIds`, so by the time
 *      this shortcut is reached the "already explicitly enabled" claim it
 *      rests on is a fact rather than an assumption -- it used to be an
 *      assumption, checked only as "at least one server is enabled
 *      somewhere") skip the prompt when
 *      `approvalMode` is `'ask_on_mutate'`. Agent (Claude Code) tools auto-approve only when
 *      their NAME classifies as file-read (never by declared risk), and agent
 *      tools need a workspace like fs/shell. Shell is carved out of this
 *      entirely and by name (`tool.source === 'shell'`), not merely by risk
 *      class, precisely so a mis-declared shell `ToolSpec` (risk `'read'`
 *      instead of `'execute'`) still can't slip through auto-approval --
 *      shell is unsandboxed and must always be at least grant- or ask-gated.
 *      The shell now has a sandboxed sibling (spec 2026-10-12-sandbox-design):
 *      `source: 'sandbox'` is `run_command` running in OtherBench's WSL sandbox,
 *      which reaches only the chat's folders and allowlisted hosts. Under
 *      `ask_on_mutate` it needs no card (`grantedBy: 'sandbox'`); under
 *      `always_ask` it is grant- or ask-gated exactly like the host shell.
 *      A host outside the allowlist is `source: 'network'` and always asks:
 *      its grants are pinned to one host. Hosts are compared in one canonical
 *      spelling (`canonicalHost`, network-hosts.ts: IDNA, lowercase, IPv4
 *      normalised, no trailing dot), and a host that has none, or is
 *      `localhost` or a private/link-local address, is denied before any
 *      grant or card.
 *   3. Everything else consults stored grants (`chat` or `always` scope,
 *      constrained by path/command prefix where set) before falling back to
 *      `ask`.
 *
 * Three properties of grant handling are load-bearing enough to state here:
 *
 *   - A constraint is checked against the tool when it is stored and when it
 *     is matched. `resolve()` stores only what `alwaysConstraintFor` derives
 *     (a shell tool: exactly one command key; the network and the browser:
 *     exactly the card's own host; anything else: a `pathPrefix` or nothing)
 *     and throws on anything else. Matching needs EVERY key present to match,
 *     a `host` key matches only a network or browser call and only a grant
 *     of that same source (a browser grant never covers the sandbox's
 *     network, nor the other way round), and a shell, network or browser call
 *     never matches a constraint-less grant. Matching on the first key present let
 *     `{commandExact: 'ls', pathPrefix: '.'}` approve any command with a
 *     `path` argument.
 *   - A `pathPrefix` constraint is matched against the RESOLVED path, using
 *     the very same `containPath()` the fs tool itself will call, not
 *     against the raw model-supplied argument string. Matching the raw
 *     string let `..` walk straight out of a scoped grant: a grant on
 *     `/ws/src` matched `/ws/src/../secret.env`, which `containPath` then
 *     happily resolved to an in-workspace path, so the write proceeded under
 *     an approval the user believed was limited to `/ws/src`. Resolving both
 *     sides first means the grant and the operation cannot disagree about
 *     which file is being touched. The cost is that `decide()` now does
 *     filesystem I/O (`containPath` lstats/realpaths) rather than being
 *     pure -- deliberate: a containment decision made without consulting the
 *     filesystem is a decision about a string, not about a file.
 *   - NO grant scope is ever blanket for the shell. `resolve()` refuses an
 *     unconstrained `always` grant, and a `chat`-scope answer for a shell
 *     tool is persisted as a grant for that ONE exact command string.
 *     `run_command` has no containment of any kind by design (it is
 *     unsandboxed), so the approval gate is the only control that exists for
 *     it; "approve this command for the rest of the chat" must therefore
 *     never widen into "approve any command for the rest of the chat".
 *
 * Live artifacts (spec 2026-10-12-live-artifacts) take a separate branch,
 * before all three: a call with `ctx.live` is one a page asked for while
 * someone has it open, never a model's. It gets the policy ceiling plus
 * "MCP, read-only, artifacts on", and then only a live grant for exactly that
 * call (tool, its MCP server's id, chat, profile, artifact, call id and
 * declaration hash), made by `grantLive` when the user allowed the page in
 * the viewer. It never asks:
 * there is no turn to raise a card in, and the declaration approval was the
 * decision. It never takes the ask-on-mutate read pass or any other grant,
 * and no other call ever matches a live grant.
 *
 * The browser (`source: 'browser'`) is refused for blocked, local and private
 * sites before any card; its reads (`snapshot`, `scroll`, `close`) skip the
 * card under ask_on_mutate; its grants are always pinned to one `host`, by
 * the same rules as the sandbox's network grants (`alwaysConstraintFor`,
 * every-key matching, the canonical host) and never interchangeable with them.
 * After those refusals, and before the stored grants, it consults one more
 * grant source: the profile's site list (`Profile.browserAllowedSites`,
 * browser-sites.ts), audited as `site_list:<entry>`. The list only skips the
 * card; nothing it holds turns a refusal into an allow.
 *
 * Computer use (`source: 'computer'`) is refused outright in an unattended
 * run; its looking actions (`screenshot`, `cursor_position`, `wait`) skip the
 * card in both modes, by exact action name; every other action is about one
 * app, named by its key (`appKey`: the program path the shell resolved,
 * compared with `===` and never repaired or folded here), and a call with no
 * valid key is refused. Its grants are always pinned to one key. An app that
 * isn't provably ordinary (`isHighRiskApp`: a shell, Explorer, a script host,
 * a path outside plain ASCII, or anything unknown) is asked about every time:
 * no grant is stored for it and none is matched. A browser or an IDE that
 * passes every other rule is ordinary here and may have a grant, still
 * pinned to its one key (Adam's ruling, 2026-10-14). The card's line names
 * the app from the key alone. Its
 * grants follow the same rules as the host-keyed ones: an "always" is
 * exactly `{ app }`, the card's own (`alwaysConstraintFor`), every key must
 * match, and an `app` grant only ever covers a computer call. In Plan mode
 * every computer action is refused, the looks included (`allowedWhilePlanning`).
 */
export class PermissionBroker {
  private readonly pending: PendingApprovals;
  private readonly allowLoopbackPorts: readonly number[];

  constructor(
    private readonly store: Store,
    options: PermissionBrokerOptions = {}
  ) {
    this.pending = new PendingApprovals(options.maxPending ?? DEFAULT_MAX_PENDING);
    this.allowLoopbackPorts = options.allowLoopbackPorts ?? [];
  }

  /** How many approval requests are currently waiting for an answer. */
  get pendingCount(): number {
    return this.pending.size;
  }

  /** True while `requestId` is still waiting for an answer (not resolved, discarded or evicted). */
  hasPending(requestId: string): boolean {
    return this.pending.has(requestId);
  }

  /**
   * Subscribes to the BACKSTOP evicting a request (see `PendingApprovals`,
   * permissions/pending.ts). The eviction is a safety net for a request whose
   * owner never ended it; whoever is waiting on it (OtherBenchToolProvider)
   * must settle that wait as a denial. Never fired by `resolve()`/`discard()`,
   * which are the callers' own doing.
   */
  onEvict(cb: (requestId: string) => void): () => void {
    return this.pending.onEvict(cb);
  }

  decide(tool: ToolSpec, args: unknown, policy: ToolPolicy, ctx: ToolContext): Decision {
    if (ctx.live) return decideLive(this.store, tool, policy, ctx, ctx.live);

    const policyDenial = checkPolicy(tool, policy);
    if (policyDenial) return { kind: 'deny', reason: policyDenial };

    // Plan mode (spec 2026-10-12-thread-cards-design §4): until the user
    // approves this reply's plan, anything that could change something is
    // refused, with no card. This only adds refusals: an allowed call still
    // goes on to its grants or card below.
    if (ctx.plan && !ctx.plan.approved && !allowedWhilePlanning(tool, args)) {
      return { kind: 'deny', reason: PLAN_REFUSAL, plan: true };
    }

    const noWorkspace = workspaceDenial(tool, ctx);
    if (noWorkspace) return noWorkspace;

    // Each source's own refusals and shortcuts (permissions/sources.ts): the
    // sandbox network's local and private hosts, read-only folders, the
    // browser's sites and site list, computer use's refusals and looks, and
    // OtherBench's own tools that never need a card.
    const bySource = sourceDecision(this.store, tool, args, policy, ctx, this.allowLoopbackPorts);
    if (bySource) return bySource;

    // Recall (spec 2026-10-09-recall-design) gets no shortcut: it reads the
    // user's OTHER chats, so text injected into this one could use it to
    // reach them. It falls through to the grants, and the card's "for this
    // chat" covers the rest of the chat. It never takes the ask-on-mutate
    // read pass below, which only fs, agent and mcp tools get.

    const readPass = askOnMutateReadPass(tool, policy);
    if (readPass) return readPass;

    // A Claude Code write to its own config (see isProtectedAgentPath) is
    // asked about every time (a card, or in Auto Claude Code's classifier): no
    // stored grant, however scoped, may cover it. Nor may one cover computer
    // use of a high-risk app.
    const grant = isProtectedAgentWrite(tool, args) || isHighRiskComputerCall(tool, args) ? null : findMatchingGrant(this.store, tool, args, ctx);
    if (grant) {
      // A 'once' grant authorises exactly one call; consume it immediately
      // so a second identical call is asked about again rather than reusing
      // it silently.
      if (grant.scope === 'once') this.store.grants.delete(grant.id);
      return { kind: 'allow', grantedBy: 'grant', grantId: grant.id };
    }

    // A card nobody can answer: refused here, with the scheduled run's reason,
    // rather than left for the provider to drop.
    if (tool.source === 'media' && ctx.unattended === true) return { kind: 'deny', reason: UNATTENDED_REASON, unattended: true };

    const request: ApprovalRequest = {
      id: randomUUID(),
      chatId: ctx.chatId,
      messageId: ctx.messageId,
      toolName: tool.name,
      risk: tool.risk,
      source: tool.source,
      args,
      summary: cardSummary(this.store, tool, args),
      ...(ctx.subagent ? { subagent: ctx.subagent } : ctx.shownSubagent ? { subagent: ctx.shownSubagent } : {}),
    };
    this.pending.add(request.id, { tool, ctx, args });
    return { kind: 'ask', request };
  }

  /** Why `tool` can't feed a live artifact under `policy`, or null when it can. Also what the viewer shows for an unavailable call. */
  liveIneligibility(tool: ToolSpec, policy: ToolPolicy): string | null {
    return liveIneligibility(tool, policy);
  }

  /** The live grant for exactly this call in this chat under this profile, or null (permissions/live.ts). */
  liveGrant(tool: ToolSpec, ctx: { chatId: string; profileId: string; live: LiveCallRef }): Grant | null {
    return liveGrant(this.store, tool, ctx);
  }

  /** The user allowed a live page's calls in the viewer: one chat grant per call, all or none (permissions/live.ts). Returns the grants it made. */
  grantLive(input: { chatId: string; profileId: string; artifactId: string; policy: ToolPolicy; calls: { tool: ToolSpec; callId: string; hash: string; serverId: string }[] }): Grant[] {
    return grantLive(this.store, input);
  }

  /** Stop live data: deletes the chat's live grants for that artifact. Returns how many. */
  revokeLive(chatId: string, artifactId: string): number {
    return revokeLive(this.store, chatId, artifactId);
  }

  /**
   * Records the human's answer to a previously-issued `ApprovalRequest`.
   * Persists a durable `Grant` for `'chat'`/`'always'` choices so a later
   * `decide()` call for a matching tool call finds it; `'deny'`/`'once'`
   * persist nothing (`'once'` authorises only the specific in-flight call --
   * actually resuming that call is the caller's responsibility, out of
   * scope here; see task 26). What a 'chat' or 'always' answer may store,
   * and when it stores nothing or throws, is `persistAnswer`
   * (permissions/grant-minting.ts).
   *
   * Each request id may be resolved exactly once: it is removed from the
   * pending set immediately, so a duplicate or unknown id throws rather than
   * silently no-op-ing (a UI double-submit or a stale id must surface as an
   * error, not be swallowed).
   */
  resolve(requestId: string, choice: ApprovalChoice): void {
    const pending = this.pending.get(requestId);
    if (!pending) {
      throw new Error(`PermissionBroker.resolve: unknown or already-resolved approval request "${requestId}".`);
    }
    this.pending.delete(requestId);
    persistAnswer(this.store, pending, choice);
  }

  /**
   * Drops a pending request created by `decide()` without answering it: no
   * grant, no event. Used when auto mode hands the call to Claude Code's
   * classifier instead of a card (OtherBenchToolProvider.requestApproval). An
   * unknown or already-settled id is a no-op, never an error.
   */
  discard(requestId: string): void {
    this.pending.delete(requestId);
  }
}
