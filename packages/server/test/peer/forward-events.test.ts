import { describe, expect, it } from 'vitest';
import type { Part } from '@otherbench/core/types/messages.js';
import { cutOffParts, turnReplies, withEvent } from '../../src/peer/forward.js';

describe('withEvent (a kept copy of a reply running on another machine)', () => {
  it('folds relayed subagent events into the parts', () => {
    let parts: Part[] = [];
    parts = withEvent(parts, { type: 'subagent', callId: 'c1', event: { type: 'start', label: 'Helper', prompt: 'p', profileId: 'pid', profileName: 'P', modelId: 'm' } });
    parts = withEvent(parts, { type: 'subagent', callId: 'c1', event: { type: 'running' } });
    parts = withEvent(parts, { type: 'subagent', callId: 'c1', event: { type: 'text-delta', text: 'hi' } });
    expect(parts).toEqual([{ type: 'subagent', callId: 'c1', label: 'Helper', prompt: 'p', profileId: 'pid', profileName: 'P', modelId: 'm', status: 'running', parts: [{ type: 'text', text: 'hi' }] }]);
  });

  it('ignores a malformed subagent event', () => {
    const parts: Part[] = [{ type: 'text', text: 'x' }];
    for (const bad of [{ type: 'subagent' }, { type: 'subagent', callId: 3, event: { type: 'running' } }, { type: 'subagent', callId: 'c', event: 'start' }, { type: 'subagent', callId: 'c', event: { type: 'start', label: 1 } }]) {
      expect(withEvent(parts, bad)).toBe(parts);
    }
  });
});

describe('cutOffParts (a reply kept after its machine went away)', () => {
  const card = (callId: string, status: 'queued' | 'running' | 'complete'): Part => ({ type: 'subagent', callId, label: callId, prompt: 'p', profileId: 'pid', profileName: 'P', modelId: 'm', status, parts: [] });

  it('closes every sub-agent card still queued or running as failed, naming the machine', () => {
    const parts = cutOffParts([{ type: 'text', text: 'x' }, card('a', 'queued'), card('b', 'running'), card('c', 'complete')], 'PC');
    expect(parts.map((p) => (p.type === 'subagent' ? [p.callId, p.status, p.error] : p.type))).toEqual([
      'text',
      ['a', 'error', 'PC stopped responding while this sub-agent was working.'],
      ['b', 'error', 'PC stopped responding while this sub-agent was working.'],
      ['c', 'complete', undefined],
    ]);
  });

  it('leaves parts with no unfinished card as they are', () => {
    const parts: Part[] = [{ type: 'text', text: 'x' }, card('c', 'complete')];
    expect(cutOffParts(parts, 'PC')).toBe(parts);
  });
});

describe('turnReplies (what this machine keeps of a turn it had another machine start)', () => {
  it("maps each reply to the profile the answer says ran it, as a compact turn runs a different one from the one asked for", () => {
    const replies = turnReplies('chat-1', { parentId: 'a0', parts: [{ type: 'text', text: '/compact' }], profileIds: ['p1', 'p2'] }, {
      userMessageId: 'u1', assistantMessageIds: ['r1'], profileIds: ['p2'], userParts: [{ type: 'context', kind: 'compact' }],
    });
    expect(replies).toEqual([
      { id: 'r1', reply: { chatId: 'chat-1', parentId: 'u1', profileId: 'p2', question: { id: 'u1', parentId: 'a0', parts: [{ type: 'context', kind: 'compact' }] }, at: expect.any(Number) } },
    ]);
  });

  it("falls back to the request's profiles and parts for an answer without them", () => {
    const replies = turnReplies('chat-1', { parentId: null, parts: [{ type: 'text', text: 'hi' }], profileIds: ['p1', 'p2'] }, { userMessageId: 'u1', assistantMessageIds: ['r1', 'r2'] });
    expect(replies.map((r) => [r.id, r.reply.profileId, r.reply.question?.parts])).toEqual([
      ['r1', 'p1', [{ type: 'text', text: 'hi' }]],
      ['r2', 'p2', [{ type: 'text', text: 'hi' }]],
    ]);
  });
});
