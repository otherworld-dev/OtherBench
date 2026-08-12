import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useGruntStore } from './state/store.js';
import { App } from './App.js';

vi.mock('./state/api.js', () => ({
  api: {
    connections: { list: vi.fn() },
    models: { list: vi.fn() },
    profiles: { list: vi.fn() },
    chats: { list: vi.fn() },
  },
}));

import { api } from './state/api.js';

const mockedConnections = vi.mocked(api.connections.list);
const mockedModels = vi.mocked(api.models.list);
const mockedProfiles = vi.mocked(api.profiles.list);
const mockedChats = vi.mocked(api.chats.list);

function reset(): void {
  useGruntStore.setState(useGruntStore.getInitialState(), true);
  mockedConnections.mockReset();
  mockedModels.mockReset();
  mockedProfiles.mockReset();
  mockedChats.mockReset();

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
  it('shows a clear unreachable-server banner when every bootstrap fetch fails', async () => {
    mockedConnections.mockRejectedValue(new TypeError('Failed to fetch'));
    mockedModels.mockRejectedValue(new TypeError('Failed to fetch'));
    mockedProfiles.mockRejectedValue(new TypeError('Failed to fetch'));
    mockedChats.mockRejectedValue(new TypeError('Failed to fetch'));

    render(<App />);

    const banner = await screen.findByRole('alert');
    expect(banner).toHaveTextContent(/can.t reach the grunt server/i);
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
});
