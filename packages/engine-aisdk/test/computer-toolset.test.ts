import { describe, expect, it, vi } from 'vitest';
import { createAnthropic } from '@ai-sdk/anthropic';
import { MockLanguageModelV3, convertArrayToReadableStream } from 'ai/test';
import type { EngineEvent, EngineRequest } from '@grunt/core/ports/chat-engine.js';
import type { ToolContext, ToolSpec } from '@grunt/core/ports/tool-provider.js';
import type { ConnectionKind, ResolvedProfile } from '@grunt/core/types/config.js';
import { COMPUTER_ACTIONS } from '@grunt/core/domain/computer-apps.js';
import { IMAGE_NOT_KEPT_LIMIT, MAX_TOOL_IMAGE_BYTES, TOOL_IMAGE_REF_REMOVED } from '@grunt/core/domain/tool-images.js';
import { AiSdkChatEngine, COMPUTER_TOOLSET_CONFIGS, COMPUTER_TOOLSET_MODELS, usesComputerToolset } from '../src/engine.js';
import type { ProviderHandle } from '../src/registry.js';
import { IMAGE_OMITTED_NOTE } from '../src/tool-images.js';

/**
 * The offline probe (spec 2026-10-12-computer-use-design section 5, "Task 1"):
 * a fake `fetch` under a real `createAnthropic`, fed canned streams with member
 * `tool_use` blocks carrying `toolset_name: 'computer'`. Nothing here reaches
 * the network: every request is answered by the fake, and the base URL points
 * at this machine in case one ever were not.
 */

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const SHOT_TEXT = 'Screenshot, 1\u00d71.';

function sse(events: Record<string, unknown>[]): string {
  return events.map((e) => `event: ${String(e['type'])}\ndata: ${JSON.stringify(e)}\n\n`).join('');
}

const start = (id: string) => ({
  type: 'message_start',
  message: {
    id,
    type: 'message',
    role: 'assistant',
    model: 'claude-opus-5-5',
    content: [],
    stop_reason: null,
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
  },
});

interface Call {
  id: string;
  name: string;
  input?: Record<string, unknown>;
  /** A plain function tool's call: no `toolset_name`. */
  plain?: true;
}

/** One assistant turn that asks for the given tool calls. A member of the toolset carries `toolset_name: 'computer'`. */
function turnOf(messageId: string, calls: Call[]): string {
  const blocks = calls.flatMap((call, index) => [
    { type: 'content_block_start', index, content_block: { type: 'tool_use', id: call.id, name: call.name, input: {}, ...(call.plain ? {} : { toolset_name: 'computer' }) } },
    ...(call.input ? [{ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(call.input) } }] : []),
    { type: 'content_block_stop', index },
  ]);
  return sse([start(messageId), ...blocks, { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 20 } }, { type: 'message_stop' }]);
}

const MEMBER_CALLS = turnOf('msg_1', [
  { id: 'toolu_1', name: 'screenshot' },
  { id: 'toolu_2', name: 'left_click', input: { coordinate: [10, 20] } },
]);

const ANSWER = sse([
  start('msg_2'),
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Done.' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 2 } },
  { type: 'message_stop' },
]);

function fakeAnthropic(...replies: string[]) {
  const bodies: Record<string, unknown>[] = [];
  const urls: string[] = [];
  const fetch = vi.fn(async (url: unknown, init?: RequestInit) => {
    urls.push(String(url));
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    const body = replies[bodies.length - 1] ?? replies[replies.length - 1]!;
    return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  });
  const provider = createAnthropic({ apiKey: 'test-key', baseURL: 'http://127.0.0.1:9/v1', fetch: fetch as unknown as typeof globalThis.fetch });
  return { provider, bodies, urls, fetch };
}

/** The parameters Grunt's own `computer` tool declares (packages/tools/src/computer-tool.ts). */
const COMPUTER_PARAMETERS = {
  type: 'object',
  properties: {
    action: { type: 'string', enum: [...COMPUTER_ACTIONS] },
    coordinate: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2 },
    text: { type: 'string' },
    scroll_direction: { type: 'string', enum: ['up', 'down', 'left', 'right'] },
    scroll_amount: { type: 'integer', minimum: 1, maximum: 10 },
    duration: { type: 'number', minimum: 0, maximum: 10 },
  },
  required: ['action'],
};

const SHOT = [{ type: 'text', text: SHOT_TEXT }, { type: 'image', data: PNG, mimeType: 'image/png' }];

/** Stands in for the gated `computer` spec the tool provider hands the engine: `execute` is where the broker decides. */
function computerSpec(seen: unknown[], answer: (args: { action: string }, ctx: ToolContext) => unknown = (args) => (args.action === 'screenshot' ? SHOT : [{ type: 'text', text: 'Done.' }])): ToolSpec {
  return {
    name: 'computer',
    description: 'Use the computer.',
    parameters: COMPUTER_PARAMETERS,
    risk: 'mutate',
    source: 'computer',
    execute: async (args, ctx) => {
      seen.push(args);
      return answer(args as { action: string }, ctx);
    },
  };
}

function plainSpec(name: string, result: unknown): ToolSpec {
  return { name, description: 'x', parameters: { type: 'object', properties: {} }, risk: 'read', source: 'mcp', execute: async () => result };
}

function request(modelId: string, tools: ToolSpec[], over: { kind?: ConnectionKind; vision?: boolean; signal?: AbortSignal } = {}): EngineRequest {
  const profile: ResolvedProfile = {
    id: 'profile-1', name: 'Claude', description: null, colour: null, connectionId: 'conn-1', modelId, systemPrompt: null, params: {},
    toolPolicy: { fs: 'off', shell: false, mcpServerIds: [], approvalMode: 'always_ask', computer: true }, isDefault: false, archivedAt: null,
    connection: { id: 'conn-1', name: 'Anthropic', kind: over.kind ?? 'anthropic', baseUrl: null, secretRef: null, extraHeaders: {}, status: 'ok', statusMessage: null, checkedAt: null },
    apiKey: 'test-key',
    model: {
      id: 'm1', connectionId: 'conn-1', modelId, displayName: modelId, source: 'manual', supportsVision: over.vision ?? true, supportsTools: true, supportsReasoning: false,
      contextWindow: null, maxOutput: null, priceInPer1m: null, priceOutPer1m: null, priceCachedPer1m: null, currency: 'USD',
    },
  };
  return {
    profile,
    messages: [{ id: 'u1', chatId: 'chat-1', parentId: null, role: 'user', parts: [{ type: 'text', text: 'click it' }], status: 'complete', error: null, producedBy: null, createdAt: 0 }],
    tools,
    signal: over.signal ?? new AbortController().signal,
    chatId: 'chat-1',
    messageId: 'msg-1',
    workspaceRoot: null,
  };
}

async function drain(iterable: AsyncIterable<EngineEvent>): Promise<EngineEvent[]> {
  const events: EngineEvent[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

type Block = Record<string, unknown>;

/** The `tool_result` blocks of the last message of an outgoing request. */
function resultsIn(body: Record<string, unknown>): Block[] {
  const messages = body['messages'] as { role: string; content: Block[] }[];
  return messages[messages.length - 1]!.content.filter((b) => b['type'] === 'tool_result');
}

const resultEvents = (events: EngineEvent[]): Extract<EngineEvent, { type: 'tool-result' }>[] => events.filter((e): e is Extract<EngineEvent, { type: 'tool-result' }> => e.type === 'tool-result');

/** What a `tool_result` block holds. A result with no image in it goes out as JSON text (the SDK's own form for it). */
function contentOf(block: Block): unknown {
  const content = block['content'];
  return typeof content === 'string' ? (JSON.parse(content) as unknown) : content;
}

/** A tool result as it was emitted, in the shape the model gets it in a `tool_result`: so the two can be compared whole. */
function asSent(result: unknown): unknown {
  const items = result as { type: string; text?: string; data?: string; mimeType?: string }[];
  if (!items.some((item) => item.type === 'image')) return items;
  return items.map((item) => (item.type === 'image' ? { type: 'image', source: { type: 'base64', media_type: item.mimeType, data: item.data } } : { type: 'text', text: item.text }));
}

const engineFor = (provider: unknown): AiSdkChatEngine => new AiSdkChatEngine({ resolve: (): ProviderHandle => ({ kind: 'aisdk', provider: provider as never }) });

describe("Anthropic's computer toolset", () => {
  it('runs member calls through the computer spec and echoes toolset_name in the results', async () => {
    const { provider, bodies, urls } = fakeAnthropic(MEMBER_CALLS, ANSWER);
    const seen: unknown[] = [];

    const events = await drain(engineFor(provider).stream(request('claude-opus-5-5', [computerSpec(seen)])));

    expect(events.filter((e) => e.type === 'error')).toEqual([]);
    expect(urls).toEqual(['http://127.0.0.1:9/v1/messages', 'http://127.0.0.1:9/v1/messages']);
    expect(seen).toEqual([{ action: 'screenshot' }, { action: 'left_click', coordinate: [10, 20] }]);
    expect(bodies[0]!['tools']).toEqual([{ type: 'computer_toolset_20260801', configs: COMPUTER_TOOLSET_CONFIGS }]);

    const messages = bodies[1]!['messages'] as { role: string; content: Block[] }[];
    const assistant = messages.find((m) => m.role === 'assistant')!;
    expect(assistant.content.filter((b) => b['type'] === 'tool_use').map((b) => [b['name'], b['toolset_name'], b['input']])).toEqual([
      ['screenshot', 'computer', {}],
      ['left_click', 'computer', { coordinate: [10, 20] }],
    ]);
    const results = resultsIn(bodies[1]!);
    expect(results.map((b) => b['toolset_name'])).toEqual(['computer', 'computer']);
    expect(results.map((b) => b['tool_use_id'])).toEqual(['toolu_1', 'toolu_2']);
    expect(results[0]!['content']).toEqual([
      { type: 'text', text: SHOT_TEXT },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } },
    ]);
    // The toolset is still among the second request's tools: that is what makes the SDK write the names back.
    expect(bodies[1]!['tools']).toEqual(bodies[0]!['tools']);

    // The transcript has one name for the tool, whichever way the model was given it.
    expect(events.filter((e) => e.type === 'tool-call')).toEqual([
      { type: 'tool-call', id: 'toolu_1', name: 'computer', args: { action: 'screenshot' } },
      { type: 'tool-call', id: 'toolu_2', name: 'computer', args: { action: 'left_click', coordinate: [10, 20] } },
    ]);
    expect(resultEvents(events).map((e) => [e.id, e.name, e.isError])).toEqual([
      ['toolu_1', 'computer', false],
      ['toolu_2', 'computer', false],
    ]);
  });

  it('gives every other model the plain JSON tool', async () => {
    const { provider, bodies } = fakeAnthropic(ANSWER);
    await drain(engineFor(provider).stream(request('claude-sonnet-4-5', [computerSpec([])])));
    const tools = bodies[0]!['tools'] as Block[];
    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({ name: 'computer', input_schema: expect.any(Object) });
    expect(tools[0]!['type']).not.toBe('computer_toolset_20260801');
  });

  it('sends one way to act: with the toolset there is no second, separate tool named computer', async () => {
    const { provider, bodies } = fakeAnthropic(ANSWER);
    await drain(engineFor(provider).stream(request('claude-opus-5-5', [plainSpec('look', 'ok'), computerSpec([])])));
    const tools = bodies[0]!['tools'] as Block[];
    expect(tools.map((t) => t['type'] ?? t['name'])).toEqual(['look', 'computer_toolset_20260801']);
    expect(tools.filter((t) => t['name'] === 'computer')).toEqual([]);
  });

  it('offers no toolset when the request has no computer tool, even to a model that takes it', async () => {
    for (const tools of [[plainSpec('look', 'ok')], []]) {
      const { provider, bodies } = fakeAnthropic(ANSWER);
      await drain(engineFor(provider).stream(request('claude-opus-5-5', tools)));
      expect(JSON.stringify(bodies[0])).not.toContain('computer_toolset');
      expect(((bodies[0]!['tools'] as Block[] | undefined) ?? []).map((t) => t['name'])).toEqual(tools.map((t) => t.name));
    }
    // A tool that only shares the name, or only the source, is not Grunt's computer tool either.
    const lookalikes: ToolSpec[] = [{ ...plainSpec('computer', 'ok') }, { ...computerSpec([]), name: 'computer_2' }];
    for (const spec of lookalikes) {
      const { provider, bodies } = fakeAnthropic(ANSWER);
      await drain(engineFor(provider).stream(request('claude-opus-5-5', [spec])));
      expect(JSON.stringify(bodies[0])).not.toContain('computer_toolset');
      expect((bodies[0]!['tools'] as Block[]).map((t) => t['name'])).toEqual([spec.name]);
    }
  });

  it('keeps the plain tool on a connection that is not Anthropic, and for a provider that has no toolset', async () => {
    // The same provider object, but the connection says OpenAI: the kind decides, not the object.
    const { provider, bodies } = fakeAnthropic(ANSWER);
    await drain(engineFor(provider).stream(request('claude-opus-5-5', [computerSpec([])], { kind: 'openai' })));
    expect((bodies[0]!['tools'] as Block[]).map((t) => [t['name'], t['type']])).toEqual([['computer', undefined]]);

    // An Anthropic connection whose provider object has no `tools.computerToolset_20260801`.
    const mock = new MockLanguageModelV3({
      doStream: async () => ({ stream: convertArrayToReadableStream([{ type: 'stream-start', warnings: [] }, { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage: { inputTokens: { total: 0 }, outputTokens: { total: 0 } } }]) as never }),
    });
    await drain(engineFor(() => mock).stream(request('claude-opus-5-5', [computerSpec([])])));
    expect(mock.doStreamCalls[0]!.tools).toMatchObject([{ type: 'function', name: 'computer' }]);
  });

  it('matches the toolset models exactly or as a dated snapshot, on Anthropic connections only', () => {
    expect([...COMPUTER_TOOLSET_MODELS]).toEqual(['claude-opus-5-5', 'claude-opus-5', 'claude-opus-4-8', 'claude-sonnet-5-5', 'claude-sonnet-5', 'claude-fable-5', 'claude-fable-5-1', 'claude-haiku-5-5']);
    for (const id of [...COMPUTER_TOOLSET_MODELS, 'claude-opus-5-5-20261001', 'claude-fable-5-20260801']) {
      expect(usesComputerToolset('anthropic', id), id).toBe(true);
    }
    for (const id of ['claude-sonnet-4-5', 'claude-opus-4-1', 'claude-haiku-4-5']) expect(usesComputerToolset('anthropic', id), id).toBe(false);
    // Not a bare prefix or a substring: a model Grunt does not know keeps the plain tool.
    for (const id of ['claude-opus-5-9', 'claude-opus-50', 'claude-opus-5-5x', 'claude-opus-5-5-', 'claude-opus-5-5-2026', 'claude-opus-5-5-202610011', 'claude-opus-5-5-latest', 'xclaude-opus-5-5', 'my-claude-opus-5-5', 'CLAUDE-OPUS-5-5', ' claude-opus-5-5', 'claude-opus-5-5\n', '']) {
      expect(usesComputerToolset('anthropic', id), JSON.stringify(id)).toBe(false);
    }
    for (const kind of ['openai', 'google', 'openai_compatible', 'ollama', 'claude_code', 'mock'] as ConnectionKind[]) expect(usesComputerToolset(kind, 'claude-opus-5-5'), kind).toBe(false);
  });

  it('turns off every member that is not a phase-1 action, and no other', () => {
    const members = ['screenshot', 'zoom', 'left_click', 'right_click', 'middle_click', 'double_click', 'triple_click', 'left_click_drag', 'mouse_move', 'left_mouse_down', 'left_mouse_up', 'cursor_position', 'scroll', 'type', 'key', 'hold_key', 'wait'];
    const off = members.filter((m) => !(COMPUTER_ACTIONS as readonly string[]).includes(m));
    expect(Object.keys(COMPUTER_TOOLSET_CONFIGS).sort()).toEqual([...off].sort());
    for (const config of Object.values(COMPUTER_TOOLSET_CONFIGS)) expect(config).toEqual({ enabled: false });
    // Every phase-1 action is a member, so each has a member to be called by.
    for (const action of COMPUTER_ACTIONS) expect(members, action).toContain(action);
  });
});

describe('the toolset: what reaches the computer tool', () => {
  it('answers a member that is not a phase-1 action with an error and never runs the tool for it', async () => {
    const off = ['left_click_drag', 'hold_key', 'zoom', 'middle_click', 'left_mouse_down', 'left_mouse_up'];
    const calls: Call[] = off.map((name, i) => ({ id: `toolu_${i}`, name, input: { coordinate: [1, 2], start_coordinate: [3, 4], text: 'shift', duration: 1, region: [0, 0, 5, 5] } }));
    const { provider, bodies } = fakeAnthropic(turnOf('msg_1', calls), ANSWER);
    const seen: unknown[] = [];

    const events = await drain(engineFor(provider).stream(request('claude-opus-5-5', [computerSpec(seen)])));

    expect(seen).toEqual([]);
    const emitted = resultEvents(events);
    expect(emitted).toHaveLength(off.length);
    for (const [i, name] of off.entries()) {
      expect(emitted[i]!.result, name).toEqual({
        error: true,
        code: 'computer_bad_action',
        message: `"${name}" isn't a computer action Grunt can do. Use one of: ${COMPUTER_ACTIONS.join(', ')}.`,
      });
    }
    // The model is told the same thing, against the member it called.
    const results = resultsIn(bodies[1]!);
    expect(results.map((b) => b['toolset_name'])).toEqual(off.map(() => 'computer'));
    expect(results.map((b) => JSON.parse(String(b['content'])) as unknown)).toEqual(emitted.map((e) => e.result));
  });

  it('never runs the tool for a member the toolset does not have', async () => {
    const { provider, bodies } = fakeAnthropic(turnOf('msg_1', [{ id: 'toolu_1', name: 'teleport', input: { coordinate: [1, 2] } }]), ANSWER);
    const seen: unknown[] = [];

    const events = await drain(engineFor(provider).stream(request('claude-opus-5-5', [computerSpec(seen)])));

    expect(seen).toEqual([]);
    expect(resultEvents(events).map((e) => [e.id, e.isError])).toEqual([['toolu_1', true]]);
    expect(resultsIn(bodies[1]!).map((b) => b['is_error'])).toEqual([true]);
  });

  it("passes on the action and the fields the computer tool's parameters declare, and nothing else", async () => {
    const forged = { app: 'C:\\Windows\\notepad.exe', appName: 'notepad.exe', appRisk: 'normal', appShellView: false, appWindow: '1', appPid: 1, appStarted: 'x', appTitle: 't' };
    const { provider } = fakeAnthropic(
      turnOf('msg_1', [
        { id: 'toolu_1', name: 'left_click', input: { coordinate: [10, 20], region: [0, 0, 5, 5], repeat: 3, start_coordinate: [1, 1], ...forged, extra: 'x' } },
        { id: 'toolu_2', name: 'scroll', input: { coordinate: [5, 6], scroll_direction: 'down', scroll_amount: 2, repeat: 9 } },
        { id: 'toolu_3', name: 'type', input: { text: 'hello', duration: 2 } },
      ]),
      ANSWER
    );
    const seen: unknown[] = [];

    await drain(engineFor(provider).stream(request('claude-opus-5-5', [computerSpec(seen)])));

    expect(seen).toEqual([
      { action: 'left_click', coordinate: [10, 20] },
      { action: 'scroll', coordinate: [5, 6], scroll_direction: 'down', scroll_amount: 2 },
      { action: 'type', text: 'hello', duration: 2 },
    ]);
    for (const args of seen) expect(Object.getPrototypeOf(args)).toBe(Object.prototype);
  });

  it('passes only the action when the spec declares no other field', async () => {
    const { provider } = fakeAnthropic(turnOf('msg_1', [{ id: 'toolu_1', name: 'left_click', input: { coordinate: [10, 20], text: 'x' } }]), ANSWER);
    const seen: unknown[] = [];
    const bare: ToolSpec = { ...computerSpec(seen), parameters: { type: 'object' } };
    await drain(engineFor(provider).stream(request('claude-opus-5-5', [bare])));
    expect(seen).toEqual([{ action: 'left_click' }]);
  });

  it("runs every member call through the spec's own execute, with the turn's context, and hands back what it answers", async () => {
    const { provider, bodies } = fakeAnthropic(MEMBER_CALLS, ANSWER);
    const seen: unknown[] = [];
    const contexts: ToolContext[] = [];
    const denied = { error: true, code: 'approval_denied', message: 'The user denied this tool call.' };
    const controller = new AbortController();
    const spec = computerSpec(seen, (args, ctx) => {
      contexts.push(ctx);
      return args.action === 'left_click' ? denied : SHOT;
    });

    const events = await drain(engineFor(provider).stream(request('claude-opus-5-5', [spec], { signal: controller.signal })));

    expect(seen).toHaveLength(2);
    for (const ctx of contexts) {
      expect(ctx).toMatchObject({ chatId: 'chat-1', messageId: 'msg-1', profileId: 'profile-1', workspaceRoot: null });
      expect(ctx.signal).toBeInstanceOf(AbortSignal);
      expect(ctx.signal.aborted).toBe(false);
    }
    // What the gate answered (a denial here) is the result, for the transcript and for the model.
    expect(resultEvents(events)[1]!.result).toEqual(denied);
    expect(JSON.parse(String(resultsIn(bodies[1]!)[1]!['content']))).toEqual(denied);
  });
});

describe('the toolset: screenshots are screened like any tool image', () => {
  const pngOf = (size: number): string => Buffer.concat([Buffer.from(PNG, 'base64'), Buffer.alloc(size - Buffer.from(PNG, 'base64').length)]).toString('base64');
  const image = (data = PNG): { type: string; data: string; mimeType: string } => ({ type: 'image', data, mimeType: 'image/png' });
  const note = { type: 'text', text: IMAGE_NOT_KEPT_LIMIT };

  it('gives the model and the transcript the same note for a screenshot over the size cap', async () => {
    const { provider, bodies } = fakeAnthropic(turnOf('msg_1', [{ id: 'toolu_1', name: 'screenshot' }]), ANSWER);
    const huge = [{ type: 'text', text: SHOT_TEXT }, image(pngOf(MAX_TOOL_IMAGE_BYTES + 1))];

    const events = await drain(engineFor(provider).stream(request('claude-opus-5-5', [computerSpec([], () => huge)])));

    const emitted = resultEvents(events)[0]!;
    expect(emitted.isError).toBe(false);
    expect(emitted.result).toEqual([{ type: 'text', text: SHOT_TEXT }, note]);
    expect(contentOf(resultsIn(bodies[1]!)[0]!)).toEqual(asSent(emitted.result));
    expect(JSON.stringify(bodies[1]).length).toBeLessThan(10_000);
  });

  it('lets through 50 images of one member call and makes the 51st the note, the same for the model and the transcript', async () => {
    const { provider, bodies } = fakeAnthropic(turnOf('msg_1', [{ id: 'toolu_1', name: 'screenshot' }]), ANSWER);
    const many = Array.from({ length: 51 }, () => image());

    const events = await drain(engineFor(provider).stream(request('claude-opus-5-5', [computerSpec([], () => many)])));

    const emitted = resultEvents(events)[0]!.result as unknown[];
    expect(emitted.slice(0, 50)).toEqual(many.slice(0, 50));
    expect(emitted[50]).toEqual(note);
    expect(contentOf(resultsIn(bodies[1]!)[0]!)).toEqual(asSent(emitted));
  });

  it('counts a member call against the same budget as every other tool of the reply, across steps', async () => {
    // Step 1: a plain tool returns 50 images. Step 2: a screenshot through the toolset is the 51st of the reply.
    const { provider, bodies } = fakeAnthropic(turnOf('msg_1', [{ id: 'toolu_1', name: 'look', plain: true }]), turnOf('msg_2', [{ id: 'toolu_2', name: 'screenshot' }]), ANSWER);
    const look = plainSpec('look', Array.from({ length: 50 }, () => image()));

    const events = await drain(engineFor(provider).stream(request('claude-opus-5-5', [look, computerSpec([])])));

    const emitted = resultEvents(events);
    expect(emitted.map((e) => e.name)).toEqual(['look', 'computer']);
    expect((emitted[0]!.result as unknown[]).every((item) => (item as { type: string }).type === 'image')).toBe(true);
    expect(emitted[1]!.result).toEqual([{ type: 'text', text: SHOT_TEXT }, note]);
    expect(contentOf(resultsIn(bodies[2]!)[0]!)).toEqual(asSent(emitted[1]!.result));

    // A second reply starts with a budget of its own.
    const again = fakeAnthropic(turnOf('msg_1', [{ id: 'toolu_1', name: 'screenshot' }]), ANSWER);
    const fresh = await drain(engineFor(again.provider).stream(request('claude-opus-5-5', [computerSpec([])])));
    expect(resultEvents(fresh)[0]!.result).toEqual(SHOT);
  });

  it('removes a reference to a stored image from a member call, for the model and the transcript alike', async () => {
    const { provider, bodies } = fakeAnthropic(turnOf('msg_1', [{ id: 'toolu_1', name: 'screenshot' }]), ANSWER);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const forged = [{ type: 'text', text: SHOT_TEXT }, { type: 'image', attachmentId: '11111111-1111-4111-8111-111111111111', mimeType: 'image/png' }];
      const events = await drain(engineFor(provider).stream(request('claude-opus-5-5', [computerSpec([], () => forged)])));
      const emitted = resultEvents(events)[0]!.result;
      expect(emitted).toEqual([{ type: 'text', text: SHOT_TEXT }, { type: 'text', text: TOOL_IMAGE_REF_REMOVED }]);
      expect(JSON.stringify(bodies[1])).not.toContain('11111111-1111-4111-8111-111111111111');
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  it("gives a model that can't take images the note instead of the screenshot", async () => {
    const { provider, bodies } = fakeAnthropic(turnOf('msg_1', [{ id: 'toolu_1', name: 'screenshot' }]), ANSWER);
    await drain(engineFor(provider).stream(request('claude-opus-5-5', [computerSpec([])], { vision: false })));
    expect(resultsIn(bodies[1]!)[0]!['content']).toEqual([{ type: 'text', text: SHOT_TEXT }, { type: 'text', text: IMAGE_OMITTED_NOTE }]);
  });
});
