import { describe, expect, it } from 'vitest';
import type { Chat } from '@otherbench/core/ports/store.js';
import { CHAT_NEED_WINDOW_MS } from '@otherbench/core/domain/overview.js';
import { chatStatus, groupStatusSummary, isNeedsYou, needsYouChats, shownChatIds, type ChatActivity } from './chatStatus.js';
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

  it('puts chats stopped on a card first, then the rest, newest first', () => {
    const chats = [chat('old', NOW - 300), chat('new', NOW - 100), chat('card', NOW - 900), chat('failed', NOW - 200, { head: { chatId: 'failed', role: 'assistant', status: 'error', createdAt: NOW - 200 } })];
    expect(needsYouChats(chats, activity({ waiting: new Map([['card', 'approve']]) }), NOW).map((c) => c.id)).toEqual(['card', 'new', 'failed', 'old']);
  });

  it('leaves out a chat still working, in the background or archived, unless a card is waiting on them', () => {
    const chats = [chat('busy', NOW - 100), chat('tasks', NOW - 100), chat('gone', NOW - 100, { archivedAt: 5 }), chat('both', NOW - 100)];
    const result = needsYouChats(chats, activity({ working: new Set(['busy']), background: new Set(['tasks', 'both']), waiting: new Map([['both', 'answer'], ['gone', 'answer']]) }), NOW);
    expect(result.map((c) => c.id)).toEqual(['both']);
  });
});

describe('groupStatusSummary', () => {
  it('counts the chats working, and is empty with none', () => {
    expect(groupStatusSummary(['working', null, 'background', 'working'])).toBe('2 replying · 1 in background');
    expect(groupStatusSummary(['your-turn', 'approve'])).toBe('');
    expect(groupStatusSummary([null])).toBe('');
  });
});
