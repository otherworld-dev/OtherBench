import { beforeEach, describe, expect, it } from 'vitest';
import { useToasts } from '../lib/toasts.js';
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
  placeInPane,
  resizeSplit,
  savePaneState,
  setLayout,
  setSplitSizes,
  showChat,
  toggleMaximised,
  togglePanePin,
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

  it('opening a tab makes only that chat a tab, and opens it beside the chat on show rather than over it', () => {
    // One pane: it splits in two, the chat on show staying put and the new tab beside it, focused.
    expect(openTab(state({ tabs: [], panes: ['open'] }), 'new')).toMatchObject({ tabs: ['new'], layout: 'columns-2', panes: ['open', 'new'], focusedPane: 1 });
    expect(openTab(state({ tabs: ['x'], panes: ['open'] }), 'new')).toMatchObject({ tabs: ['x', 'new'], panes: ['open', 'new'] });
    expect(openTab(state({ tabs: ['open'], panes: ['open'] }), 'new')).toMatchObject({ tabs: ['open', 'new'], panes: ['open', 'new'] });
    // The same chat, or an empty pane: nothing to open beside.
    expect(openTab(state({ tabs: [], panes: ['a'] }), 'a')).toMatchObject({ tabs: ['a'], layout: 'single', panes: ['a'] });
    expect(openTab(state({ tabs: [], panes: [null] }), 'new')).toMatchObject({ tabs: ['new'], layout: 'single', panes: ['new'] });
    // A chat already showing in another pane is only focused, so nothing is replaced.
    const two = state({ layout: 'columns-2', tabs: [], panes: ['open', 'new'], focusedPane: 0 });
    expect(openTab(two, 'new')).toMatchObject({ tabs: ['new'], panes: ['open', 'new'], focusedPane: 1 });
  });

  it('with several panes a new tab takes an empty one, else the one after the focused pane, never the focused one', () => {
    const gap = state({ layout: 'columns-3', tabs: ['c'], panes: ['a', null, 'c'], focusedPane: 2 });
    expect(openTab(gap, 'new')).toMatchObject({ panes: ['a', 'new', 'c'], focusedPane: 1 });
    // The case that was reported: A on show, an old tab C beside it; B goes over C, not over A.
    const full = state({ layout: 'columns-2', tabs: ['c'], panes: ['a', 'c'], focusedPane: 0, maximised: true });
    expect(openTab(full, 'b')).toMatchObject({ tabs: ['c', 'b'], panes: ['a', 'b'], focusedPane: 1, maximised: false });
    expect(openTab({ ...full, focusedPane: 1 }, 'b')).toMatchObject({ panes: ['b', 'c'], focusedPane: 0 });
  });

  it('a viewer popped out as a tab still takes its chat\'s pane, which it hands back on closing', () => {
    const view = viewTabId('c1', { kind: 'file', path: 'doc.pdf' });
    expect(openTab(state({ tabs: [], panes: ['c1'] }), view)).toMatchObject({ tabs: [view], layout: 'single', panes: [view] });
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
        tabs: ['a'], layout: 'columns-3', panes: ['a', null, null], focusedPane: 0, sizes: { 'grid-4/top': [1, 3] }, maximised: true, pinned: [], lastFree: 0,
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

describe('pinned panes', () => {
  const two = (over: Partial<PaneState> = {}): PaneState => state({ layout: 'columns-2', tabs: ['main'], panes: ['main', 'side'], focusedPane: 0, pinned: [0], lastFree: 1, ...over });

  it('a chat opened while a pinned pane has focus goes to the unpinned pane, which takes focus', () => {
    // The case that was reported: replying in the long task must not make it the next one replaced.
    expect(showChat(two(), 'other')).toMatchObject({ panes: ['main', 'other'], focusedPane: 1 });
  });

  it('the unpinned pane used last takes it, when there are several', () => {
    const three = state({ layout: 'columns-3', panes: ['main', 'x', 'y'], focusedPane: 1, pinned: [0], lastFree: 1 });
    const replying = focusPane(focusPane(three, 2), 0);
    expect(replying).toMatchObject({ focusedPane: 0, lastFree: 2 });
    expect(showChat(replying, 'other').panes).toEqual(['main', 'x', 'other']);
  });

  it('picking the pinned chat focuses it, and the next chat still goes to the unpinned pane', () => {
    const back = showChat(two({ focusedPane: 1 }), 'main');
    expect(back).toMatchObject({ panes: ['main', 'side'], focusedPane: 0 });
    expect(showChat(back, 'next').panes).toEqual(['main', 'next']);
  });

  it('an unpinned focused pane is replaced as usual', () => {
    expect(showChat(two({ focusedPane: 1 }), 'other')).toMatchObject({ panes: ['main', 'other'], focusedPane: 1 });
  });

  it('with every pane pinned the layout gains a pane for the chat', () => {
    expect(showChat(two({ pinned: [0, 1] }), 'other')).toMatchObject({ layout: 'columns-3', panes: ['main', 'side', 'other'], focusedPane: 2, pinned: [0, 1] });
    expect(showChat(state({ layout: 'rows-2', panes: ['a', 'b'], pinned: [0, 1] }), 'c')).toMatchObject({ layout: 'columns-3', panes: ['a', 'b', 'c'] });
    expect(showChat(state({ layout: 'main-right-2', panes: ['a', 'b', 'c'], pinned: [0, 1, 2] }), 'd')).toMatchObject({ layout: 'grid-4', panes: ['a', 'b', 'c', 'd'], focusedPane: 3 });
  });

  it('four pinned panes replace nothing', () => {
    const full = state({ layout: 'grid-4', panes: ['a', 'b', 'c', 'd'], pinned: [0, 1, 2, 3] });
    expect(showChat(full, 'e')).toBe(full);
  });

  it('a chat sent away from a pinned pane restores a maximised layout, so both show', () => {
    expect(showChat(two({ maximised: true }), 'other')).toMatchObject({ panes: ['main', 'other'], maximised: false });
    // Replacing the maximised pane itself keeps it maximised, as it always did.
    expect(showChat(two({ focusedPane: 1, maximised: true }), 'other')).toMatchObject({ maximised: true });
  });

  it('clearing the focused pane clears it even when pinned, and drops the pin', () => {
    // Deleting or archiving the chat on show: it must not stay behind in the pane.
    expect(showChat(two(), null)).toMatchObject({ panes: [null, 'side'], focusedPane: 0, pinned: [] });
  });

  it('a new tab never covers a pinned pane or the chat on show', () => {
    expect(openTab(two({ focusedPane: 1 }), 'new')).toMatchObject({ layout: 'columns-3', panes: ['main', 'side', 'new'], focusedPane: 2 });
    expect(openTab(two(), 'new')).toMatchObject({ panes: ['main', 'new'], focusedPane: 1 });
    const three = state({ layout: 'columns-3', panes: ['a', 'b', 'c'], focusedPane: 0, pinned: [1] });
    expect(openTab(three, 'new').panes).toEqual(['a', 'b', 'new']);
    // Nowhere to grow and one free pane left: it takes that rather than be lost.
    const full = state({ layout: 'grid-4', panes: ['a', 'b', 'c', 'd'], focusedPane: 3, pinned: [0, 1, 2] });
    expect(openTab(full, 'new').panes).toEqual(['a', 'b', 'c', 'new']);
  });

  it('placing a chat in a pane goes over a pin, which stays', () => {
    expect(placeInPane(two({ focusedPane: 1 }), 0, 'dropped')).toMatchObject({ panes: ['dropped', 'side'], focusedPane: 0, pinned: [0] });
    expect(placeInPane(two(), 0, 'side')).toMatchObject({ panes: ['main', 'side'], focusedPane: 1 });
  });

  it('pins and unpins a pane holding something, in a layout with panes to pin', () => {
    const open = state({ layout: 'columns-2', panes: ['a', null] });
    expect(togglePanePin(open, 0).pinned).toEqual([0]);
    expect(togglePanePin(togglePanePin(open, 0), 0).pinned).toEqual([]);
    expect(togglePanePin(open, 1)).toBe(open);
    const single = state({ panes: ['a'] });
    expect(togglePanePin(single, 0)).toBe(single);
  });

  it('a closed or forgotten chat takes its pin with it', () => {
    const tabs = state({ layout: 'columns-2', tabs: ['a', 'b', 'c'], panes: ['a', 'b'], pinned: [0] });
    expect(closeTab(tabs, 'a')).toMatchObject({ panes: ['c', 'b'], pinned: [] });
    expect(closeTab(tabs, 'b').pinned).toEqual([0]);
    expect(forgetChat(tabs, 'a')).toMatchObject({ panes: [null, 'b'], pinned: [] });
  });

  it('a layout keeps the pins of panes it keeps, and one chat has none', () => {
    const three = state({ layout: 'columns-3', panes: ['a', 'b', 'c'], focusedPane: 0, pinned: [0, 2] });
    expect(setLayout(three, 'columns-2')).toMatchObject({ panes: ['a', 'b'], pinned: [0] });
    expect(setLayout(three, 'single')).toMatchObject({ panes: ['a'], pinned: [] });
  });

  it('shrinking the layout does not hand the focused chat over a pinned pane', () => {
    const three = state({ layout: 'columns-3', panes: ['a', 'pin', 'c'], focusedPane: 2, pinned: [1] });
    expect(setLayout(three, 'columns-2')).toMatchObject({ panes: ['a', 'pin'], focusedPane: 1, pinned: [1] });
  });

  it('saves and repairs pins', () => {
    window.localStorage.clear();
    savePaneState(state({ layout: 'columns-2', panes: ['a', 'b'], pinned: [0], lastFree: 1 }));
    expect(loadPaneState()).toMatchObject({ pinned: [0], lastFree: 1 });
    window.localStorage.setItem(PANE_STATE_STORAGE_KEY, JSON.stringify({ layout: 'columns-2', panes: ['a', null], pinned: [0, 0, 1, 7, 'x'], lastFree: 9 }));
    expect(loadPaneState()).toMatchObject({ pinned: [0], lastFree: 0 });
    window.localStorage.setItem(PANE_STATE_STORAGE_KEY, JSON.stringify({ layout: 'columns-2', panes: ['a', 'b'] }));
    expect(loadPaneState()).toMatchObject({ pinned: [], lastFree: 0 });
  });
});

describe('pinned panes in the store', () => {
  beforeEach(() => {
    window.localStorage.clear();
    useToasts.setState({ toasts: [] });
    useOtherBenchStore.setState(useOtherBenchStore.getInitialState(), true);
  });

  const start = (over: Partial<PaneState>): void => {
    const paneState = state({ layout: 'columns-2', panes: ['main', 'side'], ...over });
    useOtherBenchStore.setState({ paneState, activeChatId: paneState.panes[paneState.focusedPane] ?? null });
  };

  it('setActiveChatId leaves a focused pinned pane alone, and the active chat follows', () => {
    start({ pinned: [0], focusedPane: 0 });
    useOtherBenchStore.getState().setActiveChatId('other');
    expect(useOtherBenchStore.getState()).toMatchObject({ activeChatId: 'other', paneState: { panes: ['main', 'other'], focusedPane: 1 } });
  });

  it('says so when four pinned panes leave nowhere to open a chat', () => {
    start({ layout: 'grid-4', panes: ['a', 'b', 'c', 'd'], pinned: [0, 1, 2, 3] });
    useOtherBenchStore.getState().setActiveChatId('e');
    expect(useOtherBenchStore.getState().activeChatId).toBe('a');
    expect(useToasts.getState().toasts.map((t) => t.text)).toEqual(['Every pane is pinned. Unpin one to open this chat.']);
  });

  it('togglePanePin pins the pane', () => {
    start({ focusedPane: 1 });
    useOtherBenchStore.getState().togglePanePin(0);
    expect(useOtherBenchStore.getState().paneState.pinned).toEqual([0]);
  });

  it('placeChat fills a pane over its pin', () => {
    start({ pinned: [0], focusedPane: 1 });
    useOtherBenchStore.getState().placeChat(0, 'dropped');
    expect(useOtherBenchStore.getState()).toMatchObject({ activeChatId: 'dropped', paneState: { panes: ['dropped', 'side'], focusedPane: 0, pinned: [0] } });
  });
});
