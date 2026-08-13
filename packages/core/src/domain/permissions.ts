import { randomUUID } from 'node:crypto';
import { sep } from 'node:path';
import type { ApprovalChoice, ApprovalRequest, ToolContext, ToolSpec } from '../ports/tool-provider.js';
import type { Grant, Store } from '../ports/store.js';
import type { ToolPolicy } from '../types/config.js';

export type { ApprovalChoice, ApprovalRequest } from '../ports/tool-provider.js';

export type Decision =
  | { kind: 'allow'; grantedBy: 'policy' | 'auto_read' | 'grant'; grantId?: string }
  | { kind: 'deny'; reason: string }
  | { kind: 'ask'; request: ApprovalRequest };

/** What `decide()` remembers about a pending 'ask' so `resolve()` can act on it later. */
interface PendingRequest {
  tool: ToolSpec;
  ctx: ToolContext;
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
 *      tools (server already explicitly enabled) skip the prompt when
 *      `approvalMode` is `'ask_on_mutate'`. Shell is carved out of this
 *      entirely and by name (`tool.source === 'shell'`), not merely by risk
 *      class, precisely so a mis-declared shell `ToolSpec` (risk `'read'`
 *      instead of `'execute'`) still can't slip through auto-approval --
 *      shell is unsandboxed and must always be at least grant- or ask-gated.
 *   3. Everything else consults stored grants (`chat` or `always` scope,
 *      constrained by path/command prefix where set) before falling back to
 *      `ask`.
 */
export class PermissionBroker {
  private readonly pending = new Map<string, PendingRequest>();

  constructor(private readonly store: Store) {}

  decide(tool: ToolSpec, args: unknown, policy: ToolPolicy, ctx: ToolContext): Decision {
    const policyDenial = checkPolicy(tool, policy);
    if (policyDenial) return { kind: 'deny', reason: policyDenial };

    // fs/shell tools act ON a workspace; without one configured for this
    // chat there is nothing for them to legitimately operate on (shell's
    // cwd is forced to workspace_root -- task 24 -- and every fs tool call
    // goes through containPath(workspaceRoot, ...), which itself denies a
    // null root). mcp tools carry no such requirement.
    if ((tool.source === 'fs' || tool.source === 'shell') && !ctx.workspaceRoot) {
      return {
        kind: 'deny',
        reason: `"${tool.name}" requires a workspace root, and none is configured for this chat.`,
      };
    }

    if (policy.approvalMode === 'ask_on_mutate' && tool.risk === 'read') {
      if (tool.source === 'fs') return { kind: 'allow', grantedBy: 'auto_read' };
      // An mcp server was already explicitly enabled by the user (a policy
      // action distinct from any single tool call), so a READ-risk call
      // against it is treated as pre-authorised by that policy decision --
      // distinct from auto_read, which is specifically the workspace-scoped
      // filesystem shortcut. Mutate/execute-risk mcp tools get no such
      // shortcut and fall through to the grant/ask path below like any
      // other mutating call.
      if (tool.source === 'mcp') return { kind: 'allow', grantedBy: 'policy' };
    }

    const grant = this.findMatchingGrant(tool, args, ctx);
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
      summary: summarize(tool, args),
    };
    this.pending.set(request.id, { tool, ctx });
    return { kind: 'ask', request };
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

    if (choice.choice === 'deny' || choice.choice === 'once') return;

    if (choice.choice === 'chat') {
      this.store.grants.create({
        id: randomUUID(),
        chatId: pending.ctx.chatId,
        profileId: null,
        toolName: pending.tool.name,
        scope: 'chat',
        constraint: null,
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
    if (pending.tool.source === 'shell' && !choice.constraint?.commandPrefix) {
      throw new Error(
        `Refusing to create an unconstrained "always" grant for shell tool "${pending.tool.name}": ` +
          'every always-scope grant for a shell tool must carry a commandPrefix constraint.'
      );
    }

    this.store.grants.create({
      id: randomUUID(),
      chatId: null,
      profileId: null,
      toolName: pending.tool.name,
      scope: 'always',
      constraint: choice.constraint,
      expiresAt: null,
    });
  }

  private findMatchingGrant(tool: ToolSpec, args: unknown, ctx: ToolContext): Grant | null {
    const now = Date.now();
    for (const grant of this.store.grants.list()) {
      if (grant.toolName !== tool.name) continue;
      if (grant.expiresAt !== null && grant.expiresAt <= now) continue;
      // null chatId = a global ('always') grant; a non-null chatId must
      // match this exact chat ('chat'-scope grants, or a scoped 'once').
      if (grant.chatId !== null && grant.chatId !== ctx.chatId) continue;
      if (!grantConstraintMatches(grant, args)) continue;
      return grant;
    }
    return null;
  }
}

// ---------------------------------------------------------------------------

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
      return null;
    case 'mcp':
      if (policy.mcpServerIds.length === 0) return 'No MCP servers are enabled by policy.';
      return null;
    default: {
      const exhaustive: never = tool.source;
      return `Unknown tool source: ${String(exhaustive)}`;
    }
  }
}

function grantConstraintMatches(grant: Grant, args: unknown): boolean {
  const constraint = grant.constraint;
  if (!constraint) return true;
  if (constraint.pathPrefix !== undefined) {
    const path = stringField(args, 'path');
    return path !== null && pathPrefixMatches(constraint.pathPrefix, path);
  }
  if (constraint.commandPrefix !== undefined) {
    const command = stringField(args, 'command');
    return command !== null && commandPrefixMatches(constraint.commandPrefix, command);
  }
  return false;
}

/**
 * Path-prefix matching by path SEGMENT, not by raw string prefix: a grant
 * on `/ws/src` must not authorise `/ws/src-secret/f` merely because the
 * text "/ws/src" is a character-for-character prefix of it. A match
 * requires exact equality, or the candidate continuing right after a path
 * separator boundary.
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
 * of any shell metacharacter anywhere in the command -- a constrained grant
 * authorises exactly that command plus plain trailing arguments, never
 * additional shell-interpreted syntax (chaining, piping, substitution,
 * redirection) that could run something else entirely.
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
