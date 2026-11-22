import { describe, it, expect, vi } from 'vitest';
import { APICallError, type LanguageModelV3StreamPart, type LanguageModelV3StreamResult } from '@ai-sdk/provider';
import { MockLanguageModelV3, convertArrayToReadableStream } from 'ai/test';
import type { EngineEvent, EngineRequest } from '@otherbench/core/ports/chat-engine.js';
import type { ToolContext, ToolSpec } from '@otherbench/core/ports/tool-provider.js';
import type { CanonMessage } from '@otherbench/core/types/messages.js';
import type { Connection, ResolvedProfile } from '@otherbench/core/types/config.js';
import { createPlanGate } from '@otherbench/core/domain/thread-tools.js';
import { FakeChatEngine } from '@otherbench/core/testing/fakes.js';
import { FAKE_PNG } from '@otherbench/core/testing/fake-computer.js';
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
function stepsForModel(...steps: unknown[][]): LanguageModelV3StreamResult[] {
  return steps.map((chunks) => ({ stream: streamOf(chunks) }));
}

/** The chunks are written loosely (a usage with only `total`, say), as a provider may send them. */
function streamOf(chunks: unknown[]): ReadableStream<LanguageModelV3StreamPart> {
  return convertArrayToReadableStream(chunks) as ReadableStream<LanguageModelV3StreamPart>;
}

function resolverFor(model: MockLanguageModelV3): ProviderResolver {
  return {
    resolve: (): ProviderHandle => ({ kind: 'aisdk', provider: (() => model) as never }),
  };
}

const ZERO_USAGE = { inputTokens: { total: 0 }, outputTokens: { total: 0 } };

/** A `retryWait` that returns at once and keeps the waits it was asked for. */
function recordedWaits(): { wait: (ms: number) => Promise<void>; waits: number[] } {
  const waits: number[] = [];
  return {
    waits,
    wait: async (ms) => {
      waits.push(ms);
    },
  };
}

// ---------------------------------------------------------------------------
// stream()
// ---------------------------------------------------------------------------

describe('AiSdkChatEngine.stream', () => {
  it('maps text-delta chunks through to text-delta EngineEvents, then finish', async () => {
    const model = new MockLanguageModelV3({
      doStream: async () => ({
        stream: streamOf([
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

  it('reports cache reads and writes from the provider usage', async () => {
    const model = new MockLanguageModelV3({
      doStream: stepsForModel([
        { type: 'stream-start', warnings: [] },
        { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage: { inputTokens: { total: 1000, noCache: 100, cacheRead: 600, cacheWrite: 300 }, outputTokens: { total: 5 } } },
      ]),
    });
    const events = await drain(new AiSdkChatEngine(resolverFor(model)).stream(makeRequest()));
    expect(events.at(-1)).toMatchObject({ type: 'finish', usage: { tokensIn: 1000, tokensCached: 600, tokensCacheWrite: 300 } });
  });

  describe('prompt caching', () => {
    const finishOnly = () => stepsForModel([{ type: 'stream-start', warnings: [] }, { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage: ZERO_USAGE }]);
    const withSystem = (): CanonMessage[] => [
      { ...userMessage('You are terse.'), role: 'system' },
      userMessage('hello'),
    ];

    it('asks Anthropic to cache the system prompt and the growing conversation', async () => {
      const model = new MockLanguageModelV3({ doStream: finishOnly() });
      await drain(new AiSdkChatEngine(resolverFor(model)).stream(makeRequest({ messages: withSystem() })));
      const call = model.doStreamCalls[0]!;
      // Top-level automatic caching: the breakpoint follows the newest block, step after step.
      expect(call.providerOptions?.['anthropic']).toMatchObject({ cacheControl: { type: 'ephemeral' } });
      // And a fixed one on the system prompt, which (with the tools before it) is the same every turn.
      const system = call.prompt.find((m) => m.role === 'system');
      expect(system?.providerOptions?.['anthropic']).toMatchObject({ cacheControl: { type: 'ephemeral' } });
    });

    it('leaves other providers alone', async () => {
      const model = new MockLanguageModelV3({ doStream: finishOnly() });
      await drain(new AiSdkChatEngine(resolverFor(model)).stream(makeRequest({ messages: withSystem(), profile: makeResolvedProfile({ connection: makeConnection({ kind: 'openai' }) }) })));
      const call = model.doStreamCalls[0]!;
      expect(call.providerOptions?.['anthropic']).toBeUndefined();
      expect(call.prompt.find((m) => m.role === 'system')?.providerOptions?.['anthropic']).toBeUndefined();
    });
  });

  it('maps reasoning-delta chunks through to reasoning-delta EngineEvents', async () => {
    const model = new MockLanguageModelV3({
      doStream: async () => ({
        stream: streamOf([
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

  it('sends an image a tool returns to a vision model on a provider that takes it as image content, and a note to any other', async () => {
    const png = FAKE_PNG.toString('base64');
    const shot = [
      { type: 'text', text: 'Screenshot, 2×1.' },
      { type: 'image', data: png, mimeType: 'image/png' },
    ];
    const toolSpec: ToolSpec = {
      name: 'look',
      description: 'Looks.',
      parameters: { type: 'object', properties: {} },
      risk: 'read',
      source: 'mcp',
      execute: async () => shot,
    };
    const model = (vision: boolean) => ({
      id: 'model-1', connectionId: 'conn-1', modelId: 'claude-test-model', displayName: 'Test', source: 'manual' as const,
      supportsVision: vision, supportsTools: true, supportsReasoning: false, contextWindow: null, maxOutput: null,
      priceInPer1m: null, priceOutPer1m: null, priceCachedPer1m: null, currency: 'USD',
    });
    const image = { type: 'image-data', data: png, mediaType: 'image/png' };
    const omitted = { type: 'text', text: "[image omitted: this model can't take images]" };
    // An image only where the provider puts it inside the tool result itself (tool-images.ts, `toolImagesSupported`).
    const table: [boolean, Connection['kind'], string, unknown][] = [
      [true, 'anthropic', 'claude-test-model', image],
      [true, 'openai', 'gpt-test-model', image],
      [true, 'google', 'gemini-3-pro', image],
      [true, 'google', 'gemini-2.5-pro', omitted],
      [false, 'anthropic', 'claude-test-model', omitted],
      [false, 'google', 'gemini-3-pro', omitted],
      [true, 'openai_compatible', 'gemini-3-pro', omitted],
      [true, 'ollama', 'llava', omitted],
    ];
    for (const [vision, kind, modelId, expected] of table) {
      const mock = new MockLanguageModelV3({
        doStream: stepsForModel(
          [
            { type: 'stream-start', warnings: [] },
            { type: 'tool-call', toolCallId: 'call-1', toolName: 'look', input: '{}' },
            { type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool_use' }, usage: ZERO_USAGE },
          ],
          [
            { type: 'stream-start', warnings: [] },
            { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage: ZERO_USAGE },
          ]
        ),
      });
      const engine = new AiSdkChatEngine(resolverFor(mock));
      await drain(engine.stream(makeRequest({ tools: [toolSpec], profile: makeResolvedProfile({ modelId, connection: makeConnection({ kind }), model: model(vision) }) })));
      const toolMessage = mock.doStreamCalls[1]!.prompt.find((m) => m.role === 'tool');
      // Content only when the image is sent; otherwise the words and the note are one text.
      const output = expected === image ? { type: 'content', value: [{ type: 'text', text: 'Screenshot, 2\u00d71.' }, image] } : { type: 'text', value: `Screenshot, 2\u00d71.\n${omitted.text}` };
      expect(toolMessage?.content[0], `${kind} ${modelId} vision=${vision}`).toMatchObject({ type: 'tool-result', output });
    }
  });

  it('lets a reply show the model no more tool images than it may store (count and bytes, across tool calls), and stores exactly what the model saw', async () => {
    const png = (size: number) => Buffer.concat([FAKE_PNG, Buffer.alloc(size - FAKE_PNG.length)]).toString('base64');
    const small = png(FAKE_PNG.length);
    const big = png(4 * 1024 * 1024);
    const vision = { id: 'model-1', connectionId: 'conn-1', modelId: 'claude-test-model', displayName: 'Test', source: 'manual' as const, supportsVision: true, supportsTools: true, supportsReasoning: false, contextWindow: null, maxOutput: null, priceInPer1m: null, priceOutPer1m: null, priceCachedPer1m: null, currency: 'USD' };
    // [tool results (one per call), images the model may get]
    const table: [string, unknown[][], number][] = [
      ['60 images in one result', [Array.from({ length: 60 }, () => ({ type: 'image', data: small, mimeType: 'image/png' }))], 50],
      ['8 big images over 8 calls (20 MB together)', Array.from({ length: 8 }, () => [{ type: 'image', data: big, mimeType: 'image/png' }]), 5],
    ];
    for (const [label, perCall, allowed] of table) {
      const specs: ToolSpec[] = perCall.map((result, i) => ({
        name: `tool${i}`,
        description: 'x',
        parameters: { type: 'object', properties: {} },
        risk: 'read',
        source: 'mcp',
        execute: async () => result,
      }));
      const calls = perCall.map((_, i) => ({ type: 'tool-call', toolCallId: `call-${i}`, toolName: `tool${i}`, input: '{}' }));
      const mock = new MockLanguageModelV3({
        doStream: stepsForModel(
          [{ type: 'stream-start', warnings: [] }, ...calls, { type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool_use' }, usage: ZERO_USAGE }],
          [{ type: 'stream-start', warnings: [] }, { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage: ZERO_USAGE }]
        ),
      });
      const events = await drain(new AiSdkChatEngine(resolverFor(mock)).stream(makeRequest({ tools: specs, profile: makeResolvedProfile({ model: vision }) })));

      const seen = mock.doStreamCalls[1]!.prompt.filter((m) => m.role === 'tool').flatMap((m) => m.content as { output: { type: string; value: unknown } }[]);
      // A result left with no image goes as one text: its one item here.
      const modelItems = seen.flatMap((r) => (r.output.type === 'text' ? [{ type: 'text', text: r.output.value as string }] : (r.output.value as { type: string; text?: string }[])));
      const emitted = events.flatMap((e) => (e.type === 'tool-result' ? (e.result as { type: string; text?: string }[]) : []));
      expect(modelItems.filter((v) => v.type === 'image-data'), label).toHaveLength(allowed);
      // What is emitted (and so stored) is the same thing, item by item: an image only where the model got one.
      expect(emitted.map((v) => v.type === 'image'), label).toEqual(modelItems.map((v) => v.type === 'image-data'));
      expect(emitted.filter((v) => v.type === 'text').every((v) => v.text === '[image not kept: too many or too large]'), label).toBe(true);
    }
  });

  it('replays a stored tool image only through the chat-scoped loader, never through loadAttachment', async () => {
    const history: CanonMessage[] = [
      userMessage('look'),
      {
        id: 'msg-assistant', chatId: 'chat-1', parentId: null, role: 'assistant', status: 'complete', error: null, producedBy: null, createdAt: 2,
        parts: [
          { type: 'tool-call', id: 'call-1', name: 'look', args: {} },
          { type: 'tool-result', id: 'call-1', name: 'look', result: [{ type: 'image', attachmentId: 'att-1', mimeType: 'image/png' }], isError: false },
        ],
      },
      userMessage('and now?'),
    ];
    const vision = { id: 'model-1', connectionId: 'conn-1', modelId: 'claude-test-model', displayName: 'Test', source: 'manual' as const, supportsVision: true, supportsTools: true, supportsReasoning: false, contextWindow: null, maxOutput: null, priceInPer1m: null, priceOutPer1m: null, priceCachedPer1m: null, currency: 'USD' };
    const run = async (extra: Partial<EngineRequest>): Promise<unknown> => {
      const mock = new MockLanguageModelV3({ doStream: stepsForModel([{ type: 'stream-start', warnings: [] }, { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage: ZERO_USAGE }]) });
      await drain(new AiSdkChatEngine(resolverFor(mock)).stream(makeRequest({ messages: history, profile: makeResolvedProfile({ model: vision }), ...extra })));
      return mock.doStreamCalls[0]!.prompt.find((m) => m.role === 'tool')?.content[0];
    };

    const loadToolImage = vi.fn(async () => FAKE_PNG);
    const loadAttachment = vi.fn(async () => FAKE_PNG);
    expect(await run({ loadToolImage, loadAttachment })).toMatchObject({ output: { type: 'content', value: [{ type: 'image-data', data: FAKE_PNG.toString('base64'), mediaType: 'image/png' }] } });
    expect(loadToolImage).toHaveBeenCalledTimes(1);
    expect(loadToolImage).toHaveBeenCalledWith({ chatId: 'chat-1', messageId: 'msg-assistant', attachmentId: 'att-1' });

    // No scoped loader: a note, and the raw loader is not used as a fallback.
    expect(await run({ loadAttachment })).toMatchObject({ output: { type: 'text', value: '[image not available]' } });
    expect(loadAttachment).not.toHaveBeenCalled();
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
    const { wait, waits } = recordedWaits();
    const engine = new AiSdkChatEngine(resolverFor(model), { retryWait: wait });

    const events = await drain(engine.stream(makeRequest()));

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'error',
      error: { kind: 'rate_limit', retryable: true },
    });
    // Tried again three times, a little longer each time, before giving up.
    expect(model.doStreamCalls).toHaveLength(4);
    expect(waits).toEqual([1000, 2000, 4000]);
  });

  describe('trying again after a busy or failed provider', () => {
    const HELLO = [
      { type: 'stream-start', warnings: [] },
      { type: 'text-start', id: 't1' },
      { type: 'text-delta', id: 't1', delta: 'Hello' },
      { type: 'text-end', id: 't1' },
      { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage: ZERO_USAGE },
    ];

    function apiError(statusCode: number, responseHeaders?: Record<string, string>, message = 'Provider said no'): APICallError {
      return new APICallError({
        message,
        url: 'https://api.example.com/v1/messages',
        requestBodyValues: {},
        statusCode,
        isRetryable: statusCode === 429 || statusCode >= 500,
        ...(responseHeaders ? { responseHeaders } : {}),
      });
    }

    /** A model whose first `failures.length` calls throw, and whose later calls answer "Hello". */
    function failingThenHello(...failures: unknown[]): MockLanguageModelV3 {
      let call = 0;
      return new MockLanguageModelV3({
        doStream: async () => {
          const failure = failures[call++];
          if (failure !== undefined) throw failure;
          return { stream: streamOf(HELLO) };
        },
      });
    }

    it.each([
      ['a 429', apiError(429)],
      ['a 529 overloaded', apiError(529, undefined, 'Overloaded')],
      ['a 503', apiError(503)],
      ['a dropped connection', Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } })],
    ])('%s before anything was shown is tried again, and the reply carries no error', async (_name, failure) => {
      const model = failingThenHello(failure);
      const { wait, waits } = recordedWaits();

      const events = await drain(new AiSdkChatEngine(resolverFor(model), { retryWait: wait }).stream(makeRequest()));

      expect(events.map((e) => e.type)).toEqual(['text-delta', 'finish']);
      expect(model.doStreamCalls).toHaveLength(2);
      expect(waits).toEqual([1000]);
    });

    it.each([
      ['retry-after in seconds', { 'retry-after': '3' }, 3000],
      ['retry-after-ms', { 'retry-after-ms': '1500' }, 1500],
      ['a retry-after shorter than the usual wait', { 'retry-after': '0' }, 1000],
    ])('waits as long as the provider asks: %s', async (_name, headers, expected) => {
      const model = failingThenHello(apiError(429, headers));
      const { wait, waits } = recordedWaits();

      await drain(new AiSdkChatEngine(resolverFor(model), { retryWait: wait }).stream(makeRequest()));

      expect(waits).toEqual([expected]);
    });

    it('gives up at once when the provider asks for a longer wait than the cap', async () => {
      const model = failingThenHello(apiError(429, { 'retry-after': '600' }));
      const { wait, waits } = recordedWaits();

      const events = await drain(new AiSdkChatEngine(resolverFor(model), { retryWait: wait }).stream(makeRequest()));

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ type: 'error', error: { kind: 'rate_limit' } });
      expect(model.doStreamCalls).toHaveLength(1);
      expect(waits).toEqual([]);
    });

    it.each([
      ['a 400', apiError(400)],
      ['a 401', apiError(401)],
    ])('%s is not tried again', async (_name, failure) => {
      const model = failingThenHello(failure);
      const { wait, waits } = recordedWaits();

      const events = await drain(new AiSdkChatEngine(resolverFor(model), { retryWait: wait }).stream(makeRequest()));

      expect(events).toHaveLength(1);
      expect(events[0]?.type).toBe('error');
      expect(model.doStreamCalls).toHaveLength(1);
      expect(waits).toEqual([]);
    });

    it('does not try again once text has been shown', async () => {
      const model = new MockLanguageModelV3({
        doStream: stepsForModel(
          [
            { type: 'stream-start', warnings: [] },
            { type: 'text-start', id: 't1' },
            { type: 'text-delta', id: 't1', delta: 'Half an ans' },
            { type: 'error', error: apiError(529, undefined, 'Overloaded') },
          ],
          HELLO
        ),
      });
      const { wait, waits } = recordedWaits();

      const events = await drain(new AiSdkChatEngine(resolverFor(model), { retryWait: wait }).stream(makeRequest()));

      expect(events.some((e) => e.type === 'error')).toBe(true);
      expect(events.filter((e) => e.type === 'text-delta')).toHaveLength(1);
      expect(model.doStreamCalls).toHaveLength(1);
      expect(waits).toEqual([]);
    });

    it('does not try again once a tool has run, so the tool never runs twice', async () => {
      const toolExecute = vi.fn(async () => 'written');
      const toolSpec: ToolSpec = {
        name: 'write_thing',
        description: 'Writes a thing.',
        parameters: { type: 'object', properties: {} },
        risk: 'mutate',
        source: 'mcp',
        execute: toolExecute,
      };
      let call = 0;
      const model = new MockLanguageModelV3({
        doStream: async () => {
          call += 1;
          // The request after the tool ran is the one that fails.
          if (call === 2) throw apiError(503);
          return {
            stream: streamOf([
              { type: 'stream-start', warnings: [] },
              { type: 'tool-call', toolCallId: `call-${call}`, toolName: 'write_thing', input: '{}' },
              { type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool_calls' }, usage: ZERO_USAGE },
            ]),
          };
        },
      });
      const { wait, waits } = recordedWaits();

      const events = await drain(new AiSdkChatEngine(resolverFor(model), { retryWait: wait }).stream(makeRequest({ tools: [toolSpec] })));

      expect(events.some((e) => e.type === 'error')).toBe(true);
      expect(toolExecute).toHaveBeenCalledTimes(1);
      expect(model.doStreamCalls).toHaveLength(2);
      expect(waits).toEqual([]);
    });

    it('stops waiting, and sends nothing more, when the reply is stopped during the wait', async () => {
      const controller = new AbortController();
      const model = failingThenHello(apiError(429));
      const wait = vi.fn(async () => {
        controller.abort();
      });

      const events = await drain(new AiSdkChatEngine(resolverFor(model), { retryWait: wait }).stream(makeRequest({ signal: controller.signal })));

      expect(events).toEqual([]);
      expect(wait).toHaveBeenCalledTimes(1);
      expect(model.doStreamCalls).toHaveLength(1);
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
    const engine = engineWithFetch(fetchImpl);

    const models = await engine.listModels(makeConnection({ kind: 'google' }), 'goog-key');

    expect(models).toEqual([
      { modelId: 'gemini-2.0-flash', displayName: 'Gemini 2.0 Flash', contextWindow: 1_000_000, supportsVision: null, supportsTools: null },
    ]);
  });

  it('rejects with a classifiable error when the provider returns 401', async () => {
    const fetchImpl = vi.fn(async () => new Response('{"error":"invalid key"}', { status: 401 }));
    const engine = engineWithFetch(fetchImpl);

    await expect(engine.listModels(makeConnection({ kind: 'openai' }), 'bad-key')).rejects.toThrow();
  });

  it('testConnection reports ok:false with the classified message on failure', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 401 }));
    const engine = engineWithFetch(fetchImpl);

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
    const engine = engineWithFetch(fetchImpl);

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

describe('AiSdkChatEngine.listModels -- LM Studio capability seeding', () => {
  function engineWithFetch(fetchImpl: typeof fetch) {
    const resolver: ProviderResolver = { resolve: () => ({ kind: 'aisdk', provider: (() => null) as never }) };
    return new AiSdkChatEngine(resolver, { fetchImpl });
  }

  /** LM Studio 0.4+'s native `GET /api/v1/models`. */
  const V1_PAYLOAD = {
    models: [
      {
        type: 'llm',
        publisher: 'qwen',
        key: 'qwen/qwen3.6-27b',
        display_name: 'Qwen3.6 27B',
        max_context_length: 262144,
        capabilities: { vision: true, trained_for_tool_use: true },
      },
      {
        type: 'llm',
        publisher: 'google',
        key: 'google/gemma-4-12b',
        display_name: 'Gemma 4 12B',
        max_context_length: 131072,
        capabilities: { vision: false, trained_for_tool_use: false },
      },
      { type: 'embedding', key: 'text-embedding-nomic-embed-text-v1.5', display_name: 'Nomic Embed', max_context_length: 2048 },
    ],
  };
  const OPENAI_LISTING = { data: [{ id: 'qwen/qwen3.6-27b' }, { id: 'google/gemma-4-12b' }, { id: 'text-embedding-nomic-embed-text-v1.5' }] };

  function lmStudioFetch(routes: Record<string, () => Response | Promise<Response>>) {
    return vi.fn(async (url: string | URL) => {
      const route = routes[String(url)];
      if (!route) return new Response('not found', { status: 404 });
      return route();
    });
  }

  it('reads capabilities, context and names from /api/v1/models, defaulting to port 1234, and drops embedding models', async () => {
    const fetchImpl = lmStudioFetch({
      'http://127.0.0.1:1234/v1/models': () => new Response(JSON.stringify(OPENAI_LISTING)),
      'http://127.0.0.1:1234/api/v1/models': () => new Response(JSON.stringify(V1_PAYLOAD)),
    });
    const engine = engineWithFetch(fetchImpl as unknown as typeof fetch);

    const models = await engine.listModels(makeConnection({ kind: 'lmstudio', baseUrl: null }), null);

    expect(models).toEqual([
      { modelId: 'qwen/qwen3.6-27b', displayName: 'Qwen3.6 27B', contextWindow: 262144, supportsVision: true, supportsTools: true },
      { modelId: 'google/gemma-4-12b', displayName: 'Gemma 4 12B', contextWindow: 131072, supportsVision: false, supportsTools: false },
    ]);
  });

  it('falls back to /api/v0/models on an older LM Studio: vlm means vision, tool_use in the list means tools', async () => {
    const fetchImpl = lmStudioFetch({
      'http://127.0.0.1:1234/v1/models': () => new Response(JSON.stringify({ data: [{ id: 'qwen2-vl-7b-instruct' }, { id: 'llama-3.1-8b' }, { id: 'old-model' }, { id: 'nomic-embed' }] })),
      'http://127.0.0.1:1234/api/v0/models': () =>
        new Response(
          JSON.stringify({
            data: [
              { id: 'qwen2-vl-7b-instruct', type: 'vlm', max_context_length: 32768, capabilities: [] },
              { id: 'llama-3.1-8b', type: 'llm', max_context_length: 131072, capabilities: ['tool_use'] },
              // Releases before capabilities were reported: tools is unknown, not "no".
              { id: 'old-model', type: 'llm', max_context_length: 4096 },
              { id: 'nomic-embed', type: 'embeddings', max_context_length: 2048 },
            ],
          })
        ),
    });
    const engine = engineWithFetch(fetchImpl as unknown as typeof fetch);

    const models = await engine.listModels(makeConnection({ kind: 'lmstudio', baseUrl: null }), null);

    expect(models).toEqual([
      { modelId: 'qwen2-vl-7b-instruct', displayName: 'qwen2-vl-7b-instruct', contextWindow: 32768, supportsVision: true, supportsTools: false },
      { modelId: 'llama-3.1-8b', displayName: 'llama-3.1-8b', contextWindow: 131072, supportsVision: false, supportsTools: true },
      { modelId: 'old-model', displayName: 'old-model', contextWindow: 4096, supportsVision: false, supportsTools: null },
    ]);
  });

  it('accepts a base URL without /v1 (another machine on the network) and finds both APIs from it', async () => {
    const fetchImpl = lmStudioFetch({
      'http://192.168.1.20:1234/v1/models': () => new Response(JSON.stringify({ data: [{ id: 'qwen/qwen3.6-27b' }] })),
      'http://192.168.1.20:1234/api/v1/models': () => new Response(JSON.stringify(V1_PAYLOAD)),
    });
    const engine = engineWithFetch(fetchImpl as unknown as typeof fetch);

    const models = await engine.listModels(makeConnection({ kind: 'lmstudio', baseUrl: 'http://192.168.1.20:1234/' }), null);

    expect(models).toEqual([{ modelId: 'qwen/qwen3.6-27b', displayName: 'Qwen3.6 27B', contextWindow: 262144, supportsVision: true, supportsTools: true }]);
  });

  it('keeps the bare listing, unknown capabilities and all, when neither native API answers', async () => {
    const fetchImpl = lmStudioFetch({
      'http://127.0.0.1:1234/v1/models': () => new Response(JSON.stringify({ data: [{ id: 'some-model' }] })),
      'http://127.0.0.1:1234/api/v1/models': () => {
        throw new Error('ECONNRESET');
      },
    });
    const engine = engineWithFetch(fetchImpl as unknown as typeof fetch);

    const models = await engine.listModels(makeConnection({ kind: 'lmstudio', baseUrl: null }), null);

    expect(models).toEqual([{ modelId: 'some-model', displayName: 'some-model', contextWindow: null, supportsVision: null, supportsTools: null }]);
  });

  it('sends the API key to the native API too, for an LM Studio with auth turned on', async () => {
    const fetchImpl = lmStudioFetch({
      'http://127.0.0.1:1234/v1/models': () => new Response(JSON.stringify({ data: [{ id: 'qwen/qwen3.6-27b' }] })),
      'http://127.0.0.1:1234/api/v1/models': () => new Response(JSON.stringify(V1_PAYLOAD)),
    });
    const engine = engineWithFetch(fetchImpl as unknown as typeof fetch);

    await engine.listModels(makeConnection({ kind: 'lmstudio', baseUrl: null }), 'lm-token');

    for (const call of fetchImpl.mock.calls as unknown as [string, RequestInit][]) {
      expect((call[1].headers as Record<string, string>)['Authorization']).toBe('Bearer lm-token');
    }
  });
});
