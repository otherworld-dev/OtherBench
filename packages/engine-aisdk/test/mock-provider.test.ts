import { describe, it, expect, vi } from 'vitest';
import type { EngineEvent, EngineRequest } from '@grunt/core/ports/chat-engine.js';
import type { ToolContext, ToolSpec } from '@grunt/core/ports/tool-provider.js';
import type { CanonMessage } from '@grunt/core/types/messages.js';
import type { ResolvedProfile } from '@grunt/core/types/config.js';
import { checkOfficeContent } from '@grunt/core/domain/office-spec.js';
import { createPlanGate, PLAN_APPROVED, PLAN_REFUSAL, planChangesText, UNATTENDED_PLAN } from '@grunt/core/domain/thread-tools.js';
import { MockChatEngine, OFFICE_SAMPLES } from '../src/mock-provider.js';

function makeResolvedProfile(): ResolvedProfile {
  return {
    id: 'profile-1',
    name: 'Test Profile',
    description: null,
    colour: null,
    connectionId: 'conn-1',
    modelId: 'model-1',
    systemPrompt: null,
    params: {},
    toolPolicy: { fs: 'off', shell: false, mcpServerIds: [], approvalMode: 'always_ask' },
    isDefault: false,
    archivedAt: null,
    connection: {
      id: 'conn-1',
      name: 'Mock Connection',
      kind: 'mock',
      baseUrl: null,
      secretRef: null,
      extraHeaders: {},
      status: 'unknown',
      statusMessage: null,
      checkedAt: null,
    },
    apiKey: null,
    model: null,
  };
}

let counter = 0;
function userMessage(text: string): CanonMessage {
  counter += 1;
  return {
    id: `msg-${counter}`,
    chatId: 'chat-1',
    parentId: null,
    role: 'user',
    parts: [{ type: 'text', text }],
    status: 'complete',
    error: null,
    producedBy: null,
    createdAt: counter,
  };
}

function makeRequest(prompt: string, over: Partial<EngineRequest> = {}): EngineRequest {
  return {
    profile: makeResolvedProfile(),
    messages: [userMessage(prompt)],
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

/** A no-op sleep so tests run instantly, while still recording every call for timing assertions. */
function fakeSleep() {
  return vi.fn(async (_ms: number, _signal: AbortSignal) => {});
}

describe('MockChatEngine', () => {
  describe('default reply', () => {
    it('streams a canned markdown reply in multiple chunks, roughly 30 tokens, then finishes', async () => {
      const sleep = fakeSleep();
      const engine = new MockChatEngine({ sleep });

      const events = await drain(engine.stream(makeRequest('hello there')));

      const deltas = events.filter((e) => e.type === 'text-delta');
      expect(deltas.length).toBeGreaterThan(1);
      const fullText = deltas.map((e) => (e as Extract<EngineEvent, { type: 'text-delta' }>).text).join('');
      expect(fullText.length).toBeGreaterThan(0);

      const finish = events.at(-1);
      expect(finish?.type).toBe('finish');
      if (finish?.type === 'finish') {
        expect(finish.finishReason).toBe('stop');
        expect(finish.usage.tokensOut).toBeGreaterThanOrEqual(20);
        expect(finish.usage.tokensOut).toBeLessThanOrEqual(45);
        expect(finish.usage.tokensIn).toBeGreaterThan(0);
      }

      // Only text-delta events followed by exactly one finish; no tool/error events.
      expect(events.slice(0, -1).every((e) => e.type === 'text-delta')).toBe(true);
    });

    it('sleeps a short amount between each chunk', async () => {
      const sleep = fakeSleep();
      const engine = new MockChatEngine({ sleep });

      await drain(engine.stream(makeRequest('hello there')));

      expect(sleep).toHaveBeenCalled();
      for (const call of sleep.mock.calls) {
        expect(call[0]).toBeGreaterThan(0);
        expect(call[0]).toBeLessThanOrEqual(200);
      }
    });
  });

  describe('#tool trigger', () => {
    it('emits a read_file tool call, then a tool result, then an answer that uses it', async () => {
      const engine = new MockChatEngine({ sleep: fakeSleep() });

      const events = await drain(engine.stream(makeRequest('please #tool notes.txt')));

      const toolCallIndex = events.findIndex((e) => e.type === 'tool-call');
      const toolResultIndex = events.findIndex((e) => e.type === 'tool-result');
      expect(toolCallIndex).toBe(0);
      expect(toolResultIndex).toBe(1);

      const toolCall = events[toolCallIndex] as Extract<EngineEvent, { type: 'tool-call' }>;
      expect(toolCall.name).toBe('read_file');
      expect(toolCall.args).toMatchObject({ path: 'notes.txt' });

      const toolResult = events[toolResultIndex] as Extract<EngineEvent, { type: 'tool-result' }>;
      expect(toolResult.id).toBe(toolCall.id);
      expect(toolResult.name).toBe('read_file');
      expect(toolResult.isError).toBe(false);
      expect(typeof toolResult.result).toBe('string');

      const afterTool = events.slice(2);
      expect(afterTool.some((e) => e.type === 'text-delta')).toBe(true);
      expect(afterTool.at(-1)?.type).toBe('finish');

      const answerText = afterTool
        .filter((e): e is Extract<EngineEvent, { type: 'text-delta' }> => e.type === 'text-delta')
        .map((e) => e.text)
        .join('');
      expect(answerText).toContain(String(toolResult.result));
    });

    it('defaults the read_file path when #tool has no argument', async () => {
      const engine = new MockChatEngine({ sleep: fakeSleep() });

      const events = await drain(engine.stream(makeRequest('#tool')));

      const toolCall = events.find((e) => e.type === 'tool-call') as Extract<EngineEvent, { type: 'tool-call' }>;
      expect(toolCall.args).toMatchObject({ path: expect.any(String) });
    });

    it('routes through a REAL read_file ToolSpec when one is supplied via req.tools, instead of fabricating a result', async () => {
      const engine = new MockChatEngine({ sleep: fakeSleep() });
      const capturedCtx: ToolContext[] = [];
      const realReadFile: ToolSpec = {
        name: 'read_file',
        description: 'real',
        parameters: {},
        risk: 'read',
        source: 'fs',
        execute: async (args, ctx) => {
          capturedCtx.push(ctx);
          return `REAL content of ${(args as { path: string }).path}`;
        },
      };

      const events = await drain(
        engine.stream(makeRequest('please #tool secrets.txt', { tools: [realReadFile], workspaceRoot: '/ws', messageId: 'variant-42' }))
      );

      const toolResult = events.find((e) => e.type === 'tool-result') as Extract<EngineEvent, { type: 'tool-result' }>;
      expect(toolResult.result).toBe('REAL content of secrets.txt');
      expect(toolResult.isError).toBe(false);

      // The ToolContext handed to the real tool is exactly what
      // engine-aisdk's own buildToolSet would construct for a genuine
      // model-triggered call -- same chatId/messageId/workspaceRoot the
      // request itself carries.
      expect(capturedCtx[0]).toMatchObject({ chatId: 'chat-1', messageId: 'variant-42', workspaceRoot: '/ws' });

      const answerText = events
        .filter((e): e is Extract<EngineEvent, { type: 'text-delta' }> => e.type === 'text-delta')
        .map((e) => e.text)
        .join('');
      expect(answerText).toContain('REAL content of secrets.txt');
    });

    it('surfaces a real tool error (e.g. an approval denial) as an error answer rather than pretending it succeeded', async () => {
      const engine = new MockChatEngine({ sleep: fakeSleep() });
      const deniedTool: ToolSpec = {
        name: 'read_file',
        description: 'real',
        parameters: {},
        risk: 'read',
        source: 'fs',
        execute: async () => ({ error: true, code: 'approval_denied', message: 'The user denied this tool call.' }),
      };

      const events = await drain(engine.stream(makeRequest('#tool secret.txt', { tools: [deniedTool] })));

      const toolResult = events.find((e) => e.type === 'tool-result') as Extract<EngineEvent, { type: 'tool-result' }>;
      expect(toolResult.isError).toBe(true);

      const answerText = events
        .filter((e): e is Extract<EngineEvent, { type: 'text-delta' }> => e.type === 'text-delta')
        .map((e) => e.text)
        .join('');
      expect(answerText).toContain('did not go through');
      expect(answerText).toContain('approval_denied');
    });
  });

  describe('#artifact trigger', () => {
    it('#artifact calls the real artifact tool when it is offered, then answers', async () => {
      const execute = vi.fn(async () => ({ ok: true, command: 'create', slug: 'page', number: 1 }));
      const artifact: ToolSpec = { name: 'artifact', description: '', parameters: {}, risk: 'read', source: 'artifact', execute };
      const events = await drain(new MockChatEngine({ sleep: fakeSleep() }).stream(makeRequest('#artifact', { tools: [artifact] })));
      expect(events).toContainEqual(expect.objectContaining({ type: 'tool-call', name: 'artifact', args: expect.objectContaining({ command: 'create', id: 'page', kind: 'html' }) }));
      expect(execute).toHaveBeenCalledOnce();
      expect(events).toContainEqual(expect.objectContaining({ type: 'tool-result', name: 'artifact', isError: false }));
      expect(events.filter((e) => e.type === 'text-delta').map((e) => (e as { text: string }).text).join('')).toContain('I made the artifact.');
      expect(events.at(-1)).toMatchObject({ type: 'finish' });
    });
  });

  describe('#live-artifact trigger', () => {
    it('creates the dash page through the real artifact tool, declaring a live call to the named tool', async () => {
      const execute = vi.fn(async (_args: unknown) => ({ ok: true, command: 'create', slug: 'dash', number: 1 }));
      const artifact: ToolSpec = { name: 'artifact', description: '', parameters: {}, risk: 'read', source: 'artifact', execute };
      const events = await drain(new MockChatEngine({ sleep: fakeSleep() }).stream(makeRequest('#live-artifact mcp__Live__lookup', { tools: [artifact] })));
      const args = execute.mock.calls[0]![0] as Record<string, unknown>;
      expect(args).toMatchObject({ command: 'create', id: 'dash', kind: 'html', title: 'Live dashboard' });
      expect(JSON.parse(args['live'] as string)).toEqual({ calls: [{ id: 'value', tool: 'mcp__Live__lookup', args: { key: { $param: 'key' } }, params: { key: { enum: ['a', 'b'], default: 'a' } } }] });
      expect(args['content']).toContain('<script src="grunt-live.js"></script>');
      expect(args['content']).toContain("grunt.live('value', { key: 'b' })");
      expect(events).toContainEqual(expect.objectContaining({ type: 'tool-result', name: 'artifact', isError: false }));
      expect(events.at(-1)).toMatchObject({ type: 'finish' });
    });
  });

  describe('#recall trigger', () => {
    it('#recall searches with the rest of the line through the real tool, then names the chats it found', async () => {
      const execute = vi.fn(async () => ({ projects: [], chats: [{ chatId: 'c1', title: 'Staging box', date: '2026-10-01', role: 'user', messageId: 'm1', snippet: 'zebrafish' }] }));
      const recall: ToolSpec = { name: 'recall', description: '', parameters: {}, risk: 'read', source: 'recall', execute };
      const events = await drain(new MockChatEngine({ sleep: fakeSleep() }).stream(makeRequest('#recall zebrafish host\nthanks', { tools: [recall] })));
      expect(events).toContainEqual(expect.objectContaining({ type: 'tool-call', name: 'recall', args: { command: 'search', query: 'zebrafish host' } }));
      expect(events).toContainEqual(expect.objectContaining({ type: 'tool-result', name: 'recall', isError: false }));
      expect(events.filter((e) => e.type === 'text-delta').map((e) => (e as { text: string }).text).join('')).toBe('I found: Staging box.');
      expect(events.at(-1)).toMatchObject({ type: 'finish' });
    });

    it('#recall says so when nothing matched, or no recall tool was offered', async () => {
      const recall: ToolSpec = { name: 'recall', description: '', parameters: {}, risk: 'read', source: 'recall', execute: async () => ({ projects: [], chats: [] }) };
      const text = (events: EngineEvent[]) => events.filter((e) => e.type === 'text-delta').map((e) => (e as { text: string }).text).join('');
      expect(text(await drain(new MockChatEngine({ sleep: fakeSleep() }).stream(makeRequest('#recall nothing', { tools: [recall] }))))).toBe('I found nothing.');
      const bare = await drain(new MockChatEngine({ sleep: fakeSleep() }).stream(makeRequest('#recall nothing')));
      expect(bare).toContainEqual(expect.objectContaining({ type: 'tool-result', name: 'recall', isError: true }));
    });
  });

  describe('#run trigger', () => {
    const text = (events: EngineEvent[]) => events.filter((e) => e.type === 'text-delta').map((e) => (e as { text: string }).text).join('');

    it('#run calls the offered run_command with the rest of the line, then reports its output', async () => {
      const execute = vi.fn(async () => ({ command: 'uname -s', exitCode: 0, output: 'Linux\n', sandbox: true, cwd: '/mnt/e/ws' }));
      const tool: ToolSpec = { name: 'run_command', description: '', parameters: {}, risk: 'execute', source: 'sandbox', execute };
      const events = await drain(new MockChatEngine({ sleep: fakeSleep() }).stream(makeRequest('#run uname -s\nthanks', { tools: [tool], workspaceRoot: '/ws' })));
      expect(execute).toHaveBeenCalledWith({ command: 'uname -s' }, expect.objectContaining({ chatId: 'chat-1', workspaceRoot: '/ws' }));
      expect(events).toContainEqual(expect.objectContaining({ type: 'tool-call', name: 'run_command', args: { command: 'uname -s' } }));
      expect(events).toContainEqual(expect.objectContaining({ type: 'tool-result', name: 'run_command', isError: false }));
      expect(text(events)).toBe('I ran it in the sandbox: Linux');
    });

    it("#run hands the tool the reply's plan gate and the unattended flag, like every other call", async () => {
      const execute = vi.fn(async () => ({ exitCode: 0, output: '', sandbox: true }));
      const tool: ToolSpec = { name: 'run_command', description: '', parameters: {}, risk: 'execute', source: 'sandbox', execute };
      const plan = createPlanGate();
      await drain(new MockChatEngine({ sleep: fakeSleep() }).stream(makeRequest('#run ls', { tools: [tool], workspaceRoot: '/ws', plan, unattended: true })));
      expect(execute).toHaveBeenCalledWith({ command: 'ls' }, expect.objectContaining({ plan, unattended: true }));
    });

    it('#run says so when the command did not run, or no run_command was offered', async () => {
      const refused: ToolSpec = { name: 'run_command', description: '', parameters: {}, risk: 'execute', source: 'sandbox', execute: async () => ({ error: true, code: 'not_set_up', message: 'nope' }) };
      expect(text(await drain(new MockChatEngine({ sleep: fakeSleep() }).stream(makeRequest('#run ls', { tools: [refused] }))))).toMatch(/^The command didn't run: /);
      const bare = await drain(new MockChatEngine({ sleep: fakeSleep() }).stream(makeRequest('#run ls')));
      expect(bare).toContainEqual(expect.objectContaining({ type: 'tool-result', name: 'run_command', isError: true }));
    });
  });

  describe('#slow trigger', () => {
    it('streams exactly 20 chunks at 400ms each', async () => {
      const sleep = fakeSleep();
      const engine = new MockChatEngine({ sleep });

      const events = await drain(engine.stream(makeRequest('#slow please')));

      const deltas = events.filter((e) => e.type === 'text-delta');
      expect(deltas).toHaveLength(20);
      expect(events.at(-1)?.type).toBe('finish');

      const chunkDelays = sleep.mock.calls.map((call) => call[0]);
      expect(chunkDelays).toEqual(Array(20).fill(400));
    });
  });

  describe('#fail trigger', () => {
    it('emits a single rate_limit error event and nothing else', async () => {
      const engine = new MockChatEngine({ sleep: fakeSleep() });

      const events = await drain(engine.stream(makeRequest('please #fail now')));

      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({
        type: 'error',
        error: expect.objectContaining({ kind: 'rate_limit', retryable: true }),
      });
    });
  });

  describe('#long trigger', () => {
    it('streams roughly 2000 tokens across many chunks', async () => {
      const sleep = fakeSleep();
      const engine = new MockChatEngine({ sleep });

      const events = await drain(engine.stream(makeRequest('#long please')));

      const deltas = events.filter((e): e is Extract<EngineEvent, { type: 'text-delta' }> => e.type === 'text-delta');
      expect(deltas.length).toBeGreaterThan(10);

      const finish = events.at(-1);
      expect(finish?.type).toBe('finish');
      if (finish?.type === 'finish') {
        expect(finish.usage.tokensOut).toBeGreaterThanOrEqual(1800);
        expect(finish.usage.tokensOut).toBeLessThanOrEqual(2200);
      }
    });
  });

  describe('abort handling', () => {
    it('yields nothing when the signal is already aborted before iteration starts', async () => {
      const controller = new AbortController();
      controller.abort();
      const engine = new MockChatEngine({ sleep: fakeSleep() });

      const events = await drain(engine.stream(makeRequest('hello', { signal: controller.signal })));

      expect(events).toEqual([]);
    });

    it('stops yielding once aborted mid-stream', async () => {
      const controller = new AbortController();
      let calls = 0;
      const sleep = vi.fn(async (_ms: number, _signal: AbortSignal) => {
        calls += 1;
        if (calls === 2) controller.abort();
      });
      const engine = new MockChatEngine({ sleep });

      const events = await drain(engine.stream(makeRequest('#slow please', { signal: controller.signal })));

      const deltas = events.filter((e) => e.type === 'text-delta');
      expect(deltas.length).toBeLessThan(20);
      expect(events.some((e) => e.type === 'finish')).toBe(false);
    });
  });

  describe('listModels / testConnection', () => {
    it('lists at least one plausible mock model', async () => {
      const engine = new MockChatEngine();
      const models = await engine.listModels(makeResolvedProfile().connection, null);
      expect(models.length).toBeGreaterThan(0);
      expect(models[0]).toMatchObject({ modelId: expect.any(String), displayName: expect.any(String) });
    });

    it('always reports a successful connection test', async () => {
      const engine = new MockChatEngine();
      const result = await engine.testConnection(makeResolvedProfile().connection, null);
      expect(result.ok).toBe(true);
      expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    });
  });

  describe('#todos, #ask and #plan triggers', () => {
    const textOf = (events: EngineEvent[]) => events.filter((e) => e.type === 'text-delta').map((e) => (e as { text: string }).text).join('');

    it('#todos updates the checklist three times through the real tool, then says it is done', async () => {
      const execute = vi.fn(async () => 'Checklist updated.');
      const todos: ToolSpec = { name: 'update_todos', description: '', parameters: {}, risk: 'read', source: 'thread', execute };
      const sleep = fakeSleep();
      const events = await drain(new MockChatEngine({ sleep }).stream(makeRequest('#todos', { tools: [todos] })));
      const calls = events.filter((e) => e.type === 'tool-call') as Extract<EngineEvent, { type: 'tool-call' }>[];
      expect(calls.map((c) => c.name)).toEqual(['update_todos', 'update_todos', 'update_todos']);
      expect((calls[0]!.args as { todos: { status: string }[] }).todos.map((t) => t.status)).toEqual(['in_progress', 'pending']);
      expect((calls[2]!.args as { todos: { status: string }[] }).todos.map((t) => t.status)).toEqual(['completed', 'completed']);
      expect(execute).toHaveBeenCalledTimes(3);
      expect(sleep.mock.calls.filter(([ms]) => ms === 1500)).toHaveLength(2);
      expect(textOf(events)).toBe('All done.');
    });

    it('#ask asks which colour through the real tool and repeats the answer', async () => {
      const execute = vi.fn(async () => 'User has answered your questions: "Which colour?"="Blue".');
      const ask: ToolSpec = { name: 'ask_user', description: '', parameters: {}, risk: 'read', source: 'thread', execute };
      const events = await drain(new MockChatEngine({ sleep: fakeSleep() }).stream(makeRequest('#ask', { tools: [ask] })));
      expect((execute.mock.calls[0]![0] as { questions: { question: string; options: { label: string }[] }[] }).questions[0]).toMatchObject({ question: 'Which colour?', options: [{ label: 'Red' }, { label: 'Blue' }] });
      expect(textOf(events)).toBe('You said: User has answered your questions: "Which colour?"="Blue".');
    });

    it('#plan is refused a write, revises its plan after changes, and writes once approved', async () => {
      const writes: unknown[] = [];
      const writeFile: ToolSpec = {
        name: 'write_file', description: '', parameters: {}, risk: 'mutate', source: 'fs',
        execute: async (args, ctx) => {
          if (ctx.plan && !ctx.plan.approved) return { error: true, code: 'plan_mode', message: PLAN_REFUSAL };
          writes.push(args);
          return 'Wrote planned.txt';
        },
      };
      const answers = [planChangesText('smaller'), PLAN_APPROVED];
      const plans: string[] = [];
      const propose: ToolSpec = {
        name: 'propose_plan', description: '', parameters: {}, risk: 'read', source: 'thread',
        execute: async (args, ctx) => {
          plans.push((args as { plan: string }).plan);
          const answer = answers.shift()!;
          if (answer === PLAN_APPROVED) ctx.plan?.approve();
          return answer;
        },
      };
      const events = await drain(new MockChatEngine({ sleep: fakeSleep() }).stream(makeRequest('#plan', { tools: [writeFile, propose], plan: createPlanGate() })));
      expect(events.filter((e) => e.type === 'tool-call').map((e) => (e as { name: string }).name)).toEqual(['write_file', 'propose_plan', 'propose_plan', 'write_file']);
      expect(plans).toEqual(['1. Write planned.txt', '1. Write planned.txt (revised)']);
      expect(writes).toEqual([{ path: 'planned.txt', content: 'planned' }]);
      expect(textOf(events)).toBe('Done: Wrote planned.txt');
    });

    it('#plan stops proposing on an unattended answer and writes nothing', async () => {
      const writeFile: ToolSpec = { name: 'write_file', description: '', parameters: {}, risk: 'mutate', source: 'fs', execute: async () => ({ error: true, code: 'plan_mode', message: PLAN_REFUSAL }) };
      const propose: ToolSpec = { name: 'propose_plan', description: '', parameters: {}, risk: 'read', source: 'thread', execute: vi.fn(async () => UNATTENDED_PLAN) };
      const events = await drain(new MockChatEngine({ sleep: fakeSleep() }).stream(makeRequest('#plan', { tools: [writeFile, propose], plan: createPlanGate() })));
      expect(propose.execute).toHaveBeenCalledTimes(1);
      expect(events.filter((e) => e.type === 'tool-call')).toHaveLength(2);
      expect(textOf(events)).toContain('No plan was approved');
    });
  });

  describe('unattended turns', () => {
    it('#tool, #artifact and #recall hand their tool an unattended context when the turn is unattended, and only then', async () => {
      const seen: Record<string, boolean | undefined> = {};
      const spec = (name: string, source: ToolSpec['source']): ToolSpec => ({
        name,
        description: '',
        parameters: {},
        risk: 'read',
        source,
        execute: async (_args: unknown, ctx: ToolContext) => {
          seen[name] = ctx.unattended;
          return name === 'recall' ? { projects: [], chats: [] } : { ok: true };
        },
      });
      const tools = [spec('read_file', 'fs'), spec('artifact', 'artifact'), spec('recall', 'recall')];

      for (const prompt of ['#tool notes.txt', '#artifact', '#recall x']) {
        await drain(new MockChatEngine({ sleep: fakeSleep() }).stream(makeRequest(prompt, { tools, unattended: true, workspaceRoot: '/ws' })));
      }
      expect(seen).toEqual({ read_file: true, artifact: true, recall: true });

      await drain(new MockChatEngine({ sleep: fakeSleep() }).stream(makeRequest('#recall x', { tools })));
      expect(seen['recall']).toBeUndefined();
    });
  });

  describe('#echo-system', () => {
    function systemMessage(text: string): CanonMessage {
      return { id: 'system:p', chatId: 'chat-1', parentId: null, role: 'system', parts: [{ type: 'text', text }], status: 'complete', error: null, producedBy: null, createdAt: 0 };
    }

    it('replies with the system prompt it was given, for checking what a turn sent (e2e)', async () => {
      const engine = new MockChatEngine({ sleep: fakeSleep() });
      const events = await drain(engine.stream(makeRequest('#echo-system', { messages: [systemMessage('# Project memory: Alpha\n- pinned-fact'), userMessage('#echo-system')] })));
      const text = events.filter((e) => e.type === 'text-delta').map((e) => (e as Extract<EngineEvent, { type: 'text-delta' }>).text).join('');
      expect(text).toBe('# Project memory: Alpha - pinned-fact');
      expect(events.at(-1)?.type).toBe('finish');
    });

    it('says so when there is no system prompt', async () => {
      const engine = new MockChatEngine({ sleep: fakeSleep() });
      const events = await drain(engine.stream(makeRequest('#echo-system')));
      const text = events.filter((e) => e.type === 'text-delta').map((e) => (e as Extract<EngineEvent, { type: 'text-delta' }>).text).join('');
      expect(text).toBe('No system prompt.');
    });
  });
});

const replyText = (events: EngineEvent[]) => events.filter((e) => e.type === 'text-delta').map((e) => (e as { text: string }).text).join('');

describe('#office trigger', () => {
  const artifactTool = () => {
    const execute = vi.fn(async () => ({ ok: true, command: 'create', slug: 'x', number: 1 }));
    const tool: ToolSpec = { name: 'artifact', description: '', parameters: {}, risk: 'read', source: 'artifact', execute };
    return { tool, execute };
  };

  it('#office spreadsheet makes the budget through the real artifact tool, then answers', async () => {
    const { tool, execute } = artifactTool();
    const events = await drain(new MockChatEngine({ sleep: fakeSleep() }).stream(makeRequest('#office spreadsheet', { tools: [tool] })));
    const call = events.find((e): e is Extract<EngineEvent, { type: 'tool-call' }> => e.type === 'tool-call')!;
    expect(call.args).toMatchObject({ command: 'create', id: 'budget', kind: 'spreadsheet', title: 'Mock budget' });
    expect(JSON.parse((call.args as { content: string }).content).sheets[0].rows[3]).toEqual(['Total', '=SUM(B2:B3)']);
    expect(execute).toHaveBeenCalledOnce();
    expect(replyText(events)).toBe('I made the file.');
    expect(events.at(-1)).toMatchObject({ type: 'finish' });
  });

  it('#office document makes the memo', async () => {
    const { tool } = artifactTool();
    const events = await drain(new MockChatEngine({ sleep: fakeSleep() }).stream(makeRequest('#office document', { tools: [tool] })));
    expect(events).toContainEqual(expect.objectContaining({ type: 'tool-call', args: expect.objectContaining({ id: 'memo', kind: 'document', title: 'Mock memo', content: expect.stringContaining('# Quarterly memo') }) }));
  });

  it('#office presentation makes the deck', async () => {
    const { tool } = artifactTool();
    const events = await drain(new MockChatEngine({ sleep: fakeSleep() }).stream(makeRequest('#office presentation', { tools: [tool] })));
    const call = events.find((e): e is Extract<EngineEvent, { type: 'tool-call' }> => e.type === 'tool-call')!;
    expect(call.args).toMatchObject({ id: 'deck', kind: 'presentation', title: 'Mock deck' });
    expect(JSON.parse((call.args as { content: string }).content).slides.map((s: { title: string }) => s.title)).toEqual(['Mock review', 'Highlights']);
  });

  it('#office with a kind it has no sample for falls through to the usual reply', async () => {
    const events = await drain(new MockChatEngine({ sleep: fakeSleep() }).stream(makeRequest('#office banana')));
    expect(events.some((e) => e.type === 'tool-call')).toBe(false);
  });

  it('every sample passes the checks the artifact tool runs', () => {
    for (const [kind, sample] of Object.entries(OFFICE_SAMPLES)) expect(checkOfficeContent(kind, sample.content), kind).toBeNull();
  });
});

describe('#echo-user trigger', () => {
  it("replies with the latest user message's text as the request carries it, an attached file's text included", async () => {
    const req = makeRequest('#echo-user');
    req.messages[0]!.parts.push({ type: 'text', text: '<attached-file name="memo.docx">\nGrunt reads this memo\n</attached-file>' });
    const events = await drain(new MockChatEngine({ sleep: fakeSleep() }).stream(req));
    expect(replyText(events)).toContain('Grunt reads this memo');
  });
});
