import { describe, expect, it } from 'vitest';
import { continuedTitle, isHandoverRequest, nextAskAt, suggestsHandover, summaryOf } from '../src/domain/handover.js';
import type { CanonMessage, Part } from '../src/types/messages.js';

const settings = { handoverEnabled: true, handoverThresholdTokens: 300_000 };
const chat = (over: Partial<{ contextTokens: number | null; handoverAskAt: number | null; handoverSuggest: boolean }> = {}) => ({
  contextTokens: 300_000,
  handoverAskAt: null,
  handoverSuggest: true,
  ...over,
});
const message = (role: 'user' | 'assistant', parts: Part[]): CanonMessage => ({
  id: 'm1',
  chatId: 'c1',
  parentId: null,
  role,
  parts,
  status: 'complete',
  error: null,
  producedBy: null,
  createdAt: 1,
});

describe('suggestsHandover', () => {
  it('needs a measurement, the chat switched on and the setting on', () => {
    expect(suggestsHandover(chat({ contextTokens: null }), settings)).toBe(false);
    expect(suggestsHandover(chat({ handoverSuggest: false }), settings)).toBe(false);
    expect(suggestsHandover(chat(), { ...settings, handoverEnabled: false })).toBe(false);
  });

  it('suggests from the threshold up', () => {
    expect(suggestsHandover(chat({ contextTokens: 299_999 }), settings)).toBe(false);
    expect(suggestsHandover(chat({ contextTokens: 300_000 }), settings)).toBe(true);
  });

  it("uses the chat's own next ask over the setting once Not now was clicked", () => {
    expect(suggestsHandover(chat({ contextTokens: 420_000, handoverAskAt: 450_000 }), settings)).toBe(false);
    expect(suggestsHandover(chat({ contextTokens: 450_000, handoverAskAt: 450_000 }), settings)).toBe(true);
  });
});

describe('nextAskAt', () => {
  it('asks again at half as much again', () => {
    expect(nextAskAt(300_000)).toBe(450_000);
    expect(nextAskAt(420_123)).toBe(630_185);
  });
});

describe('continuedTitle', () => {
  it('marks the new chat as continued, counting repeats', () => {
    expect(continuedTitle('Rig')).toBe('Rig (continued)');
    expect(continuedTitle('Rig (continued)')).toBe('Rig (continued 2)');
    expect(continuedTitle('Rig (continued 2)')).toBe('Rig (continued 3)');
  });
});

describe('summaryOf', () => {
  it("joins a reply's text and leaves out its tool calls", () => {
    const m = message('assistant', [
      { type: 'text', text: '## Goal\nA rig. ' },
      { type: 'tool-call', id: 't1', name: 'Read', args: {} },
      { type: 'text', text: '## Next\nPrint it.' },
    ]);
    expect(summaryOf(m)).toBe('## Goal\nA rig.\n\n## Next\nPrint it.');
  });
});

describe('isHandoverRequest', () => {
  it('is a user message holding a handover-request part', () => {
    expect(isHandoverRequest(message('user', [{ type: 'handover-request' }]))).toBe(true);
    expect(isHandoverRequest(message('user', [{ type: 'text', text: 'hi' }]))).toBe(false);
    expect(isHandoverRequest(message('assistant', [{ type: 'handover-request' }]))).toBe(false);
  });
});
