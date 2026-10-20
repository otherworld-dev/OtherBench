import { describe, expect, it } from 'vitest';
import { viewTabId } from '../viewer/items.js';
import { closeTab, DEFAULT_PANE_STATE, forgetApp } from './panes.js';
import { APP_TAB_PREFIX, appTabId, parseAppTab } from './appTab.js';
import { isChatTab, parseProjectTab, projectTabId } from './projectTab.js';

describe('app tab ids', () => {
  it('round-trips an app id', () => {
    expect(APP_TAB_PREFIX).toBe('app:');
    expect(appTabId('x')).toBe('app:x');
    expect(parseAppTab('app:x')).toBe('x');
  });

  it('rejects chat ids, viewer and project tab ids, an empty app id and null', () => {
    expect(parseAppTab('c1')).toBeNull();
    expect(parseAppTab(viewTabId('c1', { kind: 'browser' }))).toBeNull();
    expect(parseAppTab(projectTabId('p1'))).toBeNull();
    expect(parseAppTab('app:')).toBeNull();
    expect(parseAppTab(null)).toBeNull();
    expect(parseProjectTab(appTabId('x'))).toBeNull();
  });

  it('an app tab is not a chat tab', () => {
    expect(isChatTab('app:x')).toBe(false);
    expect(isChatTab('c1')).toBe(true);
  });
});

describe('app tabs in the pane state', () => {
  it('closing an app tab empties the pane showing it, with or without a tab', () => {
    const tab = appTabId('a1');
    const state = { ...DEFAULT_PANE_STATE, layout: 'columns-2' as const, tabs: ['c1', tab], panes: ['c1', tab], focusedPane: 1 };
    expect(closeTab(state, tab)).toMatchObject({ tabs: ['c1'], panes: ['c1', null] });
    expect(closeTab({ ...state, tabs: ['c1'] }, tab)).toMatchObject({ tabs: ['c1'], panes: ['c1', null] });
  });

  it('forgetApp removes the tab and empties its panes, and is a no-op for an app with no tab', () => {
    const tab = appTabId('a1');
    const state = { ...DEFAULT_PANE_STATE, layout: 'columns-2' as const, tabs: ['c1', tab], panes: [tab, 'c1'], focusedPane: 0 };
    expect(forgetApp(state, 'a1')).toMatchObject({ tabs: ['c1'], panes: [null, 'c1'] });
    expect(forgetApp(state, 'a2')).toBe(state);
  });
});
