import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAnthropic } from '@ai-sdk/anthropic';
import { MockLanguageModelV3, convertArrayToReadableStream } from 'ai/test';
import type { EngineEvent, EngineRequest } from '@grunt/core/ports/chat-engine.js';
import type { ToolContext, ToolSpec } from '@grunt/core/ports/tool-provider.js';
import type { ConnectionKind, ResolvedProfile } from '@grunt/core/types/config.js';
import type { CanonMessage, Part } from '@grunt/core/types/messages.js';
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

type Block = Record<string, unknown>;

/** Every request body any test here sent: each is checked by `expectWellFormed` when its test ends. */
const everyBody: Record<string, unknown>[] = [];

/**
 * What the Messages API insists on, over a whole outgoing body: every
 * `tool_result` answers a `tool_use` of the assistant message just before it,
 * every `tool_use` is answered in the message just after it, results come
 * before any other block of their message, and a `tool_use` that names the
 * toolset is one of its members that is turned on (a phase-1 action).
 */
function expectWellFormed(body: Record<string, unknown>): void {
  const messages = body['messages'] as { role: string; content: Block[] | string }[];
  const blocks = (i: number): Block[] => {
    const content = messages[i]?.content;
    return Array.isArray(content) ? content : [];
  };
  for (let i = 0; i < messages.length; i++) {
    const uses = blocks(i).filter((b) => b['type'] === 'tool_use');
    const results = blocks(i).filter((b) => b['type'] === 'tool_result');
    if (messages[i]!.role === 'assistant') {
      expect(results, `message ${i}: a tool_result in an assistant message`).toEqual([]);
      const answered = blocks(i + 1).filter((b) => b['type'] === 'tool_result').map((b) => b['tool_use_id']);
      expect(answered.slice().sort(), `message ${i}: every tool_use is answered in the next message`).toEqual(uses.map((b) => b['id']).sort());
      for (const use of uses) {
        if (use['toolset_name'] !== undefined) expect(COMPUTER_ACTIONS as readonly unknown[], `message ${i}: tool_use ${String(use['name'])} names the toolset`).toContain(use['name']);
      }
    } else {
      expect(uses, `message ${i}: a tool_use in a user message`).toEqual([]);
      const asked = messages[i - 1]?.role === 'assistant' ? blocks(i - 1).filter((b) => b['type'] === 'tool_use').map((b) => b['id']) : [];
      for (const result of results) expect(asked, `message ${i}: tool_result ${String(result['tool_use_id'])} has its tool_use just before it`).toContain(result['tool_use_id']);
      const firstOther = blocks(i).findIndex((b) => b['type'] !== 'tool_result');
      if (firstOther !== -1) expect(blocks(i).slice(firstOther).filter((b) => b['type'] === 'tool_result'), `message ${i}: results come first`).toEqual([]);
    }
    if (i > 0) expect(messages[i]!.role, `message ${i}: roles alternate`).not.toBe(messages[i - 1]!.role);
  }
  expect(messages[messages.length - 1]!.role, 'the request ends with a user message').toBe('user');
}

afterEach(() => {
  for (const body of everyBody.splice(0)) expectWellFormed(body);
});

function fakeAnthropic(...replies: string[]) {
  const bodies: Record<string, unknown>[] = [];
  const urls: string[] = [];
  const fetch = vi.fn(async (url: unknown, init?: RequestInit) => {
    urls.push(String(url));
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    everyBody.push(bodies[bodies.length - 1]!);
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

/** What the provider's gate answers for a name that is not an action (the shape of its refusals; the real one is pinned in packages/server/test/computer-toolset.test.ts). */
const refusedByGate = (action: unknown): { error: true; code: string; message: string } => ({ error: true, code: 'permission_denied', message: `"${String(action)}" isn't a computer action Grunt can do.` });

function answerLikeTheGate(args: { action: string }): unknown {
  if (!(COMPUTER_ACTIONS as readonly string[]).includes(args.action)) return refusedByGate(args.action);
  return args.action === 'screenshot' ? SHOT : [{ type: 'text', text: 'Done.' }];
}

/** Stands in for the gated `computer` spec the tool provider hands the engine: `execute` is where the broker decides. */
function computerSpec(seen: unknown[], answer: (args: { action: string }, ctx: ToolContext) => unknown = answerLikeTheGate): ToolSpec {
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

function request(modelId: string, tools: ToolSpec[], over: { kind?: ConnectionKind; vision?: boolean; signal?: AbortSignal; messages?: CanonMessage[] } = {}): EngineRequest {
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
    messages: over.messages ?? [{ id: 'u1', chatId: 'chat-1', parentId: null, role: 'user', parts: [{ type: 'text', text: 'click it' }], status: 'complete', error: null, producedBy: null, createdAt: 0 }],
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
    // The ids the SDK itself names as taking the toolset (index.d.ts, the doc comment on `computerToolset_20260801`).
    expect([...COMPUTER_TOOLSET_MODELS]).toEqual(['claude-opus-5-5', 'claude-opus-5', 'claude-opus-4-8', 'claude-sonnet-5', 'claude-fable-5', 'claude-fable-5-1']);
    for (const id of [...COMPUTER_TOOLSET_MODELS, 'claude-opus-5-5-20261001', 'claude-fable-5-20260801']) {
      expect(usesComputerToolset('anthropic', id), id).toBe(true);
    }
    for (const id of ['claude-sonnet-4-5', 'claude-opus-4-1', 'claude-haiku-4-5']) expect(usesComputerToolset('anthropic', id), id).toBe(false);
    // On the plan's list but never checked against the API: they keep the plain tool, which any model can call.
    for (const id of ['claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-sonnet-5-5-20261001']) expect(usesComputerToolset('anthropic', id), id).toBe(false);
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

/** The name a `computer` call the toolset has no member for is written under: still a call, with its result still its result. */
const PLAIN = 'invalid_computer_call';

/** The text blocks of one message of an outgoing request. */
function textsIn(body: Record<string, unknown>, index: number): string[] {
  const messages = body['messages'] as { role: string; content: Block[] }[];
  const message = messages[index < 0 ? messages.length + index : index]!;
  return message.content.filter((b) => b['type'] === 'text').map((b) => String(b['text']));
}

/** Every `tool_use` of an outgoing request, as [name, toolset_name, id]. */
function usesIn(body: Record<string, unknown>): unknown[][] {
  const messages = body['messages'] as { role: string; content: Block[] | string }[];
  return messages.flatMap((m) => (Array.isArray(m.content) ? m.content : []).filter((b) => b['type'] === 'tool_use').map((b) => [b['name'], b['toolset_name'], b['id']]));
}

describe('the toolset: what reaches the computer tool', () => {
  it('hands a member that is not a phase-1 action to the tool as its name alone, so the gate refuses it and records it', async () => {
    const off = ['left_click_drag', 'hold_key', 'zoom', 'middle_click', 'left_mouse_down', 'left_mouse_up'];
    const calls: Call[] = off.map((name, i) => ({ id: `toolu_${i}`, name, input: { coordinate: [1, 2], start_coordinate: [3, 4], text: 'shift', duration: 1, region: [0, 0, 5, 5] } }));
    const { provider, bodies } = fakeAnthropic(turnOf('msg_1', calls), ANSWER);
    const seen: unknown[] = [];

    const events = await drain(engineFor(provider).stream(request('claude-opus-5-5', [computerSpec(seen)])));

    // The name and nothing else: no point, no text, nothing the tool could act on.
    expect(seen).toEqual(off.map((name) => ({ action: name })));
    const emitted = resultEvents(events);
    expect(emitted.map((e) => e.result)).toEqual(off.map((name) => refusedByGate(name)));
    // The next request: a member that is turned off is not written back as a member. It is still a call, and
    // what the gate answered is still its result; none of it became text of the assistant's or the user's turn.
    expect(usesIn(bodies[1]!)).toEqual(off.map((_, i) => [PLAIN, undefined, `toolu_${i}`]));
    const results = resultsIn(bodies[1]!);
    expect(results.map((b) => [b['tool_use_id'], b['toolset_name']])).toEqual(off.map((_, i) => [`toolu_${i}`, undefined]));
    expect(results.map((b) => contentOf(b))).toEqual(off.map((name) => refusedByGate(name)));
    expect(textsIn(bodies[1]!, -2)).toEqual([]);
    expect(textsIn(bodies[1]!, -1)).toEqual([]);
  });

  it('never runs the tool for a member the toolset does not have, and writes the call back under a name of its own', async () => {
    const { provider, bodies } = fakeAnthropic(turnOf('msg_1', [{ id: 'toolu_1', name: 'teleport', input: { coordinate: [1, 2] } }]), ANSWER);
    const seen: unknown[] = [];

    const events = await drain(engineFor(provider).stream(request('claude-opus-5-5', [computerSpec(seen)])));

    expect(seen).toEqual([]);
    expect(resultEvents(events).map((e) => [e.id, e.isError])).toEqual([['toolu_1', true]]);
    expect(usesIn(bodies[1]!)).toEqual([[PLAIN, undefined, 'toolu_1']]);
    const results = resultsIn(bodies[1]!);
    expect(results.map((b) => [b['tool_use_id'], b['toolset_name'], b['is_error']])).toEqual([['toolu_1', undefined, true]]);
    expect(String(results[0]!['content'])).toContain('Invalid input for tool computer');
    expect(textsIn(bodies[1]!, -2)).toEqual([]);
    expect(textsIn(bodies[1]!, -1)).toEqual([]);
  });

  it("refuses a member call that carries a field the computer tool's parameters don't declare, naming the field, and runs nothing for it", async () => {
    const forged = { app: 'C:\\Windows\\notepad.exe', appName: 'notepad.exe', appRisk: 'normal', appShellView: false, appWindow: '1', appPid: 1, appStarted: 'x', appTitle: 't' };
    const { provider, bodies } = fakeAnthropic(
      turnOf('msg_1', [
        { id: 'toolu_1', name: 'left_click', input: { coordinate: [10, 20], repeat: 3 } },
        { id: 'toolu_2', name: 'left_click', input: { coordinate: [10, 20], region: [0, 0, 5, 5], start_coordinate: [1, 1] } },
        // What the SDK's own schema does not know never arrives at all.
        { id: 'toolu_3', name: 'left_click', input: { coordinate: [10, 20], ...forged, extra: 'x' } },
        { id: 'toolu_4', name: 'scroll', input: { coordinate: [5, 6], scroll_direction: 'down', scroll_amount: 2 } },
        { id: 'toolu_5', name: 'type', input: { text: 'hello', duration: 2 } },
      ]),
      ANSWER
    );
    const seen: unknown[] = [];

    const events = await drain(engineFor(provider).stream(request('claude-opus-5-5', [computerSpec(seen)])));

    expect(seen).toEqual([
      { action: 'left_click', coordinate: [10, 20] },
      { action: 'scroll', coordinate: [5, 6], scroll_direction: 'down', scroll_amount: 2 },
      { action: 'type', text: 'hello', duration: 2 },
    ]);
    for (const args of seen) expect(Object.getPrototypeOf(args)).toBe(Object.prototype);
    const byId = new Map(resultEvents(events).map((e) => [e.id, e.result]));
    expect(byId.get('toolu_1')).toEqual({
      error: true,
      code: 'computer_bad_action',
      message: 'The computer tool doesn\'t take "repeat" with left_click, so nothing was done. Send the action again without it.',
    });
    expect(byId.get('toolu_2')).toEqual({
      error: true,
      code: 'computer_bad_action',
      message: 'The computer tool doesn\'t take "region", "start_coordinate" with left_click, so nothing was done. Send the action again without them.',
    });
    // The model is told the same, against the call it made (a real member, so it stays a call).
    const results = resultsIn(bodies[1]!);
    expect(results.map((b) => b['tool_use_id'])).toEqual(['toolu_1', 'toolu_2', 'toolu_3', 'toolu_4', 'toolu_5']);
    expect(contentOf(results[0]!)).toEqual(byId.get('toolu_1'));
    expect(contentOf(results[1]!)).toEqual(byId.get('toolu_2'));
  });

  it('refuses every field but the action when the spec declares no other', async () => {
    const { provider } = fakeAnthropic(turnOf('msg_1', [{ id: 'toolu_1', name: 'left_click', input: { coordinate: [10, 20], text: 'x' } }, { id: 'toolu_2', name: 'screenshot' }]), ANSWER);
    const seen: unknown[] = [];
    const bare: ToolSpec = { ...computerSpec(seen), parameters: { type: 'object' } };
    const events = await drain(engineFor(provider).stream(request('claude-opus-5-5', [bare])));
    expect(seen).toEqual([{ action: 'screenshot' }]);
    expect((resultEvents(events).find((e) => e.id === 'toolu_1')!.result as { message: string }).message).toBe(
      'The computer tool doesn\'t take "coordinate", "text" with left_click, so nothing was done. Send the action again without them.'
    );
  });

  it('ends the turn as stopped when the reply is stopped while a member call is running', async () => {
    const { provider, fetch } = fakeAnthropic(turnOf('msg_1', [{ id: 'toolu_1', name: 'left_click', input: { coordinate: [10, 20] } }]), ANSWER);
    const controller = new AbortController();
    const during: boolean[] = [];
    const spec = computerSpec([], async (_args, ctx) => {
      during.push(ctx.signal.aborted);
      const stopped = new Promise<void>((resolve) => ctx.signal.addEventListener('abort', () => resolve(), { once: true }));
      controller.abort();
      await stopped;
      during.push(ctx.signal.aborted);
      return { error: true, code: 'cancelled', message: 'The reply was stopped, so nothing was done.' };
    });

    const events = await drain(engineFor(provider).stream(request('claude-opus-5-5', [spec], { signal: controller.signal })));

    // The call saw the stop through its own context, while it was running.
    expect(during).toEqual([false, true]);
    expect(events.at(-1)).toMatchObject({ type: 'error', error: { kind: 'cancelled' } });
    expect(events.filter((e) => e.type === 'finish')).toEqual([]);
    // No second request went out for a reply that was stopped.
    expect(fetch).toHaveBeenCalledTimes(1);
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

describe('the toolset: a computer call that is not one of its members stays a call, with its result, under another name', () => {
  const user = (id: string, text: string): CanonMessage => ({ id, chatId: 'chat-1', parentId: null, role: 'user', parts: [{ type: 'text', text }], status: 'complete', error: null, producedBy: null, createdAt: 0 });
  const call = (id: string, args: unknown): Part => ({ type: 'tool-call', id, name: 'computer', args });
  const result = (id: string, value: unknown, isError = false): Part => ({ type: 'tool-result', id, name: 'computer', result: value, isError });
  const noAction = { error: true, code: 'permission_denied', message: 'no action' };

  /** A chat whose earlier reply (made with the JSON tool, on another model) holds calls the toolset has no member for, and one it has. */
  const history: CanonMessage[] = [
    user('u1', 'do things'),
    {
      id: 'a1', chatId: 'chat-1', parentId: null, role: 'assistant', status: 'complete', error: null, producedBy: null, createdAt: 1,
      parts: [
        call('c1', {}),
        result('c1', noAction),
        call('c2', { action: 5 }),
        result('c2', 'bad input', true),
        call('c3', { action: 'click', coordinate: [1, 2] }),
        result('c3', refusedByGate('click')),
        call('c4', { action: 'left_click_drag', start_coordinate: [1, 2], coordinate: [3, 4] }),
        result('c4', refusedByGate('left_click_drag')),
        call('c5', { action: 'screenshot' }),
        result('c5', [{ type: 'text', text: 'Looked.' }]),
        { type: 'text', text: 'I tried.' },
      ],
    },
    user('u2', 'and now?'),
  ];

  it('replays stored calls with no action, an action that is not text, a name that is no member and a member that is off as plain calls', async () => {
    const { provider, bodies } = fakeAnthropic(ANSWER);
    // And one whose stored arguments are not an object at all.
    const reply = history[1]!;
    const messages = [history[0]!, { ...reply, parts: [...reply.parts.slice(0, -1), call('c6', 'not even an object'), result('c6', noAction), reply.parts.at(-1)!] }, history[2]!];

    const events = await drain(engineFor(provider).stream(request('claude-opus-5-5', [computerSpec([])], { messages })));

    expect(events.filter((e) => e.type === 'error')).toEqual([]);
    expectWellFormed(bodies[0]!);
    // The one real member is still a call of the toolset; each of the others is a call under the plain name, in place.
    expect(usesIn(bodies[0]!)).toEqual([
      [PLAIN, undefined, 'c1'],
      [PLAIN, undefined, 'c2'],
      [PLAIN, undefined, 'c3'],
      [PLAIN, undefined, 'c4'],
      ['screenshot', 'computer', 'c5'],
      [PLAIN, undefined, 'c6'],
    ]);
    // Their arguments stay the call's own arguments (an object, whatever was stored), never text.
    const assistant = (bodies[0]!['messages'] as { content: Block[] }[])[1]!.content;
    expect(assistant.filter((b) => b['type'] === 'tool_use').map((b) => b['input'])).toEqual([{}, { action: 5 }, { action: 'click', coordinate: [1, 2] }, { action: 'left_click_drag', start_coordinate: [1, 2], coordinate: [3, 4] }, {}, {}]);
    // Every result is still the result of its call, and only the member's names the toolset.
    const results = resultsIn(bodies[0]!);
    expect(results.map((b) => [b['tool_use_id'], b['toolset_name']])).toEqual([['c1', undefined], ['c2', undefined], ['c3', undefined], ['c4', undefined], ['c5', 'computer'], ['c6', undefined]]);
    expect(contentOf(results[0]!)).toEqual(noAction);
    expect(results[1]).toMatchObject({ content: '"bad input"', is_error: true });
    expect(contentOf(results[2]!)).toEqual(refusedByGate('click'));
    // Nothing a tool returned, and nothing about a call, became text of either turn.
    expect(textsIn(bodies[0]!, 1)).toEqual(['I tried.']);
    expect(textsIn(bodies[0]!, 2)).toEqual(['and now?']);
  });

  it('keeps the request well formed when every call of a reply is one the toolset has no member for', async () => {
    const only: CanonMessage[] = [user('u1', 'do things'), { ...history[1]!, parts: [call('c1', {}), result('c1', noAction)] }, user('u2', 'and now?')];
    const { provider, bodies } = fakeAnthropic(ANSWER);
    await drain(engineFor(provider).stream(request('claude-opus-5-5', [computerSpec([])], { messages: only })));
    expect((bodies[0]!['messages'] as { role: string }[]).map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(usesIn(bodies[0]!)).toEqual([[PLAIN, undefined, 'c1']]);
    expect(resultsIn(bodies[0]!).map((b) => b['tool_use_id'])).toEqual(['c1']);
    expect(textsIn(bodies[0]!, 1)).toEqual([]);
    expect(textsIn(bodies[0]!, 2)).toEqual(['and now?']);
  });

  it('leaves the same history alone for a model that gets the JSON tool, and when the request has no computer tool', async () => {
    for (const [modelId, tools] of [['claude-sonnet-4-5', [computerSpec([])]], ['claude-opus-5-5', []]] as [string, ToolSpec[]][]) {
      const { provider, bodies } = fakeAnthropic(ANSWER);
      await drain(engineFor(provider).stream(request(modelId, tools, { messages: history })));
      expect(usesIn(bodies[0]!), modelId).toEqual(['c1', 'c2', 'c3', 'c4', 'c5'].map((id) => ['computer', undefined, id]));
      expect(resultsIn(bodies[0]!).map((b) => b['tool_use_id']), modelId).toEqual(['c1', 'c2', 'c3', 'c4', 'c5']);
      expect(textsIn(bodies[0]!, 1), modelId).toEqual(['I tried.']);
    }
  });

  it('does not leave a result without its call in the next step when a member call arrives with an action that is not text', async () => {
    const { provider, bodies } = fakeAnthropic(
      turnOf('msg_1', [
        { id: 'toolu_1', name: 'screenshot', input: { action: null } },
        { id: 'toolu_2', name: 'left_click', input: { action: 5, coordinate: [1, 2] } },
        { id: 'toolu_3', name: 'screenshot' },
      ]),
      turnOf('msg_2', [{ id: 'toolu_4', name: 'left_click', input: { coordinate: [10, 20] } }]),
      ANSWER
    );
    const seen: unknown[] = [];

    const events = await drain(engineFor(provider).stream(request('claude-opus-5-5', [computerSpec(seen)])));

    expect(events.filter((e) => e.type === 'error')).toEqual([]);
    expect(seen).toEqual([{ action: 'screenshot' }, { action: 'left_click', coordinate: [10, 20] }]);
    expect(resultEvents(events).map((e) => [e.id, e.isError])).toEqual(expect.arrayContaining([['toolu_1', true], ['toolu_2', true], ['toolu_3', false], ['toolu_4', false]]));
    // The second step's request, and the third's (which carries the first step again): the two odd calls are plain
    // calls both times, each with its result, and the model reads why they failed in the result itself.
    for (const body of [bodies[1]!, bodies[2]!]) {
      expectWellFormed(body);
      expect(usesIn(body).slice(0, 3)).toEqual([[PLAIN, undefined, 'toolu_1'], [PLAIN, undefined, 'toolu_2'], ['screenshot', 'computer', 'toolu_3']]);
      const first = (body['messages'] as { content: Block[] }[])[2]!.content.filter((b) => b['type'] === 'tool_result');
      expect(first.map((b) => [b['tool_use_id'], b['toolset_name'], b['is_error']])).toEqual([['toolu_1', undefined, true], ['toolu_2', undefined, true], ['toolu_3', 'computer', undefined]]);
      expect(String(first[0]!['content'])).toContain('Invalid input for tool computer');
      expect(textsIn(body, 1)).toEqual([]);
      expect(textsIn(body, 2)).toEqual([]);
    }
    expect(usesIn(bodies[2]!).slice(3)).toEqual([['left_click', 'computer', 'toolu_4']]);
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
    // Nothing but text is left: one string, the words then the note.
    expect(resultsIn(bodies[1]!)[0]!['content']).toBe(`${SHOT_TEXT}\n${IMAGE_OMITTED_NOTE}`);
  });
});
