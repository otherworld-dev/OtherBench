import { describe, expect, it } from 'vitest';
import { agentStatusOf, parseChatStatus, runStatusCommand, STATUS_TOOL, SUBAGENT_STATUS_REFUSAL } from '../src/domain/chat-status-tool.js';
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

  it('takes what is left, trimmed', () => {
    expect(parseChatStatus({ done: false, left: ['  push  ', 'docs'] })).toEqual({ done: false, left: ['push', 'docs'] });
  });

  it('cuts a long item at 200 characters', () => {
    const parsed = parseChatStatus({ done: false, left: ['x'.repeat(250)] });
    if ('invalid' in parsed) throw new Error(parsed.invalid);
    expect(parsed.left[0]).toHaveLength(200);
  });

  it.each([
    ['done with items', { done: true, left: ['x'] }],
    ['not done with no list', { done: false }],
    ['not done with an empty list', { done: false, left: [] }],
    ['a blank item', { done: false, left: ['  '] }],
    ['21 items', { done: false, left: Array.from({ length: 21 }, (_, i) => `item ${i}`) }],
    ['done that is not a boolean', { done: 'yes' }],
    ['a non-string item', { done: false, left: [3] }],
    ['no object', null],
  ])('refuses %s', (_label, args) => {
    expect('invalid' in parseChatStatus(args)).toBe(true);
  });
});

describe('runStatusCommand', () => {
  it('answers with what was set', () => {
    expect(runStatusCommand({ done: false, left: ['a', 'b'] })).toBe('Status set: 2 left.');
    expect(runStatusCommand({ done: true })).toBe('Status set: done.');
  });

  it('answers bad input with an input error', () => {
    expect(runStatusCommand({ done: false })).toMatchObject({ error: true, code: 'invalid_input' });
  });
});

describe('agentStatusOf', () => {
  it('reads a call whose result came back', () => {
    expect(agentStatusOf([call('a', { done: false, left: ['x'] }), ok('a')])).toEqual({ done: false, left: ['x'] });
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
    expect(agentStatusOf([call('a', { done: false, left: ['x'] }), ok('a'), call('b', { done: true }), failed('b')])).toEqual({ done: false, left: ['x'] });
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
