import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import type { Options, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { agentDisallowedTools } from '@grunt/core/domain/agent-tools.js';
import type { ChatEngine, ConnectionTestResult, DiscoveredModel, EngineEvent, EngineRequest } from '@grunt/core/ports/chat-engine.js';
import type { ToolProvider } from '@grunt/core/ports/tool-provider.js';
import type { Connection } from '@grunt/core/types/config.js';
import type { CanonMessage } from '@grunt/core/types/messages.js';
import { canUseToolFor, createGate, preToolUseHook } from './approval.js';
import { backendOf, buildChildEnv, CLAUDE_BACKEND } from './env.js';
import { classifyClaudeCodeFailure, isMissingSessionError } from './errors.js';
import { SdkEventMapper } from './events.js';
import { renderHistory } from './history.js';
import { pickSession, SessionClaims, type SessionPlan } from './session.js';

export type QueryFn = (params: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => AsyncIterable<SDKMessage> & {
  interrupt(): Promise<unknown>;
  supportedModels(): Promise<{ value: string; displayName: string }[]>;
  accountInfo(): Promise<{ email?: string; subscriptionType?: string }>;
};

export interface ClaudeCodeEngineDeps {
  query: QueryFn;
  approvals: Pick<ToolProvider, 'requestApproval'>;
  /** Model listing for an endpoint backend (e.g. Ollama), supplied by the server. */
  listEndpointModels: (conn: Connection, token: string | null) => Promise<DiscoveredModel[]>;
  /** Defaults to `process.env`. */
  baseEnv?: NodeJS.ProcessEnv;
}

type ContentBlock = { type: 'text'; text: string } | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } };

/** A one-message prompt stream that stays open until `close()` -- hooks and canUseTool travel over the same channel, so input must not end before the result. */
function promptStream(content: ContentBlock[]): { stream: AsyncIterable<SDKUserMessage>; close: () => void } {
  let close!: () => void;
  const closed = new Promise<void>((r) => (close = r));
  async function* gen(): AsyncGenerator<SDKUserMessage> {
    yield { type: 'user', message: { role: 'user', content }, parent_tool_use_id: null, origin: { kind: 'human' } } as unknown as SDKUserMessage;
    await closed;
  }
  return { stream: gen(), close };
}

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

  constructor(private readonly deps: ClaudeCodeEngineDeps) {}

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

    const skipped = skippedFiles(req.messages[req.messages.length - 1]);
    if (skipped.length > 0) {
      yield { type: 'notice', text: `Not sent to Claude Code (only images are): ${skipped.join(', ')}.` };
    }

    const conn = req.profile.connection;
    const backend = backendOf(conn);
    const plan = pickSession({ history: req.messages, backend, cwd: req.workspaceRoot, latestMessageForSession: req.latestMessageForSession, claims: this.claims });
    try {
      const first = yield* this.runTurn(req, plan, backend);
      if (first === 'missing-session') {
        yield { type: 'notice', text: "The earlier Claude Code session couldn't be found, so Grunt started a new Claude Code session with this chat's history." };
        yield* this.runTurn(req, { mode: 'fresh' }, backend);
      }
    } finally {
      if (plan.mode === 'continue') this.claims.release(plan.sessionId);
    }
  }

  /** One SDK query. Returns 'missing-session' (having yielded nothing) when a resume target is gone. */
  private async *runTurn(req: EngineRequest, plan: SessionPlan, backend: string): AsyncGenerator<EngineEvent, 'done' | 'missing-session'> {
    const profile = req.profile;
    const cwd = req.workspaceRoot!;
    const content = await this.userContent(req, plan.mode === 'fresh');
    const prompt = promptStream(content);
    const abortController = new AbortController();
    const onAbort = (): void => abortController.abort();
    req.signal.addEventListener('abort', onAbort, { once: true });

    const gate = createGate({ approvals: this.deps.approvals, policy: profile.toolPolicy, ctx: { chatId: req.chatId, messageId: req.messageId, profileId: profile.id, workspaceRoot: cwd, signal: req.signal } });
    const stderr: string[] = [];
    const options: Options = {
      cwd,
      model: profile.modelId,
      env: buildChildEnv(this.deps.baseEnv ?? process.env, profile.connection, profile.apiKey, profile.modelId),
      permissionMode: 'default',
      includePartialMessages: true,
      settingSources: ['user', 'project', 'local'],
      disallowedTools: agentDisallowedTools(profile.toolPolicy),
      hooks: { PreToolUse: [{ hooks: [preToolUseHook(gate)] }] },
      canUseTool: canUseToolFor(gate),
      systemPrompt: profile.systemPrompt ? { type: 'preset', preset: 'claude_code', append: profile.systemPrompt } : { type: 'preset', preset: 'claude_code' },
      abortController,
      stderr: (data: string) => { stderr.push(data); if (stderr.length > 50) stderr.shift(); },
      ...(plan.mode !== 'fresh' ? { resume: plan.sessionId, forkSession: plan.mode === 'fork' } : {}),
      ...(profile.params.thinkingBudgetTokens ? { maxThinkingTokens: profile.params.thinkingBudgetTokens } : {}),
    };

    const mapper = new SdkEventMapper();
    let sawInit = false;
    let rateLimitResetsAt: number | null = null;
    try {
      for await (const msg of this.deps.query({ prompt: prompt.stream, options })) {
        for (const event of mapper.map(msg)) {
          if (event.type === 'init') {
            sawInit = true;
            yield { type: 'engine-meta', meta: { engine: 'claude_code', sessionId: event.sessionId, backend, cwd, tools: event.tools, mcpServers: event.mcpServers } };
          } else if (event.type === 'rate-limited') {
            rateLimitResetsAt = event.resetsAt;
          } else if (event.type === 'result-error') {
            prompt.close();
            if (!sawInit && plan.mode !== 'fresh' && isMissingSessionError(event.text)) return 'missing-session';
            yield { type: 'error', error: classifyClaudeCodeFailure(event.text, { backend, modelId: profile.modelId, rateLimitResetsAt }) };
            return 'done';
          } else {
            if (event.type === 'finish') prompt.close();
            yield event;
          }
        }
      }
    } catch (err) {
      if (req.signal.aborted) return 'done'; // TurnRunner marks the message cancelled
      const text = [err instanceof Error ? err.message : String(err), ...stderr].join('\n');
      if (!sawInit && plan.mode !== 'fresh' && isMissingSessionError(text)) return 'missing-session';
      yield { type: 'error', error: classifyClaudeCodeFailure(text, { backend, modelId: profile.modelId, rateLimitResetsAt }) };
    } finally {
      prompt.close();
      req.signal.removeEventListener('abort', onAbort);
    }
    return 'done';
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

  /** Tool-less side calls (auto-title): one turn, no settings, nothing persisted (spec §4). */
  private async *utility(req: EngineRequest): AsyncGenerator<EngineEvent> {
    const conn = req.profile.connection;
    const backend = backendOf(conn);
    const prompt = promptStream([{ type: 'text', text: textOf(req.messages[req.messages.length - 1]) }]);
    const abortController = new AbortController();
    req.signal.addEventListener('abort', () => abortController.abort(), { once: true });
    const model = backend === CLAUDE_BACKEND ? 'haiku' : req.profile.modelId;
    const mapper = new SdkEventMapper();
    try {
      for await (const msg of this.deps.query({
        prompt: prompt.stream,
        options: { cwd: tmpdir(), model, env: buildChildEnv(this.deps.baseEnv ?? process.env, conn, req.profile.apiKey, model), maxTurns: 1, settingSources: [], persistSession: false, tools: [], permissionMode: 'default', includePartialMessages: true, abortController },
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

  /** Starts Claude Code without sending a prompt, asks it something, then shuts it down. */
  private async probe<T>(conn: Connection, ask: (q: ReturnType<QueryFn>) => Promise<T>): Promise<T> {
    const abortController = new AbortController();
    const idle: AsyncIterable<SDKUserMessage> = { [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }) };
    const q = this.deps.query({ prompt: idle, options: { env: buildChildEnv(this.deps.baseEnv ?? process.env, conn, null, 'haiku'), settingSources: [], persistSession: false, abortController } });
    try {
      return await ask(q);
    } finally {
      abortController.abort();
    }
  }
}
