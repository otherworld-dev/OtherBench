import { beforeEach, describe, expect, it } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { Chat } from '@otherbench/core/ports/store.js';
import { CHAT_NEED_WINDOW_MS } from '@otherbench/core/domain/overview.js';
import { chatStatus, groupStatusSummary, isLive, isNeedsYou, needsYouChats, shownChatIds, useChatActivity, type ChatActivity } from './chatStatus.js';
import type { PeersOverview } from './api.js';
import { useOtherBenchStore } from './store.js';
import { DEFAULT_PANE_STATE, type PaneState } from './panes.js';

const state = (over: Partial<PaneState> = {}): PaneState => ({ ...DEFAULT_PANE_STATE, ...over });

describe('shownChatIds', () => {
  it("is every pane's chat, skipping empty panes", () => {
    expect(shownChatIds(state({ layout: 'columns-3', panes: ['a', null, 'c'], focusedPane: 0 }), false)).toEqual(['a', 'c']);
  });

  it("is only the focused pane's chat with a pane maximised or in a narrow window", () => {
    const two = state({ layout: 'columns-2', panes: ['a', 'b'], focusedPane: 1 });
    expect(shownChatIds({ ...two, maximised: true }, false)).toEqual(['b']);
    expect(shownChatIds(two, true)).toEqual(['b']);
    expect(shownChatIds(state({ panes: [null] }), true)).toEqual([]);
  });
});

const NOW = 1_000_000_000;

const activity = (over: Partial<ChatActivity> = {}): ChatActivity => ({ waiting: new Map(), working: new Set(), background: new Set(), ...over });

/** A chat whose last message is a reply that finished a minute ago. */
const finished = (over: Partial<Chat> = {}): Pick<Chat, 'id' | 'archivedAt' | 'dealtWithAt' | 'head'> => ({
  id: 'c', archivedAt: null, dealtWithAt: null, head: { chatId: 'c', role: 'assistant', status: 'complete', createdAt: NOW - 60_000 }, ...over,
});

describe('chatStatus', () => {
  it("is the user's turn with background tasks running when the reply asks them something, until it's ticked off", () => {
    const asking = finished({ head: { chatId: 'c', role: 'assistant', status: 'complete', createdAt: NOW - 60_000, asks: true } });
    const background = activity({ background: new Set(['c']) });
    expect(chatStatus(asking, background, NOW)).toBe('your-turn');
    expect(chatStatus({ ...asking, dealtWithAt: NOW }, background, NOW)).toBe('background');
    expect(chatStatus(finished(), background, NOW)).toBe('background');
  });

  it('says what a pending card asks for, ahead of anything else going on', () => {
    expect(chatStatus(finished(), activity({ waiting: new Map([['c', 'answer']]), working: new Set(['c']), background: new Set(['c']) }), NOW)).toBe('answer');
  });

  it('a running reply beats background tasks, which beat a finished reply', () => {
    expect(chatStatus(finished(), activity({ working: new Set(['c']), background: new Set(['c']) }), NOW)).toBe('working');
    expect(chatStatus(finished(), activity({ background: new Set(['c']) }), NOW)).toBe('background');
  });

  it('a finished reply is your turn, and a failed one says so', () => {
    expect(chatStatus(finished(), activity(), NOW)).toBe('your-turn');
    expect(chatStatus(finished({ head: { chatId: 'c', role: 'assistant', status: 'error', createdAt: NOW - 60_000 } }), activity(), NOW)).toBe('failed');
  });

  it('having the chat open does not clear it: only a reply from the user or ticking it off does', () => {
    const replied = finished({ head: { chatId: 'c', role: 'user', status: 'complete', createdAt: NOW - 1 } });
    expect(chatStatus(replied, activity(), NOW)).toBeNull();
    expect(chatStatus(finished({ dealtWithAt: NOW }), activity(), NOW)).toBeNull();
  });

  it('a reply newer than the tick needs them again', () => {
    expect(chatStatus(finished({ dealtWithAt: NOW - 120_000 }), activity(), NOW)).toBe('your-turn');
  });

  it('a reply older than the need window, or a chat with no messages, has no status', () => {
    expect(chatStatus(finished({ head: { chatId: 'c', role: 'assistant', status: 'complete', createdAt: NOW - CHAT_NEED_WINDOW_MS - 1 } }), activity(), NOW)).toBeNull();
    expect(chatStatus(finished({ head: null }), activity(), NOW)).toBeNull();
  });
});

describe('isNeedsYou', () => {
  it('is every status that has stopped until the user acts', () => {
    expect((['approve', 'answer', 'plan', 'generate', 'browser', 'waiting', 'failed', 'your-turn'] as const).every(isNeedsYou)).toBe(true);
    expect((['working', 'background', null] as const).some(isNeedsYou)).toBe(false);
  });
});

describe('needsYouChats', () => {
  const chat = (id: string, createdAt: number, over: Partial<Chat> = {}): Chat =>
    ({ id, archivedAt: null, dealtWithAt: null, head: { chatId: id, role: 'assistant', status: 'complete', createdAt }, updatedAt: 1, ...over }) as Chat;
  const stopped = (id: string, createdAt: number, finishedAt: number): Chat =>
    chat(id, createdAt, { head: { chatId: id, role: 'assistant', status: 'complete', createdAt, finishedAt } });

  it('is oldest first, with a card no different from a reply', () => {
    const chats = [chat('old', NOW - 300), chat('new', NOW - 100), chat('card', NOW - 200), chat('failed', NOW - 250, { head: { chatId: 'failed', role: 'assistant', status: 'error', createdAt: NOW - 250 } })];
    expect(needsYouChats(chats, activity({ waiting: new Map([['card', 'approve']]) }), NOW).map((c) => c.id)).toEqual(['old', 'failed', 'card', 'new']);
  });

  it('orders a reply by when it stopped, so a long one that started first but finished last goes last', () => {
    const chats = [stopped('long', NOW - 3_600_000, NOW - 10), stopped('quick', NOW - 500, NOW - 400), chat('older', NOW - 450)];
    expect(needsYouChats(chats, activity(), NOW).map((c) => c.id)).toEqual(['older', 'quick', 'long']);
  });

  it('orders a card by when it started waiting, not by the reply it holds up', () => {
    const chats = [chat('card', NOW - 3_600_000, { head: { chatId: 'card', role: 'assistant', status: 'streaming', createdAt: NOW - 3_600_000 } }), stopped('done', NOW - 900, NOW - 500)];
    const waiting = activity({ waiting: new Map([['card', 'approve']]), since: new Map([['card', NOW - 100]]) });
    expect(needsYouChats(chats, waiting, NOW).map((c) => c.id)).toEqual(['done', 'card']);
  });

  it('gives the same order every time it is worked out: nothing is kept between calls, so a reload changes nothing', () => {
    const chats = [stopped('b', NOW - 900, NOW - 100), stopped('a', NOW - 800, NOW - 200), chat('c', NOW - 150)];
    const first = needsYouChats(chats, activity(), NOW).map((c) => c.id);
    expect(first).toEqual(['a', 'c', 'b']);
    expect(needsYouChats([...chats].reverse(), activity(), NOW).map((c) => c.id)).toEqual(first);
  });

  it('leaves out a chat still working, in the background or archived, unless a card is waiting on them', () => {
    const chats = [chat('busy', NOW - 100), chat('tasks', NOW - 100), chat('gone', NOW - 100, { archivedAt: 5 }), chat('both', NOW - 100)];
    const result = needsYouChats(chats, activity({ working: new Set(['busy']), background: new Set(['tasks', 'both']), waiting: new Map([['both', 'answer'], ['gone', 'answer']]) }), NOW);
    expect(result.map((c) => c.id)).toEqual(['both']);
  });
});

describe('useChatActivity', () => {
  beforeEach(() => useOtherBenchStore.setState(useOtherBenchStore.getInitialState(), true));

  it("knows since when each chat's cards have waited: its first card here, or what the paired machine running it says", () => {
    useOtherBenchStore.setState({
      appPendingApprovals: {
        r1: { chatId: 'here', messageId: 'm1', requestId: 'r1', toolName: 'write_file', at: 300 },
        r2: { chatId: 'here', messageId: 'm1', requestId: 'r2', toolName: 'write_file', at: 200 },
        r3: { chatId: 'untimed', messageId: 'm2', requestId: 'r3', toolName: 'write_file' },
      },
      machines: {
        self: { id: 'node-laptop', name: 'Laptop' },
        peers: [{ nodeId: 'node-pc', name: 'PC', status: 'reachable', waitingChats: ['there'], waitingSince: { there: 400 } }],
      } as unknown as PeersOverview,
    });
    const { result } = renderHook(() => useChatActivity());
    expect(Object.fromEntries(result.current.since ?? [])).toEqual({ here: 200, there: 400 });
    expect(result.current.waiting.get('there')).toBe('waiting');
  });
});

describe('groupStatusSummary', () => {
  it('counts the chats working, and is empty with none', () => {
    expect(groupStatusSummary(['working', null, 'background', 'working'])).toBe('2 replying · 1 in background');
    expect(groupStatusSummary(['your-turn', 'approve'])).toBe('');
    expect(groupStatusSummary([null])).toBe('');
  });
});

describe('isLive', () => {
  it('is card for a chat on a card, running for working and background, null otherwise', () => {
    expect(isLive('approve')).toBe('card');
    expect(isLive('waiting')).toBe('card');
    expect(isLive('working')).toBe('running');
    expect(isLive('background')).toBe('running');
    expect(isLive('your-turn')).toBeNull();
    expect(isLive('failed')).toBeNull();
    expect(isLive(null)).toBeNull();
  });
});
