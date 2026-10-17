import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HookCallback, McpServerConfig, Options, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { CLEAN_CHAT_AGENT_TOOLS, agentDisallowedTools } from '@otherbench/core/domain/agent-tools.js';
import { ARTIFACT_TOOL } from '@otherbench/core/domain/artifacts.js';
import { MAX_HISTORY_ATTACHMENT_BYTES } from '@otherbench/core/domain/attachment-binding.js';
import { RECALL_TOOL } from '@otherbench/core/domain/recall.js';
import { PLAN_TOOL, runPlanCommand } from '@otherbench/core/domain/thread-tools.js';
import { toolContextFor } from '@otherbench/core/domain/tool-context.js';
import { listedName, MAX_REQUEST_ATTACHMENT_BYTES, MAX_REQUEST_ATTACHMENTS, OMISSION_REASONS, omissionNote, selectWithinBudget, withinAfterLoad, type Omission } from '@otherbench/core/domain/request-budget.js';
import { sniffToolImageMime } from '@otherbench/core/domain/tool-images.js';
import type { ChatEngine, ConnectionTestResult, DiscoveredModel, EngineBackgroundEvent, EngineEvent, EngineRequest, SelfStart } from '@otherbench/core/ports/chat-engine.js';
import type { AskInput, ToolContext, ToolProvider, ToolSpec } from '@otherbench/core/ports/tool-provider.js';
import type { Connection, ToolPolicy } from '@otherbench/core/types/config.js';
import type { CanonMessage, Part } from '@otherbench/core/types/messages.js';
import type { PlanUsage } from '@otherbench/core/types/usage.js';
import { canUseToolFor, createGate, permissionDeniedHook, preToolUseHook, type Gate, type OtherBenchTool } from './approval.js';
import { otherBenchArtifactTool, otherBenchMcpServer, otherBenchPlanTool, otherBenchRecallTool, otherBenchServerName, otherBenchToolName, type OtherBenchServerTool } from './otherbench-server.js';
import { backendOf, buildChildEnv, CLAUDE_BACKEND } from './env.js';
import { autoModeUnavailable, classifyClaudeCodeFailure, isMissingSessionError } from './errors.js';
import { SdkEventMapper } from './events.js';
import { HelperRegistry } from './helpers.js';
import { BackgroundTasks } from './background.js';
import { renderHistory } from './history.js';
import { LivePool, LiveProcess, liveKey, PromptQueue, type OtherBenchServerSwitches, type TurnBinding } from './live.js';
import { toPlanUsage } from './plan-usage.js';
import { buildRelay, currentRelayed, relayServerTool, runRelayed, type Relay } from './relay.js';
import { pickSession, SessionClaims, type SessionPlan } from './session.js';
import { ApprovalTickets } from './tickets.js';

export type QueryFn = (params: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => AsyncIterable<SDKMessage> & {
  interrupt(): Promise<unknown>;
  /** Stops one background task (a helper, a background command) by Claude Code's task id. */
  stopTask?(taskId: string): Promise<unknown>;
  supportedModels(): Promise<{ value: string; displayName: string }[]>;
  accountInfo(): Promise<{ email?: string; subscriptionType?: string }>;
  /** The data behind /usage. Experimental in the SDK and may go away, hence optional; its answer is checked, not trusted (plan-usage.ts). */
  usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET?(opts?: { skipBehaviors?: boolean }): Promise<unknown>;
};

export interface ClaudeCodeEngineDeps {
  query: QueryFn;
  /** `askUser` answers Claude Code's AskUserQuestion and OtherBench's propose_plan through cards; without it both are refused. */
  approvals: Pick<ToolProvider, 'requestApproval' | 'recordAgentDenial'> & Partial<Pick<ToolProvider, 'askUser'>>;
  /** Model listing for an endpoint backend (e.g. Ollama), supplied by the server. */
  listEndpointModels: (conn: Connection, token: string | null) => Promise<DiscoveredModel[]>;
  /** Defaults to `process.env`. */
  baseEnv?: NodeJS.ProcessEnv;
  /** How long a model-list / connection-test probe may take. Defaults to 20 s. */
  probeTimeoutMs?: number;
  /** How long an idle Claude Code process waits for the next message. Defaults to 30 minutes. */
  liveIdleMs?: number;
  /** How many idle Claude Code processes are kept. Defaults to 3. */
  maxLive?: number;
  /**
   * Runs an `artifact` tool call for a reply (Deck #896): the server's
   * executor. `mcpServerIds` are the profile's, so a live declaration (spec
   * 2026-10-12-live-artifacts) is checked against its tools. Without it,
   * Claude Code gets no artifact tool.
   */
  artifactTool?: (ctx: { chatId: string; messageId: string; mcpServerIds: string[] }, args: unknown) => Promise<unknown>;
  /** Runs a `recall` tool call for a reply (spec 2026-10-09-recall-design): the server's executor. Without it, Claude Code gets no recall tool. */
  recallTool?: (ctx: { chatId: string }, args: unknown) => Promise<unknown>;
  /**
   * Where a chat with no folder runs (a clean chat, spec
   * 2026-10-11-claude-code-clean-chat-and-mcp-design §1): each such chat gets
   * `<scratchRoot>/<chat id>`, the same folder every turn so its session
   * resumes. Without it, a private folder made in the system temp folder for
   * this engine (never a fixed path there, which another user could make first).
   */
  scratchRoot?: string;
  /**
   * What OtherBench relays to Claude Code through its own server for this policy,
   * as an API model gets it but ungated (OtherBenchToolProvider.relayTools): the
   * allowlisted MCP servers' tools (spec 2026-10-11-claude-code-clean-chat-and-mcp-design §2),
   * the sandboxed run_command when the shell runs in the sandbox (spec
   * 2026-10-12-sandbox-design), and the browser when the profile turns it on
   * (spec 2026-10-12-model-browser-design §4). The gate approves each call
   * first, and a tool that describes its calls (the browser) runs only with
   * the arguments the gate approved. Without it, no relay.
   */
  relayTools?: (policy: ToolPolicy) => ToolSpec[];
  /** Builds OtherBench's MCP server from its name and tools; defaults to the SDK's in-process server. Tests pass a fake. */
  mcpServer?: (name: string, tools: OtherBenchServerTool[]) => McpServerConfig;
}

const PROBE_TIMEOUT_MS = 20_000;

/** How long a stopped reply's turn may take to end after Claude Code is interrupted before its process is closed. */
export const INTERRUPT_GRACE_MS = 5_000;

/** A clean chat's folder name under the scratch root: its id, made a plain name so it can't point outside (the server deletes it by the same rule). */
export function scratchFolderName(chatId: string): string {
  return chatId.replace(/[^A-Za-z0-9_-]/g, '_');
}

/** A notice waiting for a safe moment to be yielded (see ClaudeCodeChatEngine.stream). */
type PendingNotice = { text: string | null };

type ContentBlock ={ type: 'text'; text: string } | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } };

/**
 * Whether a message read while no reply is attached begins a turn of the
 * main agent: Claude Code carrying on by itself. A helper's own messages
 * (with a parent tool call) and system messages don't.
 */
function startsOwnTurn(message: SDKMessage): boolean {
  const m = message as unknown as { type?: unknown; parent_tool_use_id?: unknown };
  return (m.type === 'stream_event' || m.type === 'assistant') && m.parent_tool_use_id === null;
}

/** A message to Claude Code; `uuid` lets the reply find the result of its own turn. */
const userMessage = (content: ContentBlock[], uuid?: string): SDKUserMessage =>
  ({ type: 'user', message: { role: 'user', content }, parent_tool_use_id: null, origin: { kind: 'human' }, ...(uuid ? { uuid } : {}) }) as unknown as SDKUserMessage;

/** A one-message prompt stream that stays open until `close()` -- hooks and canUseTool travel over the same channel, so input must not end before the result. */
function promptStream(content: ContentBlock[]): { stream: AsyncIterable<SDKUserMessage>; close: () => void } {
  let close!: () => void;
  const closed = new Promise<void>((r) => (close = r));
  async function* gen(): AsyncGenerator<SDKUserMessage> {
    yield userMessage(content);
    await closed;
  }
  return { stream: gen(), close };
}

/**
 * Shared by utility calls and connection probes: no settings files, no MCP
 * servers (none passed, and strict so none are loaded from config), no
 * extended thinking, and no session written to disk.
 */
const lightweightOptions = (): Pick<Options, 'settingSources' | 'strictMcpConfig' | 'thinking' | 'persistSession'> => ({
  settingSources: [],
  strictMcpConfig: true,
  thinking: { type: 'disabled' },
  persistSession: false,
});

const textOf = (m: CanonMessage | undefined): string => (m?.parts ?? []).filter((p) => p.type === 'text').map((p) => (p as { text: string }).text).join('\n');

/**
 * The names of the new message's non-image attachments, which Claude Code
 * turns do not receive, as they go into the transcript's notice and into the
 * prompt: each cleaned by core's `listedName` (one line, no control or hidden
 * character, at most 80 characters, no quote, no bracket that could close a
 * note, no comma that could pass for two names). A name with nothing left in
 * it is still listed, so the file is not dropped from the count.
 */
const skippedFiles = (m: CanonMessage | undefined): string[] => (m?.parts ?? []).flatMap((p) => (p.type === 'file' ? [listedName(p.filename) || 'unnamed file'] : []));

/** The transcript's line about the new message's images that were not sent (how many, and each reason once), or null when all were. */
function omittedImagesNotice(omitted: Omission[]): string | null {
  if (omitted.length === 0) return null;
  const reasons = [...new Set(omitted.map((why) => OMISSION_REASONS[why]))];
  return `Not sent to Claude Code: ${omitted.length} ${omitted.length === 1 ? 'image' : 'images'} (${reasons.join('; ')}).`;
}

/**
 * Runs OtherBench turns through the local Claude Code install via the Agent SDK
 * (spec: docs/superpowers/specs/2026-10-02-claude-code-engine-design.md).
 * Claude Code owns the agent loop and its tools; OtherBench owns permission
 * (every call goes through `approvals.requestApproval`) and the transcript.
 */
export class ClaudeCodeChatEngine implements ChatEngine {
  private readonly claims = new SessionClaims();
  /** Where clean chats run when `deps.scratchRoot` isn't given: made on first use (scratchFolder). */
  private privateScratch: string | undefined;
  /** Claude Code processes kept alive between replies, by session (see live.ts). */
  private readonly pool: LivePool;
  /** Every process started, so `dispose` can stop the busy ones too. */
  private readonly processes = new Set<LiveProcess>();
  /** Where work Claude Code does between replies is reported (spec 2026-10-17-claude-background-helpers-design). */
  private backgroundHandler: ((event: EngineBackgroundEvent) => void) | null = null;

  constructor(private readonly deps: ClaudeCodeEngineDeps) {
    this.pool = new LivePool(deps.liveIdleMs, deps.maxLive);
  }

  /** Stops every Claude Code process this engine started (server shutdown). */
  dispose(): void {
    this.pool.closeAll();
    for (const live of this.processes) live.close();
    this.processes.clear();
  }

  onBackground(handler: (event: EngineBackgroundEvent) => void): void {
    this.backgroundHandler = handler;
  }

  async stopHelper(chatId: string, taskId: string): Promise<boolean> {
    for (const live of this.processes) {
      if (live.isClosed || live.background?.chatId !== chatId || !live.background.has(taskId)) continue;
      await live.query.stopTask?.(taskId);
      return true;
    }
    return false;
  }

  /** What Claude Code does while no reply is attached to the process. */
  private handleIdle(live: LiveProcess, message: SDKMessage): void {
    if (startsOwnTurn(message)) this.selfStart(live, message);
  }

  /**
   * Claude Code began a turn by itself (a helper reported back): it's handed
   * to whoever runs replies as a self-start, its output buffered until then.
   * With nobody to run it, it's read to its end and dropped.
   */
  private selfStart(live: LiveProcess, first: SDKMessage): void {
    const placeholder = `self-${randomUUID()}`;
    const feed = live.attach(placeholder);
    feed.push(first);
    // Helper cards it starts belong to its reply, whose id comes when it runs.
    if (live.background) {
      live.background.current = placeholder;
      live.background.handle(first);
    }
    const iterator = feed[Symbol.asyncIterator]();
    let taken = false;
    const drain = async (): Promise<void> => {
      for (let next = await iterator.next(); !next.done; next = await iterator.next());
    };
    const last = live.last;
    if (!last || !this.backgroundHandler) {
      void drain();
      return;
    }
    const finished = live.background?.lastFinished ?? null;
    const notice = finished === null
      ? 'Carried on after a background task finished.'
      : finished.kind === 'local_agent'
        ? `Carried on after the helper "${finished.label}" reported back.`
        : `Carried on after the background task "${finished.label}" finished.`;
    const start: SelfStart = {
      chatId: last.chatId,
      afterMessageId: last.messageId,
      profileId: last.profileId,
      notice,
      unattended: last.unattended,
      run: (req) => {
        if (taken) throw new Error('A self-started turn runs once.');
        taken = true;
        live.background?.renameCurrent(placeholder, req.messageId);
        return this.runSelfStarted(live, req, iterator);
      },
      decline: () => {
        if (taken) return;
        taken = true;
        void drain();
      },
    };
    this.backgroundHandler({ type: 'self-start', start });
  }

  /** A self-started turn, for the reply `req` describes: gated and mapped like a user's reply, from the output already buffered. */
  private async *runSelfStarted(live: LiveProcess, req: EngineRequest, feed: AsyncIterator<SDKMessage>): AsyncGenerator<EngineEvent> {
    const backend = backendOf(req.profile.connection);
    const clean = !req.workspaceRoot;
    const cwd = req.workspaceRoot ?? this.scratchFolder(req.chatId);
    const prepared = this.prepareReply(req, backend, clean);
    live.binding = prepared.binding;
    live.last = { chatId: req.chatId, messageId: req.messageId, profileId: req.profile.id, policy: req.profile.toolPolicy, ctx: prepared.gateCtx, autoMode: prepared.autoMode, unattended: req.unattended === true };
    const mapper = this.replyMapper(live, req, prepared.helpers);
    let stopped!: () => void;
    const stoppedNow = new Promise<{ stopped: true }>((resolve) => (stopped = () => resolve({ stopped: true })));
    const onAbort = (): void => {
      void live.query.interrupt().catch(() => live.close());
      stopped();
    };
    req.signal.addEventListener('abort', onAbort, { once: true });
    if (req.signal.aborted) onAbort();
    let pending: Promise<IteratorResult<SDKMessage>> | null = null;
    let ended = false;
    try {
      yield { type: 'engine-meta', meta: { engine: 'claude_code', sessionId: live.sessionId ?? '', backend, cwd, tools: [], mcpServers: [] } };
      for (;;) {
        pending ??= feed.next();
        const next = await Promise.race([pending, stoppedNow]);
        if ('stopped' in next) {
          yield* mapper.backgroundOpen() as EngineEvent[];
          break;
        }
        pending = null;
        if (next.done) break;
        if ((next.value as { type?: unknown }).type === 'result') ended = true;
        for (const event of mapper.map(next.value)) {
          if (event.type === 'init' || event.type === 'rate-limited') continue;
          if (event.type === 'result-error') {
            if (!req.signal.aborted) yield { type: 'error', error: classifyClaudeCodeFailure(event.text, { backend, modelId: req.profile.modelId }) };
            continue;
          }
          yield event;
        }
        if (ended) break;
      }
    } finally {
      prepared.tickets.clear();
      req.signal.removeEventListener('abort', onAbort);
      live.binding = null;
      // Stopped mid-turn: read the rest in the background (the process stays pooled, as it already is).
      if (req.signal.aborted && !ended && !live.isClosed) void this.finishSelfStopped(live, feed, pending);
    }
  }

  /** After a self-started reply is stopped: reads its turn to the end; one that doesn't end in time closes the process. */
  private async finishSelfStopped(live: LiveProcess, feed: AsyncIterator<SDKMessage>, pending: Promise<IteratorResult<SDKMessage>> | null): Promise<void> {
    const timer = setTimeout(() => live.close(), INTERRUPT_GRACE_MS);
    timer.unref?.();
    try {
      for (let next = await (pending ?? feed.next()); !next.done; next = await feed.next());
    } catch {
      live.close();
    } finally {
      clearTimeout(timer);
    }
  }

  async *stream(req: EngineRequest): AsyncIterable<EngineEvent> {
    if (req.purpose === 'utility') {
      yield* this.utility(req);
      return;
    }
    if (req.workspaceRoot && !existsSync(req.workspaceRoot)) {
      yield { type: 'error', error: { kind: 'unknown', retryable: false, message: `Workspace folder ${req.workspaceRoot} doesn't exist.` } };
      return;
    }
    // No folder: a clean chat, run in the chat's own empty scratch folder.
    const clean = !req.workspaceRoot;
    const cwd = req.workspaceRoot ?? this.scratchFolder(req.chatId);

    // Not yielded yet: an event yielded before the engine has done any real
    // work reaches TurnRunner before the turn's live stream is registered and
    // is dropped from SSE. runTurn yields it right after the init message
    // (or before an error if Claude Code fails before init).
    const skipped = skippedFiles(req.messages[req.messages.length - 1]);
    const notice: PendingNotice = { text: skipped.length > 0 ? `Not sent to Claude Code (only images are): ${skipped.join(', ')}.` : null };

    const conn = req.profile.connection;
    const backend = backendOf(conn);
    const plan = pickSession({ history: req.messages, backend, cwd, latestMessageForSession: req.latestMessageForSession, claims: this.claims });
    try {
      // The new message's images are read once, before either attempt: a retry sends the same ones, and
      // what was left out is said once, in the same notice as the files.
      const images = await this.newImages(req);
      const leftOut = omittedImagesNotice(images.omitted);
      if (leftOut !== null) notice.text = notice.text === null ? leftOut : `${notice.text} ${leftOut}`;
      const first = yield* this.runTurn(req, plan, backend, notice, cwd, clean, images.blocks);
      // A stopped turn never starts a second Claude Code process.
      if (first === 'missing-session' && !req.signal.aborted) {
        yield { type: 'notice', text: "The earlier Claude Code session couldn't be found, so OtherBench started a new Claude Code session with this chat's history." };
        yield* this.runTurn(req, { mode: 'fresh' }, backend, notice, cwd, clean, images.blocks);
      }
    } finally {
      if (plan.mode === 'continue') this.claims.release(plan.sessionId);
    }
  }

  /**
   * One reply. It continues the session's live Claude Code process when one
   * is waiting with the same options (the planner already checked this
   * message answers the session's tip), else starts a process -- resuming
   * the session or fresh -- that stays alive afterwards for the next message.
   * Returns 'missing-session' (having yielded nothing) when a resume target
   * is gone. Yields `notice.text` once, after the init message or before an
   * error, and clears it.
   */
  private async *runTurn(
    req: EngineRequest,
    plan: SessionPlan,
    backend: string,
    notice: PendingNotice,
    cwd: string,
    clean: boolean,
    images: ContentBlock[]
  ): AsyncGenerator<EngineEvent, 'done' | 'missing-session'> {
    const profile = req.profile;
    const content = this.userContent(req, plan.mode === 'fresh', images);
    const { gateCtx, autoMode, own, relay, tickets, helpers, binding } = this.prepareReply(req, backend, clean);
    const options = this.processOptions(req, cwd, autoMode, clean);
    const key = liveKey(options, { backend, token: profile.apiKey }, own);
    const taken = plan.mode === 'continue' ? await this.pool.takeWhenFree(plan.sessionId, key) : null;
    const reused = taken !== null;
    const live = taken ?? this.startProcess(options, key, plan, own, relay);
    // A reply stopped before it began starts no turn: a new process is closed, a pooled one goes back.
    if (req.signal.aborted) {
      if (reused) this.pool.release(live);
      else live.close();
      return 'done';
    }
    live.binding = binding;
    live.last = { chatId: req.chatId, messageId: req.messageId, profileId: profile.id, policy: profile.toolPolicy, ctx: gateCtx, autoMode, unattended: req.unattended === true };
    return yield* this.runReplyTurn(req, plan, backend, notice, cwd, live, reused, content, autoMode, helpers, tickets);
  }

  /**
   * What a reply binds a process's hooks to: its gate (with its tool
   * context, policy and auto mode), its own tools and relay, and the switches
   * the process key needs. A user's reply and a self-started one build it the same way.
   */
  private prepareReply(req: EngineRequest, backend: string, clean: boolean): { gateCtx: ToolContext; autoMode: boolean; own: OtherBenchServerSwitches; relay: Relay; tickets: ApprovalTickets; helpers: HelperRegistry; binding: TurnBinding } {
    const profile = req.profile;
    // Auto mode needs the Claude login; an endpoint backend always runs in
    // default mode (spec 2026-10-03-claude-code-auto-mode-design section 4).
    const autoMode = req.autoMode === true && backend === CLAUDE_BACKEND;
    // The reply's tool context: ids, folder (none for a clean chat, whose
    // scratch folder is not a workspace), extra folders, the plan gate and the
    // unattended flag.
    const gateCtx: ToolContext = toolContextFor(req);
    const approvals = this.deps.approvals;
    const askUser = approvals.askUser ? (ctx: ToolContext, input: AskInput) => approvals.askUser!(ctx, input) : undefined;
    // Artifacts (Deck #896) and recall (spec 2026-10-09-recall-design): a
    // process's OtherBench server has each tool or not from its start, so the
    // switches are part of the process key.
    const { artifactTool, recallTool } = this.deps;
    // The profile's MCP servers, the sandboxed run_command when its shell
    // runs in the sandbox, and the browser when it is on, relayed through the
    // same server (relay.ts). A clean chat has no folder for a command to run
    // in, so it gets no run_command; it does get the browser, which needs none.
    const relayed = this.deps.relayTools ? this.deps.relayTools(profile.toolPolicy).filter((s) => !(clean && s.source === 'sandbox')) : [];
    const relay = buildRelay(relayed);
    const own: OtherBenchServerSwitches = {
      artifacts: artifactTool !== undefined && profile.toolPolicy.artifacts !== false,
      recall: recallTool !== undefined && profile.toolPolicy.recall !== false,
      plan: req.plan !== undefined && askUser !== undefined,
      relay: relay.hash,
    };
    const tickets = new ApprovalTickets();
    // The helpers this reply's agent starts: the mapper records them, the gate names them on approval cards.
    const helpers = new HelperRegistry();
    const binding: TurnBinding = {
      gate: createGate({
        approvals: this.deps.approvals,
        policy: profile.toolPolicy,
        ctx: gateCtx,
        autoMode,
        helpers,
        onApproved: (spec, input, args) => tickets.add(spec.name, input, args),
      }),
      ...(autoMode ? { permissionDenied: permissionDeniedHook({ approvals: this.deps.approvals, ctx: gateCtx }) } : {}),
      ...(artifactTool && own.artifacts ? { artifact: (args: unknown) => artifactTool({ chatId: req.chatId, messageId: req.messageId, mcpServerIds: profile.toolPolicy.mcpServerIds }, args) } : {}),
      ...(recallTool && own.recall ? { recall: (args: unknown) => recallTool({ chatId: req.chatId }, args) } : {}),
      ...(own.plan && askUser ? { plan: (args: unknown) => runPlanCommand(askUser, gateCtx, args) } : {}),
      // The current reply's spec for that tool, not the one the process started
      // with (an edit to the sandbox allowlist or the browser's blocked sites
      // applies without a new process), and only if it is the kind of tool the
      // gate approved: see currentRelayed, which fails closed (the browser
      // branch's `?? spec` fallback to the old spec is not kept). A tool that
      // describes its calls then runs only with its approval ticket: runRelayed.
      ...(relay.tools.size > 0 ? { relay: async (approved: ToolSpec, args: unknown) => runRelayed(currentRelayed(relay, approved), args, gateCtx, tickets) } : {}),
      tickets,
    };
    return { gateCtx, autoMode, own, relay, tickets, helpers, binding };
  }

  /** The mapper for one reply on `live`: this process's own tools under the API engines' names, helper cards noted for its background tasks. */
  private replyMapper(live: LiveProcess, req: EngineRequest, helpers: HelperRegistry): SdkEventMapper {
    const renames = new Map<string, string>();
    if (live.artifactTool) renames.set(live.artifactTool, ARTIFACT_TOOL);
    if (live.recallTool) renames.set(live.recallTool, RECALL_TOOL);
    if (live.planTool) renames.set(live.planTool, PLAN_TOOL);
    for (const [claudeName, apiName] of live.relayNames) renames.set(claudeName, apiName);
    return new SdkEventMapper({ ...(renames.size > 0 ? { renames } : {}), helpers, profileId: req.profile.id, modelId: req.profile.modelId });
  }

  /** A user's reply on `live`: sends its message and reads its turn (see runTurn). */
  private async *runReplyTurn(
    req: EngineRequest,
    plan: SessionPlan,
    backend: string,
    notice: PendingNotice,
    cwd: string,
    live: LiveProcess,
    reused: boolean,
    content: ContentBlock[],
    autoMode: boolean,
    helpers: HelperRegistry,
    tickets: ApprovalTickets
  ): AsyncGenerator<EngineEvent, 'done' | 'missing-session'> {
    const flushNotice = function* (): Generator<EngineEvent> {
      const text = notice.text;
      if (text === null) return;
      notice.text = null;
      yield { type: 'notice', text };
    };
    const profile = req.profile;
    // The process's background tasks, for this chat; this reply's own helper cards are left to its mapper.
    live.background ??= new BackgroundTasks(req.chatId, (event) => this.backgroundHandler?.(event));
    live.background.current = req.messageId;
    live.onIdle = (message) => this.handleIdle(live, message);
    // This reply's turn, up to its own result: attached before the message
    // goes, so nothing of it is missed and nothing else reaches it.
    const uuid = randomUUID();
    const feed = live.attach(uuid)[Symbol.asyncIterator]();

    // Stopping a reply interrupts Claude Code's turn and keeps the process, so
    // its background helpers carry on and the next message continues the
    // session. The reply ends at once; the turn is read to its end in the
    // background (finishStopped), and one that doesn't end in time closes the process.
    let stopped!: () => void;
    const stoppedNow = new Promise<{ stopped: true }>((resolve) => (stopped = () => resolve({ stopped: true })));
    const onAbort = (): void => {
      void live.query.interrupt().catch(() => live.close());
      stopped();
    };
    req.signal.addEventListener('abort', onAbort, { once: true });
    live.input.push(userMessage(content, uuid));

    const mapper = this.replyMapper(live, req, helpers);
    let sawInit = false;
    let finished = false;
    // The turn's own result arrived (a success or not): the process is in a known state.
    let ended = false;
    let rateLimitResetsAt: number | null = null;
    let pending: Promise<IteratorResult<SDKMessage>> | null = null;
    try {
      while (!finished) {
        pending ??= feed.next();
        const next = await Promise.race([pending, stoppedNow]);
        if ('stopped' in next) {
          // Its helpers working in the background carry on: their cards say so rather than stopped.
          yield* mapper.backgroundOpen() as EngineEvent[];
          break;
        }
        pending = null;
        if (next.done) {
          // The output ended (the process died) unless this turn's result was the last thing.
          if (live.failure !== null && !ended) throw live.failure;
          break;
        }
        if ((next.value as { type?: unknown }).type === 'result') ended = true;
        for (const event of mapper.map(next.value)) {
          if (event.type === 'init') {
            sawInit = true;
            live.sessionId = event.sessionId;
            if (autoMode && event.permissionMode !== 'auto') {
              // Claude Code started in another mode: auto mode isn't available
              // for this account or model. Stop before the model does any work,
              // and persist no session meta for this half-started session.
              live.close();
              yield* flushNotice();
              yield { type: 'error', error: autoModeUnavailable() };
              return 'done';
            }
            yield { type: 'engine-meta', meta: { engine: 'claude_code', sessionId: event.sessionId, backend, cwd, tools: event.tools, mcpServers: event.mcpServers } };
            yield* flushNotice();
          } else if (event.type === 'rate-limited') {
            rateLimitResetsAt = event.resetsAt;
          } else if (event.type === 'result-error') {
            // A stopped reply's interrupted turn: its process carries on for the next message.
            if (req.signal.aborted) return 'done';
            live.close();
            if (!sawInit && !reused && plan.mode !== 'fresh' && isMissingSessionError(event.text)) return 'missing-session';
            yield* flushNotice();
            yield { type: 'error', error: classifyClaudeCodeFailure(event.text, { backend, modelId: profile.modelId, rateLimitResetsAt, autoMode }) };
            return 'done';
          } else {
            if (event.type === 'finish') finished = true;
            yield event;
          }
        }
      }
      if (!finished) yield* flushNotice(); // a stream that ended without a result
    } catch (err) {
      live.close();
      if (req.signal.aborted) return 'done'; // TurnRunner marks the message cancelled
      const text = [err instanceof Error ? err.message : String(err), ...live.stderr].join('\n');
      if (!sawInit && !reused && plan.mode !== 'fresh' && isMissingSessionError(text)) return 'missing-session';
      yield* flushNotice();
      yield { type: 'error', error: classifyClaudeCodeFailure(text, { backend, modelId: profile.modelId, rateLimitResetsAt, autoMode }) };
    } finally {
      tickets.clear();
      req.signal.removeEventListener('abort', onAbort);
      if (req.signal.aborted && !ended && !live.isClosed) {
        // Stopped mid-turn: the turn is read to its end in the background, then the process waits for the next message.
        void this.finishStopped(live, feed, pending);
      } else if (ended && !live.isClosed && (finished || req.signal.aborted)) {
        // A turn that reached its own result leaves its process waiting for the next message.
        this.pool.release(live);
      } else {
        live.close();
      }
      if (live.isClosed) this.processes.delete(live);
    }
    return 'done';
  }

  /**
   * After a stop: reads the interrupted turn to its result, then pools the
   * process for the next message. One whose turn hasn't ended within
   * INTERRUPT_GRACE_MS is closed.
   */
  private async finishStopped(live: LiveProcess, feed: AsyncIterator<SDKMessage>, pending: Promise<IteratorResult<SDKMessage>> | null): Promise<void> {
    const timer = setTimeout(() => live.close(), INTERRUPT_GRACE_MS);
    timer.unref?.();
    let ended = false;
    try {
      for (let next = await (pending ?? feed.next()); !next.done; next = await feed.next()) {
        if ((next.value as { type?: unknown }).type === 'result') ended = true;
      }
    } catch {
      ended = false;
    } finally {
      clearTimeout(timer);
      if (ended && !live.isClosed) this.pool.release(live);
      else live.close();
      if (live.isClosed) this.processes.delete(live);
    }
  }

  /** A clean chat's own folder, created if need be. A chat id that isn't a plain name is made into one, so it can't point outside. */
  private scratchFolder(chatId: string): string {
    this.privateScratch ??= this.deps.scratchRoot ?? mkdtempSync(join(tmpdir(), 'otherbench-claude-scratch-'));
    const folder = join(this.privateScratch, scratchFolderName(chatId));
    mkdirSync(folder, { recursive: true });
    return folder;
  }

  /** The options a Claude Code process is started with, minus what each process wires up itself (startProcess). */
  private processOptions(req: EngineRequest, cwd: string, autoMode: boolean, clean: boolean): Options {
    const profile = req.profile;
    if (clean) {
      // A clean chat (spec 2026-10-11-claude-code-clean-chat-and-mcp-design
      // §1): none of the user's Claude Code settings, CLAUDE.md, skills, hooks
      // or MCP config, no coding-agent prompt, and of the built-in tools only
      // web search and fetch, the checklist and questions. Its MCP tools are OtherBench's own server's.
      return {
        cwd,
        model: profile.modelId,
        env: buildChildEnv(this.deps.baseEnv ?? process.env, profile.connection, profile.apiKey, profile.modelId),
        permissionMode: autoMode ? 'auto' : 'default',
        includePartialMessages: true,
        settingSources: [],
        strictMcpConfig: true,
        settings: { disableSkillShellExecution: true },
        // Web search and fetch, plus the checklist and questions (spec 2026-10-12-thread-cards-design section 6).
        tools: [...(profile.toolPolicy.agentWeb === false ? [] : ['WebSearch', 'WebFetch']), ...CLEAN_CHAT_AGENT_TOOLS],
        disallowedTools: agentDisallowedTools(profile.toolPolicy),
        ...(profile.systemPrompt ? { systemPrompt: profile.systemPrompt } : {}),
        ...(profile.params.thinkingBudgetTokens ? { thinking: { type: 'enabled', budgetTokens: profile.params.thinkingBudgetTokens } } : {}),
        ...(req.effort ? { effort: req.effort } : {}),
      };
    }
    return {
      cwd,
      model: profile.modelId,
      env: buildChildEnv(this.deps.baseEnv ?? process.env, profile.connection, profile.apiKey, profile.modelId),
      permissionMode: autoMode ? 'auto' : 'default',
      includePartialMessages: true,
      settingSources: ['user', 'project', 'local'],
      // Flag-settings layer (above user/project/local): skills and slash
      // commands may not run their inline !`cmd` shell. That shell would run
      // inside the 'internal' Skill tool, which gets no card (R14).
      settings: { disableSkillShellExecution: true },
      disallowedTools: agentDisallowedTools(profile.toolPolicy),
      systemPrompt: profile.systemPrompt ? { type: 'preset', preset: 'claude_code', append: profile.systemPrompt } : { type: 'preset', preset: 'claude_code' },
      // MCP off: load no MCP config but the servers passed here (only OtherBench's
      // own, for artifacts and recall), so the model isn't offered the user's MCP tools
      // and none of their servers start. The gate still denies MCP calls.
      ...(profile.toolPolicy.agentMcp === false ? { strictMcpConfig: true } : {}),
      ...(profile.params.thinkingBudgetTokens ? { thinking: { type: 'enabled', budgetTokens: profile.params.thinkingBudgetTokens } } : {}),
      // The chat's effort (chosen in the chat window) over the user's Claude Code settings; unset leaves those to decide.
      ...(req.effort ? { effort: req.effort } : {}),
      // The chat's extra folders are deliberately NOT additionalDirectories:
      // Claude Code would load the skills and commands under each one's
      // .claude. It reaches them anyway when the gate allows a call (live
      // probe, test/fixtures/README.md), and the system prompt names them.
    };
  }

  /**
   * Starts a Claude Code process whose input stays open for later messages.
   * Its hooks are fixed now, so they call through `live.binding`: whichever
   * reply is running decides its tool calls, and with none running every
   * call is refused.
   */
  private startProcess(options: Options, key: string, plan: SessionPlan, own: OtherBenchServerSwitches, relay: Relay): LiveProcess {
    this.pool.makeRoom();
    const input = new PromptQueue();
    const abortController = new AbortController();
    let live: LiveProcess | null = null;
    // OtherBench's own MCP server (Deck #896), under a name made for this process.
    // The gate passes its artifact and recall tools without a card, matching
    // those exact names, so no project MCP config can name a server to get
    // the same pass.
    const server = own.artifacts || own.recall || own.plan || relay.tools.size > 0 ? otherBenchServerName() : null;
    const ownArtifactTool = server && own.artifacts ? otherBenchToolName(server, ARTIFACT_TOOL) : null;
    const ownRecallTool = server && own.recall ? otherBenchToolName(server, RECALL_TOOL) : null;
    const ownPlanTool = server && own.plan ? otherBenchToolName(server, PLAN_TOOL) : null;
    // A relayed tool is matched by its exact name on this process's server, like artifact and recall.
    const relayed = new Map<string, ToolSpec>(server ? [...relay.tools].map(([name, spec]) => [otherBenchToolName(server, name), spec] as const) : []);
    const ownTool = (toolName: string): OtherBenchTool | { relay: ToolSpec } | undefined => {
      if (toolName === ownArtifactTool) return 'artifact';
      if (toolName === ownRecallTool) return 'recall';
      if (toolName === ownPlanTool) return 'plan';
      const spec = relayed.get(toolName);
      return spec ? { relay: spec } : undefined;
    };
    const tools: OtherBenchServerTool[] = [
      ...(own.artifacts ? [otherBenchArtifactTool(() => live?.binding?.artifact)] : []),
      ...(own.recall ? [otherBenchRecallTool(() => live?.binding?.recall)] : []),
      ...(own.plan ? [otherBenchPlanTool(() => live?.binding?.plan)] : []),
      ...[...relay.tools].map(([name, spec]) => relayServerTool(name, spec, () => live?.binding?.relay)),
    ];
    const gate: Gate = (toolName, toolInput, signal, opts) => {
      const which = ownTool(toolName);
      if (live?.binding) return live.binding.gate(toolName, toolInput, signal, { ...opts, ...(which ? { own: which } : {}) });
      // Between replies only a background helper's own call can be approved, on its helper's card (the reply that started it).
      const owner = live?.last && opts?.toolUseId && !which ? live.background?.ownerOf(opts.toolUseId) : null;
      if (!live?.last || !owner) return Promise.resolve({ allow: false, reason: 'No OtherBench reply is waiting on this tool call.' });
      const last = live.last;
      const helperGate = createGate({
        approvals: this.deps.approvals,
        policy: last.policy,
        ctx: { ...last.ctx, messageId: owner.messageId, shownSubagent: { callId: owner.callId, label: owner.label, parentProfileId: last.profileId } },
        autoMode: last.autoMode,
      });
      return helperGate(toolName, toolInput, signal, opts);
    };
    const permissionDenied: HookCallback = async (hookInput, toolUseId, hookOptions) =>
      live?.binding?.permissionDenied ? live.binding.permissionDenied(hookInput, toolUseId, hookOptions) : {};
    const full: Options = {
      ...options,
      // Its tool acts for whichever reply is running, like the hooks.
      ...(server ? { mcpServers: { ...(options.mcpServers ?? {}), [server]: (this.deps.mcpServer ?? otherBenchMcpServer)(server, tools) } } : {}),
      abortController,
      stderr: (data: string) => {
        if (!live) return;
        live.stderr.push(data);
        if (live.stderr.length > 50) live.stderr.shift();
      },
      // The hook waits on a human; Claude Code's default hook timeout (60 s)
      // would cancel the call under an open card. 86400 s = one day.
      hooks: {
        PreToolUse: [{ hooks: [preToolUseHook(gate)], timeout: 86_400 }],
        // Classifier blocks are audited as deny:auto (auto mode only).
        ...(options.permissionMode === 'auto' ? { PermissionDenied: [{ hooks: [permissionDenied] }] } : {}),
      },
      canUseTool: canUseToolFor(gate),
      ...(plan.mode === 'continue' ? { resume: plan.sessionId } : {}),
    };
    const process = new LiveProcess(key, input, abortController, this.deps.query({ prompt: input, options: full }));
    process.artifactTool = ownArtifactTool;
    process.recallTool = ownRecallTool;
    process.planTool = ownPlanTool;
    for (const [claudeName, spec] of relayed) process.relayNames.set(claudeName, spec.name);
    live = process;
    for (const p of this.processes) if (p.isClosed) this.processes.delete(p);
    this.processes.add(process);
    return process;
  }

  /**
   * The new message's images, when the model takes them, as what goes to
   * Claude Code in their place: an image block, or the note for one left out
   * (the notes the API engine writes), in the order of the parts. They are
   * picked from the references and the sizes their rows state before any is
   * read (the same selector the API engine uses): the newest few, each within
   * the upload cap and all together within the request's room, each file once;
   * the type sent is the one the bytes have. Nothing is left out silently:
   * `omitted` says why for each, for the transcript's notice.
   */
  private async newImages(req: EngineRequest): Promise<{ blocks: ContentBlock[]; omitted: Omission[] }> {
    const last = req.messages[req.messages.length - 1];
    const blocks: ContentBlock[] = [];
    const omitted: Omission[] = [];
    const images = (last?.parts ?? []).filter((p): p is Extract<Part, { type: 'image' }> => p.type === 'image');
    if (images.length === 0 || !req.loadAttachment || !(req.profile.model?.supportsVision ?? true)) return { blocks, omitted };
    const leaveOut = (why: Omission): void => {
      omitted.push(why);
      blocks.push({ type: 'text', text: omissionNote(why) });
    };
    const distinct = [...new Map(images.map((p) => [p.attachmentId, p])).values()];
    const limits = { maxCount: MAX_REQUEST_ATTACHMENTS, maxEach: MAX_HISTORY_ATTACHMENT_BYTES, maxTotal: MAX_REQUEST_ATTACHMENT_BYTES };
    const newestFirst = [...distinct].reverse().map((p) => ({ key: p.attachmentId, size: req.attachmentSize ? req.attachmentSize(p.attachmentId) : undefined }));
    const verdicts = selectWithinBudget(newestFirst, limits);
    const loaded = { bytes: 0 };
    for (const part of distinct) {
      const verdict = verdicts.get(part.attachmentId) ?? 'unknown';
      if (verdict !== 'load') {
        leaveOut(verdict);
        continue;
      }
      const bytes = await req.loadAttachment(part.attachmentId);
      if (!withinAfterLoad(bytes.length, loaded, limits)) {
        leaveOut(bytes.length > limits.maxEach ? 'too-large' : 'over-budget');
        continue;
      }
      const mediaType = sniffToolImageMime(bytes);
      if (mediaType === null) leaveOut('not-image');
      else blocks.push({ type: 'image', source: { type: 'base64', media_type: mediaType, data: bytes.toString('base64') } });
    }
    return { blocks, omitted };
  }

  /** The new user message as content blocks: seeded history for a fresh session, text, then its images (see `newImages`). */
  private userContent(req: EngineRequest, fresh: boolean, images: ContentBlock[]): ContentBlock[] {
    const last = req.messages[req.messages.length - 1];
    const history = fresh ? renderHistory(req.messages) : '';
    const skipped = skippedFiles(last);
    const note = skipped.length > 0 ? `\n\n(Attached files not sent, because Claude Code turns in OtherBench only receive images: ${skipped.join(', ')}.)` : '';
    const text = [history, textOf(last)].filter((s) => s.length > 0).join('\n\n') + note;
    return [{ type: 'text', text }, ...images];
  }

  /**
   * Tool-less side calls (auto-title): one turn, no settings, no MCP servers,
   * no thinking, nothing persisted (spec §4). Kept as light as possible so a
   * title comes back quickly.
   */
  private async *utility(req: EngineRequest): AsyncGenerator<EngineEvent> {
    const conn = req.profile.connection;
    const backend = backendOf(conn);
    const prompt = promptStream([{ type: 'text', text: textOf(req.messages[req.messages.length - 1]) }]);
    const abortController = new AbortController();
    const onAbort = (): void => abortController.abort();
    req.signal.addEventListener('abort', onAbort, { once: true });
    if (req.signal.aborted) abortController.abort();
    const model = backend === CLAUDE_BACKEND ? 'haiku' : req.profile.modelId;
    const mapper = new SdkEventMapper();
    try {
      for await (const msg of this.deps.query({
        prompt: prompt.stream,
        options: {
          ...lightweightOptions(),
          cwd: tmpdir(),
          model,
          env: buildChildEnv(this.deps.baseEnv ?? process.env, conn, req.profile.apiKey, model),
          maxTurns: 1,
          tools: [],
          systemPrompt: 'Reply with only the requested text.',
          permissionMode: 'default',
          includePartialMessages: true,
          abortController,
        },
      })) {
        for (const event of mapper.map(msg)) {
          if (event.type === 'text-delta' || event.type === 'finish') yield event;
          if (event.type === 'finish') prompt.close();
          if (event.type === 'result-error') { prompt.close(); yield { type: 'error', error: classifyClaudeCodeFailure(event.text, { backend, modelId: model }) }; return; }
        }
      }
    } catch (err) {
      if (!req.signal.aborted) yield { type: 'error', error: classifyClaudeCodeFailure(err instanceof Error ? err.message : String(err), { backend, modelId: model }) };
    } finally {
      prompt.close();
      req.signal.removeEventListener('abort', onAbort);
    }
  }

  async listModels(conn: Connection, apiKey: string | null): Promise<DiscoveredModel[]> {
    if (conn.baseUrl) return this.deps.listEndpointModels(conn, apiKey);
    const models = await this.probe(conn, (q) => q.supportedModels());
    return models.map((m) => ({ modelId: m.value, displayName: m.displayName, contextWindow: null, supportsVision: true, supportsTools: true }));
  }

  async testConnection(conn: Connection, apiKey: string | null): Promise<ConnectionTestResult> {
    const start = Date.now();
    try {
      if (conn.baseUrl) {
        const models = await this.deps.listEndpointModels(conn, apiKey);
        return { ok: true, message: `Connected; ${models.length} model(s) available.`, latencyMs: Date.now() - start };
      }
      const account = await this.probe(conn, (q) => q.accountInfo());
      const who = account.email ?? 'your Claude account';
      return { ok: true, message: `Logged in as ${who}${account.subscriptionType ? ` (${account.subscriptionType})` : ''}.`, latencyMs: Date.now() - start };
    } catch (err) {
      const error = classifyClaudeCodeFailure(err instanceof Error ? err.message : String(err), { backend: backendOf(conn), modelId: '' });
      return { ok: false, message: error.message, latencyMs: Date.now() - start };
    }
  }

  /**
   * The Claude login's plan usage (Deck #825), read through the SDK's
   * experimental /usage call with the transcript scan skipped. Null for an
   * endpoint backend (no plan) or an SDK without the call.
   */
  async planUsage(conn: Connection): Promise<PlanUsage | null> {
    if (conn.baseUrl) return null;
    const answer = await this.probe(conn, async (q) =>
      typeof q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET === 'function' ? q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true }) : null
    );
    return toPlanUsage(answer, Date.now());
  }

  /**
   * Starts Claude Code without sending a prompt, asks it something, then shuts
   * it down. Bounded by a timeout so a wedged process can't hang a model list
   * or connection test forever.
   */
  private async probe<T>(conn: Connection, ask: (q: ReturnType<QueryFn>) => Promise<T>): Promise<T> {
    const abortController = new AbortController();
    const idle: AsyncIterable<SDKUserMessage> = { [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }) };
    const timeoutMs = this.deps.probeTimeoutMs ?? PROBE_TIMEOUT_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        abortController.abort();
        reject(new Error(`Claude Code didn't respond within ${Math.round(timeoutMs / 1000)} s.`));
      }, timeoutMs);
    });
    try {
      const q = this.deps.query({ prompt: idle, options: { ...lightweightOptions(), env: buildChildEnv(this.deps.baseEnv ?? process.env, conn, null, 'haiku'), abortController } });
      return await Promise.race([ask(q), timedOut]);
    } finally {
      clearTimeout(timer);
      abortController.abort();
    }
  }
}
