import type { ChatEngine, EngineEvent, EngineRequest } from '../ports/chat-engine.js';
import type { Store } from '../ports/store.js';
import type { SubagentHost, ToolContext, ToolProvider, ToolSpec } from '../ports/tool-provider.js';
import { sandboxHostsOf, type FsMode, type Profile, type ResolvedProfile, type ToolPolicy } from '../types/config.js';
import type { CanonMessage, Part, SerializedError } from '../types/messages.js';
import type { Usage } from '../types/usage.js';
import type { PlanGate } from '../types/thread.js';
import type { ResolvedFolder } from '../types/workspace.js';
import { classifyProviderError } from '../types/errors.js';
import { availableOn } from './availability.js';
import { normaliseHost } from './browser-hosts.js';
import { applySubagentEvent, foldSubagentContent, type SubagentEndStatus, type SubagentEvent } from './parts.js';
import { RECALL_GUIDANCE } from './recall.js';
import { sandboxFoldersPrompt } from './sandbox-paths.js';
import { availableToolsPrompt, namesItsTools } from './tools-prompt.js';
import { extraFoldersPrompt } from './workspace.js';

/**
 * Sub-agents for API profiles (spec 2026-10-12-api-subagents-design). This
 * module holds the rules as pure functions and, below, the per-reply
 * `SubagentRunner` that runs them.
 */

export const SUBAGENT_ROLE_PROMPT =
  '# Working as a sub-agent\n' +
  "Another assistant gave you the task in the next message. You can't ask it or the user anything, and nobody reads your messages until you finish. Do the task with your tools, then end with a complete answer: your last message is all the other assistant gets back, so put everything it needs in it (what you found, file paths, what you changed, what you couldn't do).";

/** For a sub-agent started while the chat's Plan mode is on and no plan is approved yet: it has no propose_plan of its own. */
export const SUBAGENT_PLAN_NOTE =
  '# Plan mode\n' +
  "The user hasn't approved a plan for this work yet, so tools that change things (writing files, running commands) are refused for you too, and you can't propose a plan yourself. Look around with the tools that only read, and report what you found and what you would change.";

/** For a sub-agent whose profile has a sandboxed shell but which gets none here (`subagentShellWithheld`). */
export const SUBAGENT_NO_SHELL_NOTE =
  '# No shell\n' +
  "You have no run_command for this job. Your profile runs commands in the sandbox, but the chat that started you runs its commands on this machine, each with the user's approval, so a sandboxed shell isn't offered here. If the job needs a command run, say which one in your answer.";

/** The line the `subagent` tool's description gets for a parent whose shell runs on this machine. */
export const SUBAGENT_SHELL_LINE =
  "Your shell runs on this machine, so a sub-agent run as a profile whose shell runs in the sandbox has no shell. For a job that needs commands, use your own profile or one whose shell runs on this machine.";

export const MAX_CONCURRENT_SUBAGENTS = 4;
export const MAX_SUBAGENTS_PER_REPLY = 10;
export const SUBAGENT_ANSWER_MAX_CHARS = 20_000;
export const SUBAGENT_RESULT_COPY_MAX_CHARS = 4_000;
export const SUBAGENT_PROMPT_MAX_CHARS = 100_000;
export const SUBAGENT_LABEL_MAX_CHARS = 80;
export const SUBAGENT_STEP_LIMIT_NOTE = '[The sub-agent hit its step limit; this is where it got to.]';

const PROFILES_LISTED_MAX = 20;
const PROFILE_DESCRIPTION_MAX_CHARS = 100;

export type SubagentErrorCode =
  | 'invalid_input'
  | 'subagent_limit'
  | 'subagent_profile'
  | 'subagent_tools'
  | 'subagent_no_answer'
  | 'subagent_failed'
  | 'cancelled'
  | 'subagents_unavailable';

/** A `subagent` call's error result, in the `{ error: true, code, message }` shape every Grunt tool uses. */
export interface SubagentToolError {
  error: true;
  code: SubagentErrorCode;
  message: string;
}

export function subagentError(code: SubagentErrorCode, message: string): SubagentToolError {
  return { error: true, code, message };
}

// --- input ------------------------------------------------------------------

export interface SubagentToolsAsk {
  files?: FsMode;
  shell?: boolean;
  mcpServers?: string[];
}

export interface SubagentInput {
  description: string;
  prompt: string;
  profile?: string;
  tools?: SubagentToolsAsk;
}

const FS_MODES: readonly string[] = ['off', 'read', 'readwrite'];

/** Checks a `subagent` call's arguments. Empty or null `profile` means the caller's own. */
export function parseSubagentInput(args: unknown): { ok: true; input: SubagentInput } | { ok: false; message: string } {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) {
    return { ok: false, message: 'The subagent call needs an object with "description" and "prompt".' };
  }
  const a = args as Record<string, unknown>;
  const description = typeof a['description'] === 'string' ? a['description'].trim() : '';
  if (description.length === 0) return { ok: false, message: '"description" must be a short label, as non-empty text.' };
  const prompt = typeof a['prompt'] === 'string' ? a['prompt'] : '';
  if (prompt.trim().length === 0) return { ok: false, message: '"prompt" must be the whole task, as non-empty text.' };
  if (prompt.length > SUBAGENT_PROMPT_MAX_CHARS) {
    return { ok: false, message: `"prompt" is ${prompt.length} characters; at most ${SUBAGENT_PROMPT_MAX_CHARS} are allowed.` };
  }
  const input: SubagentInput = { description: description.slice(0, SUBAGENT_LABEL_MAX_CHARS), prompt };

  const profile = a['profile'];
  if (profile !== undefined && profile !== null) {
    if (typeof profile !== 'string') return { ok: false, message: '"profile" must be a profile name.' };
    if (profile.trim().length > 0) input.profile = profile.trim();
  }

  const tools = a['tools'];
  if (tools !== undefined && tools !== null) {
    if (typeof tools !== 'object' || Array.isArray(tools)) return { ok: false, message: '"tools" must be an object.' };
    const t = tools as Record<string, unknown>;
    const ask: SubagentToolsAsk = {};
    if (t['files'] !== undefined) {
      if (typeof t['files'] !== 'string' || !FS_MODES.includes(t['files'])) return { ok: false, message: '"tools.files" must be "off", "read" or "readwrite".' };
      ask.files = t['files'] as FsMode;
    }
    if (t['shell'] !== undefined) {
      if (typeof t['shell'] !== 'boolean') return { ok: false, message: '"tools.shell" must be true or false.' };
      ask.shell = t['shell'];
    }
    if (t['mcpServers'] !== undefined) {
      const list = t['mcpServers'];
      if (!Array.isArray(list) || !list.every((s) => typeof s === 'string')) return { ok: false, message: '"tools.mcpServers" must be a list of MCP server names.' };
      ask.mcpServers = list as string[];
    }
    input.tools = ask;
  }
  return { ok: true, input };
}

// --- policy -----------------------------------------------------------------

const FS_RANK: Record<FsMode, number> = { off: 0, read: 1, readwrite: 2 };
const FS_BY_RANK: readonly FsMode[] = ['off', 'read', 'readwrite'];

/** An MCP server name as it appears in `mcp__<server>__<tool>` (same rule as the provider's `sanitizeNameSegment`). */
function mcpSegment(name: string): string {
  const cleaned = name.replace(/[^a-zA-Z0-9_-]/g, '_');
  return cleaned.length > 0 ? cleaned : 'x';
}

/**
 * The sandbox allowlist entries both lists hold, in the first list's order
 * and spelling. Entries are compared whole (ignoring case): a `*.example.com`
 * on one side and `api.example.com` on the other share nothing, so that host
 * raises a card. That is narrower than either list, never wider.
 */
function sharedSandboxHosts(a: readonly string[], b: readonly string[]): string[] {
  const key = (h: string): string => h.trim().toLowerCase();
  const inB = new Set(b.map(key));
  const seen = new Set<string>();
  return a.filter((h) => {
    const k = key(h);
    if (!inB.has(k) || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** A policy's allowlist as the sandbox tool reads it (`sandboxHostsOf`: absent = the defaults). Anything that isn't a list of names is no hosts. */
function effectiveSandboxHosts(policy: ToolPolicy): string[] {
  const hosts: unknown = policy.sandboxHosts;
  if (hosts === undefined || hosts === null) return sandboxHostsOf(policy);
  return Array.isArray(hosts) ? hosts.filter((h): h is string => typeof h === 'string') : [];
}

/** A policy's blocked sites for the browser (absent = none), or null when the field is there but isn't a list of names. */
function blockedHostsOf(policy: ToolPolicy): string[] | null {
  const hosts: unknown = policy.browserBlockedHosts;
  if (hosts === undefined || hosts === null) return [];
  return Array.isArray(hosts) && hosts.every((h) => typeof h === 'string') ? (hosts as string[]) : null;
}

/** Both blocked lists as one: the first list's entries, then the second's that it doesn't already hold (compared by canonical host). */
function allBlockedHosts(a: readonly string[], b: readonly string[]): string[] {
  const seen = new Set<string>();
  return [...a, ...b].filter((h) => {
    const key = normaliseHost(h) ?? h.trim().toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Where a policy's `run_command` runs, read the way the provider and broker read it (`runsShellInSandbox`): anything but 'sandbox' is this machine. */
function shellRunsOf(policy: ToolPolicy): 'host' | 'sandbox' {
  return policy.shellRuns === 'sandbox' ? 'sandbox' : 'host';
}

/**
 * Both profiles have a shell, but the sub-agent gets none: the parent's runs
 * on this machine and the chosen profile's in the sandbox (see the `shell`
 * rule in `SUBAGENT_POLICY_RULES` for why).
 */
export function subagentShellWithheld(parent: ToolPolicy, chosen: ToolPolicy): boolean {
  return parent.shell === true && chosen.shell === true && shellRunsOf(parent) === 'host' && shellRunsOf(chosen) === 'sandbox';
}

const idsOf = (policy: ToolPolicy): string[] => (Array.isArray(policy.mcpServerIds) ? policy.mcpServerIds.filter((id): id is string => typeof id === 'string') : []);

/** What a narrowing rule works from: both policies and what the call asked for. */
export interface SubagentNarrowing {
  parent: ToolPolicy;
  chosen: ToolPolicy;
  ask: SubagentToolsAsk;
  /** The MCP servers both policies enable, cut down to the call's `mcpServers` when it named any. */
  mcpServerIds: string[];
}

/**
 * One rule per `ToolPolicy` field: what a sub-agent gets for it. This is the
 * whole of a sub-agent's policy, so it is the place where a sub-agent could
 * be given more than the reply that started it, and every rule must give a
 * value no wider than the PARENT's (and no wider than the chosen profile's).
 *
 * The type makes the table exhaustive: a field added to `ToolPolicy` without
 * a rule here fails typecheck. When a new field has no obvious way to
 * combine two policies, give it its most restrictive value (as `artifacts`,
 * `subagents`, `agentWeb` and `agentMcp` have), never the chosen profile's.
 *
 * Every rule also fails closed on a value it doesn't know (a profile synced
 * from a newer peer never went through this build's routes): an unknown file
 * mode is no files, an unknown approval mode asks always.
 */
export const SUBAGENT_POLICY_RULES: { readonly [K in keyof Required<ToolPolicy>]: (n: SubagentNarrowing) => Required<ToolPolicy>[K] } = {
  // The lowest of the parent's, the chosen profile's and the call's.
  fs: ({ parent, chosen, ask }) => {
    const ranks = [parent.fs, chosen.fs, ask.files ?? 'readwrite'].map((m) => FS_RANK[m] ?? 0);
    return FS_BY_RANK[Math.min(...ranks)] ?? 'off';
  },
  // Both must have a shell, the call may turn it off, and it must be a shell
  // the parent's own policy has. A sandboxed parent's sub-agent is sandboxed
  // whatever the chosen profile runs on. A host parent's sub-agent gets the
  // host shell (a card for each command, as the parent's) only as a profile
  // that runs on this machine too. Run as a sandboxed profile it gets NO
  // shell: the sandboxed run_command needs no card under "Ask on changes",
  // and every command of the parent's does, so offering it would let text
  // injected into the parent run commands (with the chat's folders and the
  // allowlisted hosts) that the parent's policy never allows without a card.
  shell: ({ parent, chosen, ask }) => parent.shell === true && chosen.shell === true && ask.shell !== false && !subagentShellWithheld(parent, chosen),
  // On this machine only when both run theirs here; never when the parent is sandboxed. Always named.
  shellRuns: ({ parent, chosen }) => (shellRunsOf(parent) === 'host' && shellRunsOf(chosen) === 'host' ? 'host' : 'sandbox'),
  // Only the hosts on both allowlists. Always named, even when empty: an absent list would mean the defaults again.
  sandboxHosts: ({ parent, chosen }) => sharedSandboxHosts(effectiveSandboxHosts(parent), effectiveSandboxHosts(chosen)),
  // The servers both enable, cut down by the call (worked out, and refused if the call names another, before the rules run).
  mcpServerIds: ({ mcpServerIds }) => [...mcpServerIds],
  // The stricter: "Ask on changes" only when both are exactly that.
  approvalMode: ({ parent, chosen }) => (parent.approvalMode === 'ask_on_mutate' && chosen.approvalMode === 'ask_on_mutate' ? 'ask_on_mutate' : 'always_ask'),
  // Claude Code's own tools: a sub-agent never runs as Claude Code, so it has none to allow.
  agentWeb: () => false,
  agentMcp: () => false,
  // Never, whatever either profile has: a sub-agent makes no artifacts (so no live pages) and starts no sub-agents.
  artifacts: () => false,
  subagents: () => false,
  // On only when both have it on (absent = on, as the policy defines it).
  recall: ({ parent, chosen }) => parent.recall !== false && chosen.recall !== false,
  // The browser (spec 2026-10-12-model-browser-design): only when both have it
  // on (absent = off), and only when both blocked lists can be read. A list
  // that isn't a list can't be added to the other, so the browser is off.
  browser: ({ parent, chosen }) => parent.browser === true && chosen.browser === true && blockedHostsOf(parent) !== null && blockedHostsOf(chosen) !== null,
  // Every site either profile blocks: the union, so the sub-agent can reach no
  // site its parent can't. Always named.
  browserBlockedHosts: ({ parent, chosen }) => allBlockedHosts(blockedHostsOf(parent) ?? [], blockedHostsOf(chosen) ?? []),
};

/**
 * A sub-agent's tool policy: what BOTH the parent's and the chosen
 * profile's policies allow, narrowed further by the call. Never wider than
 * either, field by field (`SUBAGENT_POLICY_RULES`), and every field is
 * written out, so nothing is left to a default. `serverNames` maps MCP
 * server ids to names, for `ask.mcpServers`.
 *
 * What this guarantees, and `subagent-policy-property.test.ts` checks
 * against the real broker for random pairs of policies: any call the
 * sub-agent's policy lets through without a card, the parent's policy lets
 * through without a card too. The thread tools (questions, plans,
 * checklists) aren't a policy field: `SubagentRunner.toolsFor` never offers
 * them, nor the artifact and subagent tools.
 */
export function subagentPolicy(
  parent: ToolPolicy,
  chosen: ToolPolicy,
  ask: SubagentToolsAsk = {},
  serverNames: ReadonlyMap<string, string> = new Map()
): { ok: true; policy: Required<ToolPolicy> } | { ok: false; message: string } {
  const chosenIds = idsOf(chosen);
  const shared = idsOf(parent).filter((id, i, all) => chosenIds.includes(id) && all.indexOf(id) === i);
  let mcpServerIds = shared;
  if (ask.mcpServers !== undefined) {
    const picked = new Set<string>();
    for (const wanted of ask.mcpServers) {
      const w = wanted.trim().toLowerCase();
      const id = shared.find((sid) => {
        const name = serverNames.get(sid) ?? sid;
        return name.toLowerCase() === w || mcpSegment(name).toLowerCase() === w;
      });
      if (id === undefined) {
        const names = shared.map((sid) => `"${serverNames.get(sid) ?? sid}"`);
        return {
          ok: false,
          message: names.length > 0
            ? `The sub-agent can't use the MCP server "${wanted}". It can use: ${names.join(', ')}.`
            : `The sub-agent can't use the MCP server "${wanted}": it can use no MCP servers.`,
        };
      }
      picked.add(id);
    }
    mcpServerIds = shared.filter((id) => picked.has(id));
  }

  const narrowing: SubagentNarrowing = { parent, chosen, ask, mcpServerIds };
  const policy: Partial<Record<keyof ToolPolicy, unknown>> = {};
  for (const field of Object.keys(SUBAGENT_POLICY_RULES) as (keyof ToolPolicy)[]) policy[field] = SUBAGENT_POLICY_RULES[field](narrowing);
  return { ok: true, policy: policy as Required<ToolPolicy> };
}

// --- profiles and the tool --------------------------------------------------

/** Profiles a sub-agent may run as: unarchived, with a connection that exists, isn't Claude Code and works on this machine. */
export function eligibleSubagentProfiles(store: Store): Profile[] {
  const self = store.nodes.self().id;
  return store.profiles.list().filter((p) => {
    if (p.archivedAt !== null) return false;
    const connection = store.connections.get(p.connectionId);
    return connection !== null && connection.kind !== 'claude_code' && availableOn(connection, self);
  });
}

export const SUBAGENT_TOOL_PARAMETERS = {
  type: 'object',
  properties: {
    description: { type: 'string', description: 'A short label for this job, shown to the user (a few words).' },
    prompt: { type: 'string', description: 'The whole task, with everything the sub-agent needs: it cannot see this chat.' },
    profile: { type: 'string', description: 'The name of a profile to run as (listed in the tool description). Leave out to use your own.' },
    tools: {
      type: 'object',
      description: 'Give it fewer tools than you have. Leave out for the same tools as you.',
      properties: {
        files: { type: 'string', enum: ['off', 'read', 'readwrite'] },
        shell: { type: 'boolean' },
        mcpServers: { type: 'array', items: { type: 'string' }, description: 'MCP server names it may use.' },
      },
      additionalProperties: false,
    },
  },
  required: ['description', 'prompt'],
  additionalProperties: false,
} as const;

/**
 * The `subagent` tool's description, naming the profiles it can run as.
 * `parent` is the policy the tool is listed for: when its shell runs on this
 * machine and a listed profile's runs in the sandbox, the description says
 * that profile's sub-agent has no shell, so the model can choose another.
 */
export function subagentToolDescription(profiles: readonly Profile[], parent?: ToolPolicy): string {
  const shown = profiles.slice(0, PROFILES_LISTED_MAX);
  const shellLine = parent !== undefined && shown.some((p) => subagentShellWithheld(parent, p.toolPolicy));
  const listed = profiles.slice(0, PROFILES_LISTED_MAX).map((p) => {
    const about = p.description?.trim() ? `: ${p.description.trim().slice(0, PROFILE_DESCRIPTION_MAX_CHARS)}` : '';
    return `- "${p.name}" (${p.modelId})${about}`;
  });
  return [
    'Hand a self-contained job to a sub-agent: another assistant that works on its own with tools, then reports back.',
    "It can't see this chat, so put everything it needs in `prompt`: the goal, the files or facts involved, and what to report.",
    'Several subagent calls in one message run at the same time (up to 4 at once), so give independent jobs a call each.',
    'It has at most your tools, and `tools` can give it fewer. Its tool calls need the user\'s approval the same way yours do.',
    ...(shellLine ? [SUBAGENT_SHELL_LINE] : []),
    'It returns only its final answer, as text.',
    ...(listed.length > 0 ? ['Profiles it can run as:', ...listed] : []),
    'Leave out `profile` to use your own.',
  ].join('\n');
}

/** The `subagent` tool's body: hands the call to the reply's runner, or says there is none (Claude Code, or a caller that gives none). */
export async function runSubagentTool(args: unknown, ctx: ToolContext): Promise<unknown> {
  if (!ctx.subagents) return subagentError('subagents_unavailable', "Sub-agents aren't available in this chat.");
  return ctx.subagents.run(args, ctx);
}

/**
 * A sub-agent's system prompt: its profile's own prompt, the role, the
 * folders note, any `notes` for this run (the sandbox note from
 * `sandboxFoldersPrompt` when its run_command is the sandboxed one,
 * `SUBAGENT_PLAN_NOTE` while a plan is waiting), the tools note and recall
 * guidance when recall is offered. No memory and no project text: the parent
 * puts what it needs in the prompt.
 */
export function subagentSystemPrompt(
  profile: Pick<ResolvedProfile, 'systemPrompt' | 'connection'>,
  tools: readonly ToolSpec[],
  folders: readonly ResolvedFolder[],
  canRecall: boolean,
  notes: readonly (string | null)[] = []
): string {
  const blocks = [
    profile.systemPrompt?.trim() || null,
    SUBAGENT_ROLE_PROMPT,
    folders.length > 0 ? extraFoldersPrompt(folders) : null,
    ...notes,
    tools.length > 0 && namesItsTools(profile.connection.kind) ? availableToolsPrompt(tools.map((t) => t.name)) : null,
    canRecall ? RECALL_GUIDANCE : null,
  ];
  return blocks.filter((b): b is string => b !== null && b.length > 0).join('\n\n');
}

// --- results ----------------------------------------------------------------

const UNSHOWABLE_RESULT_TEXT = "[a result Grunt couldn't show]";

function cutText(text: string): string {
  if (text.length <= SUBAGENT_RESULT_COPY_MAX_CHARS) return text;
  return `${text.slice(0, SUBAGENT_RESULT_COPY_MAX_CHARS)}\n… [Cut here: the result was ${text.length} characters, and the sub-agent saw all of it.]`;
}

/**
 * The copy of a tool result kept in the stored transcript: whole when short,
 * cut with a note when long. Never throws, whatever the tool returned.
 */
export function cutToolResultForCopy(result: unknown): unknown {
  if (typeof result === 'string') return cutText(result);
  let text: string;
  try {
    text = JSON.stringify(result) ?? String(result);
  } catch {
    // A BigInt somewhere inside: keep the content, with the BigInts as strings.
    try {
      const shown = JSON.stringify(result, (_key, value: unknown) => (typeof value === 'bigint' ? value.toString() : value));
      if (shown !== undefined) return shown.length <= SUBAGENT_RESULT_COPY_MAX_CHARS ? (JSON.parse(shown) as unknown) : cutText(shown);
    } catch {
      // Circular: fall through to plain text.
    }
    try {
      return cutText(String(result));
    } catch {
      // A null-prototype object has no toString to call.
      return UNSHOWABLE_RESULT_TEXT;
    }
  }
  return text.length <= SUBAGENT_RESULT_COPY_MAX_CHARS ? result : cutText(text);
}

export interface SubagentOutcome {
  status: SubagentEndStatus;
  error: SerializedError | null;
  /** The engine's `finish` reason, or null when it never finished. */
  finishReason: string | null;
  /** Its own transcript. */
  parts: Part[];
}

function textOf(parts: Part[]): string {
  return parts
    .filter((p): p is Extract<Part, { type: 'text' }> => p.type === 'text')
    .map((p) => p.text.trim())
    .filter((t) => t.length > 0)
    .join('\n\n');
}

/** What the parent model gets back: the sub-agent's final text, or an error result. */
export function subagentResult(outcome: SubagentOutcome): string | SubagentToolError {
  if (outcome.status === 'cancelled') {
    return subagentError('cancelled', 'The reply was stopped before this sub-agent finished, so it has no answer.');
  }
  if (outcome.status === 'error') {
    return subagentError('subagent_failed', `The sub-agent failed: ${outcome.error?.message ?? 'unknown error'}`);
  }
  // A last step of tool calls means it hit the engine's step limit, so the
  // text after its last tool call is empty: give what it wrote on the way.
  const hitStepLimit = outcome.finishReason === 'tool-calls';
  let text: string;
  if (hitStepLimit) {
    const all = textOf(outcome.parts);
    text = all.length > 0 ? `${SUBAGENT_STEP_LIMIT_NOTE}\n\n${all}` : '';
  } else {
    const lastTool = outcome.parts.findLastIndex((p) => p.type === 'tool-call' || p.type === 'tool-result');
    text = textOf(outcome.parts.slice(lastTool + 1));
  }
  if (text.length === 0) {
    return subagentError(
      'subagent_no_answer',
      hitStepLimit ? 'The sub-agent hit its step limit before it wrote anything, so it has no answer.' : 'The sub-agent finished without writing an answer.'
    );
  }
  return text.length > SUBAGENT_ANSWER_MAX_CHARS
    ? `${text.slice(0, SUBAGENT_ANSWER_MAX_CHARS)}\n\n[Cut: the full answer was ${text.length} characters.]`
    : text;
}

// --- the runner -------------------------------------------------------------

export interface SubagentRunnerDeps {
  store: Store;
  engine: ChatEngine;
  toolProvider: ToolProvider;
  /** Resolves another profile by id; without it only the parent's own profile can be chosen. */
  resolveProfile?: (id: string) => Promise<ResolvedProfile>;
  /** A folder's real path, as the sandbox mounts it (`TurnRunnerOptions.canonicalPath`); the sandbox note names that one. */
  canonicalPath?: (path: string) => string;
  /**
   * The parent reply's plan gate, when the chat's Plan mode is on (spec
   * 2026-10-12-thread-cards-design §4). Every sub-agent's request carries the
   * same gate object, so its calls are refused for changes until the user
   * approves the parent's plan, and allowed from then on.
   */
  plan?: PlanGate;
  /** The parent reply is a scheduled run with nobody watching: so is every sub-agent, which can raise no card either. */
  unattended?: boolean;
  now: () => number;
  generateId: () => string;
  chatId: string;
  /** The parent reply's id: cards, audit rows and usage rows all hang off it. */
  messageId: string;
  /** The parent's own profile, as resolved (its raw system prompt, not the composed one). */
  parent: ResolvedProfile;
  workspaceRoot: string | null;
  folders: ResolvedFolder[];
  /** The parent reply's signal: Stop, or the reply ending any other way, stops every sub-agent. */
  signal: AbortSignal;
  emit: (callId: string, event: SubagentEvent) => void;
  updateParts: (fn: (parts: Part[]) => Part[], force: boolean) => void;
  writeUsage: (profile: ResolvedProfile, usage: Usage, latencyMs: number, callId: string) => void;
}

/**
 * Tool sources a sub-agent never gets, whatever its policy says (defence in
 * depth: the narrowed policy already turns artifacts and sub-agents off).
 * `thread` is the thread-cards tools (ask the user, todos, plans), if that
 * work landed: a sub-agent can't ask anyone anything.
 */
const NEVER_FOR_SUBAGENTS: ReadonlySet<string> = new Set(['subagent', 'artifact', 'thread']);

const sameName = (a: string, b: string): boolean => a.trim().toLowerCase() === b.trim().toLowerCase();

function toSubagentEvent(event: EngineEvent): SubagentEvent | null {
  switch (event.type) {
    case 'text-delta':
      return { type: 'text-delta', text: event.text };
    case 'reasoning-delta':
      return { type: 'reasoning-delta', text: event.text };
    case 'notice':
      return { type: 'notice', text: event.text };
    case 'tool-call':
      return { type: 'tool-call', id: event.id, name: event.name, args: event.args };
    case 'tool-result':
      // The stored and broadcast copy is cut; the sub-agent's model already had the whole result.
      return { type: 'tool-result', id: event.id, name: event.name, result: cutToolResultForCopy(event.result), isError: event.isError };
    default:
      return null;
  }
}

/**
 * Runs one reply's sub-agents (spec 2026-10-12-api-subagents-design). Made
 * by `TurnRunner.runVariant` for a turn that offers the `subagent` tool and
 * reached by the tool through `ToolContext.subagents`. Each sub-agent is its
 * own model loop through the same engine, with tools from the same provider
 * (`listTools` of a narrowed policy, so the same broker gates every call),
 * under the parent's chat and reply. At most four run at once; the rest
 * wait in order.
 */
export class SubagentRunner implements SubagentHost {
  private started = 0;
  private active = 0;
  private readonly waiting: (() => void)[] = [];
  private readonly inFlight = new Set<Promise<unknown>>();
  private readonly callIds = new Set<string>();

  constructor(private readonly deps: SubagentRunnerDeps) {}

  run(input: unknown, ctx: ToolContext): Promise<unknown> {
    const job = this.runOne(input, ctx);
    this.inFlight.add(job);
    const done = (): void => {
      this.inFlight.delete(job);
    };
    job.then(done, done);
    return job;
  }

  async settled(): Promise<void> {
    while (this.inFlight.size > 0) await Promise.allSettled([...this.inFlight]);
  }

  private async runOne(input: unknown, ctx: ToolContext): Promise<unknown> {
    try {
      return await this.execute(input, ctx);
    } catch (err) {
      console.error('[SubagentRunner] a sub-agent failed outside its own error handling:', err);
      return subagentError('subagent_failed', `The sub-agent failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async execute(input: unknown, ctx: ToolContext): Promise<unknown> {
    const parsed = parseSubagentInput(input);
    if (!parsed.ok) return subagentError('invalid_input', parsed.message);
    if (this.started >= MAX_SUBAGENTS_PER_REPLY) {
      return subagentError('subagent_limit', `This reply has already started ${MAX_SUBAGENTS_PER_REPLY} sub-agents, the most one reply may. Do the rest of the work yourself.`);
    }
    // Deliberate: a refusal below (bad profile, bad tools, Stop before start) still counts toward the limit.
    this.started += 1;
    const { description: label, prompt } = parsed.input;
    const callId = ctx.toolCallId !== undefined && !this.callIds.has(ctx.toolCallId) ? ctx.toolCallId : this.deps.generateId();
    this.callIds.add(callId);

    const picked = await this.pickProfile(parsed.input.profile);
    if (!picked.ok) return subagentError('subagent_profile', picked.message);
    const chosen = picked.profile;

    const serverNames = new Map(this.deps.store.mcpServers.list().map((s) => [s.id, s.name] as const));
    const narrowed = subagentPolicy(this.deps.parent.toolPolicy, chosen.toolPolicy, parsed.input.tools, serverNames);
    if (!narrowed.ok) return subagentError('subagent_tools', narrowed.message);
    // It would have had a shell but for the sandbox rule (and the call didn't turn the shell off itself): it is told why.
    const shellWithheld = parsed.input.tools?.shell !== false && subagentShellWithheld(this.deps.parent.toolPolicy, chosen.toolPolicy);

    if (this.deps.signal.aborted) return subagentResult({ status: 'cancelled', error: null, finishReason: null, parts: [] });

    const startedAt = this.deps.now();
    const child = new AbortController();
    const follow = (): void => child.abort();
    this.deps.signal.addEventListener('abort', follow, { once: true });
    let parts: Part[] = [];
    let usage: Usage | null = null;
    let finishReason: string | null = null;
    let failure: SerializedError | null = null;
    let slot = false;
    let aborted = false;
    try {
      // Inside the try: if storing the start throws after it was broadcast,
      // the end below still goes out, so no card is left queued.
      this.send(callId, { type: 'start', label, prompt, profileId: chosen.id, profileName: chosen.name, modelId: chosen.modelId }, true);
      slot = await this.acquire(this.deps.signal);
      if (slot) {
        this.send(callId, { type: 'running' }, true);
        const tools = await this.toolsFor(chosen, narrowed.policy);
        const request = this.requestFor(chosen, narrowed.policy, shellWithheld, label, prompt, callId, tools, child.signal, ctx);
        for await (const event of this.deps.engine.stream(request)) {
          const subEvent = toSubagentEvent(event);
          if (subEvent) {
            parts = foldSubagentContent(parts, subEvent);
            // Deltas are throttled like the parent's; everything else is written at once.
            this.send(callId, subEvent, subEvent.type !== 'text-delta' && subEvent.type !== 'reasoning-delta');
          } else if (event.type === 'finish') {
            usage = event.usage;
            finishReason = event.finishReason;
          } else if (event.type === 'error') {
            failure = event.error;
          }
          // engine-meta is Claude Code's, which never runs a sub-agent: ignored.
        }
      }
    } catch (err) {
      failure = classifyProviderError(err);
    } finally {
      this.deps.signal.removeEventListener('abort', follow);
      aborted = child.signal.aborted || this.deps.signal.aborted;
      // Whatever ended it, nothing may still wait on it: this settles any
      // card it left open (the provider's abort path) as cancelled.
      child.abort();
      if (slot) this.release();
    }

    const status: SubagentEndStatus = failure
      ? failure.kind === 'cancelled' ? 'cancelled' : 'error'
      : finishReason !== null ? 'complete' : aborted || !slot ? 'cancelled' : 'complete';
    const result = subagentResult({ status, error: failure, finishReason, parts });
    // The usage row is a synchronous store write that can throw; the card must close either way.
    if (usage) {
      try {
        this.deps.writeUsage(chosen, usage, this.deps.now() - startedAt, callId);
      } catch (err) {
        console.error('[SubagentRunner] could not write a sub-agent usage row:', err);
      }
    }
    const endStatus: SubagentEndStatus = status === 'complete' && typeof result !== 'string' ? 'error' : status;
    const endError = endStatus === 'error' ? (failure?.message ?? (typeof result === 'string' ? undefined : result.message)) : undefined;
    this.sendEnd(callId, { type: 'end', status: endStatus, ...(endError !== undefined ? { error: endError } : {}), ...(usage ? { usage } : {}) });
    return result;
  }

  /** The closing event, forced: the broadcast and the stored card each get their try, so one failing can't stop the other. */
  private sendEnd(callId: string, event: SubagentEvent): void {
    try {
      this.deps.emit(callId, event);
    } catch (err) {
      console.error('[SubagentRunner] could not broadcast a sub-agent end:', err);
    }
    try {
      this.deps.updateParts((parts) => applySubagentEvent(parts, callId, event), true);
    } catch (err) {
      console.error('[SubagentRunner] could not store a sub-agent end:', err);
    }
  }

  private send(callId: string, event: SubagentEvent, force: boolean): void {
    this.deps.emit(callId, event);
    this.deps.updateParts((parts) => applySubagentEvent(parts, callId, event), force);
  }

  /** Waits for one of the `MAX_CONCURRENT_SUBAGENTS` slots, first come first served. False when the reply stopped first. */
  private acquire(signal: AbortSignal): Promise<boolean> {
    if (signal.aborted) return Promise.resolve(false);
    if (this.active < MAX_CONCURRENT_SUBAGENTS) {
      this.active += 1;
      return Promise.resolve(true);
    }
    return new Promise((resolve) => {
      const grant = (): void => {
        signal.removeEventListener('abort', onAbort);
        this.active += 1;
        resolve(true);
      };
      const onAbort = (): void => {
        const at = this.waiting.indexOf(grant);
        if (at !== -1) this.waiting.splice(at, 1);
        resolve(false);
      };
      this.waiting.push(grant);
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  private release(): void {
    this.active -= 1;
    this.waiting.shift()?.();
  }

  private async pickProfile(name: string | undefined): Promise<{ ok: true; profile: ResolvedProfile } | { ok: false; message: string }> {
    const parent = this.deps.parent;
    if (name === undefined || sameName(name, parent.name)) return { ok: true, profile: parent };
    const eligible = eligibleSubagentProfiles(this.deps.store);
    const choices = `Choose one of: ${eligible.map((p) => `"${p.name}"`).join(', ')}, or leave out "profile" to use your own.`;
    const matches = eligible.filter((p) => sameName(p.name, name));
    if (matches.length === 0) return { ok: false, message: `No profile called "${name}" can run a sub-agent here. ${choices}` };
    if (matches.length > 1) {
      return { ok: false, message: `${matches.length} profiles are called "${name}": ${matches.map((p) => `${p.id} (${p.modelId})`).join(' and ')}. Ask the user to rename one, or leave out "profile" to use your own.` };
    }
    const match = matches[0]!;
    if (match.id === parent.id) return { ok: true, profile: parent };
    if (!this.deps.resolveProfile) return { ok: false, message: 'Sub-agents can only run as your own profile here. Leave out "profile".' };
    try {
      return { ok: true, profile: await this.deps.resolveProfile(match.id) };
    } catch (err) {
      return { ok: false, message: `The profile "${match.name}" can't be used: ${err instanceof Error ? err.message : String(err)} ${choices}` };
    }
  }

  private async toolsFor(chosen: ResolvedProfile, policy: ToolPolicy): Promise<ToolSpec[]> {
    const listed = await this.deps.toolProvider.listTools(policy);
    // Recall is on by default, so a model that says it can't use tools isn't sent it (as runVariant does).
    return listed.filter((t) => !NEVER_FOR_SUBAGENTS.has(t.source) && !(chosen.model?.supportsTools === false && t.source === 'recall'));
  }

  private requestFor(
    chosen: ResolvedProfile,
    policy: ToolPolicy,
    shellWithheld: boolean,
    label: string,
    prompt: string,
    callId: string,
    tools: ToolSpec[],
    signal: AbortSignal,
    ctx: ToolContext
  ): EngineRequest {
    const { chatId, messageId, workspaceRoot, folders } = this.deps;
    // The parent's plan gate and unattended flag go with the sub-agent, from
    // the `subagent` call's own context and from the turn that made this
    // runner (either is enough: both only take permissions away). Plan mode
    // lets a planning reply start a sub-agent (`allowedWhilePlanning`) only
    // because of the first; a scheduled run's sub-agent can raise no card
    // because of the second.
    const plan = ctx.plan ?? this.deps.plan;
    const unattended = ctx.unattended === true || this.deps.unattended === true;
    // Its run_command is the sandboxed one (the narrowed policy decides): say where the folders are in there, as the parent's prompt does.
    const sandboxNote = workspaceRoot !== null && tools.some((t) => t.source === 'sandbox') ? sandboxFoldersPrompt(workspaceRoot, folders, this.deps.canonicalPath) : null;
    const systemPrompt = subagentSystemPrompt(chosen, tools, folders, tools.some((t) => t.source === 'recall'), [
      sandboxNote,
      shellWithheld ? SUBAGENT_NO_SHELL_NOTE : null,
      plan && !plan.approved ? SUBAGENT_PLAN_NOTE : null,
    ]);
    // Synthetic, never stored: the sub-agent sees no chat history.
    const message = (id: string, role: 'system' | 'user', text: string): CanonMessage => ({
      id,
      chatId,
      parentId: null,
      role,
      parts: [{ type: 'text', text }],
      status: 'complete',
      error: null,
      producedBy: null,
      createdAt: 0,
    });
    return {
      // The narrowed policy, not the chosen profile's own: nothing that reads the request's profile sees a wider one.
      profile: { ...chosen, systemPrompt, toolPolicy: policy },
      messages: [message(`subagent-system:${callId}`, 'system', systemPrompt), message(`subagent-prompt:${callId}`, 'user', prompt)],
      tools,
      signal,
      chatId,
      messageId,
      workspaceRoot,
      ...(folders.length > 0 ? { folders } : {}),
      purpose: 'turn',
      // Never auto mode, whatever the chat's toggle says: it hands approvals to
      // Claude Code's own classifier, and a sub-agent is never Claude Code.
      autoMode: false,
      ...(plan ? { plan } : {}),
      ...(unattended ? { unattended: true } : {}),
      subagent: { callId, label, parentProfileId: this.deps.parent.id, ...(chosen.id !== this.deps.parent.id ? { profileName: chosen.name } : {}) },
    };
  }
}
