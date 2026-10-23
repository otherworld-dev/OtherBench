import { describe, expect, it } from 'vitest';
import type { TurnEvent } from '@otherbench/core/domain/turn.js';
import type { CanonMessage } from '@otherbench/core/types/messages.js';
import { applyEventToMessage, applyHelloBuffer, emptyExtras, replayEvents } from './reducer.js';

function baseMessage(overrides: Partial<CanonMessage> = {}): CanonMessage {
  return {
    id: 'm1',
    chatId: 'c1',
    parentId: 'u1',
    role: 'assistant',
    parts: [],
    status: 'streaming',
    error: null,
    producedBy: null,
    createdAt: 0,
    ...overrides,
  };
}

describe('applyEventToMessage', () => {
  it('starts a new text part on the first text-delta', () => {
    const { message } = applyEventToMessage(baseMessage(), emptyExtras, { messageId: 'm1', type: 'text-delta', text: 'Hi' });
    expect(message.parts).toEqual([{ type: 'text', text: 'Hi' }]);
  });

  it('merges consecutive text-deltas into the trailing text part', () => {
    let acc = applyEventToMessage(baseMessage(), emptyExtras, { messageId: 'm1', type: 'text-delta', text: 'Hello' });
    acc = applyEventToMessage(acc.message, acc.extras, { messageId: 'm1', type: 'text-delta', text: ' world' });
    expect(acc.message.parts).toEqual([{ type: 'text', text: 'Hello world' }]);
  });

  it('starts a fresh part when a tool-call interrupts a run of text-deltas', () => {
    let acc = applyEventToMessage(baseMessage(), emptyExtras, { messageId: 'm1', type: 'text-delta', text: 'before' });
    acc = applyEventToMessage(acc.message, acc.extras, { messageId: 'm1', type: 'tool-call', id: 't1', name: 'read_file', args: {} });
    acc = applyEventToMessage(acc.message, acc.extras, { messageId: 'm1', type: 'text-delta', text: 'after' });
    expect(acc.message.parts).toEqual([
      { type: 'text', text: 'before' },
      { type: 'tool-call', id: 't1', name: 'read_file', args: {} },
      { type: 'text', text: 'after' },
    ]);
  });

  it('records usage on finish without touching parts', () => {
    const usage = { tokensIn: 10, tokensOut: 5, tokensCached: 0, tokensReasoning: 0 };
    const { message, extras } = applyEventToMessage(baseMessage(), emptyExtras, {
      messageId: 'm1',
      type: 'finish',
      usage,
      finishReason: 'stop',
    });
    expect(extras.usage).toEqual(usage);
    expect(message.parts).toEqual([]);
  });

  it('records an error event on the message but leaves its status alone: the server keeps the turn streaming until the terminal status event', () => {
    const failed = applyEventToMessage(baseMessage({ status: 'streaming' }), emptyExtras, {
      messageId: 'm1',
      type: 'error',
      error: { kind: 'rate_limit', message: 'slow down', retryable: true },
    });
    expect(failed.message.status).toBe('streaming');
    expect(failed.message.error?.kind).toBe('rate_limit');
    const ended = applyEventToMessage(failed.message, failed.extras, { messageId: 'm1', type: 'status', status: 'error' });
    expect(ended.message.status).toBe('error');
  });

  it('applies a status event directly', () => {
    const { message } = applyEventToMessage(baseMessage(), emptyExtras, { messageId: 'm1', type: 'status', status: 'complete' });
    expect(message.status).toBe('complete');
  });

  it('appends a notice event as its own Part (task 21 capability-fallback disclosure), never merged into an adjacent text part', () => {
    let acc = applyEventToMessage(baseMessage(), emptyExtras, {
      messageId: 'm1',
      type: 'notice',
      text: '1 image attachment ("photo.png") sent as text to "local-llava" because this model does not support image input.',
    });
    expect(acc.message.parts).toEqual([
      { type: 'notice', text: '1 image attachment ("photo.png") sent as text to "local-llava" because this model does not support image input.' },
    ]);

    acc = applyEventToMessage(acc.message, acc.extras, { messageId: 'm1', type: 'text-delta', text: 'Based on the description...' });
    expect(acc.message.parts).toEqual([
      { type: 'notice', text: expect.stringContaining('does not support image input') },
      { type: 'text', text: 'Based on the description...' },
    ]);
  });

  it('an approval-request adds to pendingApprovals without touching parts/status', () => {
    const request = { id: 'req-1', chatId: 'c1', messageId: 'm1', toolName: 'write_file', risk: 'mutate' as const, source: 'fs' as const, args: { path: 'a.txt' }, summary: 'write_file(a.txt)' };
    const { message, extras } = applyEventToMessage(baseMessage(), emptyExtras, { messageId: 'm1', type: 'approval-request', request });
    expect(extras.pendingApprovals).toEqual([request]);
    expect(message).toEqual(baseMessage());
  });

  it('approval-resolved removes only the matching request, leaving siblings untouched', () => {
    const reqA = { id: 'req-a', chatId: 'c1', messageId: 'm1', toolName: 'write_file', risk: 'mutate' as const, source: 'fs' as const, args: {}, summary: 'a' };
    const reqB = { id: 'req-b', chatId: 'c1', messageId: 'm1', toolName: 'run_command', risk: 'execute' as const, source: 'shell' as const, args: {}, summary: 'b' };
    let acc = applyEventToMessage(baseMessage(), emptyExtras, { messageId: 'm1', type: 'approval-request', request: reqA });
    acc = applyEventToMessage(acc.message, acc.extras, { messageId: 'm1', type: 'approval-request', request: reqB });
    expect(acc.extras.pendingApprovals).toHaveLength(2);

    acc = applyEventToMessage(acc.message, acc.extras, { messageId: 'm1', type: 'approval-resolved', requestId: 'req-a', choice: 'once' });
    expect(acc.extras.pendingApprovals).toEqual([reqB]);
  });
});

describe('applyHelloBuffer', () => {
  it('reconstructs a message purely from an events list, ignoring the message shell passed in', () => {
    const shell = baseMessage({ parts: [{ type: 'text', text: 'STALE' }], status: 'error' });
    const events: TurnEvent[] = [
      { messageId: 'm1', type: 'text-delta', text: 'Hello' },
      { messageId: 'm1', type: 'text-delta', text: ' world' },
    ];
    const { message } = applyHelloBuffer(shell, events, 'streaming');
    expect(message.parts).toEqual([{ type: 'text', text: 'Hello world' }]);
    expect(message.status).toBe('streaming');
  });

  it('is idempotent: replaying the same buffer twice never duplicates text', () => {
    const events: TurnEvent[] = [
      { messageId: 'm1', type: 'text-delta', text: 'Hello' },
      { messageId: 'm1', type: 'text-delta', text: ' world' },
    ];
    const once = applyHelloBuffer(baseMessage(), events, 'streaming');
    const twice = applyHelloBuffer(once.message, events, 'streaming');
    expect(twice.message.parts).toEqual([{ type: 'text', text: 'Hello world' }]);
  });

  it('the authoritative status wins even if the last event implied something else', () => {
    const events: TurnEvent[] = [{ messageId: 'm1', type: 'text-delta', text: 'partial' }];
    const { message } = applyHelloBuffer(baseMessage(), events, 'complete');
    expect(message.status).toBe('complete');
  });
});

describe('replayEvents', () => {
  it('folds an empty list into a no-op', () => {
    const shell = baseMessage({ parts: [{ type: 'text', text: 'x' }] });
    const { message } = replayEvents(shell, emptyExtras, []);
    expect(message).toEqual(shell);
  });
});

describe('dead approval prompts', () => {
  const req = { id: 'req-1', chatId: 'c1', messageId: 'm1', toolName: 'write_file', risk: 'mutate' as const, source: 'fs' as const, args: {}, summary: 'a' };

  it.each(['complete', 'error', 'cancelled'] as const)('a terminal %s status drops every pending approval of that message', (status) => {
    const acc = applyEventToMessage(baseMessage(), emptyExtras, { messageId: 'm1', type: 'approval-request', request: req });
    const after = applyEventToMessage(acc.message, acc.extras, { messageId: 'm1', type: 'status', status });
    expect(after.extras.pendingApprovals).toEqual([]);
  });

  it('an error event does NOT drop them (the server may still be waiting on the card; only the terminal status ends it), and a streaming status does not either', () => {
    const acc = applyEventToMessage(baseMessage(), emptyExtras, { messageId: 'm1', type: 'approval-request', request: req });
    expect(applyEventToMessage(acc.message, acc.extras, { messageId: 'm1', type: 'status', status: 'streaming' }).extras.pendingApprovals).toEqual([req]);
    expect(applyEventToMessage(acc.message, acc.extras, { messageId: 'm1', type: 'error', error: { kind: 'rate_limit', message: 'x', retryable: true } }).extras.pendingApprovals).toEqual([req]);
  });
});

describe('asks', () => {
  const ask = { kind: 'question' as const, toolName: 'ask_user', questions: [], id: 'a1', chatId: 'c1', messageId: 'm1' };
  it('adds a pending ask on ask-request and removes it on ask-resolved', () => {
    let acc = applyEventToMessage(baseMessage(), emptyExtras, { messageId: 'm1', type: 'ask-request', ask });
    expect(acc.extras.pendingAsks).toEqual([ask]);
    acc = applyEventToMessage(acc.message, acc.extras, { messageId: 'm1', type: 'ask-resolved', askId: 'a1' });
    expect(acc.extras.pendingAsks).toEqual([]);
  });
  it('drops pending asks when the message stops streaming, and keeps them across a hello replay', () => {
    const asked = applyEventToMessage(baseMessage(), emptyExtras, { messageId: 'm1', type: 'ask-request', ask });
    expect(applyEventToMessage(asked.message, asked.extras, { messageId: 'm1', type: 'status', status: 'cancelled' }).extras.pendingAsks ?? []).toEqual([]);
    expect(applyHelloBuffer(baseMessage(), [{ messageId: 'm1', type: 'ask-request', ask }], 'streaming').extras.pendingAsks).toEqual([ask]);
  });
});

describe('error mid-step (server keeps streaming)', () => {
  const req = { id: 'req-1', chatId: 'c1', messageId: 'm1', toolName: 'write_file', risk: 'mutate' as const, source: 'fs' as const, args: {}, summary: 'a' };

  it('a hello replay of [approval-request, error] on a still-streaming message keeps the card and the streaming status', () => {
    const { message, extras } = applyHelloBuffer(baseMessage(), [
      { messageId: 'm1', type: 'approval-request', request: req },
      { messageId: 'm1', type: 'error', error: { kind: 'rate_limit', message: 'overloaded', retryable: true } },
    ], 'streaming');
    expect(message.status).toBe('streaming');
    expect(extras.pendingApprovals).toEqual([req]);
  });
});

describe('subagent events', () => {
  const start: TurnEvent = { messageId: 'm1', type: 'subagent', callId: 'c1', event: { type: 'start', label: 'Helper', prompt: 'Look.', profileId: 'p', profileName: 'P', modelId: 'm' } };
  const delta: TurnEvent = { messageId: 'm1', type: 'subagent', callId: 'c1', event: { type: 'text-delta', text: 'Found it.' } };
  const end: TurnEvent = { messageId: 'm1', type: 'subagent', callId: 'c1', event: { type: 'end', status: 'complete' } };

  it('folds a sub-agent into a card part on the message', () => {
    const { message } = replayEvents(baseMessage(), emptyExtras, [start, { messageId: 'm1', type: 'subagent', callId: 'c1', event: { type: 'running' } }, delta, end]);
    expect(message.parts).toEqual([
      { type: 'subagent', callId: 'c1', label: 'Helper', prompt: 'Look.', profileId: 'p', profileName: 'P', modelId: 'm', status: 'complete', parts: [{ type: 'text', text: 'Found it.' }] },
    ]);
  });

  it('ignores a malformed sub-agent event instead of folding it', () => {
    const live = replayEvents(baseMessage(), emptyExtras, [start]).message;
    const bad = [
      { messageId: 'm1', type: 'subagent', callId: 7, event: { type: 'running' } },
      { messageId: 'm1', type: 'subagent', callId: 'c1', event: { type: 'start', label: 1 } },
      { messageId: 'm1', type: 'subagent', callId: 'c1', event: 'end' },
      { messageId: 'm1', type: 'subagent', callId: 'c1' },
    ] as unknown as TurnEvent[];
    const { message } = replayEvents(live, emptyExtras, bad);
    expect(message.parts).toBe(live.parts);
  });

  it('replays a hello buffer of sub-agent events without duplicating the card', () => {
    const live = replayEvents(baseMessage(), emptyExtras, [start, delta]).message;
    const { message } = applyHelloBuffer(live, [start, delta, end], 'complete');
    expect(message.parts).toHaveLength(1);
    expect(message.parts[0]).toMatchObject({ status: 'complete', parts: [{ type: 'text', text: 'Found it.' }] });
  });
});

describe('tool-progress', () => {
  const progress: TurnEvent = { messageId: 'm1', type: 'tool-progress', callId: 't1', progress: { stage: 'generating', step: 4, steps: 20 } };

  it('replays tool-progress from hello', () => {
    const call: TurnEvent = { messageId: 'm1', type: 'tool-call', id: 't1', name: 'generate_image', args: { prompt: 'p' } };
    const replayed = applyHelloBuffer(baseMessage(), [call, progress], 'streaming');
    expect(replayed.extras.progressByCall).toEqual({ t1: { stage: 'generating', step: 4, steps: 20 } });
    const after = applyEventToMessage(replayed.message, replayed.extras, { messageId: 'm1', type: 'tool-result', id: 't1', name: 'generate_image', result: [], isError: false });
    expect(after.extras.progressByCall ?? {}).toEqual({});
  });

  it('keeps the latest progress per call and drops it all when the message stops streaming', () => {
    let acc = replayEvents(baseMessage(), emptyExtras, [progress, { ...progress, progress: { stage: 'saving' } }]);
    expect(acc.extras.progressByCall).toEqual({ t1: { stage: 'saving' } });
    acc = applyEventToMessage(acc.message, acc.extras, { messageId: 'm1', type: 'status', status: 'cancelled' });
    expect(acc.extras.progressByCall ?? {}).toEqual({});
  });
});

describe('user-note', () => {
  it('reducer appends a user-note part', () => {
    const part = { type: 'user-note' as const, noteId: 'n1', text: 'also this', attachments: [] };
    const { message } = applyEventToMessage(baseMessage(), emptyExtras, { messageId: 'm1', type: 'user-note', part });
    expect(message.parts).toEqual([part]);
  });
});
