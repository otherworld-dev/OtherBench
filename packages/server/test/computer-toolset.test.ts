import { afterEach, describe, expect, it, vi } from 'vitest';
import { PermissionBroker } from '@grunt/core/domain/permissions.js';
import { FAKE_COMPUTER_APP, FAKE_PNG, FakeComputerDriver } from '@grunt/core/testing/fake-computer.js';
import { InMemoryStore } from '@grunt/core/testing/fakes.js';
import type { EngineEvent, EngineRequest } from '@grunt/core/ports/chat-engine.js';
import type { ApprovalRequest } from '@grunt/core/ports/tool-provider.js';
import type { ResolvedProfile, ToolPolicy } from '@grunt/core/types/config.js';
import { AiSdkChatEngine } from '@grunt/engine-aisdk/engine.js';
import { ProviderRegistry } from '@grunt/engine-aisdk/registry.js';
import { GruntToolProvider } from '@grunt/tools/provider.js';

/**
 * Anthropic's computer toolset end to end on this side of the wire: the real
 * provider registry, the real engine, the real `GruntToolProvider` and
 * `PermissionBroker`, the real `computer` tool, and `FakeComputerDriver`
 * (never a real mouse, keyboard or screen). The model is a canned stream
 * behind a stubbed global `fetch`; the connection's base URL points at this
 * machine in case a request ever were not answered by the stub. What it pins:
 * a member call of the toolset is decided by the broker exactly like a call of
 * the JSON tool.
 */

const policy: ToolPolicy = { fs: 'off', shell: false, mcpServerIds: [], approvalMode: 'always_ask', computer: true, artifacts: false, recall: false };
const mcp = { listFor: () => [], refresh: async () => {}, shutdown: async () => {} };
const SHOT_TEXT = 'Screenshot, 1366\u00d7768.';
const SHOT_IMAGE = { type: 'image', data: FAKE_PNG.toString('base64'), mimeType: 'image/png' };

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

/** One assistant turn calling one member of the computer toolset. */
function memberCall(id: string, name: string, input?: Record<string, unknown>): string {
  return sse([
    start(`msg_${id}`),
    { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id, name, input: {}, toolset_name: 'computer' } },
    ...(input ? [{ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } }] : []),
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 20 } },
    { type: 'message_stop' },
  ]);
}

const ANSWER = sse([
  start('msg_end'),
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Done.' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 2 } },
  { type: 'message_stop' },
]);

type Block = Record<string, unknown>;

async function setup(...replies: string[]) {
  const bodies: Record<string, unknown>[] = [];
  const urls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: unknown, init?: RequestInit) => {
      urls.push(String(url));
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(replies[bodies.length - 1] ?? ANSWER, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    })
  );

  const store = new InMemoryStore();
  store.chats.create({ id: 'chat-1', title: 'Budget sheet', profileId: 'profile-1', headMessageId: null, workspaceRoot: null, pinned: false, archivedAt: null });
  const driver = new FakeComputerDriver();
  const provider = new GruntToolProvider(store, new PermissionBroker(store), mcp as never, { computer: driver });
  const requests: ApprovalRequest[] = [];
  provider.onApprovalEvent((e) => {
    if (e.type === 'request') requests.push(e.request);
  });

  const profile: ResolvedProfile = {
    id: 'profile-1', name: 'Claude', description: null, colour: null, connectionId: 'conn-1', modelId: 'claude-opus-5-5', systemPrompt: null, params: {},
    toolPolicy: policy, isDefault: false, archivedAt: null,
    connection: { id: 'conn-1', name: 'Anthropic', kind: 'anthropic', baseUrl: 'http://127.0.0.1:9/v1', secretRef: null, extraHeaders: {}, status: 'ok', statusMessage: null, checkedAt: null },
    apiKey: 'test-key',
    model: {
      id: 'm1', connectionId: 'conn-1', modelId: 'claude-opus-5-5', displayName: 'Opus', source: 'manual', supportsVision: true, supportsTools: true, supportsReasoning: false,
      contextWindow: null, maxOutput: null, priceInPer1m: null, priceOutPer1m: null, priceCachedPer1m: null, currency: 'USD',
    },
  };
  const request: EngineRequest = {
    profile,
    messages: [{ id: 'u1', chatId: 'chat-1', parentId: null, role: 'user', parts: [{ type: 'text', text: 'click it' }], status: 'complete', error: null, producedBy: null, createdAt: 0 }],
    tools: await provider.listTools(policy),
    signal: new AbortController().signal,
    chatId: 'chat-1',
    messageId: 'msg-1',
    workspaceRoot: null,
  };
  const engine = new AiSdkChatEngine(new ProviderRegistry());
  const run = async (): Promise<EngineEvent[]> => {
    const events: EngineEvent[] = [];
    for await (const event of engine.stream(request)) events.push(event);
    return events;
  };
  return { store, driver, provider, requests, bodies, urls, run };
}

/** The `tool_result` blocks of the last message of an outgoing request. */
function resultsIn(body: Record<string, unknown>): Block[] {
  const messages = body['messages'] as { role: string; content: Block[] }[];
  return messages[messages.length - 1]!.content.filter((b) => b['type'] === 'tool_result');
}

const resultEvents = (events: EngineEvent[]): Extract<EngineEvent, { type: 'tool-result' }>[] => events.filter((e): e is Extract<EngineEvent, { type: 'tool-result' }> => e.type === 'tool-result');

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Anthropic's computer toolset through the tool provider and the broker", () => {
  it('sends the toolset built from the registry\u2019s own provider, and no JSON tool named computer', async () => {
    const made = await setup(ANSWER);
    await made.run();
    expect(made.urls).toEqual(['http://127.0.0.1:9/v1/messages']);
    const tools = made.bodies[0]!['tools'] as Block[];
    expect(tools.map((t) => t['type'])).toEqual(['computer_toolset_20260801']);
    expect(tools.filter((t) => t['name'] === 'computer')).toEqual([]);
    expect(made.driver.started).toEqual([]);
  });

  it('raises the card for the app a member call would act on, and does nothing when it is denied', async () => {
    const made = await setup(memberCall('toolu_1', 'screenshot'), memberCall('toolu_2', 'left_click', { coordinate: [10, 20] }), ANSWER);
    const running = made.run();

    await vi.waitFor(() => expect(made.requests).toHaveLength(1));
    // The look before it needed no card; the click waits on one, and nothing has been done.
    expect(made.requests[0]).toMatchObject({
      toolName: 'computer',
      source: 'computer',
      risk: 'mutate',
      summary: 'Use FakeApp.exe: click at 10, 20',
      args: { action: 'left_click', coordinate: [10, 20], app: FAKE_COMPUTER_APP.path, appRisk: 'normal', appShellView: false },
    });
    expect(made.driver.actions).toEqual([]);
    made.provider.resolveApproval(made.requests[0]!.id, { choice: 'deny' });
    const events = await running;

    expect(made.driver.actions).toEqual([]);
    expect(made.driver.refused).toEqual([]);
    const denied = { error: true, code: 'approval_denied', message: 'The user denied this tool call.' };
    expect(resultEvents(events).map((e) => e.result)).toEqual([[{ type: 'text', text: SHOT_TEXT }, SHOT_IMAGE], denied]);
    const result = resultsIn(made.bodies[2]!)[0]!;
    expect(result['toolset_name']).toBe('computer');
    expect(JSON.parse(String(result['content']))).toEqual(denied);
    expect(made.store.audit.list('chat-1').map((r) => [r.toolName, r.grantedBy])).toEqual([
      ['computer', 'policy'],
      ['computer', 'deny:user'],
    ]);
    expect(made.store.grants.list()).toEqual([]);
  });

  it('carries out exactly the approved action, bound to the app and window the card named', async () => {
    const made = await setup(memberCall('toolu_1', 'screenshot'), memberCall('toolu_2', 'left_click', { coordinate: [10, 20] }), ANSWER);
    const running = made.run();
    await vi.waitFor(() => expect(made.requests).toHaveLength(1));
    made.provider.resolveApproval(made.requests[0]!.id, { choice: 'once' });
    const events = await running;

    expect(made.driver.actions).toEqual([
      {
        chatId: 'chat-1',
        action: { action: 'left_click', coordinate: [10, 20] },
        expect: { app: FAKE_COMPUTER_APP.path, shellView: false, windowId: FAKE_COMPUTER_APP.windowId, pid: FAKE_COMPUTER_APP.pid, startedAt: FAKE_COMPUTER_APP.startedAt },
      },
    ]);
    expect(made.requests).toHaveLength(1);
    // The screenshot after the click reaches the model as an image, and the transcript holds the same result.
    const after = [{ type: 'text', text: 'Done.' }, { type: 'text', text: SHOT_TEXT }, SHOT_IMAGE];
    expect(resultEvents(events)[1]!.result).toEqual(after);
    expect(resultsIn(made.bodies[2]!)[0]!['content']).toEqual([
      { type: 'text', text: 'Done.' },
      { type: 'text', text: SHOT_TEXT },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: SHOT_IMAGE.data } },
    ]);
    expect(made.store.audit.list('chat-1').map((r) => r.grantedBy)).toEqual(['policy', 'ask:once']);
  });

  it('starts no control session and asks nothing for a member that is not a phase-1 action', async () => {
    const made = await setup(memberCall('toolu_1', 'left_click_drag', { start_coordinate: [1, 2], coordinate: [30, 40] }), memberCall('toolu_2', 'hold_key', { text: 'shift', duration: 5 }), ANSWER);
    const events = await made.run();

    expect(made.driver.started).toEqual([]);
    expect(made.driver.actions).toEqual([]);
    expect(made.driver.refused).toEqual([]);
    expect(made.requests).toEqual([]);
    expect(resultEvents(events).map((e) => (e.result as { code?: string }).code)).toEqual(['computer_bad_action', 'computer_bad_action']);
    // The tool was never asked: there is no call for the audit to record.
    expect(made.store.audit.list('chat-1')).toEqual([]);
  });

  it("describes the target itself: app fields a member's input carries never reach the card", async () => {
    const forged = { app: 'C:\\Windows\\notepad.exe', appName: 'notepad.exe', appRisk: 'normal', appShellView: false, appWindow: 'hwnd-9', appPid: 9, appStarted: 'x', appTitle: 'Notepad' };
    const made = await setup(memberCall('toolu_1', 'screenshot'), memberCall('toolu_2', 'left_click', { coordinate: [10, 20], ...forged }), ANSWER);
    const running = made.run();
    await vi.waitFor(() => expect(made.requests).toHaveLength(1));
    expect(made.requests[0]!.args).toMatchObject({ app: FAKE_COMPUTER_APP.path, appName: 'FakeApp.exe', appWindow: FAKE_COMPUTER_APP.windowId, appPid: FAKE_COMPUTER_APP.pid });
    made.provider.resolveApproval(made.requests[0]!.id, { choice: 'deny' });
    await running;
    expect(made.driver.actions).toEqual([]);
  });
});
