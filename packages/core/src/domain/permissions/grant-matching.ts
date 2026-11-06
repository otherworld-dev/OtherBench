/**
 * Tier 3 of the permission broker (`../permissions.ts`): whether a stored
 * `Grant` covers a call. `findMatchingGrant` is what `decide()` consults once
 * the policy ceiling and the per-source shortcuts have had their say. The
 * load-bearing rules (every key must match, a `pathPrefix` is matched on the
 * RESOLVED path, a host or app grant covers only its own source) are stated
 * on `PermissionBroker` and again where each is enforced below. The other
 * half, what an answer may store, is `grant-minting.ts`.
 */
import { sep } from 'node:path';
import { classifyAgentTool } from '../agent-tools.js';
import { normaliseHost } from '../browser-hosts.js';
import { appKey } from '../computer-apps.js';
import { canonicalHost } from '../network-hosts.js';
import { containPathIn } from '../paths.js';
import type { ToolContext, ToolSpec } from '../../ports/tool-provider.js';
import type { Grant, Store } from '../../ports/store.js';
import type { ToolSource } from '../../types/config.js';
import { rawField, stringField } from './fields.js';

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
export function isShellTool(tool: ToolSpec): boolean {
  return tool.source === 'shell' || SHELL_TOOL_NAMES.has(tool.name) || (tool.source === 'agent' && classifyAgentTool(tool.name).category === 'shell');
}

export function findMatchingGrant(store: Store, tool: ToolSpec, args: unknown, ctx: ToolContext): Grant | null {
  const now = Date.now();
  for (const grant of store.grants.list()) {
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

export type ConstraintKey = 'pathPrefix' | 'commandPrefix' | 'commandExact' | 'host' | 'app';
const CONSTRAINT_KEYS: readonly ConstraintKey[] = ['pathPrefix', 'commandPrefix', 'commandExact', 'host', 'app'];

/**
 * The keys a constraint actually sets. A key holding `undefined` is absent
 * (the server's parser spells "not given" that way). Returns `null` when the
 * constraint carries a key OtherBench doesn't know: such a grant can't be read,
 * so it neither matches nor gets stored.
 */
export function constraintKeys(constraint: object): ConstraintKey[] | null {
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
 * network, browser or computer call, and one with no key OtherBench knows covers
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

/** The sources whose grants are pinned to one `host`: the sandbox's network and the browser. */
export function isHostKeyed(source: ToolSource): source is 'network' | 'browser' {
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
export function hostOfCall(source: ToolSource, raw: unknown): string | null {
  if (source === 'browser') return typeof raw === 'string' ? normaliseHost(raw) : null;
  return canonicalHost(raw);
}
