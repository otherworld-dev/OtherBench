import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetSidebarWidthForTests } from './state/sidebarWidth.js';
import { useAuthStore } from './state/auth.js';
import { useOtherBenchStore } from './state/store.js';
import { App } from './App.js';

vi.mock('./state/api.js', () => ({
  api: {
    connections: { list: vi.fn() },
    models: { list: vi.fn() },
    profiles: { list: vi.fn() },
    chats: { list: vi.fn() },
    projects: { list: vi.fn() },
    usage: { get: vi.fn() },
    mcpServers: { list: vi.fn(), refresh: vi.fn() },
    grants: { list: vi.fn(), revoke: vi.fn() },
    audit: { list: vi.fn() },
  },
}));

// The app-wide event stream is tested on its own (state/store.test.ts, server events.test.ts).
vi.mock('./state/useAppEvents.js', () => ({ useAppEvents: () => {} }));
vi.mock('./views/QuickChat.js', () => ({ QuickChat: () => <div data-testid="quick-chat-view" /> }));
vi.mock('./views/IndicatorView.js', () => ({ IndicatorView: () => <div data-testid="indicator-view" /> }));

import { api } from './state/api.js';

const mockedConnections = vi.mocked(api.connections.list);
const mockedModels = vi.mocked(api.models.list);
const mockedProfiles = vi.mocked(api.profiles.list);
const mockedChats = vi.mocked(api.chats.list);
const mockedProjects = vi.mocked(api.projects.list);
const mockedUsage = vi.mocked(api.usage.get);
const mockedMcpList = vi.mocked(api.mcpServers.list);
const mockedGrantsList = vi.mocked(api.grants.list);
const mockedAuditList = vi.mocked(api.audit.list);

function reset(): void {
  window.localStorage.clear();
  resetSidebarWidthForTests();
  useOtherBenchStore.setState(useOtherBenchStore.getInitialState(), true);
  useAuthStore.setState(useAuthStore.getInitialState(), true);
  mockedConnections.mockReset();
  mockedModels.mockReset();
  mockedProfiles.mockReset();
  mockedChats.mockReset();
  mockedProjects.mockReset().mockResolvedValue([]);
  mockedUsage.mockReset();
  // The Inspector's honest-state sections (task 26) mount alongside every
  // other App view regardless of which one the test is exercising -- give
  // them a benign default so this file's tests, which are about
  // connections/models/profiles/chats/usage, aren't also asserting on (or
  // spamming console.error from) MCP/grants/audit polling they don't care about.
  mockedMcpList.mockReset().mockResolvedValue([]);
  mockedGrantsList.mockReset().mockResolvedValue([]);
  mockedAuditList.mockReset().mockResolvedValue([]);

  // jsdom doesn't implement matchMedia -- App's narrow-layout breakpoint
  // (useMediaQuery, lib/useMediaQuery.ts) needs it just to mount.
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
}

describe('App bootstrap', () => {
  beforeEach(reset);
  afterEach(cleanup);

  // IMPORTANT (task 19/20 brief): a cold load with the server down must not
  // render identically to a genuinely fresh install. Before the fix, all
  // four bootstrap fetches failed silently (console.error only), leaving
  // the UI showing "No chats yet..." with no indication anything was wrong.
  it('loads projects at startup alongside the rest of the reference data', async () => {
    mockedConnections.mockResolvedValue([]);
    mockedModels.mockResolvedValue([]);
    mockedProfiles.mockResolvedValue([]);
    mockedChats.mockResolvedValue([]);
    mockedProjects.mockResolvedValue([
      { id: 'p-a', name: 'Alpha', description: '', instructions: '', workspace: null, workspaceRoot: null, defaultProfileId: null, sortOrder: 0, createdAt: 1, updatedAt: 1 },
    ]);

    render(<App />);

    await waitFor(() => expect(useOtherBenchStore.getState().projects.map((p) => p.id)).toEqual(['p-a']));
  });

  it('has a Sign out button in sign-in mode only', async () => {
    mockedConnections.mockResolvedValue([]);
    mockedModels.mockResolvedValue([]);
    mockedProfiles.mockResolvedValue([]);
    mockedChats.mockResolvedValue([]);
    const first = render(<App />);
    await screen.findByRole('button', { name: 'Settings' });
    expect(screen.queryByRole('button', { name: 'Sign out' })).toBeNull();
    first.unmount();

    useAuthStore.setState({ mode: 'login', status: 'ready' });
    render(<App />);
    expect(await screen.findByRole('button', { name: 'Sign out' })).toBeInTheDocument();
  });

  it('shows a clear unreachable-server banner when every bootstrap fetch fails', async () => {
    mockedConnections.mockRejectedValue(new TypeError('Failed to fetch'));
    mockedModels.mockRejectedValue(new TypeError('Failed to fetch'));
    mockedProfiles.mockRejectedValue(new TypeError('Failed to fetch'));
    mockedChats.mockRejectedValue(new TypeError('Failed to fetch'));
    mockedProjects.mockRejectedValue(new TypeError('Failed to fetch'));

    render(<App />);

    const banner = await screen.findByRole('alert');
    expect(banner).toHaveTextContent(/can.t reach the otherbench server/i);
    expect(banner).toHaveTextContent(/may not be running/i);
  });

  it('does NOT show the unreachable banner on a genuine fresh install (server reachable, nothing configured yet)', async () => {
    mockedConnections.mockResolvedValue([]);
    mockedModels.mockResolvedValue([]);
    mockedProfiles.mockResolvedValue([]);
    mockedChats.mockResolvedValue([]);

    render(<App />);

    // Give the bootstrap effect's promises a tick to settle.
    await screen.findByText(/no chats yet/i);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('does NOT show the unreachable banner when only some of the four fetches fail', async () => {
    mockedConnections.mockResolvedValue([]);
    mockedModels.mockResolvedValue([]);
    mockedProfiles.mockResolvedValue([]);
    mockedChats.mockRejectedValue(new Error('transient 500'));

    render(<App />);

    await screen.findByText(/no chats yet/i);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('opens the usage/pricing overlay from the header button, and closes it again', async () => {
    mockedConnections.mockResolvedValue([]);
    mockedModels.mockResolvedValue([]);
    mockedProfiles.mockResolvedValue([]);
    mockedChats.mockResolvedValue([]);
    mockedUsage.mockResolvedValue({ profiles: [], chats: [], buckets: [], totalMeasuredCost: 0, totalCancelledCount: 0, totalUnmeasuredErrorCount: 0 });
    const user = userEvent.setup();

    render(<App />);
    await screen.findByText(/no chats yet/i);

    await user.click(screen.getByRole('button', { name: 'Usage' }));
    expect(await screen.findByTestId('usage-view')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /close usage view/i }));
    expect(screen.queryByTestId('usage-view')).not.toBeInTheDocument();
  });

  it('opens the settings overlay from the header button, and closes it again', async () => {
    mockedConnections.mockResolvedValue([]);
    mockedModels.mockResolvedValue([]);
    mockedProfiles.mockResolvedValue([]);
    mockedChats.mockResolvedValue([]);
    const user = userEvent.setup();

    render(<App />);
    await screen.findByText(/no chats yet/i);

    await user.click(screen.getByRole('button', { name: 'Settings' }));
    expect(await screen.findByTestId('settings-view')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /close settings/i }));
    expect(screen.queryByTestId('settings-view')).not.toBeInTheDocument();
  });
});

describe('App view', () => {
  beforeEach(() => {
    reset();
    for (const list of [mockedConnections, mockedModels, mockedProfiles, mockedChats, mockedProjects]) list.mockResolvedValue([]);
  });
  // Unmount before jsdom goes away: a still-mounted App runs effects (matchMedia) after teardown.
  afterEach(() => {
    cleanup();
    window.history.replaceState({}, '', '/');
  });

  it('renders the quick-chat view when the URL has view=quick, and the main app otherwise', () => {
    window.history.replaceState({}, '', '/?view=quick');
    const { unmount } = render(<App />);
    expect(screen.getByTestId('quick-chat-view')).toBeInTheDocument();
    unmount();
    window.history.replaceState({}, '', '/');
    render(<App />);
    expect(screen.queryByTestId('quick-chat-view')).not.toBeInTheDocument();
  });

  it('renders only the computer-use indicator when the URL has view=indicator', () => {
    window.history.replaceState({}, '', '/?view=indicator&title=Budget');
    render(<App />);
    expect(screen.getByTestId('indicator-view')).toBeInTheDocument();
    expect(screen.queryByTestId('quick-chat-view')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Expand inspector' })).toBeNull();
    window.history.replaceState({}, '', '/');
  });

  it('has no top bar', () => {
    render(<App />);
    expect(screen.queryByRole('banner')).toBeNull();
  });

  it('shows the inspector as a disabled strip while no chat is selected, without changing the saved state', async () => {
    render(<App />);
    const strip = await screen.findByRole('button', { name: 'Expand inspector' });
    expect(strip).toHaveAttribute('aria-disabled', 'true');
    expect(useOtherBenchStore.getState().inspectorCollapsed).toBe(false);
    expect(screen.queryByRole('complementary', { name: 'Inspector' })).toBeNull();
  });

  it('sizes the sidebar column from --sidebar-w, capped at 40% of the window', () => {
    const { container } = render(<App />);
    expect((container.firstElementChild as HTMLElement).style.gridTemplateColumns).toBe('min(var(--sidebar-w, 16.25rem), 40vw) minmax(0, 1fr)');
    expect(screen.getByRole('separator', { name: 'Resize sidebar' })).toBeInTheDocument();
  });
});
