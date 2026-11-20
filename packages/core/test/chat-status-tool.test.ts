import { describe, expect, it } from 'vitest';
import { agentStatusOf, failedStatusCalls, parseChatStatus, runStatusCommand, STATUS_TOOL, SUBAGENT_STATUS_REFUSAL, groupLeft, waitingOnUser } from '../src/domain/chat-status-tool.js';
import { PermissionBroker } from '../src/domain/permissions.js';
import { SUBAGENT_THREAD_REFUSAL } from '../src/domain/permissions/sources.js';
import { PLAN_TOOL } from '../src/domain/thread-tools.js';
import type { ToolContext, ToolSpec } from '../src/ports/tool-provider.js';
import type { ToolPolicy } from '../src/types/config.js';
import type { Part } from '../src/types/messages.js';
import { InMemoryStore } from '../src/testing/fakes.js';

const call = (id: string, args: unknown): Part => ({ type: 'tool-call', id, name: STATUS_TOOL, args });
const ok = (id: string): Part => ({ type: 'tool-result', id, name: STATUS_TOOL, result: 'Status set.', isError: false });
const failed = (id: string): Part => ({ type: 'tool-result', id, name: STATUS_TOOL, result: 'no', isError: true });

describe('parseChatStatus', () => {
  it('takes done with no items', () => {
    expect(parseChatStatus({ done: true })).toEqual({ done: true, left: [] });
    expect(parseChatStatus({ done: true, left: [] })).toEqual({ done: true, left: [] });
  });

  it('takes a null list as no list, as some providers send unset fields', () => {
    expect(parseChatStatus({ done: true, left: null })).toEqual({ done: true, left: [] });
    expect('invalid' in parseChatStatus({ done: false, left: null })).toBe(true);
  });

  it('takes what is left with who it waits on, trimmed', () => {
    expect(parseChatStatus({ done: false, left: [{ text: '  push  ', who: 'me' }, { text: 'try it', who: 'you' }, { text: 'docs', who: 'parked' }] })).toEqual({
      done: false,
      left: [{ text: 'push', who: 'me' }, { text: 'try it', who: 'you' }, { text: 'docs', who: 'parked' }],
    });
  });

  it('takes plain lines, as replies saved before items said who, with no who', () => {
    expect(parseChatStatus({ done: false, left: ['  push  ', 'docs'] })).toEqual({ done: false, left: [{ text: 'push' }, { text: 'docs' }] });
  });

  it('takes an item with no who, or a null one, as untagged', () => {
    expect(parseChatStatus({ done: false, left: [{ text: 'push' }, { text: 'docs', who: null }] })).toEqual({ done: false, left: [{ text: 'push' }, { text: 'docs' }] });
  });

  it('keeps the ask on a "you" item, trimmed, and drops it on the others', () => {
    expect(parseChatStatus({ done: false, left: [{ text: 'dns', who: 'you', ask: '  Change the record?  ' }, { text: 'push', who: 'me', ask: 'x' }] })).toEqual({
      done: false,
      left: [{ text: 'dns', who: 'you', ask: 'Change the record?' }, { text: 'push', who: 'me' }],
    });
  });

  it('still reads a "you" item saved before items carried an ask', () => {
    expect(parseChatStatus({ done: false, left: [{ text: 'try it', who: 'you' }] })).toEqual({ done: false, left: [{ text: 'try it', who: 'you' }] });
  });

  it('cuts a long ask at 2000 characters', () => {
    const parsed = parseChatStatus({ done: false, left: [{ text: 'x', who: 'you', ask: 'y'.repeat(2500) }] });
    if ('invalid' in parsed) throw new Error(parsed.invalid);
    expect(parsed.left[0]?.ask).toHaveLength(2000);
  });

  it('cuts a long item at 200 characters', () => {
    const parsed = parseChatStatus({ done: false, left: [{ text: 'x'.repeat(250), who: 'me' }] });
    if ('invalid' in parsed) throw new Error(parsed.invalid);
    expect(parsed.left[0]?.text).toHaveLength(200);
  });

  it.each([
    ['done with items', { done: true, left: ['x'] }],
    ['not done with no list', { done: false }],
    ['not done with an empty list', { done: false, left: [] }],
    ['a blank item', { done: false, left: ['  '] }],
    ['21 items', { done: false, left: Array.from({ length: 21 }, (_, i) => `item ${i}`) }],
    ['done that is not a boolean', { done: 'yes' }],
    ['a non-string item', { done: false, left: [3] }],
    ['an item with blank text', { done: false, left: [{ text: ' ', who: 'you' }] }],
    ['an item with no text', { done: false, left: [{ who: 'you' }] }],
    ['an unknown who', { done: false, left: [{ text: 'x', who: 'them' }] }],
    ['an ask that is not text', { done: false, left: [{ text: 'x', who: 'you', ask: 3 }] }],
    ['no object', null],
  ])('refuses %s', (_label, args) => {
    expect('invalid' in parseChatStatus(args)).toBe(true);
  });
});

describe('waitingOnUser', () => {
  it('counts only the items that wait on the user', () => {
    expect(waitingOnUser([{ text: 'a', who: 'you' }, { text: 'b', who: 'me' }, { text: 'c' }, { text: 'd', who: 'you' }, { text: 'e', who: 'parked' }])).toBe(2);
  });
});

describe('groupLeft', () => {
  it('groups by who: you, me, parked, then untagged, dropping empty groups', () => {
    expect(groupLeft([{ text: 'docs', who: 'parked' }, { text: 'old' }, { text: 'try it', who: 'you' }, { text: 'check', who: 'you' }])).toEqual([
      { who: 'you', label: 'Waiting on you', items: [{ text: 'try it', who: 'you' }, { text: 'check', who: 'you' }] },
      { who: 'parked', label: 'Parked', items: [{ text: 'docs', who: 'parked' }] },
      { who: undefined, label: 'Left', items: [{ text: 'old' }] },
    ]);
  });
});

describe('runStatusCommand', () => {
  it('answers with what was set', () => {
    expect(runStatusCommand({ done: false, left: [{ text: 'a', who: 'me' }, { text: 'b', who: 'parked' }] })).toBe('Status set: 2 left.');
    expect(
      runStatusCommand({ done: false, left: [{ text: 'a', who: 'you', ask: 'Run x?' }, { text: 'b', who: 'me' }, { text: 'c', who: 'you', ask: 'Yes or no?' }] }),
    ).toBe('Status set: 3 left, 2 waiting on the user.');
    expect(runStatusCommand({ done: true })).toBe('Status set: done.');
  });

  it('answers bad input with an input error', () => {
    expect(runStatusCommand({ done: false })).toMatchObject({ error: true, code: 'invalid_input' });
  });

  it('refuses a "you" item with no ask, naming it, since a question left in the thinking was never asked', () => {
    const out = runStatusCommand({ done: false, left: [{ text: 'approve the DNS change', who: 'you' }, { text: 'b', who: 'me' }] });
    expect(out).toMatchObject({ error: true, code: 'invalid_input' });
    expect(JSON.stringify(out)).toContain('approve the DNS change');
    expect(runStatusCommand({ done: false, left: [{ text: 'x', who: 'you', ask: '   ' }] })).toMatchObject({ error: true });
  });

  it('refuses untagged items in a new call, though stored replies still read them', () => {
    expect(runStatusCommand({ done: false, left: ['a'] })).toMatchObject({ error: true, code: 'invalid_input' });
    expect(parseChatStatus({ done: false, left: ['a'] })).toEqual({ done: false, left: [{ text: 'a' }] });
  });
});

describe('agentStatusOf', () => {
  it('reads a call whose result came back', () => {
    expect(agentStatusOf([call('a', { done: false, left: [{ text: 'x', who: 'you' }] }), ok('a')])).toEqual({ done: false, left: [{ text: 'x', who: 'you' }] });
  });

  it('ignores a refused call', () => {
    expect(agentStatusOf([call('a', { done: true }), failed('a')])).toBeNull();
  });

  it('ignores a call the API engine refused, whose result is a tool error with isError false', () => {
    const refused: Part = { type: 'tool-result', id: 'a', name: STATUS_TOOL, result: { error: true, code: 'permission_denied', message: 'no' }, isError: false };
    expect(agentStatusOf([call('a', { done: true }), refused])).toBeNull();
  });

  it('ignores a call with no result yet', () => {
    expect(agentStatusOf([call('a', { done: true })])).toBeNull();
  });

  it('takes the last call', () => {
    expect(agentStatusOf([call('a', { done: false, left: ['x'] }), ok('a'), { type: 'text', text: 'hi' }, call('b', { done: true }), ok('b')])).toEqual({ done: true, left: [] });
  });

  it('skips a later refused call for the earlier good one', () => {
    expect(agentStatusOf([call('a', { done: false, left: ['x'] }), ok('a'), call('b', { done: true }), failed('b')])).toEqual({ done: false, left: [{ text: 'x' }] });
  });

  it("ignores a helper's call inside its subagent part", () => {
    const helper: Part = { type: 'subagent', callId: 's', label: 'helper', status: 'complete', parts: [call('a', { done: true }), ok('a')] } as Part;
    expect(agentStatusOf([helper])).toBeNull();
  });

  it('ignores a call whose arguments do not parse', () => {
    expect(agentStatusOf([call('a', { done: 'yes' }), ok('a')])).toBeNull();
  });

  it('is null with no call', () => {
    expect(agentStatusOf([{ type: 'text', text: 'All done.' }])).toBeNull();
  });
});

describe('the broker and set_chat_status', () => {
  const STATUS: ToolSpec = { name: STATUS_TOOL, description: '', parameters: {}, risk: 'read', source: 'thread', execute: async () => null };
  const PLAN: ToolSpec = { ...STATUS, name: PLAN_TOOL };
  const policy: ToolPolicy = { fs: 'off', shell: false, mcpServerIds: [], approvalMode: 'ask_on_mutate' };
  const ctx = (over: Partial<ToolContext> = {}): ToolContext => ({ chatId: 'chat-1', messageId: 'msg-1', profileId: 'profile-1', workspaceRoot: null, signal: new AbortController().signal, ...over });
  const tag = { callId: 'c', label: 'x', parentProfileId: 'profile-1' };
  const broker = new PermissionBroker(new InMemoryStore());

  it('allows the main agent without a card', () => {
    expect(broker.decide(STATUS, { done: true }, policy, ctx())).toMatchObject({ kind: 'allow' });
  });

  it('refuses an API sub-agent', () => {
    expect(broker.decide(STATUS, { done: true }, policy, ctx({ subagent: tag }))).toEqual({ kind: 'deny', reason: SUBAGENT_THREAD_REFUSAL });
  });

  it('refuses a Claude Code helper', () => {
    expect(broker.decide(STATUS, { done: true }, policy, ctx({ shownSubagent: tag }))).toEqual({ kind: 'deny', reason: SUBAGENT_STATUS_REFUSAL });
  });

  it("leaves a helper's propose_plan as it was", () => {
    expect(broker.decide(PLAN, { plan: 'x' }, policy, ctx({ shownSubagent: tag }))).toMatchObject({ kind: 'allow' });
  });
});

describe('failedStatusCalls', () => {
  it('names the calls that were refused or bad, not the ones that took or still wait', () => {
    const apiRefused: Part = { type: 'tool-result', id: 'c', name: STATUS_TOOL, result: { error: true, code: 'invalid_input', message: 'x' }, isError: false };
    const parts: Part[] = [
      call('a', { done: true }), ok('a'),
      call('b', { done: true }), failed('b'),
      call('c', { done: false }), apiRefused,
      call('d', { done: 'yes' }), ok('d'),
      call('e', { done: true }),
    ];
    expect([...failedStatusCalls(parts)].sort()).toEqual(['b', 'c', 'd']);
  });
});
