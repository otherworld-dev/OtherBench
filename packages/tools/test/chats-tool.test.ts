import { describe, expect, it } from 'vitest';
import { PermissionBroker } from '@otherbench/core/domain/permissions.js';
import { CHAT_SENDS_TOOL } from '@otherbench/core/domain/chat-sends.js';
import { InMemoryStore } from '@otherbench/core/testing/fakes.js';
import type { ChatMessenger, SendTarget } from '@otherbench/core/ports/chat-messenger.js';
import type { ToolApprovalEvent, ToolContext } from '@otherbench/core/ports/tool-provider.js';
import type { ToolPolicy } from '@otherbench/core/types/config.js';
import { chatsTool } from '../src/chats-tool.js';
import { OtherBenchToolProvider } from '../src/provider.js';

const emptyMcp = { listFor: () => [], refresh: async () => undefined, shutdown: async () => undefined };

function ctx(over: Partial<ToolContext> = {}): ToolContext {
  return { chatId: 'chat-1', messageId: 'msg-1', profileId: 'profile-1', workspaceRoot: null, signal: new AbortController().signal, ...over };
}

function policy(over: Partial<ToolPolicy> = {}): ToolPolicy {
  return { fs: 'off', shell: false, mcpServerIds: [], approvalMode: 'ask_on_mutate', ...over };
}

function fakeMessenger(): ChatMessenger & { sent: SendTarget[][] } {
  const sent: SendTarget[][] = [];
  return {
    sent,
    list: () => [{ chatId: 'chat-2', title: 'Web', app: 'Web', busy: false }],
    send: async (_ctx, targets) => {
      sent.push(targets);
      return { sent: targets.map((t, i) => ({ sendId: `s${i}`, chatId: t.chatId ?? `new-${i}`, title: 'T', app: t.app ?? null, createdChat: t.chatId === undefined, queued: false })) };
    },
  };
}

describe('message_chats tool', () => {
  it('list hands back what the messenger lists', async () => {
    const tool = chatsTool(fakeMessenger());
    expect(await tool.execute({ command: 'list' }, ctx())).toEqual({ chats: [{ chatId: 'chat-2', title: 'Web', app: 'Web', busy: false }] });
  });

  it('refuses more than 4 messages before reaching the messenger', async () => {
    const messenger = fakeMessenger();
    const messages = Array.from({ length: 5 }, (_, i) => ({ chatId: `c${i}`, text: 'x' }));
    expect(await chatsTool(messenger).execute({ command: 'send', messages }, ctx())).toMatchObject({ error: true, message: expect.stringMatching(/at most 4/) });
    expect(messenger.sent).toEqual([]);
  });

  it('refuses a message naming neither or both of chatId and app, or with no text', async () => {
    const messenger = fakeMessenger();
    const tool = chatsTool(messenger);
    for (const m of [{ text: 'x' }, { chatId: 'c', app: 'Web', text: 'x' }, { chatId: 'c', text: '  ' }]) {
      expect(await tool.execute({ command: 'send', messages: [m] }, ctx())).toMatchObject({ error: true });
    }
    expect(await tool.execute({ command: 'send', messages: [] }, ctx())).toMatchObject({ error: true });
    expect(messenger.sent).toEqual([]);
  });

  it('passes a good send through and tells the model to end its turn', async () => {
    const messenger = fakeMessenger();
    const out = await chatsTool(messenger).execute({ command: 'send', messages: [{ chatId: 'chat-2', text: 'Add the button' }, { app: 'Server', text: 'Add the route' }] }, ctx());
    expect(messenger.sent).toEqual([[{ chatId: 'chat-2', text: 'Add the button' }, { app: 'Server', text: 'Add the route' }]]);
    expect(out).toMatchObject({ sent: [{ chatId: 'chat-2' }, { app: 'Server' }], note: expect.stringMatching(/End your turn now/) });
  });

  it('turns a refusal from the messenger into a tool error', async () => {
    const messenger: ChatMessenger = { list: () => [], send: async () => ({ refused: 'Compare turns cannot message other chats.' }) };
    expect(await chatsTool(messenger).execute({ command: 'send', messages: [{ chatId: 'c', text: 'x' }] }, ctx())).toMatchObject({ error: true, message: 'Compare turns cannot message other chats.' });
  });

  it('describes a call as its own arguments, so the relay runs only what was approved', async () => {
    const tool = chatsTool(fakeMessenger());
    expect(await tool.describeCall!({ command: 'list' }, ctx())).toEqual({ args: { command: 'list' }, risk: 'execute' });
  });
});

describe('message_chats in the tool provider', () => {
  const make = (withMessenger = true) => {
    const store = new InMemoryStore();
    const broker = new PermissionBroker(store);
    return { store, provider: new OtherBenchToolProvider(store, broker, emptyMcp, withMessenger ? { chats: fakeMessenger() } : {}) };
  };

  it('offers it unless the profile turns it off, and only with a messenger', async () => {
    expect((await make().provider.listTools(policy())).some((t) => t.name === CHAT_SENDS_TOOL)).toBe(true);
    expect((await make().provider.listTools(policy({ chatMessages: false }))).some((t) => t.name === CHAT_SENDS_TOOL)).toBe(false);
    expect((await make(false).provider.listTools(policy())).some((t) => t.name === CHAT_SENDS_TOOL)).toBe(false);
  });

  it('relays it to Claude Code', async () => {
    expect((await make().provider.relayTools(policy())).map((t) => t.name)).toContain(CHAT_SENDS_TOOL);
    expect((await make().provider.relayTools(policy({ chatMessages: false }))).map((t) => t.name)).not.toContain(CHAT_SENDS_TOOL);
  });

  it('still asks in auto mode: a send is never approved without its card or a chat grant', async () => {
    const { provider } = make();
    const spec = (await provider.relayTools(policy())).find((t) => t.name === CHAT_SENDS_TOOL)!;
    const seen: ToolApprovalEvent[] = [];
    provider.onApprovalEvent((e) => {
      seen.push(e);
      if (e.type === 'request') provider.resolveApproval(e.request.id, { choice: 'chat' });
    });
    const args = { command: 'send', messages: [{ chatId: 'chat-2', text: 'x' }] };
    expect(await provider.requestApproval(spec, args, policy(), ctx(), { deferAsk: true })).toMatchObject({ allowed: true, grantedBy: 'ask:chat' });
    expect(seen.filter((e) => e.type === 'request')).toHaveLength(1);
    // The chat's grant covers the next one, in auto mode or not, with no card.
    expect(await provider.requestApproval(spec, args, policy(), ctx({ messageId: 'msg-2' }), { deferAsk: true })).toMatchObject({ allowed: true, grantedBy: expect.stringMatching(/^grant:/) });
    expect(seen.filter((e) => e.type === 'request')).toHaveLength(1);
  });
});
