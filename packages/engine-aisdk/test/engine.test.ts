import { describe, it, expect, vi } from 'vitest';
import { APICallError } from '@ai-sdk/provider';
import { MockLanguageModelV3, convertArrayToReadableStream } from 'ai/test';
import type { EngineEvent, EngineRequest } from '@grunt/core/ports/chat-engine.js';
import type { ToolContext, ToolSpec } from '@grunt/core/ports/tool-provider.js';
import type { CanonMessage } from '@grunt/core/types/messages.js';
import type { Connection, ResolvedProfile } from '@grunt/core/types/config.js';
import { createPlanGate } from '@grunt/core/domain/thread-tools.js';
import { FakeChatEngine } from '@grunt/core/testing/fakes.js';
import { AiSdkChatEngine, type ProviderResolver } from '../src/engine.js';
import type { ProviderHandle } from '../src/registry.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeConnection(overrides: Partial<Connection> = {}): Connection {
  return {
    id: 'conn-1',
    name: 'Test Connection',
    kind: 'anthropic',
    baseUrl: null,
    secretRef: null,
    extraHeaders: {},
    status: 'unknown',
    statusMessage: null,
    checkedAt: null,
    ...overrides,
  };
}

function makeResolvedProfile(overrides: Partial<ResolvedProfile> = {}): ResolvedProfile {
  return {
    id: 'profile-1',
    name: 'Test Profile',
    description: null,
    colour: null,
    connectionId: 'conn-1',
    modelId: 'claude-test-model',
    systemPrompt: null,
    params: {},
    toolPolicy: { fs: 'off', shell: false, mcpServerIds: [], approvalMode: 'always_ask' },
    isDefault: false,
    archivedAt: null,
    connection: makeConnection(),
    apiKey: 'sk-test-key',
    model: null,
    ...overrides,
  };
}

let counter = 0;
function userMessage(text: string, chatId = 'chat-1'): CanonMessage {
  counter += 1;
  return {
    id: `msg-${counter}`,
    chatId,
    parentId: null,
    role: 'user',
    parts: [{ type: 'text', text }],
    status: 'complete',
    error: null,
    producedBy: null,
    createdAt: counter,
  };
}

function makeRequest(over: Partial<EngineRequest> = {}): EngineRequest {
  return {
    profile: makeResolvedProfile(),
    messages: [userMessage('hello')],
    tools: [],
    signal: new AbortController().signal,
    chatId: 'chat-1',
    messageId: 'msg-req-1',
    workspaceRoot: null,
    ...over,
  };
}

async function drain(iterable: AsyncIterable<EngineEvent>): Promise<EngineEvent[]> {
  const events: EngineEvent[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

/**
 * Lists the per-call streams for `MockLanguageModelV3`'s array-based
 * `doStream`, in the natural order. Older `ai` releases (up to at least
 * 6.0.253) indexed the array with an off-by-one (the first call read index 1)
 * and this helper padded a dummy step 0; that was fixed upstream by 6.0.300,
 * so no padding is needed any more.
 */
function stepsForModel(...steps: unknown[][]): { stream: ReadableStream<unknown> }[] {
  return steps.map((chunks) => ({ stream: convertArrayToReadableStream(chunks) }));
}

function resolverFor(model: MockLanguageModelV3): ProviderResolver {
  return {
    resolve: (): ProviderHandle => ({ kind: 'aisdk', provider: (() => model) as never }),
  };
}

const ZERO_USAGE = { inputTokens: { total: 0 }, outputTokens: { total: 0 } };

// ---------------------------------------------------------------------------
// stream()
// ---------------------------------------------------------------------------

describe('AiSdkChatEngine.stream', () => {
  it('maps text-delta chunks through to text-delta EngineEvents, then finish', async () => {
    const model = new MockLanguageModelV3({
      doStream: async () => ({
        stream: convertArrayToReadableStream([
          { type: 'stream-start', warnings: [] },
          { type: 'text-start', id: 't1' },
          { type: 'text-delta', id: 't1', delta: 'Hello' },
          { type: 'text-delta', id: 't1', delta: ' world' },
          { type: 'text-end', id: 't1' },
          {
            type: 'finish',
            finishReason: { unified: 'stop', raw: 'stop' },
            usage: { inputTokens: { total: 12 }, outputTokens: { total: 3 } },
          },
        ]),
      }),
    });
    const engine = new AiSdkChatEngine(resolverFor(model));

    const events = await drain(engine.stream(makeRequest()));

    expect(events.filter((e) => e.type === 'text-delta')).toEqual([
      { type: 'text-delta', text: 'Hello' },
      { type: 'text-delta', text: ' world' },
    ]);
    const finish = events.at(-1);
    expect(finish).toMatchObject({
      type: 'finish',
      finishReason: 'stop',
      usage: { tokensIn: 12, tokensOut: 3, tokensCached: 0, tokensReasoning: 0 },
    });
  });

  it('maps reasoning-delta chunks through to reasoning-delta EngineEvents', async () => {
    const model = new MockLanguageModelV3({
      doStream: async () => ({
        stream: convertArrayToReadableStream([
          { type: 'stream-start', warnings: [] },
          { type: 'reasoning-start', id: 'r1' },
          { type: 'reasoning-delta', id: 'r1', delta: 'thinking...' },
          { type: 'reasoning-end', id: 'r1' },
          { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage: ZERO_USAGE },
        ]),
      }),
    });
    const engine = new AiSdkChatEngine(resolverFor(model));

    const events = await drain(engine.stream(makeRequest()));

    expect(events).toContainEqual({ type: 'reasoning-delta', text: 'thinking...' });
  });

  it("gives each tool call its call id, the reply's sub-agent host and the sub-agent tag", async () => {
    const seen: ToolContext[] = [];
    const spec: ToolSpec = {
      name: 'probe',
      description: '',
      parameters: { type: 'object', properties: {} },
      risk: 'read',
      source: 'mcp',
      execute: async (_args, ctx) => {
        seen.push(ctx);
        return 'ok';
      },
    };
    const model = new MockLanguageModelV3({
      doStream: stepsForModel(
        [
          { type: 'stream-start', warnings: [] },
          { type: 'tool-call', toolCallId: 'call-42', toolName: 'probe', input: '{}' },
          { type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool_calls' }, usage: ZERO_USAGE },
        ],
        [
          { type: 'stream-start', warnings: [] },
          { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage: ZERO_USAGE },
        ]
      ),
    });
    const host = { run: async () => 'x' };
    await drain(new AiSdkChatEngine(resolverFor(model)).stream(makeRequest({ tools: [spec], subagents: host, subagent: { callId: 'parent-call', label: 'Helper', parentProfileId: 'profile-1' } })));
    expect(seen[0]).toMatchObject({ toolCallId: 'call-42', subagents: host, subagent: { callId: 'parent-call', label: 'Helper', parentProfileId: 'profile-1' }, chatId: 'chat-1', profileId: 'profile-1' });
  });

  it('round-trips a tool call: tool-call event, then tool-result event with the real return value, then the follow-up answer', async () => {
    const toolExecute = vi.fn(async (args: unknown, ctx: ToolContext) => {
      expect(ctx.chatId).toBe('chat-1');
      expect(typeof ctx.messageId).toBe('string');
      expect(ctx.messageId.length).toBeGreaterThan(0);
      expect(ctx.signal).toBeInstanceOf(AbortSignal);
      return { tempC: 22, city: (args as { city: string }).city };
    });
    const toolSpec: ToolSpec = {
      name: 'get_weather',
      description: 'Gets the weather for a city.',
      parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
      risk: 'read',
      source: 'mcp',
      execute: toolExecute,
    };

    const model = new MockLanguageModelV3({
      doStream: stepsForModel(
        [
          { type: 'stream-start', warnings: [] },
          { type: 'tool-call', toolCallId: 'call-1', toolName: 'get_weather', input: JSON.stringify({ city: 'Paris' }) },
          { type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool_calls' }, usage: ZERO_USAGE },
        ],
        [
          { type: 'stream-start', warnings: [] },
          { type: 'text-start', id: 't1' },
          { type: 'text-delta', id: 't1', delta: 'It is 22C in Paris.' },
          { type: 'text-end', id: 't1' },
          { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage: ZERO_USAGE },
        ]
      ),
    });
    const engine = new AiSdkChatEngine(resolverFor(model));

    const events = await drain(engine.stream(makeRequest({ tools: [toolSpec] })));

    expect(toolExecute).toHaveBeenCalledTimes(1);

    const toolCall = events.find((e) => e.type === 'tool-call');
    expect(toolCall).toMatchObject({ type: 'tool-call', id: 'call-1', name: 'get_weather', args: { city: 'Paris' } });

    const toolResult = events.find((e) => e.type === 'tool-result');
    expect(toolResult).toMatchObject({
      type: 'tool-result',
      id: 'call-1',
      name: 'get_weather',
      result: { tempC: 22, city: 'Paris' },
      isError: false,
    });

    const toolCallIndex = events.indexOf(toolCall!);
    const toolResultIndex = events.indexOf(toolResult!);
    expect(toolCallIndex).toBeLessThan(toolResultIndex);

    const text = events
      .filter((e): e is Extract<EngineEvent, { type: 'text-delta' }> => e.type === 'text-delta')
      .map((e) => e.text)
      .join('');
    expect(text).toContain('22C in Paris');
    expect(events.at(-1)?.type).toBe('finish');
  });

  it('gives each tool call a context carrying the reply plan gate and the unattended flag', async () => {
    const seen: ToolContext[] = [];
    const toolExecute = vi.fn(async (_args: unknown, ctx: ToolContext) => {
      seen.push(ctx);
      return { tempC: 22 };
    });
    const toolSpec: ToolSpec = {
      name: 'get_weather',
      description: 'Gets the weather for a city.',
      parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
      risk: 'read',
      source: 'mcp',
      execute: toolExecute,
    };

    const model = new MockLanguageModelV3({
      doStream: stepsForModel(
        [
          { type: 'stream-start', warnings: [] },
          { type: 'tool-call', toolCallId: 'call-1', toolName: 'get_weather', input: JSON.stringify({ city: 'Paris' }) },
          { type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool_calls' }, usage: ZERO_USAGE },
        ],
        [
          { type: 'stream-start', warnings: [] },
          { type: 'text-start', id: 't1' },
          { type: 'text-delta', id: 't1', delta: 'It is 22C in Paris.' },
          { type: 'text-end', id: 't1' },
          { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage: ZERO_USAGE },
        ]
      ),
    });
    const engine = new AiSdkChatEngine(resolverFor(model));
    const plan = createPlanGate();

    await drain(engine.stream(makeRequest({ tools: [toolSpec], plan, unattended: true })));

    expect(seen).toHaveLength(1);
    expect(seen[0]!.plan).toBe(plan);
    expect(seen[0]!.unattended).toBe(true);
    expect(seen[0]!.profileId).toBe(makeRequest().profile.id);
  });

  it("marks each tool call of an unattended turn unattended, and leaves an ordinary turn's calls unmarked", async () => {
    const seen: (boolean | undefined)[] = [];
    const toolSpec: ToolSpec = {
      name: 'get_weather',
      description: 'Gets the weather for a city.',
      parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
      risk: 'read',
      source: 'mcp',
      execute: async (_args: unknown, ctx: ToolContext) => {
        seen.push(ctx.unattended);
        return { tempC: 22 };
      },
    };
    const steps = () =>
      stepsForModel(
        [
          { type: 'stream-start', warnings: [] },
          { type: 'tool-call', toolCallId: 'call-1', toolName: 'get_weather', input: JSON.stringify({ city: 'Paris' }) },
          { type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool_calls' }, usage: ZERO_USAGE },
        ],
        [
          { type: 'stream-start', warnings: [] },
          { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage: ZERO_USAGE },
        ]
      );

    await drain(new AiSdkChatEngine(resolverFor(new MockLanguageModelV3({ doStream: steps() }))).stream(makeRequest({ tools: [toolSpec], unattended: true })));
    await drain(new AiSdkChatEngine(resolverFor(new MockLanguageModelV3({ doStream: steps() }))).stream(makeRequest({ tools: [toolSpec] })));

    expect(seen).toEqual([true, undefined]);
  });

  it('reports a failed tool execution as a tool-result event with isError true', async () => {
    const toolSpec: ToolSpec = {
      name: 'boom',
      description: 'Always fails.',
      parameters: { type: 'object', properties: {} },
      risk: 'execute',
      source: 'shell',
      execute: async () => {
        throw new Error('kaboom');
      },
    };
    const model = new MockLanguageModelV3({
      doStream: stepsForModel(
        [
          { type: 'stream-start', warnings: [] },
          { type: 'tool-call', toolCallId: 'call-1', toolName: 'boom', input: '{}' },
          { type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool_calls' }, usage: ZERO_USAGE },
        ],
        [
          { type: 'stream-start', warnings: [] },
          { type: 'text-start', id: 't1' },
          { type: 'text-delta', id: 't1', delta: 'Sorry, that failed.' },
          { type: 'text-end', id: 't1' },
          { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage: ZERO_USAGE },
        ]
      ),
    });
    const engine = new AiSdkChatEngine(resolverFor(model));

    const events = await drain(engine.stream(makeRequest({ tools: [toolSpec] })));

    const toolResult = events.find((e) => e.type === 'tool-result');
    expect(toolResult).toMatchObject({ type: 'tool-result', id: 'call-1', name: 'boom', isError: true });
    if (toolResult?.type === 'tool-result') {
      expect(String(toolResult.result)).toContain('kaboom');
    }
  });

  it('starts every tool call of one step at once, without waiting for the one before (sub-agents run in parallel)', async () => {
    let started = 0;
    let bothStarted!: () => void;
    const allIn = new Promise<void>((resolve) => {
      bothStarted = resolve;
    });
    const execute = vi.fn(async () => {
      started += 1;
      if (started === 2) bothStarted();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          allIn,
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error('the calls ran one after another')), 2_000);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
      return 'ok';
    });
    const spec: ToolSpec = {
      name: 'wait_for_sibling',
      description: 'Waits until its sibling call has started too.',
      parameters: { type: 'object', properties: {} },
      risk: 'read',
      source: 'mcp',
      execute,
    };
    const model = new MockLanguageModelV3({
      doStream: stepsForModel(
        [
          { type: 'stream-start', warnings: [] },
          { type: 'tool-call', toolCallId: 'call-1', toolName: 'wait_for_sibling', input: '{}' },
          { type: 'tool-call', toolCallId: 'call-2', toolName: 'wait_for_sibling', input: '{}' },
          { type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool_calls' }, usage: ZERO_USAGE },
        ],
        [
          { type: 'stream-start', warnings: [] },
          { type: 'text-start', id: 't1' },
          { type: 'text-delta', id: 't1', delta: 'Both done.' },
          { type: 'text-end', id: 't1' },
          { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage: ZERO_USAGE },
        ]
      ),
    });

    const events = await drain(new AiSdkChatEngine(resolverFor(model)).stream(makeRequest({ tools: [spec] })));

    expect(execute).toHaveBeenCalledTimes(2);
    const results = events.filter((e): e is Extract<EngineEvent, { type: 'tool-result' }> => e.type === 'tool-result');
    expect(results.map((r) => [r.id, r.isError])).toEqual([
      ['call-1', false],
      ['call-2', false],
    ]);
  });

  it('maps a 429 APICallError to a single error event with kind rate_limit, retryable true', async () => {
    const model = new MockLanguageModelV3({
      doStream: async () => {
        throw new APICallError({
          message: 'Rate limited',
          url: 'https://api.example.com/v1/messages',
          requestBodyValues: {},
          statusCode: 429,
          isRetryable: true,
        });
      },
    });
    const engine = new AiSdkChatEngine(resolverFor(model));

    const events = await drain(engine.stream(makeRequest()));

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'error',
      error: { kind: 'rate_limit', retryable: true },
    });
  });

  it('maps a mid-stream abort to a single error event with kind cancelled', async () => {
    const controller = new AbortController();
    const model = new MockLanguageModelV3({
      doStream: async (options) => {
        const stream = new ReadableStream({
          start(ctrl) {
            ctrl.enqueue({ type: 'stream-start', warnings: [] });
            ctrl.enqueue({ type: 'text-start', id: 't1' });
            ctrl.enqueue({ type: 'text-delta', id: 't1', delta: 'Hello' });
            options.abortSignal?.addEventListener(
              'abort',
              () => ctrl.error(new DOMException('This operation was aborted', 'AbortError')),
              { once: true }
            );
          },
        });
        return { stream };
      },
    });
    const engine = new AiSdkChatEngine(resolverFor(model));

    const events: EngineEvent[] = [];
    const streamPromise = (async () => {
      for await (const event of engine.stream(makeRequest({ signal: controller.signal }))) {
        events.push(event);
      }
    })();
    // Give the stream a tick to emit the initial text-delta before aborting.
    await new Promise((resolve) => setTimeout(resolve, 10));
    controller.abort();
    await streamPromise;

    const errorEvent = events.at(-1);
    expect(errorEvent).toMatchObject({ type: 'error', error: { kind: 'cancelled', retryable: false } });
  });

  it('yields nothing when the signal is already aborted before iteration starts', async () => {
    const controller = new AbortController();
    controller.abort();
    const model = new MockLanguageModelV3({ doStream: async () => ({ stream: convertArrayToReadableStream([]) }) });
    const engine = new AiSdkChatEngine(resolverFor(model));

    const events = await drain(engine.stream(makeRequest({ signal: controller.signal })));

    expect(events).toEqual([]);
  });

  it('delegates entirely to the mock engine for a mock connection', async () => {
    const scriptedEvents: EngineEvent[] = [{ type: 'text-delta', text: 'from mock' }];
    const fakeMock = new FakeChatEngine(scriptedEvents);
    const resolver: ProviderResolver = { resolve: () => ({ kind: 'mock' }) };
    const engine = new AiSdkChatEngine(resolver, { mock: fakeMock });

    const req = makeRequest({ profile: makeResolvedProfile({ connection: makeConnection({ kind: 'mock' }) }) });
    const events = await drain(engine.stream(req));

    expect(events).toEqual(scriptedEvents);
    expect(fakeMock.requests).toHaveLength(1);
    expect(fakeMock.requests[0]).toBe(req);
  });
});

// ---------------------------------------------------------------------------
// listModels / testConnection
// ---------------------------------------------------------------------------

describe('AiSdkChatEngine.listModels / testConnection (mock connections)', () => {
  it('delegates listModels to the mock engine for a mock connection', async () => {
    const fakeMock = new FakeChatEngine([]);
    fakeMock.models = [{ modelId: 'mock-1', displayName: 'Mock One', contextWindow: null, supportsVision: null, supportsTools: null }];
    const resolver: ProviderResolver = { resolve: () => ({ kind: 'mock' }) };
    const engine = new AiSdkChatEngine(resolver, { mock: fakeMock });

    const models = await engine.listModels(makeConnection({ kind: 'mock' }), null);

    expect(models).toEqual(fakeMock.models);
  });

  it('delegates testConnection to the mock engine for a mock connection', async () => {
    const fakeMock = new FakeChatEngine([]);
    const resolver: ProviderResolver = { resolve: () => ({ kind: 'mock' }) };
    const engine = new AiSdkChatEngine(resolver, { mock: fakeMock });

    const result = await engine.testConnection(makeConnection({ kind: 'mock' }), null);

    expect(result).toEqual(fakeMock.connectionTestResult);
  });
});

describe('AiSdkChatEngine.listModels (real providers, injectable fetch)', () => {
  function engineWithFetch(fetchImpl: typeof fetch) {
    const resolver: ProviderResolver = { resolve: () => ({ kind: 'aisdk', provider: (() => null) as never }) };
    return new AiSdkChatEngine(resolver, { fetchImpl });
  }

  it('lists OpenAI models from GET {baseUrl}/models with a bearer token', async () => {
    const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
      expect(String(url)).toBe('https://api.openai.com/v1/models');
      expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer sk-openai-key');
      return new Response(JSON.stringify({ data: [{ id: 'gpt-4o-mini' }, { id: 'gpt-4o' }] }), { status: 200 });
    });
    const engine = engineWithFetch(fetchImpl as unknown as typeof fetch);

    const models = await engine.listModels(makeConnection({ kind: 'openai' }), 'sk-openai-key');

    expect(models.map((m) => m.modelId)).toEqual(['gpt-4o-mini', 'gpt-4o']);
  });

  it('lists Anthropic models using display_name and the x-api-key header', async () => {
    const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
      expect(String(url)).toBe('https://api.anthropic.com/v1/models');
      expect((init?.headers as Record<string, string>)['x-api-key']).toBe('sk-ant-key');
      return new Response(
        JSON.stringify({ data: [{ id: 'claude-opus-4', display_name: 'Claude Opus 4' }] }),
        { status: 200 }
      );
    });
    const engine = engineWithFetch(fetchImpl as unknown as typeof fetch);

    const models = await engine.listModels(makeConnection({ kind: 'anthropic' }), 'sk-ant-key');

    expect(models).toEqual([
      { modelId: 'claude-opus-4', displayName: 'Claude Opus 4', contextWindow: null, supportsVision: null, supportsTools: null },
    ]);
  });

  it('lists Google models, stripping the "models/" name prefix and reading inputTokenLimit', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({ models: [{ name: 'models/gemini-2.0-flash', displayName: 'Gemini 2.0 Flash', inputTokenLimit: 1_000_000 }] }),
        { status: 200 }
      )
    );
    const engine = engineWithFetch(fetchImpl as unknown as typeof fetch);

    const models = await engine.listModels(makeConnection({ kind: 'google' }), 'goog-key');

    expect(models).toEqual([
      { modelId: 'gemini-2.0-flash', displayName: 'Gemini 2.0 Flash', contextWindow: 1_000_000, supportsVision: null, supportsTools: null },
    ]);
  });

  it('rejects with a classifiable error when the provider returns 401', async () => {
    const fetchImpl = vi.fn(async () => new Response('{"error":"invalid key"}', { status: 401 }));
    const engine = engineWithFetch(fetchImpl as unknown as typeof fetch);

    await expect(engine.listModels(makeConnection({ kind: 'openai' }), 'bad-key')).rejects.toThrow();
  });

  it('testConnection reports ok:false with the classified message on failure', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 401 }));
    const engine = engineWithFetch(fetchImpl as unknown as typeof fetch);

    const result = await engine.testConnection(makeConnection({ kind: 'openai' }), 'bad-key');

    expect(result.ok).toBe(false);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('testConnection reports ok:false instead of rejecting when resolver.resolve() throws synchronously', async () => {
    // Mirrors what the REAL ProviderRegistry.resolve() does for an
    // `openai_compatible` connection with no baseUrl (registry.ts's
    // buildProvider throws ConfigError synchronously, before any network
    // call). `stream()` already wraps `resolver.resolve()` in a try/catch;
    // `testConnection()`'s try block used to start one line below the
    // resolve() call, so this same failure mode escaped as a rejected
    // promise instead of a reported {ok: false, ...} result -- which is what
    // let it reach POST /api/connections/:id/test as an opaque 500.
    const resolver: ProviderResolver = {
      resolve: () => {
        throw new Error(
          'Connection "Local LLM" (conn-1) is kind "openai_compatible" but has no baseUrl configured.'
        );
      },
    };
    const engine = new AiSdkChatEngine(resolver);

    const result = await engine.testConnection(makeConnection({ kind: 'openai_compatible', baseUrl: null }), null);

    expect(result.ok).toBe(false);
    expect(result.message).toContain('baseUrl');
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('testConnection reports ok:true when models list successfully', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ data: [{ id: 'gpt-4o' }] }), { status: 200 }));
    const engine = engineWithFetch(fetchImpl as unknown as typeof fetch);

    const result = await engine.testConnection(makeConnection({ kind: 'openai' }), 'sk-key');

    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Ollama-specific capability seeding (task: settings UI part 4) -- Ollama's
// native `/api/tags` genuinely reports per-model capabilities/context length,
// unlike every other connection kind (declared, not probed -- see
// ModelsPanel's doc). A realistic payload below is copied verbatim from a
// real local Ollama instance's response shape.
// ---------------------------------------------------------------------------

describe('AiSdkChatEngine.listModels (Ollama capability seeding from /api/tags)', () => {
  function engineWithFetch(fetchImpl: typeof fetch) {
    const resolver: ProviderResolver = { resolve: () => ({ kind: 'aisdk', provider: (() => null) as never }) };
    return new AiSdkChatEngine(resolver, { fetchImpl });
  }

  /** A realistic `GET /api/tags` payload, trimmed to the fields this code reads. */
  const REALISTIC_TAGS_PAYLOAD = {
    models: [
      {
        name: 'qwen2.5vl:7b',
        model: 'qwen2.5vl:7b',
        details: { family: 'qwen25vl', parameter_size: '8.3B', context_length: 128000, embedding_length: 3584 },
        capabilities: ['vision', 'completion'],
      },
      {
        name: 'qwen3-coder:30b',
        model: 'qwen3-coder:30b',
        details: { family: 'qwen3moe', parameter_size: '30.5B', context_length: 262144, embedding_length: 2048 },
        capabilities: ['completion', 'tools'],
      },
      {
        name: 'nomic-embed-text:latest',
        model: 'nomic-embed-text:latest',
        details: { family: 'nomic-bert', parameter_size: '137M', context_length: 2048, embedding_length: 768 },
        capabilities: ['embedding'],
      },
    ],
  };

  it('seeds supportsVision/supportsTools/contextWindow from /api/tags, matched by model id', async () => {
    const fetchImpl = vi.fn(async (url: string | URL) => {
      if (String(url) === 'http://127.0.0.1:11434/v1/models') {
        return new Response(
          JSON.stringify({ data: [{ id: 'qwen2.5vl:7b' }, { id: 'qwen3-coder:30b' }, { id: 'nomic-embed-text:latest' }] }),
          { status: 200 }
        );
      }
      if (String(url) === 'http://127.0.0.1:11434/api/tags') {
        return new Response(JSON.stringify(REALISTIC_TAGS_PAYLOAD), { status: 200 });
      }
      throw new Error(`unexpected fetch: ${String(url)}`);
    });
    const engine = engineWithFetch(fetchImpl as unknown as typeof fetch);

    const models = await engine.listModels(makeConnection({ kind: 'ollama', baseUrl: null }), null);

    expect(models).toEqual([
      { modelId: 'qwen2.5vl:7b', displayName: 'qwen2.5vl:7b', contextWindow: 128000, supportsVision: true, supportsTools: false },
      { modelId: 'qwen3-coder:30b', displayName: 'qwen3-coder:30b', contextWindow: 262144, supportsVision: false, supportsTools: true },
      { modelId: 'nomic-embed-text:latest', displayName: 'nomic-embed-text:latest', contextWindow: 2048, supportsVision: false, supportsTools: false },
    ]);
  });

  it('derives the native API root from a custom baseUrl ending in /v1', async () => {
    const fetchImpl = vi.fn(async (url: string | URL) => {
      if (String(url) === 'http://my-ollama-box:11434/v1/models') {
        return new Response(JSON.stringify({ data: [{ id: 'qwen2.5vl:7b' }] }), { status: 200 });
      }
      if (String(url) === 'http://my-ollama-box:11434/api/tags') {
        return new Response(JSON.stringify(REALISTIC_TAGS_PAYLOAD), { status: 200 });
      }
      throw new Error(`unexpected fetch: ${String(url)}`);
    });
    const engine = engineWithFetch(fetchImpl as unknown as typeof fetch);

    const models = await engine.listModels(makeConnection({ kind: 'ollama', baseUrl: 'http://my-ollama-box:11434/v1' }), null);

    expect(models[0]).toMatchObject({ supportsVision: true, contextWindow: 128000 });
  });

  it('falls back to the conservative defaults, without throwing, when /api/tags is unreachable', async () => {
    const fetchImpl = vi.fn(async (url: string | URL) => {
      if (String(url) === 'http://127.0.0.1:11434/v1/models') {
        return new Response(JSON.stringify({ data: [{ id: 'qwen2.5vl:7b' }] }), { status: 200 });
      }
      if (String(url) === 'http://127.0.0.1:11434/api/tags') {
        throw new Error('ECONNREFUSED');
      }
      throw new Error(`unexpected fetch: ${String(url)}`);
    });
    const engine = engineWithFetch(fetchImpl as unknown as typeof fetch);

    const models = await engine.listModels(makeConnection({ kind: 'ollama', baseUrl: null }), null);

    expect(models).toEqual([
      { modelId: 'qwen2.5vl:7b', displayName: 'qwen2.5vl:7b', contextWindow: null, supportsVision: null, supportsTools: null },
    ]);
  });

  it('falls back to the conservative defaults when /api/tags returns a non-2xx status', async () => {
    const fetchImpl = vi.fn(async (url: string | URL) => {
      if (String(url) === 'http://127.0.0.1:11434/v1/models') {
        return new Response(JSON.stringify({ data: [{ id: 'qwen2.5vl:7b' }] }), { status: 200 });
      }
      return new Response('not found', { status: 404 });
    });
    const engine = engineWithFetch(fetchImpl as unknown as typeof fetch);

    const models = await engine.listModels(makeConnection({ kind: 'ollama', baseUrl: null }), null);

    expect(models[0]).toMatchObject({ contextWindow: null, supportsVision: null, supportsTools: null });
  });

  it('falls back to the conservative defaults when /api/tags returns unexpected JSON shape', async () => {
    const fetchImpl = vi.fn(async (url: string | URL) => {
      if (String(url) === 'http://127.0.0.1:11434/v1/models') {
        return new Response(JSON.stringify({ data: [{ id: 'qwen2.5vl:7b' }] }), { status: 200 });
      }
      return new Response(JSON.stringify({ unexpected: 'shape' }), { status: 200 });
    });
    const engine = engineWithFetch(fetchImpl as unknown as typeof fetch);

    const models = await engine.listModels(makeConnection({ kind: 'ollama', baseUrl: null }), null);

    expect(models[0]).toMatchObject({ contextWindow: null, supportsVision: null, supportsTools: null });
  });

  // Finding 7 regression: a try/catch alone does not catch a HANG. Against a
  // host that answers /v1/models but never responds on /api/tags, discovery
  // used to stay open indefinitely -- a capability *hint* must not become a
  // hard dependency for the whole call.
  it('does not hang forever when /api/tags never responds -- bounded by the ~3s timeout, falling back to conservative defaults', async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = vi.fn((url: string | URL, init?: RequestInit) => {
        if (String(url) === 'http://127.0.0.1:11434/v1/models') {
          return Promise.resolve(new Response(JSON.stringify({ data: [{ id: 'qwen2.5vl:7b' }] }), { status: 200 }));
        }
        if (String(url) === 'http://127.0.0.1:11434/api/tags') {
          // Never resolves on its own -- rejects only when the signal
          // aborts, exactly like a real fetch would once the timeout fires.
          return new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError')));
          });
        }
        throw new Error(`unexpected fetch: ${String(url)}`);
      });
      const engine = engineWithFetch(fetchImpl as unknown as typeof fetch);

      const resultPromise = engine.listModels(makeConnection({ kind: 'ollama', baseUrl: null }), null);
      await vi.advanceTimersByTimeAsync(3_000);
      const models = await resultPromise;

      expect(models).toEqual([
        { modelId: 'qwen2.5vl:7b', displayName: 'qwen2.5vl:7b', contextWindow: null, supportsVision: null, supportsTools: null },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does NOT query /api/tags for a plain openai_compatible connection (only ollama is special-cased)', async () => {
    const fetchImpl = vi.fn(async (url: string | URL) => {
      expect(String(url)).toBe('https://my-endpoint.example.com/v1/models');
      return new Response(JSON.stringify({ data: [{ id: 'some-model' }] }), { status: 200 });
    });
    const engine = engineWithFetch(fetchImpl as unknown as typeof fetch);

    const models = await engine.listModels(makeConnection({ kind: 'openai_compatible', baseUrl: 'https://my-endpoint.example.com/v1' }), null);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(models).toEqual([{ modelId: 'some-model', displayName: 'some-model', contextWindow: null, supportsVision: null, supportsTools: null }]);
  });
});
