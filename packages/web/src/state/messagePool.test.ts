import { beforeEach, describe, expect, it } from 'vitest';
import type { CanonMessage } from '@otherbench/core/types/messages.js';
import type { ReplyNote } from '@otherbench/core/types/notes.js';
import type { RecordedUsage } from '@otherbench/core/types/usage.js';
import { viewTabId } from '../viewer/items.js';
import { followChat, KEPT_RECENT_CHATS } from './messagePool.js';
import { DEFAULT_PANE_STATE } from './panes.js';
import { useOtherBenchStore } from './store.js';

function message(chatId: string, over: Partial<CanonMessage> = {}): CanonMessage {
  return { id: `${chatId}-m`, chatId, parentId: null, role: 'user', parts: [{ type: 'text', text: 'hi' }], status: 'complete', error: null, producedBy: null, createdAt: 1, ...over };
}

const store = (): ReturnType<typeof useOtherBenchStore.getState> => useOtherBenchStore.getState();
const loadedChats = (): string[] => [...new Set(Object.values(store().messages).map((m) => m.chatId))].sort();

/** Shows the chat in the focused pane and loads its one message, with usage and extras, as its thread would. */
function visit(chatId: string): void {
  store().setActiveChatId(chatId);
  store().loadMessages(chatId, [message(chatId)], null, { [`${chatId}-m`]: { tokensIn: 1 } as unknown as RecordedUsage });
  useOtherBenchStore.setState((s) => ({ extras: { ...s.extras, [`${chatId}-m`]: { usage: null, pendingApprovals: [] } } }));
}

/** Visits c0, then enough other chats that c0 is the oldest past those kept. */
function visitPastKept(): void {
  for (let i = 0; i <= KEPT_RECENT_CHATS + 1; i++) visit(`c${i}`);
}

describe('message pool pruning', () => {
  beforeEach(() => {
    window.localStorage.clear();
    useOtherBenchStore.setState(useOtherBenchStore.getInitialState(), true);
    useOtherBenchStore.setState({ paneState: DEFAULT_PANE_STATE, otherPaneState: DEFAULT_PANE_STATE, activeChatId: null });
  });

  it('forgets the chat viewed longest ago, with its extras and usage, keeping the active chat and the ones viewed last', () => {
    visitPastKept();
    const kept = Array.from({ length: KEPT_RECENT_CHATS + 1 }, (_, i) => `c${i + 1}`).sort();
    expect(loadedChats()).toEqual(kept);
    expect(store().extras['c0-m']).toBeUndefined();
    expect(store().recordedUsage['c0-m']).toBeUndefined();
    expect(store().extras['c1-m']).toBeDefined();
    expect(store().recordedUsage['c1-m']).toBeDefined();
    expect(store().viewedChats[0]).toBe(`c${KEPT_RECENT_CHATS + 1}`);
  });

  it("drops a forgotten chat's background tasks and stale stream state, never its waiting cards or notes", () => {
    visit('c0');
    useOtherBenchStore.setState({ chatHelpers: { c0: [] }, backgroundApprovals: { c0: [] }, chatNotes: { c0: [] } });
    for (let i = 1; i <= KEPT_RECENT_CHATS + 1; i++) visit(`c${i}`);
    expect(store().chatHelpers).not.toHaveProperty('c0');
    expect(store().backgroundApprovals).not.toHaveProperty('c0');
    expect(store().chatNotes).not.toHaveProperty('c0');
  });

  it('counts a chat loaded but never shown as the oldest', () => {
    store().registerMessage(message('never-shown'));
    for (let i = 0; i < KEPT_RECENT_CHATS; i++) visit(`c${i}`);
    expect(loadedChats()).toContain('never-shown');
    visit(`c${KEPT_RECENT_CHATS}`);
    expect(loadedChats()).not.toContain('never-shown');
    expect(loadedChats()).toContain('c0');
  });

  it('prunes on a chat switch, not as a reply streams', () => {
    // Loaded without being shown (registered replies, say): nothing is pruned until a switch.
    for (let i = 0; i <= KEPT_RECENT_CHATS + 2; i++) store().registerMessage(message(`c${i}`, { status: 'streaming', role: 'assistant' }));
    store().applyTurnEvent({ type: 'text-delta', messageId: 'c0-m', text: 'more' });
    expect(loadedChats()).toHaveLength(KEPT_RECENT_CHATS + 3);
    store().setActiveChatId('c0');
    expect(loadedChats()).toHaveLength(KEPT_RECENT_CHATS + 1);
  });

  it('keeps a chat with a reply running, a card open or messages queued, however long ago it was viewed', () => {
    for (const id of ['run', 'card', 'ask', 'bg', 'queued', 'sent']) visit(id);
    useOtherBenchStore.setState({
      appRunningTurns: { 'run-m2': 'run' },
      appPendingApprovals: {
        r1: { chatId: 'card', messageId: 'card-m', requestId: 'r1', toolName: 'shell' },
        r2: { chatId: 'ask', messageId: 'ask-m', requestId: 'r2', toolName: 'ask', kind: 'question' },
      },
      backgroundApprovals: { bg: [{ id: 'r3' } as never] },
      chatNotes: { queued: [{ id: 'n1', chatId: 'queued', text: 'also', attachments: [] } as unknown as ReplyNote] },
      sentNotes: { n2: { id: 'n2', chatId: 'sent', text: 'and', attachments: [] } as unknown as ReplyNote },
    });
    for (let i = 0; i <= KEPT_RECENT_CHATS; i++) visit(`c${i}`);
    expect(loadedChats()).toEqual(expect.arrayContaining(['run', 'card', 'ask', 'bg', 'queued', 'sent']));
    expect(store().backgroundApprovals).toHaveProperty('bg');
    expect(store().chatNotes).toHaveProperty('queued');
  });

  it("goes by the app's running replies, not a reply left marked as streaming when its chat was closed", () => {
    visit('left');
    store().registerMessage(message('left', { id: 'left-r', role: 'assistant', status: 'streaming' }));
    visitPastKept();
    expect(loadedChats()).not.toContain('left');
  });

  it("keeps the chats in every pane, a pinned one, a viewer tab's chat and the other mode's panes", () => {
    for (const id of ['pinned', 'other', 'viewer', 'code']) visit(id);
    useOtherBenchStore.setState({
      paneState: { ...DEFAULT_PANE_STATE, layout: 'columns-3', panes: ['pinned', viewTabId('viewer', { kind: 'browser' }), null], pinned: [0], focusedPane: 2 },
      otherPaneState: { ...DEFAULT_PANE_STATE, panes: ['code'] },
      activeChatId: null,
    });
    for (let i = 0; i <= KEPT_RECENT_CHATS + 1; i++) visit(`c${i}`);
    expect(store().paneState.panes[0]).toBe('pinned');
    expect(loadedChats()).toEqual(expect.arrayContaining(['pinned', 'viewer', 'code']));
    expect(loadedChats()).not.toContain('other');
  });

  it('keeps a chat a thread follows (quick chat, say) until it lets go', () => {
    visit('quick');
    const release = followChat('quick');
    visitPastKept();
    expect(loadedChats()).toContain('quick');
    release();
    visit('one-more');
    expect(loadedChats()).not.toContain('quick');
  });
});
