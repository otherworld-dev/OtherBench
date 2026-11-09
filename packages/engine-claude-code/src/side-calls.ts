import { tmpdir } from 'node:os';
import type { Options, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { EngineEvent, EngineRequest } from '@otherbench/core/ports/chat-engine.js';
import type { Connection } from '@otherbench/core/types/config.js';
import { isClaudeLogin, type ClaudeAccountRef } from '@otherbench/core/types/claude-accounts.js';
import type { ClaudeCodeEngineDeps, QueryFn } from './deps.js';
import { backendOf, buildChildEnv } from './env.js';
import { classifyClaudeCodeFailure } from './errors.js';
import { SdkEventMapper } from './events.js';
import { textOf, userMessage, type ContentBlock } from './user-content.js';

const PROBE_TIMEOUT_MS = 20_000;

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

/**
 * Tool-less side calls (auto-title): one turn, no settings, no MCP servers,
 * no thinking, nothing persisted (spec §4). Kept as light as possible so a
 * title comes back quickly.
 */
export async function* utility(deps: ClaudeCodeEngineDeps, req: EngineRequest): AsyncGenerator<EngineEvent> {
  const conn = req.profile.connection;
  const backend = backendOf(conn, req.claudeAccount);
  const prompt = promptStream([{ type: 'text', text: textOf(req.messages[req.messages.length - 1]) }]);
  const abortController = new AbortController();
  const onAbort = (): void => abortController.abort();
  req.signal.addEventListener('abort', onAbort, { once: true });
  if (req.signal.aborted) abortController.abort();
  const model = isClaudeLogin(backend) ? 'haiku' : req.profile.modelId;
  const mapper = new SdkEventMapper();
  try {
    for await (const msg of deps.query({
      prompt: prompt.stream,
      options: {
        ...lightweightOptions(),
        cwd: tmpdir(),
        model,
        env: buildChildEnv(deps.baseEnv ?? process.env, conn, req.profile.apiKey, model, req.claudeAccount),
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

/**
 * Starts Claude Code without sending a prompt, asks it something, then shuts
 * it down. Bounded by a timeout so a wedged process can't hang a model list
 * or connection test forever.
 */
export async function probe<T>(deps: ClaudeCodeEngineDeps, conn: Connection, ask: (q: ReturnType<QueryFn>) => Promise<T>, account?: ClaudeAccountRef): Promise<T> {
  const abortController = new AbortController();
  const idle: AsyncIterable<SDKUserMessage> = { [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }) };
  const timeoutMs = deps.probeTimeoutMs ?? PROBE_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      abortController.abort();
      reject(new Error(`Claude Code didn't respond within ${Math.round(timeoutMs / 1000)} s.`));
    }, timeoutMs);
  });
  try {
    const q = deps.query({ prompt: idle, options: { ...lightweightOptions(), env: buildChildEnv(deps.baseEnv ?? process.env, conn, null, 'haiku', account), abortController } });
    return await Promise.race([ask(q), timedOut]);
  } finally {
    clearTimeout(timer);
    abortController.abort();
  }
}
