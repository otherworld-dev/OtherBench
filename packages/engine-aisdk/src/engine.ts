import type { AnthropicProvider } from '@ai-sdk/anthropic';
import { APICallError } from '@ai-sdk/provider';
import { jsonSchema, stepCountIs, streamText, tool } from 'ai';
import type { JSONSchema7, LanguageModel, LanguageModelUsage, ModelMessage, TextStreamPart, ToolSet } from 'ai';
import type {
  ChatEngine,
  ConnectionTestResult,
  DiscoveredModel,
  EngineEvent,
  EngineRequest,
} from '@otherbench/core/ports/chat-engine.js';
import { toolContextFor } from '@otherbench/core/domain/tool-context.js';
import type { ToolSpec } from '@otherbench/core/ports/tool-provider.js';
import type { Connection, ConnectionKind } from '@otherbench/core/types/config.js';
import { classifyProviderError } from '@otherbench/core/types/errors.js';
import type { Usage } from '@otherbench/core/types/usage.js';
import { cardLine } from '@otherbench/core/domain/card-text.js';
import { COMPUTER_TOOL, desktopTextForResult, isComputerAction, screenContentError } from '@otherbench/core/domain/computer-apps.js';
import { toolsetSafeMessages } from './computer-toolset.js';
import { toModelMessages } from './convert.js';
import { LIVE_IMAGE_LIMITS, screenToolResult, type ToolImageBudget } from '@otherbench/core/domain/tool-images.js';
import { liveToolOutput, toolImagesSupported } from './tool-images.js';
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
 * Models that take Anthropic's computer toolset (spec
 * 2026-10-12-computer-use-design section 5), on Anthropic connections. Every
 * other model gets OtherBench's JSON-schema `computer` tool, with the same action
 * names and arguments, which any model can call. Anthropic's tool versions
 * change often: this list is the one place to update.
 *
 * These are the ids the SDK's own doc comment names as supported
 * (`@ai-sdk/anthropic` 3.0.127, `dist/index.d.ts`, on
 * `computerToolset_20260801`): Opus 5.5 (which takes only the toolset), Opus
 * 5, Sonnet 5, Fable 5, Fable 5.1 and Opus 4.8. The plan also listed
 * `claude-sonnet-5-5` and `claude-haiku-5-5`; nobody has checked them against
 * the API, so they are left out and get the JSON tool.
 *
 * To add an id: send one live request with it from a profile that has computer
 * use on, and add it only if the request is accepted. A wrong id here has no
 * fallback: the toolset is in every request of such a profile whether or not
 * the model uses it, so every request fails with a 400 that names
 * `computer_toolset_20260801`. A missing id costs nothing but the JSON tool.
 */
export const COMPUTER_TOOLSET_MODELS = [
  'claude-opus-5-5',
  'claude-opus-5',
  'claude-opus-4-8',
  'claude-sonnet-5',
  'claude-fable-5',
  'claude-fable-5-1',
] as const;

/**
 * Phase 1 leaves out zoom, drags, raw mouse down/up, middle click and held
 * keys: every member of the toolset that is not one of core's
 * `COMPUTER_ACTIONS` is turned off here. This list is not what keeps such a
 * member from running: one the model calls anyway reaches the tool as its
 * name alone (`memberArgs`), and the tool provider's gate refuses it.
 */
export const COMPUTER_TOOLSET_CONFIGS = Object.freeze({
  zoom: Object.freeze({ enabled: false }),
  left_click_drag: Object.freeze({ enabled: false }),
  left_mouse_down: Object.freeze({ enabled: false }),
  left_mouse_up: Object.freeze({ enabled: false }),
  middle_click: Object.freeze({ enabled: false }),
  hold_key: Object.freeze({ enabled: false }),
});

/** A dated snapshot of a model: its id, a hyphen and eight digits (`claude-opus-5-5-20261001`). */
const SNAPSHOT_DATE = /^\d{8}$/;

/**
 * Whether a model is given the toolset instead of the JSON tool: an Anthropic
 * connection, and a model id that is one of `COMPUTER_TOOLSET_MODELS` exactly
 * or a dated snapshot of one. Not a bare prefix: a model OtherBench does not know
 * (`claude-opus-5-9`, a later `claude-opus-50`) keeps the JSON tool, which any
 * model can use, where a toolset it may not take would fail the request.
 */
export function usesComputerToolset(kind: ConnectionKind, modelId: string): boolean {
  if (kind !== 'anthropic' || typeof modelId !== 'string') return false;
  return COMPUTER_TOOLSET_MODELS.some((id) => modelId === id || (modelId.startsWith(`${id}-`) && SNAPSHOT_DATE.test(modelId.slice(id.length + 1))));
}

type ComputerToolsetFactory = AnthropicProvider['tools']['computerToolset_20260801'];

/** The Anthropic provider's toolset factory, or null (another provider, or a test double without one). */
function computerToolsetOf(handle: Extract<ProviderHandle, { kind: 'aisdk' }>): ComputerToolsetFactory | null {
  const tools = (handle.provider as Partial<AnthropicProvider>).tools;
  return typeof tools?.computerToolset_20260801 === 'function' ? tools.computerToolset_20260801 : null;
}

/**
 * Bounds `seedOllamaCapabilities`'s own `/api/tags` fetch (see that
 * method's doc for why a failure there is swallowed rather than propagated).
 * A `try/catch` alone does not catch a HANG -- a host that answers
 * `/v1/models` but never responds on `/api/tags` left `POST
 * /discover-models` open indefinitely, turning an optional capability
 * *hint* into a hard dependency for the whole discovery call. Built from an
 * `AbortController` + `setTimeout` (not `AbortSignal.timeout`) so it is
 * driven by the same fake-timer-friendly primitive as `chats.ts`'s
 * `applyAutoTitle` watchdog, rather than a native timer vitest's fake
 * timers cannot see.
 */
const OLLAMA_TAGS_TIMEOUT_MS = 3_000;

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

    // Tool executions need a ToolContext (chatId, messageId, ...), built from
    // the request by toolContextFor: the TurnRunner allocates and persists the
    // assistant message row before calling stream().
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
      const imagesOk = caps.vision && toolImagesSupported(req.profile.connection.kind, req.profile.modelId);
      // Stored tool images come back only through a loader that checks them
      // against this chat; `loadAttachment` is never used for them.
      const messages = await toModelMessages(
        req.messages,
        { ...caps, toolImages: imagesOk },
        req.loadAttachment ?? loadAttachmentUnavailable,
        req.loadToolImage ? { chatId: req.chatId, load: req.loadToolImage, ...(req.toolImageSize ? { size: req.toolImageSize } : {}) } : undefined,
        req.attachmentSize
      );
      // One budget for the whole reply: images a tool returns are screened against it as they come, across every step.
      const imageBudget: ToolImageBudget = { images: 0, bytes: 0 };
      // Anthropic's own computer toolset, for the models that take it. It only stands in for OtherBench's `computer` tool when the request has one.
      const toolset = usesComputerToolset(req.profile.connection.kind, req.profile.modelId) ? computerToolsetOf(handle) : null;
      const tools = buildToolSet(req, imagesOk, imageBudget, toolset);
      const model = resolveLanguageModel(handle, req.profile.modelId);
      // With the toolset among the tools, a `computer` call that is not one of its members can't be written back
      // as a member call: it and its result go out as an ordinary call and result under another name, never as
      // text. The same pass runs on the history the request starts with and on every later step's messages,
      // which hold the calls this reply itself made (computer-toolset.ts).
      const toolsetOn = toolset !== null && req.tools.some(isComputerSpec);
      const safe = (list: ModelMessage[]): ModelMessage[] => (toolsetOn ? toolsetSafeMessages(list, COMPUTER_TOOL) : list);
      const caching = req.profile.connection.kind === 'anthropic';

      const result = streamText({
        model,
        messages: safe(caching ? withCachedSystem(messages) : messages),
        // Anthropic caches nothing unless asked. Top-level caching puts the
        // breakpoint on the newest block of every request, so each tool step
        // reads what the step before it wrote, and the next turn reads this
        // turn's (prompt-caching guide: automatic caching for the growing tail).
        ...(caching ? { providerOptions: { anthropic: { cacheControl: CACHE_CONTROL } } } : {}),
        ...(toolsetOn ? { prepareStep: ({ messages: stepMessages }: { messages: ModelMessage[] }) => ({ messages: safe(stepMessages) }) } : {}),
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
    const start = Date.now();
    try {
      // `resolver.resolve()` used to run before this try block, so a
      // synchronous throw from it (e.g. ProviderRegistry's buildProvider
      // rejecting an `openai_compatible` connection with no baseUrl --
      // registry.ts's ConfigError) escaped as a rejected promise instead of
      // the `{ok: false, message}` this method exists to report, and from
      // there surfaced as an opaque 500 at POST /api/connections/:id/test
      // (no try/catch there either). `stream()` above already wraps its own
      // `resolver.resolve()` call the same way, for the same reason -- this
      // brings `testConnection` in line with it.
      const handle = this.resolver.resolve(conn, apiKey);
      if (handle.kind === 'mock') return await this.mock.testConnection(conn, apiKey);

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
        const models = await this.fetchJsonModels(`${trimTrailingSlash(base)}/models`, headers, (body) =>
          asArray(body['data']).map((m) => ({
            modelId: stringField(m, 'id') ?? 'unknown',
            displayName: stringField(m, 'id') ?? 'unknown',
            contextWindow: null,
            supportsVision: null,
            supportsTools: null,
          }))
        );
        // Capabilities stay declared-not-probed for every other kind (a
        // custom endpoint can claim to be anything -- see ModelsPanel's own
        // doc, packages/web/src/views/settings/ModelsPanel.tsx). Ollama is
        // the one deliberate exception: its native API genuinely reports
        // per-model capabilities and context length, unlike its OpenAI-
        // compatible `/v1/models` surface above, which returns bare ids.
        return conn.kind === 'ollama' ? this.seedOllamaCapabilities(base, headers, models) : models;
      }

      case 'claude_code':
        throw new Error('listRealModels() was called for a claude_code connection; RoutingChatEngine should have routed it elsewhere.');

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

  /**
   * Enriches `models` (already listed from Ollama's OpenAI-compatible
   * `/v1/models`, which returns bare ids and nothing else) with
   * `supportsVision`/`supportsTools`/`contextWindow` read from Ollama's own
   * `GET /api/tags` -- verified against a real instance to return, per
   * model, a `capabilities` array (`"vision"`, `"tools"`, `"completion"`,
   * `"insert"`, `"embedding"`) and `details.context_length`. `/api/tags`
   * lives at the host root, not under `/v1`, so `openAiBase` (the URL
   * `/v1/models` was just fetched relative to) is de-suffixed first.
   *
   * A capability hint is not worth breaking model discovery over: any
   * failure here -- unreachable host, non-2xx, malformed/unexpected JSON,
   * OR a request that just never comes back within
   * `OLLAMA_TAGS_TIMEOUT_MS` -- is swallowed and `models` is returned
   * exactly as discovered, still carrying the conservative `null`
   * ("unknown", not "no") defaults every other connection kind gets.
   * Matching is by exact name (`details.name` from `/api/tags` against
   * `DiscoveredModel.modelId` from `/v1/models`, confirmed identical --
   * e.g. both report `"qwen2.5vl:7b"`); a model present in one listing but
   * not the other is left untouched rather than guessed at.
   */
  private async seedOllamaCapabilities(
    openAiBase: string,
    headers: Record<string, string>,
    models: DiscoveredModel[]
  ): Promise<DiscoveredModel[]> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), OLLAMA_TAGS_TIMEOUT_MS);
    try {
      const nativeBase = deriveOllamaNativeBaseUrl(openAiBase);
      const response = await this.fetchImpl(`${nativeBase}/api/tags`, { headers, signal: controller.signal });
      if (!response.ok) return models;
      const body = (await response.json()) as Record<string, unknown>;
      const capabilitiesByName = new Map<string, { capabilities: Set<string>; contextLength: number | null }>();
      for (const row of asArray(body['models'])) {
        const name = stringField(row, 'name');
        if (!name) continue;
        const rawCapabilities = row['capabilities'];
        const capabilities = Array.isArray(rawCapabilities) ? rawCapabilities.filter((c): c is string => typeof c === 'string') : [];
        const details = row['details'];
        const contextLength =
          typeof details === 'object' && details !== null ? numberField(details as Record<string, unknown>, 'context_length') : null;
        capabilitiesByName.set(name, { capabilities: new Set(capabilities), contextLength });
      }

      return models.map((model) => {
        const hit = capabilitiesByName.get(model.modelId);
        if (!hit) return model;
        return {
          ...model,
          supportsVision: hit.capabilities.has('vision'),
          supportsTools: hit.capabilities.has('tools'),
          contextWindow: hit.contextLength,
        };
      });
    } catch {
      // Covers a non-2xx-shaped network failure, malformed JSON, AND the
      // `AbortError` the timer above raises on a hang -- all three are
      // exactly the same "couldn't get a capability hint in time" case from
      // this method's contract, and all three fall back the same way.
      return models;
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Ollama serves its native API (`/api/tags`, etc.) at the host root, but
 * OtherBench talks to it through the OpenAI-compatible surface at `/v1`
 * (`DEFAULT_OLLAMA_BASE_URL`, or a user-supplied `baseUrl` ending the same
 * way) -- so the native root is derived by stripping that suffix. A
 * `baseUrl` that was never given a `/v1` suffix (already pointing at the
 * root) is returned unchanged rather than mangled.
 */
function deriveOllamaNativeBaseUrl(base: string): string {
  const trimmed = trimTrailingSlash(base);
  return trimmed.endsWith('/v1') ? trimmed.slice(0, -'/v1'.length) : trimmed;
}

// ---------------------------------------------------------------------------
// stream() helpers
// ---------------------------------------------------------------------------

/**
 * The fallback used when a request carries no `EngineRequest.loadAttachment`
 * at all (every pre-task-21 caller, and any task-21+ caller that genuinely
 * has nowhere to load attachment bytes from). `engine-aisdk` still has no
 * dependency on `@otherbench/store-sqlite`/filesystem access of its own -- task 21
 * wires a real loader through from the TurnRunner
 * (`TurnRunnerOptions.loadAttachment`, populated by the server's `Container`
 * from the content-addressed blob store) onto `req.loadAttachment`, and
 * `stream()` above prefers that when present. This stub is only ever reached
 * if a caller both omits `loadAttachment` AND sends a request whose messages
 * contain a real `image`/`file` part to a vision-capable model -- text-only
 * conversations (everything task 14's tests cover) never call this.
 */
async function loadAttachmentUnavailable(id: string): Promise<Buffer> {
  throw new Error(
    `AiSdkChatEngine cannot load attachment "${id}": EngineRequest carries no attachment loader yet. ` +
      'Wiring real attachment bytes through to the model is the responsibility of whatever assembles ' +
      'EngineRequest (the TurnRunner, tasks 16-18).'
  );
}

/** Anthropic's 5-minute prompt cache, the price `estimateCost` charges for its writes (CACHE_WRITE_PRICE_FACTOR). */
const CACHE_CONTROL = Object.freeze({ type: 'ephemeral' as const });

/**
 * The history with a cache breakpoint on its last system message. The tools
 * and the system prompt come first in an Anthropic request and are the same
 * for every turn of a chat, so they get a read point of their own that holds
 * whatever happens further down the conversation.
 */
function withCachedSystem(messages: ModelMessage[]): ModelMessage[] {
  const last = messages.findLastIndex((m) => m.role === 'system');
  if (last < 0) return messages;
  return messages.map((m, i) => (i === last ? { ...m, providerOptions: { ...m.providerOptions, anthropic: { ...m.providerOptions?.['anthropic'], cacheControl: CACHE_CONTROL } } } : m));
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

/** OtherBench's own `computer` tool (packages/tools/src/computer-tool.ts), by source and by name: the one tool the toolset can stand in for. */
function isComputerSpec(spec: ToolSpec): boolean {
  return spec.source === 'computer' && spec.name === COMPUTER_TOOL;
}

/** The fields a spec's parameters declare (the top-level `properties` of its JSON Schema). */
function declaredFields(spec: ToolSpec): string[] {
  const properties = spec.parameters['properties'];
  return typeof properties === 'object' && properties !== null && !Array.isArray(properties) ? Object.keys(properties) : [];
}

/**
 * A member call of the computer toolset as the arguments of OtherBench's `computer`
 * tool, or why it has none. The SDK hands a member call over as
 * `{ action: <member>, ...its input }`, which is the JSON tool's own shape.
 *
 *   - A member that is not one of core's phase-1 actions (a drag, a held key,
 *     a zoom, a name nobody knows) goes to the tool as `{ action }` ALONE:
 *     nothing it could act on. The tool provider's gate then refuses it the
 *     way it refuses an unknown action of the JSON tool (before any control
 *     session is started, with no card) and records it in the audit.
 *   - A phase-1 action that carries a field the tool's parameters do not
 *     declare (`fields`): the provider's schema allows `region`, `repeat` and
 *     `start_coordinate`, which OtherBench does nothing with. It is refused here,
 *     naming the field, rather than run without it: a click sent with
 *     `repeat: 3` that ran once would leave the model and the transcript
 *     believing it ran three times. This refusal is the engine's own and
 *     leaves no audit row. Core's `parseAction` now refuses a field an action
 *     doesn't use as well, so the gate would refuse the call too; this stays
 *     as a second line.
 *   - Otherwise the action and the declared fields it carries, in a fresh
 *     object, and nothing else. A declared field the action doesn't use
 *     (`text` on a click, which Anthropic's tools use for keys to hold) goes
 *     on to the gate, which refuses it and records it.
 */
function memberArgs(input: unknown, fields: readonly string[]): { args: Record<string, unknown> } | { refuse: string } {
  const member = typeof input === 'object' && input !== null && !Array.isArray(input) ? (input as Record<string, unknown>) : null;
  const action = member !== null && Object.hasOwn(member, 'action') ? member['action'] : undefined;
  if (member === null || !isComputerAction(action)) return { args: { action } };
  const sent = Object.keys(member).filter((field) => field !== 'action' && member[field] !== undefined);
  const unknown = sent.filter((field) => !fields.includes(field));
  if (unknown.length > 0) {
    const names = unknown.map((field) => `"${cardLine(field, 40)}"`).join(', ');
    return { refuse: `The computer tool doesn't take ${names} with ${action}, so nothing was done. Send the action again without ${unknown.length === 1 ? 'it' : 'them'}.` };
  }
  const args: Record<string, unknown> = { action };
  for (const field of sent) args[field] = member[field];
  return { args };
}

function buildToolSet(
  req: EngineRequest,
  imagesOk: boolean,
  imageBudget: ToolImageBudget,
  /** Anthropic's computer toolset when this request's model takes it: it then stands in for OtherBench's `computer` tool, when the request has one. */
  toolset: ComputerToolsetFactory | null
): ToolSet {
  const toolSet: ToolSet = {};
  for (const spec of req.tools) {
    /**
     * Runs the tool for one call, however the model was given it (a JSON tool
     * or a member of the toolset). `spec.execute` is the tool provider's gate,
     * so the permission broker decides every call.
     */
    const run = async (input: unknown, abortSignal: AbortSignal | undefined, toolCallId: string | undefined): Promise<unknown> => {
      // toolContextFor is the one place a ToolContext is built: ids, profile
      // (it scopes grants, see ToolContext.profileId), workspace, folders,
      // the reply's plan gate and unattended flag, the call id, and the
      // reply's sub-agent host and tag. The toolset's member calls get the
      // same context as the JSON tool's.
      const ctx = toolContextFor(req, abortSignal ?? req.signal, toolCallId);
      try {
        // What the model is shown and what is stored are one thing: the output is
        // screened here, once, so an image that is not let through is the same note
        // in both, and bulk base64 never goes on to either.
        const screened = screenToolResult(await spec.execute(input, ctx), imageBudget, LIVE_IMAGE_LIMITS);
        if (screened.forged) console.warn(`[AiSdkChatEngine] a "${spec.name}" result carried a reference to a stored image; removed.`);
        return screened.result;
      } catch (err) {
        // Every other tool's throw goes on to the SDK as it always has (its own error result), and so does a stop.
        if (!isComputerSpec(spec) || ctx.signal.aborted) throw err;
        // A computer call's words may be the desktop app's: answered as the Claude Code relay answers the
        // same throw (relay.ts), one clean bounded line under the line that says it is screen content.
        return screenContentError('computer_failed', desktopTextForResult(errorMessage(err)));
      }
    };
    // Images a tool returns go to the model as images, or as a note when it can't take them.
    const toModelOutput = ({ output }: { output: unknown }): ReturnType<typeof liveToolOutput> => liveToolOutput(output, imagesOk);

    if (toolset !== null && isComputerSpec(spec)) {
      // One way to act: the toolset is sent INSTEAD of the JSON tool, under the
      // same name, so the transcript and the broker see one `computer` tool
      // whichever way the model was given it.
      const fields = declaredFields(spec);
      toolSet[spec.name] = toolset({
        configs: COMPUTER_TOOLSET_CONFIGS,
        toModelOutput,
        execute: async (input: unknown, opts) => {
          const member = memberArgs(input, fields);
          // The shape of every other refusal the model gets from an OtherBench tool (packages/tools/src/provider.ts).
          if ('refuse' in member) return { error: true, code: 'computer_bad_action', message: member.refuse };
          return run(member.args, opts.abortSignal, opts.toolCallId);
        },
      });
      continue;
    }
    toolSet[spec.name] = tool({
      description: spec.description,
      inputSchema: jsonSchema(spec.parameters as JSONSchema7),
      toModelOutput,
      execute: async (input: unknown, opts) => run(input, opts.abortSignal, opts.toolCallId),
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
    tokensCacheWrite: usage.inputTokenDetails.cacheWriteTokens ?? 0,
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
