import { describe, expect, it } from 'vitest';
import type { Part } from '@otherbench/core/types/messages.js';
import { cutOffParts, withEvent } from '../../src/peer/forward.js';

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
