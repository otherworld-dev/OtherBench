/**
 * The per-source branches of the permission broker (`../permissions.ts`):
 * what each kind of tool needs before the grants are looked at. Tier 2 of
 * the broker's model lives here: the workspace requirement, each source's
 * refusals before any card, and the narrow shortcuts that skip the card
 * (OtherBench's own tools, the sandbox under ask_on_mutate, the ask-on-mutate
 * read pass). The browser's and computer use's branches are big enough to
 * have their own modules (`browser.ts`, `computer.ts`). Nothing here stores
 * or matches a grant; a branch only adds refusals and shortcuts, and every
 * call it lets past goes on to the grants and a card in `decide()`.
 */
import { AGENT_PATH_ARG_KEYS, classifyAgentTool, isProtectedAgentPath } from '../agent-tools.js';
import { confirmPromptsOf } from '../media.js';
import { canonicalHost, isLocalOrPrivateHost } from '../network-hosts.js';
import { containPathIn } from '../paths.js';
import type { ToolContext, ToolSpec } from '../../ports/tool-provider.js';
import type { Store } from '../../ports/store.js';
import type { ToolPolicy } from '../../types/config.js';
import { browserDecision } from './browser.js';
import { computerDecision } from './computer.js';
import type { Decision } from './decision.js';
import { stringField } from './fields.js';

/** A media call made from inside a sub-agent, or a helper Claude Code's own agent started. */
export const SUBAGENT_MEDIA_REFUSAL = "Sub-agents can't generate images or video.";

/** A thread tool (question, plan, checklist) called from inside a sub-agent. */
export const SUBAGENT_THREAD_REFUSAL = "A sub-agent can't ask the user, propose a plan or keep the reply's checklist. Put what you need to say in your answer.";

/** Why a call that acts on a workspace can't go ahead without one, or null when it can. */
export function workspaceDenial(tool: ToolSpec, ctx: ToolContext): Decision | null {
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
  return null;
}

/**
 * What the call's own source decides before the read pass and the grants,
 * or null to carry on to them. Sources are exclusive, so at most one branch
 * applies to a call.
 */
export function sourceDecision(store: Store, tool: ToolSpec, args: unknown, policy: ToolPolicy, ctx: ToolContext, allowLoopbackPorts: readonly number[]): Decision | null {
  switch (tool.source) {
    // The sandbox never reaches this machine or the local network, whatever
    // a grant says, and a host with no canonical spelling can't be compared
    // with one: both are refused before the grants are looked at.
    case 'network': {
      const refusal = networkHostRefusal(args);
      if (refusal) return { kind: 'deny', reason: refusal };
      return null;
    }

    // A write into one of the chat's read-only extra folders is refused here,
    // before any card (spec 2026-10-07-extra-folders). A path in no folder at
    // all is left to the tool, which refuses it as it always has.
    case 'fs': {
      if (tool.risk === 'mutate') {
        const path = stringField(args, 'path');
        if (path !== null && inReadOnlyFolder(ctx, path)) {
          return { kind: 'deny', reason: `"${tool.name}" can't change ${path}: it's in a read-only folder.` };
        }
      }
      return null;
    }

    case 'browser':
      return browserDecision(store, args, policy, ctx, allowLoopbackPorts);

    // Claude Code's bookkeeping tools (TodoWrite, Task/Agent, AskUserQuestion)
    // have no side effects of their own; a subagent's real tool calls come
    // back through here individually.
    case 'agent':
      if (classifyAgentTool(tool.name).category === 'internal') {
        return { kind: 'allow', grantedBy: 'policy' };
      }
      return null;

    // Artifacts (Deck #896) change nothing outside OtherBench and keep every
    // version, so they never need a card; the profile's switch (checkPolicy,
    // checked first) is how they're turned off. Only the source says a call is
    // OtherBench's: never a Claude Code tool's name, which any MCP server can take
    // (the Claude Code engine marks its own server's call itself).
    case 'artifact':
      return { kind: 'allow', grantedBy: 'policy' };

    // A sandboxed command (spec 2026-10-12-sandbox-design) can reach only the
    // chat's folders and allowlisted hosts, so under ask-on-changes it needs
    // no card, which is what lets unattended runs use the shell. Under
    // always-ask it falls through to the grants and a card like the host
    // shell. Its network requests (source 'network') never take this pass.
    case 'sandbox':
      if (policy.approvalMode === 'ask_on_mutate') {
        return { kind: 'allow', grantedBy: 'sandbox' };
      }
      return null;

    // Thread tools (spec 2026-10-12-thread-cards-design): a checklist, a
    // question or a plan for the user. They change nothing, so they never
    // need a card; they are still audited like every call. A sub-agent gets
    // none of them: it can't ask the user anything, a plan it proposed would
    // open its parent's plan gate, and the checklist is the reply's own.
    // SubagentRunner never offers them; this refuses one that arrives anyway.
    case 'thread':
      return ctx.subagent ? { kind: 'deny', reason: SUBAGENT_THREAD_REFUSAL } : { kind: 'allow', grantedBy: 'policy' };

    // Sub-agents (spec 2026-10-12-api-subagents-design): the call itself has
    // no effect; every tool call the sub-agent makes comes back through here
    // on its own, under a policy never wider than this one. One level only.
    case 'subagent':
      return ctx.subagent ? { kind: 'deny', reason: "A sub-agent can't start another sub-agent." } : { kind: 'allow', grantedBy: 'policy' };

    case 'computer':
      return computerDecision(args, ctx);

    // Generation (media-generation plan, task 2). Needs no workspace. Never a
    // sub-agent's, nor a helper Claude Code's own Task/Agent tool started
    // (`shownSubagent`), whatever grants exist. Under ask-on-changes the
    // profile's choice (checkPolicy, checked first) is the consent, so no card, unattended
    // included. Under always-ask with the generation ask on (`confirmPrompts`)
    // and someone there, that ask is the confirmation, so no second card: one
    // card per generation. With it off, always-ask falls through to the grants
    // and a card, and with nobody there and no grant it is refused (in `decide()`).
    case 'media':
      if (ctx.subagent || ctx.shownSubagent) return { kind: 'deny', reason: SUBAGENT_MEDIA_REFUSAL };
      if (policy.approvalMode === 'ask_on_mutate') return { kind: 'allow', grantedBy: 'policy' };
      if (confirmPromptsOf(policy) && ctx.unattended !== true) return { kind: 'allow', grantedBy: 'policy' };
      return null;

    // Nothing of their own before the read pass and the grants: the host
    // shell is always grant- or ask-gated, MCP has only the policy ceiling and
    // the read pass, and recall gets no shortcut at all (see `decide()`).
    case 'shell':
    case 'mcp':
    case 'recall':
      return null;

    default:
      return null;
  }
}

/** The ask-on-mutate read pass: a read-risk fs, Claude Code file-read or MCP call needs no card. Null when it doesn't apply. */
export function askOnMutateReadPass(tool: ToolSpec, policy: ToolPolicy): Decision | null {
  if (policy.approvalMode === 'ask_on_mutate' && tool.risk === 'read') {
    if (tool.source === 'fs') return { kind: 'allow', grantedBy: 'auto_read' };
    // Name-based, not declared-risk-based: only Claude Code's known file-read tools.
    if (tool.source === 'agent' && classifyAgentTool(tool.name).category === 'file-read') return { kind: 'allow', grantedBy: 'auto_read' };
    // An mcp server was already explicitly enabled by the user (a policy
    // action distinct from any single tool call), so a READ-risk call
    // against it is treated as pre-authorised by that policy decision --
    // distinct from auto_read, which is specifically the workspace-scoped
    // filesystem shortcut. Mutate/execute-risk mcp tools get no such
    // shortcut and fall through to the grant/ask path in decide() like any
    // other mutating call.
    if (tool.source === 'mcp') return { kind: 'allow', grantedBy: 'policy' };
  }
  return null;
}

/**
 * A Claude Code file-write call where the workspace-relative `path` (set by the
 * engine's gate, engine-claude-code/src/approval.ts), or any other path key,
 * is Claude Code config.
 * A file-write call with no usable `path` cannot be checked, so it counts as
 * protected too (fail closed: ask, store nothing).
 */
export function isProtectedAgentWrite(tool: ToolSpec, args: unknown): boolean {
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
