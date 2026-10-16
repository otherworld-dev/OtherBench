import { describe, expect, it, vi } from 'vitest';
import type { ToolContext, ToolSpec } from '@otherbench/core/ports/tool-provider.js';
import { runRelayed } from '../src/relay.js';
import { ApprovalTickets, MAX_TICKETS, ticketKey } from '../src/tickets.js';

describe('ApprovalTickets', () => {
  it('hands each approved call its described arguments once, by tool and exact input', () => {
    const t = new ApprovalTickets();
    t.add('browser', { command: 'open', url: 'example.com' }, { host: 'example.com', n: 1 });
    t.add('browser', { command: 'open', url: 'example.com' }, { host: 'example.com', n: 2 });
    expect(t.take('browser', { command: 'open', url: 'other.test' })).toBeNull();
    expect(t.take('other', { command: 'open', url: 'example.com' })).toBeNull();
    expect(t.take('browser', { command: 'open', url: 'example.com' })).toEqual({ args: { host: 'example.com', n: 1 } });
    expect(t.take('browser', { command: 'open', url: 'example.com' })).toEqual({ args: { host: 'example.com', n: 2 } });
    expect(t.take('browser', { command: 'open', url: 'example.com' })).toBeNull();
    expect(t.size).toBe(0);
  });

  it(`keeps at most ${MAX_TICKETS} per reply: past that the oldest is dropped, and its call finds no approval when it arrives`, () => {
    const t = new ApprovalTickets();
    // The oldest two, under two keys, with a later ticket of the first key behind them.
    t.add('browser', { n: 'a' }, { host: 'a', i: 0 });
    t.add('computer', { n: 'b' }, { i: 1 });
    for (let i = 2; i < MAX_TICKETS - 1; i++) t.add('browser', { n: i }, { i });
    t.add('browser', { n: 'a' }, { host: 'a', i: 'later' });
    expect(t.size).toBe(MAX_TICKETS);
    // One more: the oldest of all goes, not the oldest of the key just added.
    t.add('computer', { n: 'new' }, { i: 'new' });
    expect(t.size).toBe(MAX_TICKETS);
    expect(t.take('browser', { n: 'a' })).toEqual({ args: { host: 'a', i: 'later' } });
    expect(t.take('browser', { n: 'a' })).toBeNull();
    expect(t.take('computer', { n: 'b' })).toEqual({ args: { i: 1 } });
    expect(t.take('computer', { n: 'new' })).toEqual({ args: { i: 'new' } });
    // Taken tickets free their place: nothing else is dropped.
    t.add('browser', { n: 'x' }, { i: 'x' });
    t.add('browser', { n: 'y' }, { i: 'y' });
    expect(t.take('browser', { n: 2 })).toEqual({ args: { i: 2 } });
    expect(t.size).toBe(MAX_TICKETS - 2);
  });

  it('refuses the call whose ticket was dropped, through the relay', async () => {
    const t = new ApprovalTickets();
    const execute = vi.fn(async (args: unknown) => args);
    const spec: ToolSpec = { name: 'computer', description: '', parameters: {}, risk: 'mutate', source: 'computer', describeCall: async (a) => ({ args: a as Record<string, unknown>, risk: 'mutate' }), execute };
    const ctx: ToolContext = { chatId: 'c', messageId: 'm', profileId: 'p', workspaceRoot: null, signal: new AbortController().signal };
    t.add('computer', { action: 'left_click', coordinate: [1, 2] }, { approved: 'first' });
    for (let i = 0; i < MAX_TICKETS; i++) t.add('computer', { action: 'wait', duration: i }, { approved: i });
    expect(await runRelayed(spec, { action: 'left_click', coordinate: [1, 2] }, ctx, t)).toMatchObject({ error: true, code: 'no_approval' });
    expect(execute).not.toHaveBeenCalled();
    expect(await runRelayed(spec, { action: 'wait', duration: 0 }, ctx, t)).toEqual({ approved: 0 });
  });

  it('forgets everything on clear', () => {
    const t = new ApprovalTickets();
    t.add('browser', {}, { host: 'a' });
    t.clear();
    expect(t.take('browser', {})).toBeNull();
    expect(ticketKey('browser', undefined)).toBe(ticketKey('browser', {}));
  });
});
