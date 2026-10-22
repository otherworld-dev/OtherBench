import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Chat, Project } from '@otherbench/core/ports/store.js';
import type { Profile } from '@otherbench/core/types/config.js';

vi.mock('../state/api.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../state/api.js')>();
  return { ...actual, api: { ...actual.api, memory: { ...actual.api.memory, get: vi.fn() } } };
});
vi.mock('../state/startChat.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../state/startChat.js')>();
  return { ...actual, startChat: vi.fn() };
});

import { ApiError, api } from '../state/api.js';
import { DEFAULT_PANE_STATE } from '../state/panes.js';
import { projectTabId } from '../state/projectTab.js';
import { StartChatError, startChat } from '../state/startChat.js';
import { useOtherBenchStore } from '../state/store.js';
import { ProjectHome, resetPendingStartsForTests } from './ProjectHome.js';

const project = (over: Partial<Project> = {}): Project => ({
  id: 'p1', name: 'Alpha', description: '', instructions: '', workspace: null, defaultProfileId: null, sortOrder: 0, createdAt: 1, updatedAt: 1, ...over,
});
const chat = (id: string, over: Partial<Chat> = {}): Chat => ({
  id, title: `Chat ${id}`, profileId: 'prof', headMessageId: null, workspace: null, runsOn: 'node-self', workspaceRoot: null, pinned: false, projectPinned: false, unread: false, archivedAt: null, autoMode: false,
  projectId: 'p1', appId: null, memoryCursor: null, memoryExcluded: false, sortOrder: 0, createdAt: 1, updatedAt: 1, ...over,
});
const profile = (id: string, name: string): Profile => ({
  id, name, description: null, colour: null, connectionId: 'c', modelId: 'm', systemPrompt: null, params: {},
  toolPolicy: { fs: 'off', shell: false, mcpServerIds: [], approvalMode: 'always_ask' }, isDefault: false, archivedAt: null,
});
const emptyMemory = { memory: { projectId: 'p1', body: '', updatedAt: 0, updatedBy: 'user' as const, sourceChatId: null }, lastError: null };

beforeEach(() => {
  resetPendingStartsForTests();
  window.localStorage.clear();
  useOtherBenchStore.setState(useOtherBenchStore.getInitialState(), true);
  useOtherBenchStore.setState({ paneState: { ...DEFAULT_PANE_STATE, tabs: [projectTabId('p1')], panes: [projectTabId('p1')] }, activeChatId: projectTabId('p1') });
  vi.mocked(api.memory.get).mockResolvedValue(emptyMemory);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('ProjectHome', () => {
  it('shows the name and description, and Settings… opens the project settings page', async () => {
    useOtherBenchStore.setState({ projects: [project({ description: 'Local workbench' })] });
    render(<ProjectHome projectId="p1" />);
    expect(screen.getByRole('heading', { level: 2, name: 'Alpha' })).toBeInTheDocument();
    expect(screen.getByText('Local workbench')).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Settings…' }));
    expect(useOtherBenchStore.getState().projectPage).toEqual({ mode: 'edit', projectId: 'p1' });
  });

  it("lists the project's unarchived chats, pinned in the project first, with time and status; a click shows the chat", async () => {
    const now = Date.now();
    useOtherBenchStore.setState({
      projects: [project()],
      chats: [
        chat('c1', { updatedAt: now - 2 * 3_600_000 }),
        chat('c2', { projectPinned: true }),
        chat('c3', { archivedAt: 5 }),
        chat('c4', { projectId: 'other' }),
      ],
      appRunningTurns: { m1: 'c1' },
    });
    render(<ProjectHome projectId="p1" />);

    const rows = within(screen.getByTestId('home-chats')).getAllByRole('listitem');
    expect(rows.map((r) => r.getAttribute('data-chat-id'))).toEqual(['c2', 'c1']);
    expect(within(rows[1]!).getByText('2 h ago')).toBeInTheDocument();
    expect(screen.getByTestId('home-chat-status-c1')).toHaveAttribute('data-status', 'working');

    await userEvent.setup().click(screen.getByRole('button', { name: /^Chat c1/ }));
    expect(useOtherBenchStore.getState().activeChatId).toBe('c1');
  });

  it('says plainly what is empty', async () => {
    useOtherBenchStore.setState({ projects: [project()] });
    render(<ProjectHome projectId="p1" />);
    expect(screen.getByText('No chats yet')).toBeInTheDocument();
    expect(screen.getByText('No instructions')).toBeInTheDocument();
    expect(screen.getByText('No folder')).toBeInTheDocument();
    expect(screen.getByText("OtherBench's default profile")).toBeInTheDocument();
    expect(await screen.findByText('No memory yet')).toBeInTheDocument();
    expect(screen.getByText('Not saved yet')).toBeInTheDocument();
  });

  it('shows the folder, extra folders and default profile when set', () => {
    useOtherBenchStore.setState({
      projects: [
        project({
          workspace: { kind: 'machine', nodeId: 'n', root: '/w' },
          workspaceRoot: '/w',
          defaultProfileId: 'prof',
          folderViews: [{ workspace: { kind: 'machine', nodeId: 'n', root: '/docs' }, access: 'read', root: '/docs', status: { status: 'ok', root: '/docs' } }],
        }),
      ],
      profiles: [profile('prof', 'Everyday')],
    });
    render(<ProjectHome projectId="p1" />);
    expect(screen.getByText('/w')).toBeInTheDocument();
    expect(screen.getByText('/docs')).toBeInTheDocument();
    expect(screen.getByText('Everyday')).toBeInTheDocument();
  });

  /** jsdom has no layout: a cut block measures taller inside than it shows. */
  function measureClamped(cut: boolean): () => void {
    const scroll = vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function (this: HTMLElement) {
      return this.hasAttribute('data-clamp') && cut ? 400 : 0;
    });
    const client = vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (this: HTMLElement) {
      return this.hasAttribute('data-clamp') ? 160 : 0;
    });
    return () => {
      scroll.mockRestore();
      client.mockRestore();
    };
  }

  it('offers Show more / Show less only when the text is really cut, going by its rendered height', async () => {
    const user = userEvent.setup();
    useOtherBenchStore.setState({ projects: [project({ instructions: Array.from({ length: 20 }, (_, i) => `Rule ${i}`).join('\n') })] });
    let restore = measureClamped(false);
    render(<ProjectHome projectId="p1" />);
    expect(screen.queryByRole('button', { name: 'Show more' })).toBeNull();
    restore();
    cleanup();

    restore = measureClamped(true);
    useOtherBenchStore.setState({ projects: [project({ instructions: 'Two lines\nthat wrap a lot in a narrow pane' })] });
    render(<ProjectHome projectId="p1" />);
    await user.click(screen.getByRole('button', { name: 'Show more' }));
    expect(screen.getByRole('button', { name: 'Show less' })).toBeInTheDocument();
    restore();
  });

  it('opens cut text when focus moves into it, so a hidden link is never focused out of sight', async () => {
    vi.mocked(api.memory.get).mockResolvedValueOnce({ ...emptyMemory, memory: { ...emptyMemory.memory, body: '## Goals\n\nSee [the notes](https://example.com/notes).\n', updatedAt: Date.now() } });
    useOtherBenchStore.setState({ projects: [project()] });
    const restore = measureClamped(true);
    render(<ProjectHome projectId="p1" />);
    const link = await screen.findByRole('link', { name: 'the notes' });
    expect(within(screen.getByRole('region', { name: 'Memory' })).getByRole('button', { name: 'Show more' })).toBeInTheDocument();

    act(() => link.focus());

    expect(within(screen.getByRole('region', { name: 'Memory' })).getByRole('button', { name: 'Show less' })).toBeInTheDocument();
    restore();
  });

  it("shows the memory and who last changed it, or that it couldn't load", async () => {
    vi.mocked(api.memory.get).mockResolvedValueOnce({ ...emptyMemory, memory: { ...emptyMemory.memory, body: 'Uses npm workspaces', updatedAt: Date.now() - 5 * 60_000 } });
    useOtherBenchStore.setState({ projects: [project()] });
    render(<ProjectHome projectId="p1" />);
    expect(await screen.findByText('Uses npm workspaces')).toBeInTheDocument();
    expect(screen.getByText('Updated 5 min ago by you')).toBeInTheDocument();
    cleanup();

    vi.mocked(api.memory.get).mockRejectedValueOnce(new Error('down'));
    render(<ProjectHome projectId="p1" />);
    expect(await screen.findByText("Couldn't load project memory.")).toBeInTheDocument();
  });

  it('counts a memory of only the template headings as empty, and shows real memory as formatted Markdown', async () => {
    const template = '## Pinned\n\n## Goals\n\n## Decisions\n\n## Current focus\n\n## Open questions\n';
    vi.mocked(api.memory.get).mockResolvedValueOnce({ ...emptyMemory, memory: { ...emptyMemory.memory, body: template } });
    useOtherBenchStore.setState({ projects: [project()] });
    render(<ProjectHome projectId="p1" />);
    expect(await screen.findByText('No memory yet')).toBeInTheDocument();
    expect(screen.queryByText('## Goals')).toBeNull();
    cleanup();

    vi.mocked(api.memory.get).mockResolvedValueOnce({ ...emptyMemory, memory: { ...emptyMemory.memory, body: '## Pinned\n\n## Goals\n\nShip the project page.\n', updatedAt: Date.now() } });
    render(<ProjectHome projectId="p1" />);
    expect(await screen.findByText('Ship the project page.')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Goals' })).toBeInTheDocument();
  });

  it("says Loading, not deleted, while the project list hasn't arrived", () => {
    render(<ProjectHome projectId="p1" />);
    expect(screen.getByText('Loading…')).toBeInTheDocument();
    expect(screen.queryByText(/This project no longer exists/)).toBeNull();
  });

  it('says a missing project no longer exists, and Close closes its tab', async () => {
    useOtherBenchStore.getState().setProjects([]);
    render(<ProjectHome projectId="p1" />);
    expect(screen.getByText(/This project no longer exists/)).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Close' }));
    expect(useOtherBenchStore.getState().paneState.tabs).toEqual([]);
  });

  describe('start a chat', () => {
    const box = (): HTMLElement => screen.getByRole('textbox', { name: 'Start a chat in Alpha' });

    it('sends on Enter and shows the new chat; Shift+Enter adds a line; blank does nothing', async () => {
      const user = userEvent.setup();
      useOtherBenchStore.setState({ projects: [project()] });
      vi.mocked(startChat).mockResolvedValue(chat('c9'));
      render(<ProjectHome projectId="p1" />);

      await user.type(box(), '   {Enter}');
      expect(startChat).not.toHaveBeenCalled();
      await user.clear(box());
      await user.type(box(), 'first line{Shift>}{Enter}{/Shift}second');
      expect(startChat).not.toHaveBeenCalled();
      await user.type(box(), '{Enter}');

      expect(startChat).toHaveBeenCalledWith({ projectId: 'p1', text: 'first line\nsecond' });
      await waitFor(() => expect(useOtherBenchStore.getState().activeChatId).toBe('c9'));
    });

    it('keeps the text and shows the error on failure, and a retry sends into the chat already made', async () => {
      const user = userEvent.setup();
      useOtherBenchStore.setState({ projects: [project()], chats: [chat('c9')] }); // startChat adds the chat it made
      vi.mocked(startChat).mockRejectedValueOnce(new StartChatError(chat('c9'), new ApiError(500, 'The model is unavailable.'))).mockResolvedValueOnce(chat('c9'));
      render(<ProjectHome projectId="p1" />);

      await user.type(box(), 'hello{Enter}');
      expect(await screen.findByRole('alert')).toHaveTextContent('The model is unavailable.');
      expect(box()).toHaveValue('hello');

      await user.type(box(), '{Enter}');
      expect(startChat).toHaveBeenLastCalledWith({ projectId: 'p1', chat: expect.objectContaining({ id: 'c9' }), text: 'hello' });
      await waitFor(() => expect(useOtherBenchStore.getState().activeChatId).toBe('c9'));
    });

    it('puts the new chat in the pane the page was in, keeping focus where it went during a slow send', async () => {
      const user = userEvent.setup();
      let resolve!: (c: Chat) => void;
      vi.mocked(startChat).mockImplementation(() => new Promise((r) => (resolve = r)));
      useOtherBenchStore.setState({
        projects: [project()],
        chats: [chat('b', { projectId: null })],
        paneState: { ...DEFAULT_PANE_STATE, layout: 'columns-2', tabs: [projectTabId('p1')], panes: [projectTabId('p1'), 'b'], focusedPane: 0 },
        activeChatId: projectTabId('p1'),
      });
      render(<ProjectHome projectId="p1" />);

      await user.type(box(), 'hello{Enter}');
      act(() => useOtherBenchStore.getState().focusPane(1));
      await act(async () => resolve(chat('c9')));

      const { paneState, activeChatId } = useOtherBenchStore.getState();
      expect(paneState.panes).toEqual(['c9', 'b']);
      expect(activeChatId).toBe('b');
    });

    it("leaves a pane alone that moved on to something else while the send was going", async () => {
      const user = userEvent.setup();
      let resolve!: (c: Chat) => void;
      vi.mocked(startChat).mockImplementation(() => new Promise((r) => (resolve = r)));
      useOtherBenchStore.setState({ projects: [project()], chats: [chat('b', { projectId: null })] });
      render(<ProjectHome projectId="p1" />);

      await user.type(box(), 'hello{Enter}');
      act(() => useOtherBenchStore.getState().setActiveChatId('b'));
      await act(async () => resolve(chat('c9')));

      expect(useOtherBenchStore.getState().paneState.panes).toEqual(['b']);
      expect(useOtherBenchStore.getState().activeChatId).toBe('b');
    });

    it('still retries into the chat already made after the page was left and reopened', async () => {
      const user = userEvent.setup();
      useOtherBenchStore.setState({ projects: [project()], chats: [chat('c9')] });
      vi.mocked(startChat).mockRejectedValueOnce(new StartChatError(chat('c9'), new ApiError(500, 'The model is unavailable.'))).mockResolvedValueOnce(chat('c9'));
      const { unmount } = render(<ProjectHome projectId="p1" />);
      await user.type(box(), 'hello{Enter}');
      await screen.findByRole('alert');
      unmount();

      render(<ProjectHome projectId="p1" />);
      await user.type(box(), 'hello{Enter}');
      expect(startChat).toHaveBeenLastCalledWith({ projectId: 'p1', chat: expect.objectContaining({ id: 'c9' }), text: 'hello' });
    });

    it('makes a new chat when the one a failed send made has since been deleted, moved or used', async () => {
      const user = userEvent.setup();
      useOtherBenchStore.setState({ projects: [project()], chats: [chat('c9')] });
      vi.mocked(startChat).mockRejectedValue(new StartChatError(chat('c9'), new ApiError(500, 'The model is unavailable.')));
      render(<ProjectHome projectId="p1" />);
      await user.type(box(), 'hello{Enter}');
      await screen.findByRole('alert');

      for (const after of [[], [chat('c9', { projectId: 'other' })], [chat('c9', { headMessageId: 'm1' })], [chat('c9', { archivedAt: 5 })]]) {
        useOtherBenchStore.setState({ chats: after });
        await user.type(box(), '{Enter}');
        expect(startChat).toHaveBeenLastCalledWith({ projectId: 'p1', text: 'hello' });
        // The failed send that follows makes c9 pending again for the next case.
        useOtherBenchStore.setState({ chats: [chat('c9')] });
        await waitFor(() => expect(screen.getByRole('textbox', { name: 'Start a chat in Alpha' })).not.toHaveAttribute('readonly'));
      }
    });
  });
});

describe('ProjectHome with sub-projects (spec 2026-10-15-sub-projects-design §6)', () => {
  it("a parent lists its sub-projects with their chat counts, each opening its page", async () => {
    useOtherBenchStore.setState({
      projects: [project(), project({ id: 'p-sub', name: 'Desktop', parentId: 'p1' }), project({ id: 'p-other', name: 'Other' })],
      chats: [chat('own'), chat('s1', { projectId: 'p-sub' }), chat('s2', { projectId: 'p-sub' })],
    });
    render(<ProjectHome projectId="p1" />);
    const list = screen.getByRole('region', { name: 'Sub-projects' });
    expect(within(list).getByRole('button', { name: /Desktop/ })).toHaveTextContent('2 chats');
    expect(within(list).queryByText('Other')).toBeNull();
    // Its own chats only: the sub-project's are on the sub-project's page.
    expect(within(screen.getByTestId('home-chats')).getAllByRole('listitem')).toHaveLength(1);

    await userEvent.setup().click(within(list).getByRole('button', { name: /Desktop/ }));
    // Shown in the pane, not made a tab.
    expect(useOtherBenchStore.getState().activeChatId).toBe(projectTabId('p-sub'));
    expect(useOtherBenchStore.getState().paneState.tabs).not.toContain(projectTabId('p-sub'));
  });

  it("a sub-project's page lists its own chats and links to its parent; a project without sub-projects has no list", async () => {
    useOtherBenchStore.setState({
      projects: [project(), project({ id: 'p-sub', name: 'Desktop', parentId: 'p1' })],
      chats: [chat('s1', { projectId: 'p-sub' })],
    });
    render(<ProjectHome projectId="p-sub" />);
    expect(screen.queryByRole('region', { name: 'Sub-projects' })).toBeNull();
    expect(within(screen.getByTestId('home-chats')).getAllByRole('listitem')).toHaveLength(1);
    await userEvent.setup().click(screen.getByTestId('home-parent'));
    expect(useOtherBenchStore.getState().activeChatId).toBe(projectTabId('p1'));
  });
});
