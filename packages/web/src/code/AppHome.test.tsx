import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { App, Chat, Project } from '@otherbench/core/ports/store.js';

vi.mock('../state/api.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../state/api.js')>();
  return {
    ...actual,
    api: {
      ...actual.api,
      chats: { ...actual.api.chats, create: vi.fn() },
      apps: { ...actual.api.apps, issues: { list: vi.fn(), get: vi.fn(), comment: vi.fn(), close: vi.fn(), reopen: vi.fn() } },
    },
  };
});

import { ApiError, api } from '../state/api.js';
import { appTabId } from '../state/appTab.js';
import { DEFAULT_PANE_STATE } from '../state/panes.js';
import { useOtherBenchStore } from '../state/store.js';
import { AppHome } from './AppHome.js';

const app = (over: Partial<App> = {}): App => ({
  id: 'a1', name: 'OtherBench', workspace: null, workspaceRoot: 'E:/Git/OtherBench', githubRepo: 'otherworld-dev/OtherBench', linkedProjectId: 'p1', defaultProfileId: null, sortOrder: 0, createdAt: 1, updatedAt: 1, ...over,
});
const project: Project = { id: 'p1', name: 'Planning', description: '', instructions: '', workspace: null, defaultProfileId: null, sortOrder: 0, createdAt: 1, updatedAt: 1 };
const chat = (id: string, over: Partial<Chat> = {}): Chat => ({
  id, title: `Chat ${id}`, profileId: 'prof', headMessageId: null, workspace: null, runsOn: 'node-self', workspaceRoot: null, pinned: false, projectPinned: false, unread: false, archivedAt: null, autoMode: false,
  projectId: null, appId: 'a1', memoryCursor: null, memoryExcluded: false, sortOrder: 0, createdAt: 1, updatedAt: 1, ...over,
});

beforeEach(() => {
  window.localStorage.clear();
  useOtherBenchStore.setState(useOtherBenchStore.getInitialState(), true);
  useOtherBenchStore.setState({
    mode: 'code',
    paneState: { ...DEFAULT_PANE_STATE, tabs: [appTabId('a1')], panes: [appTabId('a1')] },
    activeChatId: appTabId('a1'),
    projects: [project],
    projectsLoaded: true,
  });
  vi.mocked(api.apps.issues.list).mockResolvedValue({
    repo: 'otherworld-dev/OtherBench',
    issues: [{ number: 48, title: 'MCP tools vanish on reconnect', state: 'open', author: 'adam', labels: [], comments: 0, createdAt: '2026-10-10T10:00:00Z', updatedAt: '2026-10-10T10:00:00Z', url: 'https://github.com/x/y/issues/48' }],
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('AppHome', () => {
  it('shows the name, folder, GitHub repo and linked project', () => {
    useOtherBenchStore.setState({ apps: [app()], appsLoaded: true });
    render(<AppHome appId="a1" />);
    expect(screen.getByRole('heading', { level: 2, name: 'OtherBench' })).toBeInTheDocument();
    expect(screen.getByTestId('app-home-folder')).toHaveTextContent('E:/Git/OtherBench');
    expect(screen.getByTestId('app-home-repo')).toHaveTextContent('otherworld-dev/OtherBench');
    expect(screen.getByTestId('app-home-project')).toHaveTextContent('Planning');
  });

  it("New chat creates a chat in the app and opens it", async () => {
    useOtherBenchStore.setState({ apps: [app()], appsLoaded: true });
    vi.mocked(api.chats.create).mockResolvedValue(chat('c9'));
    render(<AppHome appId="a1" />);
    await userEvent.setup().click(screen.getByTestId('app-home-new-chat'));
    await waitFor(() => expect(api.chats.create).toHaveBeenCalledWith({ appId: 'a1' }));
    await waitFor(() => expect(useOtherBenchStore.getState().activeChatId).toBe('c9'));
    expect(useOtherBenchStore.getState().chats.map((c) => c.id)).toEqual(['c9']);
  });

  it('a failed New chat says why', async () => {
    useOtherBenchStore.setState({ apps: [app()], appsLoaded: true });
    vi.mocked(api.chats.create).mockRejectedValue(new ApiError(400, 'App not found.'));
    render(<AppHome appId="a1" />);
    await userEvent.setup().click(screen.getByTestId('app-home-new-chat'));
    expect(await screen.findByText('App not found.')).toBeInTheDocument();
  });

  it("lists the app's chats, and a click shows one", async () => {
    useOtherBenchStore.setState({ apps: [app()], appsLoaded: true, chats: [chat('c1'), chat('c2', { appId: 'other' }), chat('c3', { archivedAt: 5 })] });
    render(<AppHome appId="a1" />);
    const list = screen.getByTestId('app-home-chats');
    expect(within(list).getAllByRole('listitem').map((r) => r.getAttribute('data-chat-id'))).toEqual(['c1']);
    await userEvent.setup().click(within(list).getByRole('button', { name: /^Chat c1/ }));
    expect(useOtherBenchStore.getState().activeChatId).toBe('c1');
  });

  it('shows the open issues', async () => {
    useOtherBenchStore.setState({ apps: [app()], appsLoaded: true });
    render(<AppHome appId="a1" />);
    expect(await within(screen.getByTestId('app-home-issues')).findByTestId('issue-row-48')).toHaveTextContent('MCP tools vanish on reconnect');
  });

  it('in a narrow window, Panel opens the Code panel overlay', async () => {
    useOtherBenchStore.setState({ apps: [app()], appsLoaded: true });
    const original = window.matchMedia;
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({ matches: true, media: query, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
    try {
      render(<AppHome appId="a1" />);
      await userEvent.setup().click(screen.getByRole('button', { name: 'Panel' }));
      expect(useOtherBenchStore.getState().inspectorOverlayOpen).toBe(true);
    } finally {
      window.matchMedia = original;
    }
  });

  it('waits for the app list before calling an app missing', () => {
    render(<AppHome appId="a1" />);
    expect(screen.getByText('Loading…')).toBeInTheDocument();
  });

  it('an app that no longer exists says so, and its tab can be closed', async () => {
    useOtherBenchStore.setState({ apps: [], appsLoaded: true });
    render(<AppHome appId="a1" />);
    expect(screen.getByText(/This app no longer exists/)).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Close' }));
    expect(useOtherBenchStore.getState().paneState.tabs).toEqual([]);
  });
});
