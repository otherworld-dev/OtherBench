import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import type { HookCallback, McpServerConfig, Options, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { agentDisallowedTools } from '@grunt/core/domain/agent-tools.js';
import { ARTIFACT_TOOL } from '@grunt/core/domain/artifacts.js';
import { RECALL_TOOL } from '@grunt/core/domain/recall.js';
import type { ChatEngine, ConnectionTestResult, DiscoveredModel, EngineEvent, EngineRequest } from '@grunt/core/ports/chat-engine.js';
import type { ToolContext, ToolProvider } from '@grunt/core/ports/tool-provider.js';
import type { Connection } from '@grunt/core/types/config.js';
import type { CanonMessage } from '@grunt/core/types/messages.js';
import type { PlanUsage } from '@grunt/core/types/usage.js';
import { canUseToolFor, createGate, permissionDeniedHook, preToolUseHook, type Gate, type GruntTool } from './approval.js';
import { gruntArtifactTool, gruntArtifactToolName, gruntMcpServer, gruntRecallTool, gruntRecallToolName, gruntServerName, type GruntServerTool } from './grunt-server.js';
import { backendOf, buildChildEnv, CLAUDE_BACKEND } from './env.js';
import { autoModeUnavailable, classifyClaudeCodeFailure, isMissingSessionError } from './errors.js';
import { SdkEventMapper } from './events.js';
import { renderHistory } from './history.js';
import { LivePool, LiveProcess, liveKey, PromptQueue, type GruntServerSwitches, type TurnBinding } from './live.js';
import { toPlanUsage } from './plan-usage.js';
import { pickSession, SessionClaims, type SessionPlan } from './session.js';

export type QueryFn = (params: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => AsyncIterable<SDKMessage> & {
  interrupt(): Promise<unknown>;
  supportedModels(): Promise<{ value: string; displayName: string }[]>;
  accountInfo(): Promise<{ email?: string; subscriptionType?: string }>;
  /** The data behind /usage. Experimental in the SDK and may go away, hence optional; its answer is checked, not trusted (plan-usage.ts). */
  usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET?(opts?: { skipBehaviors?: boolean }): Promise<unknown>;
};

export interface ClaudeCodeEngineDeps {
  query: QueryFn;
  approvals: Pick<ToolProvider, 'requestApproval' | 'recordAgentDenial'>;
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
  /** Runs an `artifact` tool call for a reply (Deck #896): the server's executor. Without it, Claude Code gets no artifact tool. */
  artifactTool?: (ctx: { chatId: string; messageId: string }, args: unknown) => Promise<unknown>;
  /** Runs a `recall` tool call for a reply (spec 2026-10-09-recall-design): the server's executor. Without it, Claude Code gets no recall tool. */
  recallTool?: (ctx: { chatId: string }, args: unknown) => Promise<unknown>;
  /** Builds Grunt's MCP server from its name and tools; defaults to the SDK's in-process server. Tests pass a fake. */
  mcpServer?: (name: string, tools: GruntServerTool[]) => McpServerConfig;
}

const PROBE_TIMEOUT_MS = 20_000;

/** A notice waiting for a safe moment to be yielded (see ClaudeCodeChatEngine.stream). */
type PendingNotice = { text: string | null };

type ContentBlock ={ type: 'text'; text: string } | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } };

const userMessage = (content: ContentBlock[]): SDKUserMessage =>
  ({ type: 'user', message: { role: 'user', content }, parent_tool_use_id: null, origin: { kind: 'human' } }) as unknown as SDKUserMessage;

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

/** Filenames of the new message's non-image attachments, which Claude Code turns do not receive. */
const skippedFiles = (m: CanonMessage | undefined): string[] => (m?.parts ?? []).flatMap((p) => (p.type === 'file' ? [p.filename] : []));

/**
 * Runs Grunt turns through the local Claude Code install via the Agent SDK
 * (spec: docs/superpowers/specs/2026-10-02-claude-code-engine-design.md).
 * Claude Code owns the agent loop and its tools; Grunt owns permission
 * (every call goes through `approvals.requestApproval`) and the transcript.
 */
export class ClaudeCodeChatEngine implements ChatEngine {
  private readonly claims = new SessionClaims();
  /** Claude Code processes kept alive between replies, by session (see live.ts). */
  private readonly pool: LivePool;
  /** Every process started, so `dispose` can stop the busy ones too. */
  private readonly processes = new Set<LiveProcess>();

  constructor(private readonly deps: ClaudeCodeEngineDeps) {
    this.pool = new LivePool(deps.liveIdleMs, deps.maxLive);
  }

  /** Stops every Claude Code process this engine started (server shutdown). */
  dispose(): void {
    this.pool.closeAll();
    for (const live of this.processes) live.close();
    this.processes.clear();
  }

  async *stream(req: EngineRequest): AsyncIterable<EngineEvent> {
    if (req.purpose === 'utility') {
      yield* this.utility(req);
      return;
    }
    if (!req.workspaceRoot) {
      yield { type: 'error', error: { kind: 'capability', retryable: false, message: 'Set a workspace folder to use Claude Code.' } };
      return;
    }
    if (!existsSync(req.workspaceRoot)) {
      yield { type: 'error', error: { kind: 'unknown', retryable: false, message: `Workspace folder ${req.workspaceRoot} doesn't exist.` } };
      return;
    }

    // Not yielded yet: an event yielded before the engine has done any real
    // work reaches TurnRunner before the turn's live stream is registered and
    // is dropped from SSE. runTurn yields it right after the init message
    // (or before an error if Claude Code fails before init).
    const skipped = skippedFiles(req.messages[req.messages.length - 1]);
    const notice: PendingNotice = { text: skipped.length > 0 ? `Not sent to Claude Code (only images are): ${skipped.join(', ')}.` : null };

    const conn = req.profile.connection;
    const backend = backendOf(conn);
    const plan = pickSession({ history: req.messages, backend, cwd: req.workspaceRoot, latestMessageForSession: req.latestMessageForSession, claims: this.claims });
    try {
      const first = yield* this.runTurn(req, plan, backend, notice);
      // A stopped turn never starts a second Claude Code process.
      if (first === 'missing-session' && !req.signal.aborted) {
        yield { type: 'notice', text: "The earlier Claude Code session couldn't be found, so Grunt started a new Claude Code session with this chat's history." };
        yield* this.runTurn(req, { mode: 'fresh' }, backend, notice);
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
  private async *runTurn(req: EngineRequest, plan: SessionPlan, backend: string, notice: PendingNotice): AsyncGenerator<EngineEvent, 'done' | 'missing-session'> {
    const flushNotice = function* (): Generator<EngineEvent> {
      const text = notice.text;
      if (text === null) return;
      notice.text = null;
      yield { type: 'notice', text };
    };
    const profile = req.profile;
    const cwd = req.workspaceRoot!;
    const content = await this.userContent(req, plan.mode === 'fresh');

    // Auto mode needs the Claude login; an endpoint backend always runs in
    // default mode (spec 2026-10-03-claude-code-auto-mode-design section 4).
    const autoMode = req.autoMode === true && backend === CLAUDE_BACKEND;
    const gateCtx: ToolContext = {
      chatId: req.chatId,
      messageId: req.messageId,
      profileId: profile.id,
      workspaceRoot: cwd,
      ...(req.folders && req.folders.length > 0 ? { folders: req.folders } : {}),
      signal: req.signal,
    };
    // Artifacts (Deck #896) and recall (spec 2026-10-09-recall-design): a
    // process's Grunt server has each tool or not from its start, so the
    // switches are part of the process key.
    const { artifactTool, recallTool } = this.deps;
    const own: GruntServerSwitches = {
      artifacts: artifactTool !== undefined && profile.toolPolicy.artifacts !== false,
      recall: recallTool !== undefined && profile.toolPolicy.recall !== false,
    };
    const binding: TurnBinding = {
      gate: createGate({ approvals: this.deps.approvals, policy: profile.toolPolicy, ctx: gateCtx, autoMode }),
      ...(autoMode ? { permissionDenied: permissionDeniedHook({ approvals: this.deps.approvals, ctx: gateCtx }) } : {}),
      ...(artifactTool && own.artifacts ? { artifact: (args: unknown) => artifactTool({ chatId: req.chatId, messageId: req.messageId }, args) } : {}),
      ...(recallTool && own.recall ? { recall: (args: unknown) => recallTool({ chatId: req.chatId }, args) } : {}),
    };
    const options = this.processOptions(req, cwd, autoMode);
    const key = liveKey(options, { backend, token: profile.apiKey }, own);
    const taken = plan.mode === 'continue' ? this.pool.take(plan.sessionId, key) : null;
    const reused = taken !== null;
    const live = taken ?? this.startProcess(options, key, plan, own);
    live.binding = binding;

    // Stopping a reply stops its process: the next message resumes the
    // session in a new one, rather than trusting a half-finished turn.
    const onAbort = (): void => live.close();
    req.signal.addEventListener('abort', onAbort, { once: true });
    // An 'abort' that fired before the listener existed never reaches it.
    if (req.signal.aborted) live.close();
    live.input.push(userMessage(content));

    // This process's own tools are reported under the API engines' names.
    const renames = new Map<string, string>();
    if (live.artifactTool) renames.set(live.artifactTool, ARTIFACT_TOOL);
    if (live.recallTool) renames.set(live.recallTool, RECALL_TOOL);
    const mapper = new SdkEventMapper(renames.size > 0 ? renames : undefined);
    let sawInit = false;
    let finished = false;
    let rateLimitResetsAt: number | null = null;
    try {
      // Read by hand: a for-await `break` would end the process's output for good.
      while (!finished) {
        const next = await live.iterator.next();
        if (next.done) break; // the process ended
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
      req.signal.removeEventListener('abort', onAbort);
      // Only a cleanly finished reply leaves its process waiting for the next message.
      if (finished && !req.signal.aborted && !live.isClosed) this.pool.release(live);
      else live.close();
      if (live.isClosed) this.processes.delete(live);
    }
    return 'done';
  }

  /** The options a Claude Code process is started with, minus what each process wires up itself (startProcess). */
  private processOptions(req: EngineRequest, cwd: string, autoMode: boolean): Options {
    const profile = req.profile;
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
      // MCP off: load no MCP config but the servers passed here (only Grunt's
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
  private startProcess(options: Options, key: string, plan: SessionPlan, own: GruntServerSwitches): LiveProcess {
    this.pool.makeRoom();
    const input = new PromptQueue();
    const abortController = new AbortController();
    let live: LiveProcess | null = null;
    // Grunt's own MCP server (Deck #896), under a name made for this process.
    // The gate passes its artifact and recall tools without a card, matching
    // those exact names, so no project MCP config can name a server to get
    // the same pass.
    const server = own.artifacts || own.recall ? gruntServerName() : null;
    const ownArtifactTool = server && own.artifacts ? gruntArtifactToolName(server) : null;
    const ownRecallTool = server && own.recall ? gruntRecallToolName(server) : null;
    const ownTool = (toolName: string): GruntTool | undefined =>
      toolName === ownArtifactTool ? 'artifact' : toolName === ownRecallTool ? 'recall' : undefined;
    const tools: GruntServerTool[] = [
      ...(own.artifacts ? [gruntArtifactTool(() => live?.binding?.artifact)] : []),
      ...(own.recall ? [gruntRecallTool(() => live?.binding?.recall)] : []),
    ];
    const gate: Gate = (toolName, toolInput, signal, opts) => {
      const which = ownTool(toolName);
      return live?.binding
        ? live.binding.gate(toolName, toolInput, signal, { ...opts, ...(which ? { own: which } : {}) })
        : Promise.resolve({ allow: false, reason: 'No Grunt reply is waiting on this tool call.' });
    };
    const permissionDenied: HookCallback = async (hookInput, toolUseId, hookOptions) =>
      live?.binding?.permissionDenied ? live.binding.permissionDenied(hookInput, toolUseId, hookOptions) : {};
    const full: Options = {
      ...options,
      // Its tool acts for whichever reply is running, like the hooks.
      ...(server ? { mcpServers: { ...(options.mcpServers ?? {}), [server]: (this.deps.mcpServer ?? gruntMcpServer)(server, tools) } } : {}),
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
    live = process;
    for (const p of this.processes) if (p.isClosed) this.processes.delete(p);
    this.processes.add(process);
    return process;
  }

  /** The new user message as content blocks: seeded history for a fresh session, text, and images when the model takes them. */
  private async userContent(req: EngineRequest, fresh: boolean): Promise<ContentBlock[]> {
    const last = req.messages[req.messages.length - 1];
    const history = fresh ? renderHistory(req.messages) : '';
    const blocks: ContentBlock[] = [];
    for (const part of last?.parts ?? []) {
      if (part.type === 'image' && req.loadAttachment && (req.profile.model?.supportsVision ?? true)) {
        const bytes = await req.loadAttachment(part.attachmentId);
        blocks.push({ type: 'image', source: { type: 'base64', media_type: part.mime, data: bytes.toString('base64') } });
      }
    }
    const skipped = skippedFiles(last);
    const note = skipped.length > 0 ? `\n\n(Attached files not sent, because Claude Code turns in Grunt only receive images: ${skipped.join(', ')}.)` : '';
    const text = [history, textOf(last)].filter((s) => s.length > 0).join('\n\n') + note;
    return [{ type: 'text', text }, ...blocks];
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
