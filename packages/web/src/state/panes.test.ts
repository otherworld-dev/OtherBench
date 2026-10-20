import { beforeEach, describe, expect, it } from 'vitest';
import { viewTabId } from '../viewer/items.js';
import { useOtherBenchStore } from './store.js';
import {
  closeTab,
  CODE_PANE_STATE_STORAGE_KEY,
  DEFAULT_PANE_STATE,
  focusPane,
  forgetChat,
  loadPaneState,
  moveTab,
  openTab,
  PANE_STATE_STORAGE_KEY,
  resizeSplit,
  savePaneState,
  setLayout,
  setSplitSizes,
  showChat,
  toggleMaximised,
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

  it('opening a tab adds it once and shows it; closing it takes it out of its pane too', () => {
    const opened = openTab(openTab(state(), 'a'), 'a');
    expect(opened).toMatchObject({ tabs: ['a'], panes: ['a'] });
    expect(closeTab(opened, 'a')).toMatchObject({ tabs: [], panes: [null] });
    expect(closeTab(opened, 'zzz')).toBe(opened);
  });

  it('a closed tab hands its pane to the next tab not already showing, or leaves it empty', () => {
    const grid = state({ layout: 'grid-4', tabs: ['a', 'b', 'c', 'd'], panes: ['c', 'b', 'a', 'd'], focusedPane: 0 });
    expect(closeTab(grid, 'b')).toMatchObject({ tabs: ['a', 'c', 'd'], panes: ['c', null, 'a', 'd'] });
    const waiting = state({ layout: 'columns-2', tabs: ['a', 'b', 'c'], panes: ['a', 'b'], focusedPane: 1 });
    expect(closeTab(waiting, 'b')).toMatchObject({ tabs: ['a', 'c'], panes: ['a', 'c'], focusedPane: 1 });
    // A tab that isn't showing anywhere just leaves the tab strip.
    expect(closeTab(waiting, 'c')).toMatchObject({ tabs: ['a', 'b'], panes: ['a', 'b'] });
  });

  it('opening a tab keeps the chat the focused pane was showing as a tab too, so it is not replaced and lost', () => {
    expect(openTab(state({ tabs: [], panes: ['open'] }), 'new')).toMatchObject({ tabs: ['open', 'new'], panes: ['new'] });
    expect(openTab(state({ tabs: ['x'], panes: ['open'] }), 'new')).toMatchObject({ tabs: ['x', 'open', 'new'], panes: ['new'] });
    // Already a tab, the same chat, or an empty pane: nothing extra to keep.
    expect(openTab(state({ tabs: ['open'], panes: ['open'] }), 'new')).toMatchObject({ tabs: ['open', 'new'] });
    expect(openTab(state({ tabs: [], panes: ['a'] }), 'a')).toMatchObject({ tabs: ['a'] });
    expect(openTab(state({ tabs: [], panes: [null] }), 'new')).toMatchObject({ tabs: ['new'] });
    // A chat already showing in another pane is only focused, so nothing is replaced.
    const two = state({ layout: 'columns-2', tabs: [], panes: ['open', 'new'], focusedPane: 0 });
    expect(openTab(two, 'new')).toMatchObject({ tabs: ['new'], panes: ['open', 'new'], focusedPane: 1 });
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

  it('a divider keeps both neighbours at least 15% of the split, and keeps the total', () => {
    const near = (actual: number[], expected: number[]): void => expected.forEach((v, i) => expect(actual[i]).toBeCloseTo(v));
    near(resizeSplit([1, 1], 0, 0.25), [1.5, 0.5]);
    near(resizeSplit([1, 1], 0, 0.9), [1.7, 0.3]);
    near(resizeSplit([1, 1, 1], 1, -0.5), [1, 0.45, 1.55]);
    expect(resizeSplit([1, 1], 5, 0.1)).toEqual([1, 1]);
  });

  it('remembers split sizes, ignoring bad ones; maximise needs two panes and a layout change ends it', () => {
    const s = state({ layout: 'columns-2', panes: ['a', 'b'] });
    expect(setSplitSizes(s, 'columns-2/root', [2, 1]).sizes).toEqual({ 'columns-2/root': [2, 1] });
    expect(setSplitSizes(s, 'columns-2/root', [2, 0])).toBe(s);
    expect(setSplitSizes(s, 'columns-2/root', [2])).toBe(s);
    const big = toggleMaximised(s);
    expect(big.maximised).toBe(true);
    expect(toggleMaximised(big).maximised).toBe(false);
    expect(setLayout(big, 'columns-3').maximised).toBe(false);
    expect(toggleMaximised(state())).toEqual(state());
  });

  it('the new layouts have three and four panes, filled from tabs', () => {
    const s = state({ tabs: ['a', 'b', 'c', 'd'], panes: ['a'] });
    expect(setLayout(s, 'main-right-2').panes).toEqual(['a', 'b', 'c']);
    expect(setLayout(s, 'grid-4').panes).toEqual(['a', 'b', 'c', 'd']);
  });

  describe('storage', () => {
    beforeEach(() => window.localStorage.clear());

    it('round-trips, and repairs what it reads: unknown layouts, short pane lists, a focus out of range, junk ids', () => {
      const s = state({ tabs: ['a', 'b'], layout: 'columns-2', panes: ['a', 'b'], focusedPane: 1 });
      savePaneState(s);
      expect(loadPaneState()).toEqual(s);

      window.localStorage.setItem(
        PANE_STATE_STORAGE_KEY,
        JSON.stringify({ tabs: ['a', 7, 'a'], layout: 'columns-3', panes: ['a'], focusedPane: 9, sizes: { 'columns-3/root': [1, 0, 2], 'grid-4/top': [1, 3] }, maximised: true })
      );
      expect(loadPaneState()).toEqual({
        tabs: ['a'], layout: 'columns-3', panes: ['a', null, null], focusedPane: 0, sizes: { 'grid-4/top': [1, 3] }, maximised: true,
      });

      window.localStorage.setItem(PANE_STATE_STORAGE_KEY, JSON.stringify({ layout: 'mosaic' }));
      expect(loadPaneState()).toEqual(DEFAULT_PANE_STATE);
      window.localStorage.setItem(PANE_STATE_STORAGE_KEY, '{not json');
      expect(loadPaneState()).toEqual(DEFAULT_PANE_STATE);
    });

    it("keeps Code mode's pane state under its own key, apart from Chat mode's", () => {
      const chat = state({ tabs: ['a', 'b'], layout: 'columns-2', panes: ['a', 'b'], focusedPane: 1 });
      const code = state({ tabs: ['app:x', 'c'], panes: ['c'] });
      savePaneState(chat);
      savePaneState(code, CODE_PANE_STATE_STORAGE_KEY);
      expect(CODE_PANE_STATE_STORAGE_KEY).toBe(PANE_STATE_STORAGE_KEY + '.code');
      expect(loadPaneState()).toEqual(chat);
      expect(loadPaneState(PANE_STATE_STORAGE_KEY)).toEqual(chat);
      expect(loadPaneState(CODE_PANE_STATE_STORAGE_KEY)).toEqual(code);
      expect(loadPaneState('otherbench.panes.nothing')).toEqual(DEFAULT_PANE_STATE);
    });
  });

  it("forgets a deleted chat's viewer tabs along with the chat", () => {
    const view = viewTabId('c1', { kind: 'file', path: 'a.md' });
    const other = viewTabId('c2', { kind: 'file', path: 'b.md' });
    const state = { ...DEFAULT_PANE_STATE, tabs: ['c1', view, other], panes: [view] };
    expect(forgetChat(state, 'c1')).toMatchObject({ tabs: [other], panes: [null] });
  });

  it("closing a viewer tab takes it out of its pane too: back to the file's chat, or empty when another pane shows that chat", () => {
    const view = viewTabId('c1', { kind: 'file', path: 'doc.pdf' });
    const single = { ...DEFAULT_PANE_STATE, tabs: ['c1', view], panes: [view] };
    expect(closeTab(single, view)).toMatchObject({ tabs: ['c1'], panes: ['c1'] });
    const split = { ...DEFAULT_PANE_STATE, layout: 'columns-2' as const, tabs: ['c1', view], panes: ['c1', view], focusedPane: 1 };
    expect(closeTab(split, view)).toMatchObject({ tabs: ['c1'], panes: ['c1', null] });
  });

  it('closing a viewer tab in the store shows its chat again', () => {
    useOtherBenchStore.setState(useOtherBenchStore.getInitialState(), true);
    const view = viewTabId('c1', { kind: 'file', path: 'doc.pdf' });
    const store = useOtherBenchStore.getState();
    store.openTab('c1');
    store.openTab(view);
    expect(useOtherBenchStore.getState().activeChatId).toBe(view);
    useOtherBenchStore.getState().closeTab(view);
    expect(useOtherBenchStore.getState()).toMatchObject({ activeChatId: 'c1', paneState: { tabs: ['c1'], panes: ['c1'] } });
  });
});
