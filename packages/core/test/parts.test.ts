import { describe, expect, it } from 'vitest';
import type { Part } from '../src/types/messages.js';
import {
  appendDelta,
  applySubagentEvent,
  isSubagentEvent,
  subagentPartEvents,
  type SubagentEvent,
  type SubagentPart,
} from '../src/domain/parts.js';

const start: SubagentEvent = { type: 'start', label: 'Check the logs', prompt: 'Look in logs/', profileId: 'p1', profileName: 'Cheap', modelId: 'small-1' };
const usage = { tokensIn: 120, tokensOut: 30, tokensCached: 0, tokensReasoning: 0 };

function fold(events: SubagentEvent[], callId = 'call-1', from: Part[] = []): Part[] {
  return events.reduce((parts, event) => applySubagentEvent(parts, callId, event), from);
}

describe('appendDelta', () => {
  it('merges into a trailing part of the same kind and starts a new one otherwise', () => {
    const parts = appendDelta(appendDelta(appendDelta([], 'text', 'Hel'), 'text', 'lo'), 'reasoning', 'hm');
    expect(parts).toEqual([{ type: 'text', text: 'Hello' }, { type: 'reasoning', text: 'hm' }]);
  });
});

describe('applySubagentEvent', () => {
  const run: SubagentEvent[] = [
    start,
    { type: 'running' },
    { type: 'reasoning-delta', text: 'Where ' },
    { type: 'reasoning-delta', text: 'to look?' },
    { type: 'tool-call', id: 't1', name: 'read_file', args: { path: 'logs/a.log' } },
    { type: 'tool-result', id: 't1', name: 'read_file', result: 'ERROR at 12:00', isError: false },
    { type: 'notice', text: 'A note.' },
    { type: 'text-delta', text: 'One error, ' },
    { type: 'text-delta', text: 'at 12:00.' },
    { type: 'end', status: 'complete', usage },
  ];

  it('folds a whole run into one finished subagent part, after the parts already there', () => {
    const parts = fold(run, 'call-1', [{ type: 'text', text: 'Let me check.' }]);
    expect(parts).toEqual([
      { type: 'text', text: 'Let me check.' },
      {
        type: 'subagent',
        callId: 'call-1',
        label: 'Check the logs',
        prompt: 'Look in logs/',
        profileId: 'p1',
        profileName: 'Cheap',
        modelId: 'small-1',
        status: 'complete',
        usage,
        parts: [
          { type: 'reasoning', text: 'Where to look?' },
          { type: 'tool-call', id: 't1', name: 'read_file', args: { path: 'logs/a.log' } },
          { type: 'tool-result', id: 't1', name: 'read_file', result: 'ERROR at 12:00', isError: false },
          { type: 'notice', text: 'A note.' },
          { type: 'text', text: 'One error, at 12:00.' },
        ],
      },
    ]);
  });

  it('starts queued, and a second start for the same call changes nothing', () => {
    const once = fold([start]);
    expect((once[0] as SubagentPart).status).toBe('queued');
    expect(applySubagentEvent(once, 'call-1', start)).toBe(once);
  });

  it('keeps two sub-agents apart by call id', () => {
    const parts = fold([start], 'b', fold([start], 'a'));
    const both = applySubagentEvent(applySubagentEvent(parts, 'a', { type: 'text-delta', text: 'A' }), 'b', { type: 'text-delta', text: 'B' });
    expect(both.map((p) => (p as SubagentPart).parts)).toEqual([[{ type: 'text', text: 'A' }], [{ type: 'text', text: 'B' }]]);
  });

  it('ignores an event for an unknown call id', () => {
    const parts: Part[] = [{ type: 'text', text: 'x' }];
    expect(applySubagentEvent(parts, 'nope', { type: 'text-delta', text: 'y' })).toBe(parts);
    expect(applySubagentEvent(parts, 'nope', { type: 'end', status: 'error', error: 'boom' })).toBe(parts);
  });

  it('keeps a finished sub-agent finished: late events change nothing', () => {
    for (const status of ['complete', 'error', 'cancelled'] as const) {
      const done = fold([start, { type: 'running' }, { type: 'text-delta', text: 'a' }, { type: 'end', status }]);
      for (const late of [{ type: 'running' }, { type: 'text-delta', text: 'b' }, { type: 'tool-call', id: 't', name: 'n', args: 1 }, { type: 'end', status: 'complete', usage }] as SubagentEvent[]) {
        expect(applySubagentEvent(done, 'call-1', late)).toBe(done);
      }
    }
  });

  it('stores only the four usage fields on end', () => {
    const noisy = { ...usage, extra: 'x' } as typeof usage;
    const parts = fold([start, { type: 'end', status: 'complete', usage: noisy }]);
    expect((parts[0] as SubagentPart).usage).toEqual(usage);
    expect(Object.keys((parts[0] as SubagentPart).usage!)).toHaveLength(4);
  });

  it('records an error on end', () => {
    const parts = fold([start, { type: 'running' }, { type: 'end', status: 'error', error: 'Rate limited.' }]);
    expect(parts[0]).toMatchObject({ status: 'error', error: 'Rate limited.' });
  });
});

describe('subagentPartEvents', () => {
  it('rebuilds a stored part: folding its events again gives the same part', () => {
    const stored = fold([
      start,
      { type: 'running' },
      { type: 'tool-call', id: 't1', name: 'read_file', args: { path: 'a' } },
      { type: 'tool-result', id: 't1', name: 'read_file', result: 'x', isError: true },
      { type: 'text-delta', text: 'Could not read it.' },
      { type: 'end', status: 'complete', usage },
    ])[0] as SubagentPart;
    expect(fold(subagentPartEvents(stored))).toEqual([stored]);
  });

  it('keeps when it started and finished, and gives them back when rebuilt', () => {
    const stored = fold([start, { type: 'running', at: 1000 }, { type: 'running', at: 2000 }, { type: 'end', status: 'complete', at: 5000 }])[0] as SubagentPart;
    // The first start counts; a repeated running doesn't move it.
    expect(stored).toMatchObject({ startedAt: 1000, finishedAt: 5000 });
    expect(fold(subagentPartEvents(stored))).toEqual([stored]);
  });

  it('refuses a time that is not a sensible number from a peer', () => {
    expect(isSubagentEvent({ type: 'running', at: 1000 })).toBe(true);
    expect(isSubagentEvent({ type: 'running', at: 'soon' })).toBe(false);
    expect(isSubagentEvent({ type: 'end', status: 'complete', at: -1 })).toBe(false);
  });

  it('leaves out running for a queued part and end for an unfinished one', () => {
    const queued = fold([start])[0] as SubagentPart;
    expect(subagentPartEvents(queued).map((e) => e.type)).toEqual(['start']);
    const running = fold([start, { type: 'running' }, { type: 'text-delta', text: 'so far' }])[0] as SubagentPart;
    expect(subagentPartEvents(running).map((e) => e.type)).toEqual(['start', 'running', 'text-delta']);
  });
});

describe('isSubagentEvent', () => {
  it('accepts every well-formed event', () => {
    for (const event of [start, { type: 'running' }, { type: 'text-delta', text: 'a' }, { type: 'tool-call', id: 'x', name: 'y', args: 1 }, { type: 'tool-result', id: 'x', name: 'y', result: null, isError: false }, { type: 'end', status: 'cancelled' }, { type: 'end', status: 'complete', usage }]) {
      expect(isSubagentEvent(event)).toBe(true);
    }
  });

  it('refuses malformed ones (as a paired machine could send)', () => {
    for (const bad of [null, 'start', [], { type: 'start', label: 1 }, { type: 'text-delta' }, { type: 'tool-result', id: 'x', name: 'y' }, { type: 'end', status: 'exploded' }, { type: 'end', status: 'error', error: 3 }, { type: 'end', status: 'complete', usage: { tokensIn: 'lots' } }, { type: 'end', status: 'complete', usage: null }, { type: 'end', status: 'complete', usage: { ...usage, tokensOut: -1 } }, { type: 'end', status: 'complete', usage: { ...usage, tokensIn: Infinity } }, { type: 'end', status: 'complete', usage: { ...usage, tokensIn: NaN } }, { type: 'subagent' }]) {
      expect(isSubagentEvent(bad)).toBe(false);
    }
  });
});
