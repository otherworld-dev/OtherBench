import { describe, expect, it } from 'vitest';
import { ALL_APPS_TAB_ID, isAllAppsTab } from './allAppsTab.js';
import { appTabId, parseAppTab } from './appTab.js';
import { closeTab, DEFAULT_PANE_STATE } from './panes.js';
import { isChatTab, parseProjectTab } from './projectTab.js';

describe('the All apps tab id', () => {
  it('is apps:all, and nothing else is it', () => {
    expect(ALL_APPS_TAB_ID).toBe('apps:all');
    expect(isAllAppsTab('apps:all')).toBe(true);
    expect(isAllAppsTab(appTabId('all'))).toBe(false);
    expect(isAllAppsTab('c1')).toBe(false);
    expect(isAllAppsTab(null)).toBe(false);
  });

  it('is not a chat, an app home or a project page', () => {
    expect(isChatTab(ALL_APPS_TAB_ID)).toBe(false);
    expect(parseAppTab(ALL_APPS_TAB_ID)).toBeNull();
    expect(parseProjectTab(ALL_APPS_TAB_ID)).toBeNull();
  });

  it('closing it empties the pane showing it, with or without a tab', () => {
    const state = { ...DEFAULT_PANE_STATE, layout: 'columns-2' as const, tabs: ['c1', ALL_APPS_TAB_ID], panes: ['c1', ALL_APPS_TAB_ID], focusedPane: 1 };
    expect(closeTab(state, ALL_APPS_TAB_ID)).toMatchObject({ tabs: ['c1'], panes: ['c1', null] });
    expect(closeTab({ ...state, tabs: ['c1'] }, ALL_APPS_TAB_ID)).toMatchObject({ tabs: ['c1'], panes: ['c1', null] });
  });
});
