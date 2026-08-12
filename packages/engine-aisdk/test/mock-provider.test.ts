import { describe, it, expect, vi } from 'vitest';
import type { EngineEvent, EngineRequest } from '@grunt/core/ports/chat-engine.js';
import type { CanonMessage } from '@grunt/core/types/messages.js';
import type { ResolvedProfile } from '@grunt/core/types/config.js';
import { MockChatEngine } from '../src/mock-provider.js';

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
});
