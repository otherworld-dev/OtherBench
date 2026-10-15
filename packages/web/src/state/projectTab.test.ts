import { beforeEach, describe, expect, it } from 'vitest';
import type { Project } from '@grunt/core/ports/store.js';
import { viewTabId } from '../viewer/items.js';
import { closeTab, DEFAULT_PANE_STATE, forgetProject } from './panes.js';
import { isChatTab, parseProjectTab, projectTabId } from './projectTab.js';
import { useGruntStore } from './store.js';

const project = (id: string): Project => ({
  id, name: `Project ${id}`, description: '', instructions: '', workspace: null, defaultProfileId: null, sortOrder: 0, createdAt: 1, updatedAt: 1,
});

describe('project tab ids', () => {
  it('round-trips a project id', () => {
    expect(projectTabId('p1')).toBe('project:p1');
    expect(parseProjectTab(projectTabId('p1'))).toBe('p1');
  });

  it('rejects chat ids, viewer tab ids, an empty project id and null', () => {
    expect(parseProjectTab('c1')).toBeNull();
    expect(parseProjectTab(viewTabId('c1', { kind: 'browser' }))).toBeNull();
    expect(parseProjectTab('project:')).toBeNull();
    expect(parseProjectTab(null)).toBeNull();
  });

  it('tells chat tabs from viewer and project tabs', () => {
    expect(isChatTab('c1')).toBe(true);
    expect(isChatTab(viewTabId('c1', { kind: 'browser' }))).toBe(false);
    expect(isChatTab(projectTabId('p1'))).toBe(false);
    expect(isChatTab(null)).toBe(false);
  });
});

describe('project tabs in the pane state', () => {
  it('closing a project tab empties the pane showing it, unlike a chat tab', () => {
    const tab = projectTabId('p1');
    const state = { ...DEFAULT_PANE_STATE, layout: 'columns-2' as const, tabs: ['c1', tab], panes: ['c1', tab], focusedPane: 1 };
    expect(closeTab(state, tab)).toMatchObject({ tabs: ['c1'], panes: ['c1', null] });
    expect(closeTab(state, 'c1')).toMatchObject({ tabs: [tab], panes: ['c1', tab] });
  });

  it('forgetProject removes the tab and empties its panes, and is a no-op for a project with no tab', () => {
    const tab = projectTabId('p1');
    const state = { ...DEFAULT_PANE_STATE, layout: 'columns-2' as const, tabs: ['c1', tab], panes: [tab, 'c1'], focusedPane: 0 };
    expect(forgetProject(state, 'p1')).toMatchObject({ tabs: ['c1'], panes: [null, 'c1'] });
    expect(forgetProject(state, 'p2')).toBe(state);
  });
});

describe('removeProject', () => {
  beforeEach(() => {
    window.localStorage.clear();
    useGruntStore.setState(useGruntStore.getInitialState(), true);
  });

  it("closes the project's tab and clears the active id when its page was focused", () => {
    useGruntStore.setState({ projects: [project('p1')], paneState: DEFAULT_PANE_STATE, activeChatId: null });
    useGruntStore.getState().openTab(projectTabId('p1'));
    expect(useGruntStore.getState().activeChatId).toBe('project:p1');

    useGruntStore.getState().removeProject('p1');

    expect(useGruntStore.getState().paneState.tabs).toEqual([]);
    expect(useGruntStore.getState().activeChatId).toBeNull();
  });
});
