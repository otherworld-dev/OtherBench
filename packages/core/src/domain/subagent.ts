import type { ChatEngine, EngineEvent, EngineRequest } from '../ports/chat-engine.js';
import type { Store } from '../ports/store.js';
import type { SubagentHost, ToolContext, ToolProvider, ToolSpec } from '../ports/tool-provider.js';
import type { FsMode, Profile, ResolvedProfile, ToolPolicy } from '../types/config.js';
import type { CanonMessage, Part, SerializedError } from '../types/messages.js';
import type { Usage } from '../types/usage.js';
import type { ResolvedFolder } from '../types/workspace.js';
import { classifyProviderError } from '../types/errors.js';
import { availableOn } from './availability.js';
import { applySubagentEvent, foldSubagentContent, type SubagentEndStatus, type SubagentEvent } from './parts.js';
import { RECALL_GUIDANCE } from './recall.js';
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

/** An MCP server name as it appears in `mcp__<server>__<tool>` (same rule as the provider's `sanitizeNameSegment`). */
function mcpSegment(name: string): string {
  const cleaned = name.replace(/[^a-zA-Z0-9_-]/g, '_');
  return cleaned.length > 0 ? cleaned : 'x';
}

/**
 * A sub-agent's tool policy: what BOTH the parent's and the chosen
 * profile's policies allow, narrowed further by the call. Never wider than
 * either. `serverNames` maps MCP server ids to names, for `ask.mcpServers`.
 */
export function subagentPolicy(
  parent: ToolPolicy,
  chosen: ToolPolicy,
  ask: SubagentToolsAsk = {},
  serverNames: ReadonlyMap<string, string> = new Map()
): { ok: true; policy: ToolPolicy } | { ok: false; message: string } {
  const fs = [parent.fs, chosen.fs, ask.files ?? 'readwrite'].reduce<FsMode>((low, m) => (FS_RANK[m] < FS_RANK[low] ? m : low), 'readwrite');
  const shell = parent.shell && chosen.shell && ask.shell !== false;

  const shared = parent.mcpServerIds.filter((id) => chosen.mcpServerIds.includes(id));
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

  const policy: ToolPolicy = {
    fs,
    shell,
    mcpServerIds,
    approvalMode: parent.approvalMode === 'always_ask' || chosen.approvalMode === 'always_ask' ? 'always_ask' : 'ask_on_mutate',
    artifacts: false,
    recall: parent.recall !== false && chosen.recall !== false,
    subagents: false,
  };
  return { ok: true, policy };
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

/** The `subagent` tool's description, naming the profiles it can run as. */
export function subagentToolDescription(profiles: readonly Profile[]): string {
  const listed = profiles.slice(0, PROFILES_LISTED_MAX).map((p) => {
    const about = p.description?.trim() ? `: ${p.description.trim().slice(0, PROFILE_DESCRIPTION_MAX_CHARS)}` : '';
    return `- "${p.name}" (${p.modelId})${about}`;
  });
  return [
    'Hand a self-contained job to a sub-agent: another assistant that works on its own with tools, then reports back.',
    "It can't see this chat, so put everything it needs in `prompt`: the goal, the files or facts involved, and what to report.",
    'Several subagent calls in one message run at the same time (up to 4 at once), so give independent jobs a call each.',
    'It has at most your tools, and `tools` can give it fewer. Its tool calls need the user\'s approval the same way yours do.',
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
 * folders note, the tools note and recall guidance when recall is offered.
 * No memory and no project text: the parent puts what it needs in the prompt.
 */
export function subagentSystemPrompt(
  profile: Pick<ResolvedProfile, 'systemPrompt' | 'connection'>,
  tools: readonly ToolSpec[],
  folders: readonly ResolvedFolder[],
  canRecall: boolean
): string {
  const blocks = [
    profile.systemPrompt?.trim() || null,
    SUBAGENT_ROLE_PROMPT,
    folders.length > 0 ? extraFoldersPrompt(folders) : null,
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

    if (this.deps.signal.aborted) return subagentResult({ status: 'cancelled', error: null, finishReason: null, parts: [] });

    this.send(callId, { type: 'start', label, prompt, profileId: chosen.id, profileName: chosen.name, modelId: chosen.modelId }, true);

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
      slot = await this.acquire(this.deps.signal);
      if (slot) {
        this.send(callId, { type: 'running' }, true);
        const tools = await this.toolsFor(chosen, narrowed.policy);
        const request = this.requestFor(chosen, label, prompt, callId, tools, child.signal);
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

  private requestFor(chosen: ResolvedProfile, label: string, prompt: string, callId: string, tools: ToolSpec[], signal: AbortSignal): EngineRequest {
    const { chatId, messageId, workspaceRoot, folders } = this.deps;
    const systemPrompt = subagentSystemPrompt(chosen, tools, folders, tools.some((t) => t.source === 'recall'));
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
      profile: { ...chosen, systemPrompt },
      messages: [message(`subagent-system:${callId}`, 'system', systemPrompt), message(`subagent-prompt:${callId}`, 'user', prompt)],
      tools,
      signal,
      chatId,
      messageId,
      workspaceRoot,
      ...(folders.length > 0 ? { folders } : {}),
      purpose: 'turn',
      subagent: { callId, label },
    };
  }
}
