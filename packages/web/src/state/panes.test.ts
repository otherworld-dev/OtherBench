import { beforeEach, describe, expect, it } from 'vitest';
import {
  closeTab,
  DEFAULT_PANE_STATE,
  focusPane,
  forgetChat,
  loadPaneState,
  moveTab,
  openTab,
  PANE_STATE_STORAGE_KEY,
  savePaneState,
  setLayout,
  showChat,
  type PaneState,
} from './panes.js';

const state = (over: Partial<PaneState> = {}): PaneState => ({ ...DEFAULT_PANE_STATE, ...over });

describe('pane state (#824)', () => {
  it('shows a chat in the focused pane, or focuses the pane already showing it', () => {
    const two = state({ layout: 'columns-2', panes: ['a', 'b'], focusedPane: 0 });
    expect(showChat(two, 'c')).toMatchObject({ panes: ['c', 'b'], focusedPane: 0 });
    expect(showChat(two, 'b')).toMatchObject({ panes: ['a', 'b'], focusedPane: 1 });
    expect(showChat(two, null)).toMatchObject({ panes: [null, 'b'] });
  });

  it('opening a tab adds it once and shows it; closing a tab leaves the panes alone', () => {
    const opened = openTab(openTab(state(), 'a'), 'a');
    expect(opened).toMatchObject({ tabs: ['a'], panes: ['a'] });
    expect(closeTab(opened, 'a')).toMatchObject({ tabs: [], panes: ['a'] });
    expect(closeTab(opened, 'zzz')).toBe(opened);
  });

  it('a bigger layout keeps the panes in place and fills new ones with tabs not yet showing', () => {
    const s = state({ tabs: ['a', 'b', 'c'], panes: ['b'], focusedPane: 0 });
    expect(setLayout(s, 'columns-3')).toMatchObject({ layout: 'columns-3', panes: ['b', 'a', 'c'], focusedPane: 0 });
    expect(setLayout(state({ tabs: [], panes: ['x'] }), 'rows-2')).toMatchObject({ panes: ['x', null] });
  });

  it('a smaller layout moves the focused chat into the last pane left', () => {
    const s = state({ layout: 'columns-3', tabs: [], panes: ['a', 'b', 'c'], focusedPane: 2 });
    expect(setLayout(s, 'columns-2')).toMatchObject({ panes: ['a', 'c'], focusedPane: 1 });
    expect(setLayout(s, 'single')).toMatchObject({ panes: ['c'], focusedPane: 0 });
    expect(setLayout({ ...s, focusedPane: 0 }, 'single')).toMatchObject({ panes: ['a'], focusedPane: 0 });
  });

  it('focusing ignores a pane that does not exist', () => {
    const s = state({ layout: 'columns-2', panes: ['a', 'b'], focusedPane: 0 });
    expect(focusPane(s, 1).focusedPane).toBe(1);
    expect(focusPane(s, 5)).toBe(s);
  });

  it('a deleted chat leaves the tabs and every pane', () => {
    const s = state({ layout: 'columns-2', tabs: ['a', 'b'], panes: ['a', 'a'] });
    expect(forgetChat(s, 'a')).toMatchObject({ tabs: ['b'], panes: [null, null] });
  });

  it('moves a tab before another, or to the end', () => {
    const s = state({ tabs: ['a', 'b', 'c'] });
    expect(moveTab(s, 'c', 'a').tabs).toEqual(['c', 'a', 'b']);
    expect(moveTab(s, 'a', null).tabs).toEqual(['b', 'c', 'a']);
    expect(moveTab(s, 'a', 'a')).toBe(s);
  });

  describe('storage', () => {
    beforeEach(() => window.localStorage.clear());

    it('round-trips, and repairs what it reads: unknown layouts, short pane lists, a focus out of range, junk ids', () => {
      const s = state({ tabs: ['a', 'b'], layout: 'columns-2', panes: ['a', 'b'], focusedPane: 1 });
      savePaneState(s);
      expect(loadPaneState()).toEqual(s);

      window.localStorage.setItem(PANE_STATE_STORAGE_KEY, JSON.stringify({ tabs: ['a', 7, 'a'], layout: 'columns-3', panes: ['a'], focusedPane: 9 }));
      expect(loadPaneState()).toEqual({ tabs: ['a'], layout: 'columns-3', panes: ['a', null, null], focusedPane: 0 });

      window.localStorage.setItem(PANE_STATE_STORAGE_KEY, JSON.stringify({ layout: 'mosaic' }));
      expect(loadPaneState()).toEqual(DEFAULT_PANE_STATE);
      window.localStorage.setItem(PANE_STATE_STORAGE_KEY, '{not json');
      expect(loadPaneState()).toEqual(DEFAULT_PANE_STATE);
    });
  });
});
