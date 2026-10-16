import { beforeEach, describe, expect, it } from 'vitest';
import type { Project } from '@otherbench/core/ports/store.js';
import { viewTabId } from '../viewer/items.js';
import { closeTab, DEFAULT_PANE_STATE, forgetProject } from './panes.js';
import { isChatTab, parseProjectTab, projectTabId } from './projectTab.js';
import { useOtherBenchStore } from './store.js';

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

  it('closing a project page that has no tab still empties its pane', () => {
    const tab = projectTabId('p1');
    const state = { ...DEFAULT_PANE_STATE, layout: 'columns-2' as const, tabs: ['c1'], panes: ['c1', tab], focusedPane: 1 };
    expect(closeTab(state, tab)).toMatchObject({ tabs: ['c1'], panes: ['c1', null] });
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
    useOtherBenchStore.setState(useOtherBenchStore.getInitialState(), true);
  });

  it("closes the project's tab and clears the active id when its page was focused", () => {
    useOtherBenchStore.setState({ projects: [project('p1')], paneState: DEFAULT_PANE_STATE, activeChatId: null });
    useOtherBenchStore.getState().openTab(projectTabId('p1'));
    expect(useOtherBenchStore.getState().activeChatId).toBe('project:p1');

    useOtherBenchStore.getState().removeProject('p1');

    expect(useOtherBenchStore.getState().paneState.tabs).toEqual([]);
    expect(useOtherBenchStore.getState().activeChatId).toBeNull();
  });

  it('closes the tab of a project deleted elsewhere when the new project list arrives', () => {
    useOtherBenchStore.getState().setProjects([project('p1'), project('p2')]);
    useOtherBenchStore.getState().openTab(projectTabId('p1'));
    useOtherBenchStore.getState().openTab(projectTabId('p2'));

    useOtherBenchStore.getState().setProjects([project('p2')]);

    expect(useOtherBenchStore.getState().paneState.tabs).toEqual([projectTabId('p2')]);
    expect(useOtherBenchStore.getState().activeChatId).toBe(projectTabId('p2'));
  });
});
