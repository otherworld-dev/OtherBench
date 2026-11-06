import { beforeEach, describe, expect, it } from 'vitest';
import { PermissionBroker, UNATTENDED_REASON } from '../src/domain/permissions.js';
import { allowedWhilePlanning } from '../src/domain/permissions/modes.js';
import { CHAT_MESSAGES_OFF_REASON, CHAT_SENDS_TOOL } from '../src/domain/chat-sends.js';
import type { ToolContext, ToolSpec } from '../src/ports/tool-provider.js';
import type { ToolPolicy } from '../src/types/config.js';
import { InMemoryStore } from '../src/testing/fakes.js';

const SEND: ToolSpec = { name: CHAT_SENDS_TOOL, description: '', parameters: {}, risk: 'execute', source: 'chats', execute: async () => null };

function policy(over: Partial<ToolPolicy> = {}): ToolPolicy {
  return { fs: 'off', shell: false, mcpServerIds: [], approvalMode: 'ask_on_mutate', ...over };
}

function ctx(over: Partial<ToolContext> = {}): ToolContext {
  return { chatId: 'chat-1', messageId: 'msg-1', profileId: 'profile-1', workspaceRoot: null, signal: new AbortController().signal, ...over };
}

const SEND_ARGS = { command: 'send', messages: [{ chatId: 'chat-2', text: 'hi' }] };

describe('PermissionBroker and messaging other chats', () => {
  let store: InMemoryStore;
  let broker: PermissionBroker;

  beforeEach(() => {
    store = new InMemoryStore();
    broker = new PermissionBroker(store);
  });

  it('refuses when the profile turns it off', () => {
    expect(broker.decide(SEND, SEND_ARGS, policy({ chatMessages: false }), ctx())).toEqual({ kind: 'deny', reason: CHAT_MESSAGES_OFF_REASON });
  });

  it('refuses a sub-agent, a Claude Code helper and a scheduled run without a card', () => {
    const tag = { callId: 'c', label: 'x', parentProfileId: 'profile-1' };
    expect(broker.decide(SEND, SEND_ARGS, policy(), ctx({ subagent: tag })).kind).toBe('deny');
    expect(broker.decide(SEND, SEND_ARGS, policy(), ctx({ shownSubagent: tag })).kind).toBe('deny');
    expect(broker.decide(SEND, SEND_ARGS, policy(), ctx({ unattended: true }))).toEqual({ kind: 'deny', reason: UNATTENDED_REASON, unattended: true });
  });

  it('asks once per chat: a "for this chat" answer covers the chat and nothing else', () => {
    const asked = broker.decide(SEND, SEND_ARGS, policy(), ctx());
    if (asked.kind !== 'ask') throw new Error(`expected ask, got ${asked.kind}`);
    expect(asked.request.summary).toMatch(/other chat/);
    broker.resolve(asked.request.id, { choice: 'chat' });
    expect(broker.decide(SEND, SEND_ARGS, policy(), ctx({ messageId: 'msg-2' }))).toMatchObject({ kind: 'allow', grantedBy: 'grant' });
    expect(broker.decide(SEND, SEND_ARGS, policy(), ctx({ chatId: 'chat-9' })).kind).toBe('ask');
  });

  it('stores an "always" answer as a grant for this chat only', () => {
    const asked = broker.decide(SEND, SEND_ARGS, policy(), ctx());
    if (asked.kind !== 'ask') throw new Error('expected ask');
    broker.resolve(asked.request.id, { choice: 'always', constraint: null });
    expect(store.grants.list()).toHaveLength(1);
    expect(store.grants.list()[0]).toMatchObject({ chatId: 'chat-1', scope: 'chat', source: 'chats' });
    expect(broker.decide(SEND, SEND_ARGS, policy(), ctx({ chatId: 'chat-9' })).kind).toBe('ask');
  });

  it('is refused while a plan is unapproved', () => {
    expect(allowedWhilePlanning(SEND, SEND_ARGS)).toBe(false);
  });
});
