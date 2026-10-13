import { describe, expect, it } from 'vitest';
import { chatStatus, groupStatus, shownChatIds } from './chatStatus.js';
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

describe('chatStatus', () => {
  const none = new Set<string>();

  it('waiting for an approval beats replying, which beats a reply ready', () => {
    const chat = { id: 'c', unread: true };
    expect(chatStatus(chat, new Set(['c']), new Set(['c']))).toBe('waiting');
    expect(chatStatus(chat, none, new Set(['c']))).toBe('working');
    expect(chatStatus(chat, none, none)).toBe('ready');
    expect(chatStatus({ id: 'c', unread: false }, none, none)).toBeNull();
  });
});

describe('groupStatus', () => {
  it('is the most urgent status among the chats, or null', () => {
    expect(groupStatus([null, 'ready', 'working'])).toBe('working');
    expect(groupStatus(['ready', 'waiting', 'working'])).toBe('waiting');
    expect(groupStatus([null, 'ready'])).toBe('ready');
    expect(groupStatus([null])).toBeNull();
    expect(groupStatus([])).toBeNull();
  });
});
