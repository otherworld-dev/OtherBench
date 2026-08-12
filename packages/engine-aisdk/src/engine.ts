import { APICallError } from '@ai-sdk/provider';
import { jsonSchema, stepCountIs, streamText, tool } from 'ai';
import type { JSONSchema7, LanguageModel, LanguageModelUsage, TextStreamPart, ToolSet } from 'ai';
import type {
  ChatEngine,
  ConnectionTestResult,
  DiscoveredModel,
  EngineEvent,
  EngineRequest,
} from '@grunt/core/ports/chat-engine.js';
import type { ToolContext, ToolSpec } from '@grunt/core/ports/tool-provider.js';
import type { Connection } from '@grunt/core/types/config.js';
import { classifyProviderError } from '@grunt/core/types/errors.js';
import type { Usage } from '@grunt/core/types/usage.js';
import { toModelMessages } from './convert.js';
import { MockChatEngine } from './mock-provider.js';
import { DEFAULT_OLLAMA_BASE_URL, type ProviderHandle } from './registry.js';

/**
 * The subset of `ProviderRegistry`'s public surface `AiSdkChatEngine`
 * depends on. `ProviderRegistry` (registry.ts) satisfies this structurally
 * with zero coupling; tests substitute a fake that hands back a
 * `MockLanguageModelV3`-backed handle so `stream()`'s AI-SDK-facing mapping
 * logic can be exercised without a real network call or monkeypatching the
 * `@ai-sdk/*` provider factories.
 */
export interface ProviderResolver {
  resolve(connection: Connection, apiKey: string | null): ProviderHandle;
}

export interface AiSdkChatEngineOptions {
  /**
   * The `ChatEngine` a `mock`-kind connection delegates to entirely (see
   * task 14 decision #3: the mock connection must work through this same
   * `ChatEngine` interface with no API key). Defaults to a real
   * `MockChatEngine`; tests override it with a `FakeChatEngine` to assert on
   * exactly what request the engine forwarded.
   */
  mock?: ChatEngine;
  /**
   * Used only by `listModels`/`testConnection` for non-mock connections,
   * which call each provider's plain models-list REST endpoint directly
   * (the AI SDK's `LanguageModel` interface has no "list models" operation
   * at all -- see task-14-15-report.md). Defaults to the global `fetch`;
   * tests inject a stub to assert URL/header construction and response
   * mapping without any network access.
   */
  fetchImpl?: typeof fetch;
}

/**
 * How many `streamText` steps (LLM call -> tool execution -> LLM call -> ...)
 * a single `stream()` request may take before the SDK is told to stop.
 * `streamText`'s own default is `stepCountIs(1)`, which would stop the whole
 * turn right after a tool call without ever asking the model for a final
 * answer -- the opposite of "AI SDK runs the tool loop" (task 14). 20 is
 * generous for realistic multi-tool turns while still bounding a
 * misbehaving loop to a finite number of model calls within one request.
 */
const MAX_TOOL_STEPS = 20;

/**
 * `ChatEngine` implementation backed by AI SDK v6 (`ai@6.0.253`). Real
 * (non-mock) connections go through `streamText`; `mock`-kind connections
 * are delegated to `MockChatEngine` (or a test double) so the same interface
 * serves both without a key or network access.
 */
export class AiSdkChatEngine implements ChatEngine {
  private readonly mock: ChatEngine;
  private readonly fetchImpl: typeof fetch;

  constructor(
    private readonly resolver: ProviderResolver,
    options: AiSdkChatEngineOptions = {}
  ) {
    this.mock = options.mock ?? new MockChatEngine();
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
  }

  async *stream(req: EngineRequest): AsyncIterable<EngineEvent> {
    if (req.signal.aborted) return;

    let handle: ProviderHandle;
    try {
      handle = this.resolver.resolve(req.profile.connection, req.profile.apiKey);
    } catch (err) {
      yield { type: 'error', error: classifyProviderError(err) };
      return;
    }

    if (handle.kind === 'mock') {
      yield* this.mock.stream(req);
      return;
    }

    // Tool executions need a ToolContext, which wants a chatId and a
    // messageId -- both now carried directly on EngineRequest (task 16
    // decision #1), supplied by the TurnRunner, which allocates and
    // persists the assistant message row before calling stream().
    const { chatId, messageId } = req;

    try {
      const caps = {
        // Conservative defaults when a model's capabilities are unknown
        // (`req.profile.model` is null -- the model was never discovered):
        // assuming vision support that isn't there sends bytes the provider
        // will reject, so default to false (degrade to a text placeholder).
        // Tools default to true since `req.tools` was already filtered by
        // the caller's ToolPolicy before reaching here.
        vision: req.profile.model?.supportsVision ?? false,
        tools: req.profile.model?.supportsTools ?? true,
      };
      const messages = await toModelMessages(req.messages, caps, loadAttachmentUnavailable);
      const tools = buildToolSet(req.tools, req.signal, chatId, messageId);
      const model = resolveLanguageModel(handle, req.profile.modelId);

      const result = streamText({
        model,
        messages,
        tools: Object.keys(tools).length > 0 ? tools : undefined,
        stopWhen: stepCountIs(MAX_TOOL_STEPS),
        abortSignal: req.signal,
        // The AI SDK's own retry-with-backoff is disabled deliberately:
        // engine.ts has no retry policy of its own, and letting `streamText`
        // silently retry (with real delays) before an error ever reaches the
        // caller would both slow every failure down and hide the original
        // error inside a RetryError wrapper. Retry policy belongs to
        // whatever calls `stream()` (the future TurnRunner, tasks 16-18),
        // which can inspect `SerializedError.retryable` and decide.
        maxRetries: 0,
        temperature: req.profile.params.temperature,
        topP: req.profile.params.topP,
        maxOutputTokens: req.profile.params.maxOutputTokens,
      });

      for await (const part of result.fullStream) {
        const event = mapStreamPart(part);
        if (event) yield event;
      }
    } catch (err) {
      yield { type: 'error', error: classifyProviderError(err) };
    }
  }

  async listModels(conn: Connection, apiKey: string | null): Promise<DiscoveredModel[]> {
    const handle = this.resolver.resolve(conn, apiKey);
    if (handle.kind === 'mock') return this.mock.listModels(conn, apiKey);
    return this.listRealModels(conn, apiKey);
  }

  async testConnection(conn: Connection, apiKey: string | null): Promise<ConnectionTestResult> {
    const handle = this.resolver.resolve(conn, apiKey);
    if (handle.kind === 'mock') return this.mock.testConnection(conn, apiKey);

    const start = Date.now();
    try {
      const models = await this.listRealModels(conn, apiKey);
      return { ok: true, message: `Connected; ${models.length} model(s) available.`, latencyMs: Date.now() - start };
    } catch (err) {
      const classified = classifyProviderError(err);
      return { ok: false, message: classified.message, latencyMs: Date.now() - start };
    }
  }

  /**
   * Lists models via each provider's plain models-list REST endpoint
   * directly -- there is no such operation on the AI SDK's unified
   * `LanguageModel`/provider-factory interface (verified against the
   * installed `@ai-sdk/{anthropic,openai,google}` packages: none expose
   * anything beyond constructing a model handle for a *known* id). This is
   * therefore hand-rolled per provider rather than going through
   * `ProviderRegistry`/`streamText` at all.
   */
  private async listRealModels(conn: Connection, apiKey: string | null): Promise<DiscoveredModel[]> {
    switch (conn.kind) {
      case 'anthropic':
        return this.fetchJsonModels(
          `${trimTrailingSlash(conn.baseUrl ?? 'https://api.anthropic.com')}/v1/models`,
          { 'x-api-key': apiKey ?? '', 'anthropic-version': '2023-06-01', ...conn.extraHeaders },
          (body) =>
            asArray(body['data']).map((m) => ({
              modelId: stringField(m, 'id') ?? 'unknown',
              displayName: stringField(m, 'display_name') ?? stringField(m, 'id') ?? 'unknown',
              contextWindow: null,
              supportsVision: null,
              supportsTools: null,
            }))
        );

      case 'openai':
        return this.fetchJsonModels(
          `${trimTrailingSlash(conn.baseUrl ?? 'https://api.openai.com/v1')}/models`,
          { Authorization: `Bearer ${apiKey ?? ''}`, ...conn.extraHeaders },
          (body) =>
            asArray(body['data']).map((m) => ({
              modelId: stringField(m, 'id') ?? 'unknown',
              displayName: stringField(m, 'id') ?? 'unknown',
              contextWindow: null,
              supportsVision: null,
              supportsTools: null,
            }))
        );

      case 'google':
        return this.fetchJsonModels(
          `${trimTrailingSlash(conn.baseUrl ?? 'https://generativelanguage.googleapis.com/v1beta')}/models`,
          { 'x-goog-api-key': apiKey ?? '', ...conn.extraHeaders },
          (body) =>
            asArray(body['models']).map((m) => {
              const name = stringField(m, 'name') ?? 'unknown';
              return {
                modelId: stripModelsPrefix(name),
                displayName: stringField(m, 'displayName') ?? stripModelsPrefix(name),
                contextWindow: numberField(m, 'inputTokenLimit'),
                supportsVision: null,
                supportsTools: null,
              };
            })
        );

      case 'openai_compatible':
      case 'ollama': {
        const base = conn.baseUrl ?? (conn.kind === 'ollama' ? DEFAULT_OLLAMA_BASE_URL : null);
        if (!base) {
          throw new Error(
            `Connection "${conn.name}" (${conn.id}) is kind "openai_compatible" but has no baseUrl configured.`
          );
        }
        const headers: Record<string, string> = { ...conn.extraHeaders };
        if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
        return this.fetchJsonModels(`${trimTrailingSlash(base)}/models`, headers, (body) =>
          asArray(body['data']).map((m) => ({
            modelId: stringField(m, 'id') ?? 'unknown',
            displayName: stringField(m, 'id') ?? 'unknown',
            contextWindow: null,
            supportsVision: null,
            supportsTools: null,
          }))
        );
      }

      case 'mock':
        // Unreachable in practice: callers (listModels/testConnection above)
        // already branch on `handle.kind === 'mock'` before calling this.
        // Kept as an explicit throw, not a silent [], so a future caller
        // that skips that branch fails loudly instead of returning nothing.
        throw new Error('listRealModels() was called for a mock connection; this is a bug in AiSdkChatEngine.');

      default: {
        const exhaustive: never = conn.kind;
        throw new Error(`Unknown connection kind: ${String(exhaustive)}`);
      }
    }
  }

  private async fetchJsonModels(
    url: string,
    headers: Record<string, string>,
    map: (body: Record<string, unknown>) => DiscoveredModel[]
  ): Promise<DiscoveredModel[]> {
    const response = await this.fetchImpl(url, { headers });
    if (!response.ok) {
      const responseBody = await response.text().catch(() => '');
      throw new APICallError({
        message: `Request to ${url} failed with status ${response.status}.`,
        url,
        requestBodyValues: {},
        statusCode: response.status,
        responseBody,
        isRetryable: response.status >= 500,
      });
    }
    const body = (await response.json()) as Record<string, unknown>;
    return map(body);
  }
}

// ---------------------------------------------------------------------------
// stream() helpers
// ---------------------------------------------------------------------------

/**
 * `EngineRequest` (packages/core) carries no way to load attachment bytes --
 * there is no `loadAttachment` field, and `engine-aisdk` has no dependency
 * on `@grunt/store-sqlite`/filesystem access to fetch them itself. Wiring
 * real attachment bytes through is therefore out of scope for task 14; it
 * belongs to whatever assembles `EngineRequest` (the TurnRunner, tasks
 * 16-18). Text-only conversations (everything task 14's tests cover) never
 * call this. See task-14-15-report.md for the full writeup of this gap.
 */
async function loadAttachmentUnavailable(id: string): Promise<Buffer> {
  throw new Error(
    `AiSdkChatEngine cannot load attachment "${id}": EngineRequest carries no attachment loader yet. ` +
      'Wiring real attachment bytes through to the model is the responsibility of whatever assembles ' +
      'EngineRequest (the TurnRunner, tasks 16-18).'
  );
}

function resolveLanguageModel(handle: Extract<ProviderHandle, { kind: 'aisdk' }>, modelId: string): LanguageModel {
  // `AiSdkProvider` (registry.ts) is a union of the four real provider
  // factories, each typed to accept only ITS OWN model-id string-literal
  // union (e.g. `AnthropicMessagesModelId`). `req.profile.modelId` is a
  // plain `string` (Profile.modelId is deliberately free text -- see
  // packages/store-sqlite/src/repos/profiles.ts -- naming a model the app
  // may never have discovered), so it cannot satisfy all four signatures at
  // once; this cast is the one place that gap is bridged. Every real
  // provider's model-id union is a template-literal type ending in
  // `(string & {})`, so any string is accepted at runtime regardless.
  return (handle.provider as unknown as (id: string) => LanguageModel)(modelId);
}

function buildToolSet(specs: ToolSpec[], signal: AbortSignal, chatId: string, messageId: string): ToolSet {
  const toolSet: ToolSet = {};
  for (const spec of specs) {
    toolSet[spec.name] = tool({
      description: spec.description,
      inputSchema: jsonSchema(spec.parameters as JSONSchema7),
      execute: async (input: unknown, opts) => {
        const ctx: ToolContext = {
          chatId,
          messageId,
          workspaceRoot: null,
          signal: opts.abortSignal ?? signal,
        };
        return spec.execute(input, ctx);
      },
    });
  }
  return toolSet;
}

function mapStreamPart(part: TextStreamPart<ToolSet>): EngineEvent | null {
  switch (part.type) {
    case 'text-delta':
      return { type: 'text-delta', text: part.text };
    case 'reasoning-delta':
      return { type: 'reasoning-delta', text: part.text };
    case 'tool-call':
      return { type: 'tool-call', id: part.toolCallId, name: part.toolName, args: part.input };
    case 'tool-result':
      return { type: 'tool-result', id: part.toolCallId, name: part.toolName, result: part.output, isError: false };
    case 'tool-error':
      return {
        type: 'tool-result',
        id: part.toolCallId,
        name: part.toolName,
        result: errorMessage(part.error),
        isError: true,
      };
    case 'tool-output-denied':
      return { type: 'tool-result', id: part.toolCallId, name: part.toolName, result: 'Tool call was denied.', isError: true };
    case 'finish':
      return { type: 'finish', usage: mapUsage(part.totalUsage), finishReason: part.finishReason };
    case 'error':
      return { type: 'error', error: classifyProviderError(part.error) };
    case 'abort':
      // A clean cancellation: `streamText` observed `abortSignal` firing and
      // ended the stream itself (no exception thrown from `for await`) --
      // see task-14-15-report.md for how this was verified empirically.
      return {
        type: 'error',
        error: { kind: 'cancelled', message: part.reason ?? 'The request was cancelled.', retryable: false },
      };
    // text-start/text-end/reasoning-start/reasoning-end/tool-input-*/source/
    // file/start-step/finish-step/start/raw/tool-approval-request: no
    // EngineEvent counterpart; deliberately dropped.
    default:
      return null;
  }
}

function mapUsage(usage: LanguageModelUsage): Usage {
  return {
    tokensIn: usage.inputTokens ?? 0,
    tokensOut: usage.outputTokens ?? 0,
    tokensCached: usage.inputTokenDetails.cacheReadTokens ?? 0,
    tokensReasoning: usage.outputTokenDetails.reasoningTokens ?? 0,
  };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------------------
// listModels() helpers
// ---------------------------------------------------------------------------

function trimTrailingSlash(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url;
}

function stripModelsPrefix(name: string): string {
  return name.startsWith('models/') ? name.slice('models/'.length) : name;
}

function asArray(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is Record<string, unknown> => typeof v === 'object' && v !== null);
}

function stringField(obj: Record<string, unknown>, key: string): string | null {
  const value = obj[key];
  return typeof value === 'string' ? value : null;
}

function numberField(obj: Record<string, unknown>, key: string): number | null {
  const value = obj[key];
  return typeof value === 'number' ? value : null;
}
