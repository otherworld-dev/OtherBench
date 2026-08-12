import { describe, expect, it } from 'vitest';
import type { TurnEvent } from '@grunt/core/domain/turn.js';
import type { CanonMessage } from '@grunt/core/types/messages.js';
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

  it('maps a cancelled error kind to cancelled status, other kinds to error status', () => {
    const cancelled = applyEventToMessage(baseMessage(), emptyExtras, {
      messageId: 'm1',
      type: 'error',
      error: { kind: 'cancelled', message: 'stopped', retryable: false },
    });
    expect(cancelled.message.status).toBe('cancelled');

    const failed = applyEventToMessage(baseMessage(), emptyExtras, {
      messageId: 'm1',
      type: 'error',
      error: { kind: 'rate_limit', message: 'slow down', retryable: true },
    });
    expect(failed.message.status).toBe('error');
    expect(failed.message.error?.kind).toBe('rate_limit');
  });

  it('applies a status event directly', () => {
    const { message } = applyEventToMessage(baseMessage(), emptyExtras, { messageId: 'm1', type: 'status', status: 'complete' });
    expect(message.status).toBe('complete');
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
