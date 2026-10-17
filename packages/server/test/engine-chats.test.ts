import { describe, expect, it, vi } from 'vitest';
import { closeEngineChatsThatAreGone, followChatSettings } from '../src/engine-chats.js';
import { AppEventBus } from '../src/stream/events.js';

describe('closeEngineChatsThatAreGone', () => {
  it("closes a deleted chat's engine processes, and after a sync those of every chat that's gone", () => {
    const events = new AppEventBus();
    const closeChats = vi.fn();
    const exists = new Set(['kept']);
    closeEngineChatsThatAreGone(events, { closeChats }, (chatId) => exists.has(chatId));

    events.emit({ type: 'chat-deleted', chatId: 'c1' });
    const deleted = closeChats.mock.calls[0]![0] as (chatId: string) => boolean;
    expect([deleted('c1'), deleted('kept'), deleted('c2')]).toEqual([true, false, false]);

    events.emit({ type: 'sync-applied', nodeId: 'laptop', changed: 3 });
    const synced = closeChats.mock.calls[1]![0] as (chatId: string) => boolean;
    expect([synced('kept'), synced('c2')]).toEqual([false, true]);
  });

  it('does nothing for an engine without closeChats', () => {
    const events = new AppEventBus();
    closeEngineChatsThatAreGone(events, {}, () => false);
    expect(() => events.emit({ type: 'chat-deleted', chatId: 'c1' })).not.toThrow();
  });
});

describe('followChatSettings', () => {
  it("tells the engine a chat's settings changed, and after a sync that any may have", () => {
    const events = new AppEventBus();
    const refreshChatSettings = vi.fn();
    followChatSettings(events, { refreshChatSettings });
    const chat = { id: 'c1' } as Parameters<AppEventBus['emit']>[0] extends infer E ? (E extends { type: 'chat-updated'; chat: infer C } ? C : never) : never;
    events.emit({ type: 'chat-updated', chat });
    events.emit({ type: 'sync-applied', nodeId: 'laptop', changed: 2 });
    expect(refreshChatSettings.mock.calls).toEqual([['c1'], []]);
  });
});
