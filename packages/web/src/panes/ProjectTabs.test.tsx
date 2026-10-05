import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { JSX } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Chat, Project } from '@grunt/core/ports/store.js';

vi.mock('../state/api.js', () => ({
  api: { chats: { create: vi.fn() } },
  ApiError: class ApiError extends Error {},
}));

import { api } from '../state/api.js';
import { PROJECT_TABS_STORAGE_KEY, resetProjectTabsForTests } from '../state/projectTabs.js';
import { useGruntStore } from '../state/store.js';
import { ProjectTabs } from './ProjectTabs.js';

const mockedCreate = vi.mocked(api.chats.create);

function chat(id: string, over: Partial<Chat> = {}): Chat {
  return {
    id, title: `Chat ${id}`, profileId: 'p', headMessageId: null, workspaceRoot: null, pinned: false, archivedAt: null, autoMode: false,
    projectId: 'proj', memoryCursor: null, memoryExcluded: false, sortOrder: 0, createdAt: 1, updatedAt: 1, ...over,
  };
}
const project: Project = { id: 'proj', name: 'Grunt app', workspaceRoot: null, defaultProfileId: null, sortOrder: 0, createdAt: 1, updatedAt: 1 };

/** Renders the strip for whichever chat is active in the store, as Thread does. */
function Strip(): JSX.Element | null {
  const active = useGruntStore((s) => s.chats.find((c) => c.id === s.activeChatId) ?? null);
  return active ? <ProjectTabs chat={active} /> : null;
}

const tabNames = (): string[] => within(screen.getByRole('tablist')).getAllByRole('tab').map((t) => t.textContent ?? '');
const storedTabs = (): unknown => JSON.parse(window.localStorage.getItem(PROJECT_TABS_STORAGE_KEY) ?? '{}');

beforeEach(() => {
  window.localStorage.clear();
  resetProjectTabsForTests();
  useGruntStore.setState(useGruntStore.getInitialState(), true);
  useGruntStore.setState({
    projects: [project],
    chats: [
      chat('a', { sortOrder: 30 }),
      chat('b', { sortOrder: 20 }),
      chat('c', { sortOrder: 10 }),
      chat('old', { archivedAt: 5 }),
      chat('elsewhere', { projectId: null }),
    ],
  });
  mockedCreate.mockReset();
});

afterEach(cleanup);

describe('ProjectTabs (#824)', () => {
  it('shows nothing for a chat outside a project', () => {
    useGruntStore.setState({ activeChatId: 'elsewhere' });
    render(<Strip />);
    expect(screen.queryByTestId('project-tabs')).not.toBeInTheDocument();
  });

  it("opening a chat opens its tab; the strip shows the project's open chats in sidebar order, never archived ones", async () => {
    window.localStorage.setItem(PROJECT_TABS_STORAGE_KEY, JSON.stringify({ proj: ['c', 'old'] }));
    useGruntStore.setState({ activeChatId: 'a' });
    render(<Strip />);
    expect(tabNames()).toEqual(['Chat a', 'Chat c']);
    expect(screen.getByRole('tab', { name: 'Chat a' })).toHaveAttribute('aria-selected', 'true');
    await waitFor(() => expect(storedTabs()).toEqual({ proj: ['c', 'old', 'a'] }));
  });

  it('clicking a tab opens that chat', async () => {
    window.localStorage.setItem(PROJECT_TABS_STORAGE_KEY, JSON.stringify({ proj: ['a', 'b'] }));
    useGruntStore.setState({ activeChatId: 'a' });
    const user = userEvent.setup();
    render(<Strip />);
    await user.click(screen.getByRole('tab', { name: 'Chat b' }));
    expect(useGruntStore.getState().activeChatId).toBe('b');
  });

  it('✕ closes a tab without touching the chat; closing the open one moves to its neighbour, the last one leaves nothing open', async () => {
    window.localStorage.setItem(PROJECT_TABS_STORAGE_KEY, JSON.stringify({ proj: ['a', 'b'] }));
    useGruntStore.setState({ activeChatId: 'a' });
    const user = userEvent.setup();
    render(<Strip />);

    await user.click(screen.getByRole('button', { name: 'Close tab Chat b' }));
    expect(tabNames()).toEqual(['Chat a']);
    expect(useGruntStore.getState().activeChatId).toBe('a');

    await user.click(screen.getByRole('tab', { name: 'Chat a' }));
    window.localStorage.setItem(PROJECT_TABS_STORAGE_KEY, JSON.stringify({ proj: ['a', 'c'] }));
    resetProjectTabsForTests();
    cleanup();
    render(<Strip />);
    await user.click(screen.getByRole('button', { name: 'Close tab Chat a' }));
    expect(useGruntStore.getState().activeChatId).toBe('c');

    await user.click(screen.getByRole('button', { name: 'Close tab Chat c' }));
    expect(useGruntStore.getState().activeChatId).toBeNull();
    expect(useGruntStore.getState().chats.map((c) => c.id)).toContain('c');
  });

  it('+ starts a new chat in the project and opens it as a tab', async () => {
    mockedCreate.mockResolvedValue(chat('new', { sortOrder: 99, title: 'New Chat' }));
    useGruntStore.setState({ activeChatId: 'a' });
    const user = userEvent.setup();
    render(<Strip />);
    await user.click(screen.getByRole('button', { name: 'New chat in Grunt app' }));
    expect(mockedCreate).toHaveBeenCalledWith({ projectId: 'proj' });
    await waitFor(() => expect(useGruntStore.getState().activeChatId).toBe('new'));
    expect(tabNames()).toEqual(['New Chat', 'Chat a']);
  });

  it('marks a tab replying, or waiting for an approval', () => {
    window.localStorage.setItem(PROJECT_TABS_STORAGE_KEY, JSON.stringify({ proj: ['a', 'b', 'c'] }));
    useGruntStore.setState({
      activeChatId: 'a',
      appRunningTurns: { m1: 'b', m2: 'c' },
      appPendingApprovals: { r1: { chatId: 'c', messageId: 'm2', requestId: 'r1', toolName: 'Write' } },
    });
    render(<Strip />);
    expect(screen.queryByTestId('tab-status-a')).not.toBeInTheDocument();
    expect(screen.getByTestId('tab-status-b')).toHaveAttribute('data-status', 'working');
    expect(screen.getByTestId('tab-status-c')).toHaveAttribute('data-status', 'waiting');
    expect(screen.getByRole('img', { name: 'waiting for approval' })).toBeInTheDocument();
  });

  it('arrow keys move between tabs, and Delete closes the focused one', async () => {
    window.localStorage.setItem(PROJECT_TABS_STORAGE_KEY, JSON.stringify({ proj: ['a', 'b', 'c'] }));
    useGruntStore.setState({ activeChatId: 'a' });
    const user = userEvent.setup();
    render(<Strip />);
    screen.getByRole('tab', { name: 'Chat a' }).focus();
    await user.keyboard('{ArrowRight}');
    expect(useGruntStore.getState().activeChatId).toBe('b');
    await waitFor(() => expect(screen.getByRole('tab', { name: 'Chat b' })).toHaveFocus());
    await user.keyboard('{End}');
    expect(useGruntStore.getState().activeChatId).toBe('c');
    await waitFor(() => expect(screen.getByRole('tab', { name: 'Chat c' })).toHaveFocus());
    await user.keyboard('{Delete}');
    expect(tabNames()).toEqual(['Chat a', 'Chat b']);
  });
});
