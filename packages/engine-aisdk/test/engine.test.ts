import { describe, it, expect, vi } from 'vitest';
import { APICallError } from '@ai-sdk/provider';
import { MockLanguageModelV3, convertArrayToReadableStream } from 'ai/test';
import type { EngineEvent, EngineRequest } from '@grunt/core/ports/chat-engine.js';
import type { ToolContext, ToolSpec } from '@grunt/core/ports/tool-provider.js';
import type { CanonMessage } from '@grunt/core/types/messages.js';
import type { Connection, ResolvedProfile } from '@grunt/core/types/config.js';
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
    ...over,
  };
}

async function drain(iterable: AsyncIterable<EngineEvent>): Promise<EngineEvent[]> {
  const events: EngineEvent[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

/**
 * `MockLanguageModelV3`'s array-based `doStream` indexes with
 * `array[this.doStreamCalls.length]` *after* pushing the just-received call,
 * so the first `doStream()` invocation reads index 1, not 0 (verified
 * empirically against the installed `ai@6.0.253` -- see
 * task-14-15-report.md). This helper hides that off-by-one so tests can list
 * steps in the natural order.
 */
function stepsForModel(...steps: unknown[][]): { stream: ReadableStream<unknown> }[] {
  return [{ stream: convertArrayToReadableStream([]) }, ...steps.map((chunks) => ({ stream: convertArrayToReadableStream(chunks) }))];
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

  it('testConnection reports ok:true when models list successfully', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ data: [{ id: 'gpt-4o' }] }), { status: 200 }));
    const engine = engineWithFetch(fetchImpl as unknown as typeof fetch);

    const result = await engine.testConnection(makeConnection({ kind: 'openai' }), 'sk-key');

    expect(result.ok).toBe(true);
  });
});
