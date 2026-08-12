import { beforeEach, describe, expect, it } from 'vitest';
import type { CanonMessage } from '@grunt/core/types/messages.js';
import type { Chat } from '@grunt/core/ports/store.js';
import { useGruntStore } from './store.js';

function stubAssistant(id: string, overrides: Partial<CanonMessage> = {}): CanonMessage {
  return {
    id,
    chatId: 'chat-1',
    parentId: 'user-1',
    role: 'assistant',
    parts: [],
    status: 'streaming',
    error: null,
    producedBy: { profileId: 'p1', profileName: 'Default', connectionId: 'c1', modelId: 'mock-standard' },
    createdAt: 0,
    ...overrides,
  };
}

function reset(): void {
  useGruntStore.setState(useGruntStore.getInitialState(), true);
}

describe('useGruntStore', () => {
  beforeEach(reset);

  it('setChats/upsertChat populate the chat list', () => {
    const chat: Chat = {
      id: 'chat-1',
      title: 'Hello',
      profileId: 'p1',
      headMessageId: null,
      workspaceRoot: null,
      pinned: false,
      archivedAt: null,
      createdAt: 1,
      updatedAt: 1,
    };
    useGruntStore.getState().setChats([chat]);
    expect(useGruntStore.getState().chats).toEqual([chat]);

    useGruntStore.getState().upsertChat({ ...chat, title: 'Renamed' });
    expect(useGruntStore.getState().chats).toHaveLength(1);
    expect(useGruntStore.getState().chats[0]?.title).toBe('Renamed');
  });

  it('applyTurnEvent on a known message appends streamed text', () => {
    useGruntStore.getState().registerMessage(stubAssistant('m1'));
    useGruntStore.getState().applyTurnEvent({ messageId: 'm1', type: 'text-delta', text: 'Hello' });
    useGruntStore.getState().applyTurnEvent({ messageId: 'm1', type: 'text-delta', text: ' world' });

    expect(useGruntStore.getState().messages['m1']?.parts).toEqual([{ type: 'text', text: 'Hello world' }]);
  });

  // Load-bearing (task 19 brief): a `text-delta` for a message id the store
  // doesn't know yet must be buffered, not silently dropped. This is a real
  // race in this design -- the SSE connection can already be open and
  // delivering events for a message before the `POST .../turns` response
  // (which is how the client normally learns the id) has even resolved.
  it('buffers a text-delta for an unknown message id instead of dropping it, then flushes it once the message is registered', () => {
    useGruntStore.getState().applyTurnEvent({ messageId: 'm-unknown', type: 'text-delta', text: 'early bird' });

    // Not dropped: it's sitting in pendingEvents, and no message was
    // fabricated for it.
    expect(useGruntStore.getState().messages['m-unknown']).toBeUndefined();
    expect(useGruntStore.getState().pendingEvents['m-unknown']).toHaveLength(1);

    // Once the message becomes known (e.g. the turn-creation response
    // arrives), the buffered event is folded in immediately.
    useGruntStore.getState().registerMessage(stubAssistant('m-unknown'));

    expect(useGruntStore.getState().messages['m-unknown']?.parts).toEqual([{ type: 'text', text: 'early bird' }]);
    expect(useGruntStore.getState().pendingEvents['m-unknown']).toBeUndefined();
  });

  it('buffers events for several unknown messages independently', () => {
    useGruntStore.getState().applyTurnEvent({ messageId: 'a', type: 'text-delta', text: 'A' });
    useGruntStore.getState().applyTurnEvent({ messageId: 'b', type: 'text-delta', text: 'B' });
    useGruntStore.getState().applyTurnEvent({ messageId: 'a', type: 'text-delta', text: '1' });

    expect(useGruntStore.getState().pendingEvents['a']).toHaveLength(2);
    expect(useGruntStore.getState().pendingEvents['b']).toHaveLength(1);
  });

  // Load-bearing (task 19 brief): reconnecting and replaying the `hello`
  // snapshot must not duplicate text already applied from the live feed
  // before the disconnect. StreamRegistry's buffer is "everything since the
  // turn started", not "everything since you last saw", so naively
  // appending the hello replay on top of current state would double it.
  it('reconnect replay via applyHello does not duplicate text already streamed live', () => {
    useGruntStore.getState().registerMessage(stubAssistant('m1'));
    useGruntStore.getState().applyTurnEvent({ messageId: 'm1', type: 'text-delta', text: 'Hello' });
    useGruntStore.getState().applyTurnEvent({ messageId: 'm1', type: 'text-delta', text: ' world' });
    expect(useGruntStore.getState().messages['m1']?.parts).toEqual([{ type: 'text', text: 'Hello world' }]);

    // Simulate a drop + reconnect: the server's hello snapshot replays the
    // FULL buffer for this message, which happens to be exactly the two
    // deltas already applied above.
    useGruntStore.getState().applyHello([
      {
        messageId: 'm1',
        status: 'streaming',
        events: [
          { messageId: 'm1', type: 'text-delta', text: 'Hello' },
          { messageId: 'm1', type: 'text-delta', text: ' world' },
        ],
      },
    ]);

    expect(useGruntStore.getState().messages['m1']?.parts).toEqual([{ type: 'text', text: 'Hello world' }]);
  });

  it('applyHello for a message not yet known replaces (not appends to) its pending buffer', () => {
    useGruntStore.getState().applyTurnEvent({ messageId: 'm2', type: 'text-delta', text: 'partial-from-live' });

    useGruntStore.getState().applyHello([
      {
        messageId: 'm2',
        status: 'streaming',
        events: [{ messageId: 'm2', type: 'text-delta', text: 'full-from-hello' }],
      },
    ]);
    useGruntStore.getState().registerMessage(stubAssistant('m2'));

    expect(useGruntStore.getState().messages['m2']?.parts).toEqual([{ type: 'text', text: 'full-from-hello' }]);
  });

  it('applyHello on a known message also updates its authoritative status', () => {
    useGruntStore.getState().registerMessage(stubAssistant('m1'));
    useGruntStore.getState().applyHello([{ messageId: 'm1', status: 'complete', events: [] }]);
    expect(useGruntStore.getState().messages['m1']?.status).toBe('complete');
  });

  it('registerMessage does not clobber an already-known message', () => {
    useGruntStore.getState().registerMessage(stubAssistant('m1'));
    useGruntStore.getState().applyTurnEvent({ messageId: 'm1', type: 'text-delta', text: 'live text' });
    // A redundant registration (e.g. a stale bulk hydrate racing the live
    // stream) must not overwrite the further-along live state.
    useGruntStore.getState().registerMessage(stubAssistant('m1'));
    expect(useGruntStore.getState().messages['m1']?.parts).toEqual([{ type: 'text', text: 'live text' }]);
  });

  it('setHeadMessageId updates the chat entry in place', () => {
    const chat: Chat = {
      id: 'chat-1',
      title: 'Hello',
      profileId: 'p1',
      headMessageId: null,
      workspaceRoot: null,
      pinned: false,
      archivedAt: null,
      createdAt: 1,
      updatedAt: 1,
    };
    useGruntStore.getState().setChats([chat]);
    useGruntStore.getState().setHeadMessageId('chat-1', 'm1');
    expect(useGruntStore.getState().chats[0]?.headMessageId).toBe('m1');
  });
});
