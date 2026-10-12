import { describe, expect, it } from 'vitest';
import type { Part } from '@grunt/core/types/messages.js';
import { withEvent } from '../../src/peer/forward.js';

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
