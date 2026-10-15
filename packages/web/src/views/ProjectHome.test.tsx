import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Chat, Project } from '@grunt/core/ports/store.js';
import type { Profile } from '@grunt/core/types/config.js';

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
import { useGruntStore } from '../state/store.js';
import { ProjectHome } from './ProjectHome.js';

const project = (over: Partial<Project> = {}): Project => ({
  id: 'p1', name: 'Alpha', description: '', instructions: '', workspace: null, defaultProfileId: null, sortOrder: 0, createdAt: 1, updatedAt: 1, ...over,
});
const chat = (id: string, over: Partial<Chat> = {}): Chat => ({
  id, title: `Chat ${id}`, profileId: 'prof', headMessageId: null, workspace: null, runsOn: 'node-self', workspaceRoot: null, pinned: false, projectPinned: false, unread: false, archivedAt: null, autoMode: false,
  projectId: 'p1', memoryCursor: null, memoryExcluded: false, sortOrder: 0, createdAt: 1, updatedAt: 1, ...over,
});
const profile = (id: string, name: string): Profile => ({
  id, name, description: null, colour: null, connectionId: 'c', modelId: 'm', systemPrompt: null, params: {},
  toolPolicy: { fs: 'off', shell: false, mcpServerIds: [], approvalMode: 'always_ask' }, isDefault: false, archivedAt: null,
});
const emptyMemory = { memory: { projectId: 'p1', body: '', updatedAt: 0, updatedBy: 'user' as const, sourceChatId: null }, lastError: null };

beforeEach(() => {
  window.localStorage.clear();
  useGruntStore.setState(useGruntStore.getInitialState(), true);
  useGruntStore.setState({ paneState: { ...DEFAULT_PANE_STATE, tabs: [projectTabId('p1')], panes: [projectTabId('p1')] }, activeChatId: projectTabId('p1') });
  vi.mocked(api.memory.get).mockResolvedValue(emptyMemory);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('ProjectHome', () => {
  it('shows the name and description, and Settings… opens the project settings page', async () => {
    useGruntStore.setState({ projects: [project({ description: 'Local workbench' })] });
    render(<ProjectHome projectId="p1" />);
    expect(screen.getByRole('heading', { level: 2, name: 'Alpha' })).toBeInTheDocument();
    expect(screen.getByText('Local workbench')).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Settings…' }));
    expect(useGruntStore.getState().projectPage).toEqual({ mode: 'edit', projectId: 'p1' });
  });

  it("lists the project's unarchived chats, pinned in the project first, with time and status; a click shows the chat", async () => {
    const now = Date.now();
    useGruntStore.setState({
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
    expect(useGruntStore.getState().activeChatId).toBe('c1');
  });

  it('says plainly what is empty', async () => {
    useGruntStore.setState({ projects: [project()] });
    render(<ProjectHome projectId="p1" />);
    expect(screen.getByText('No chats yet')).toBeInTheDocument();
    expect(screen.getByText('No instructions')).toBeInTheDocument();
    expect(screen.getByText('No folder')).toBeInTheDocument();
    expect(screen.getByText("Grunt's default profile")).toBeInTheDocument();
    expect(await screen.findByText('No memory yet')).toBeInTheDocument();
    expect(screen.getByText('Not saved yet')).toBeInTheDocument();
  });

  it('shows the folder, extra folders and default profile when set', () => {
    useGruntStore.setState({
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

  it('cuts long instructions with Show more / Show less', async () => {
    const user = userEvent.setup();
    useGruntStore.setState({ projects: [project({ instructions: Array.from({ length: 20 }, (_, i) => `Rule ${i}`).join('\n') })] });
    render(<ProjectHome projectId="p1" />);
    await user.click(screen.getByRole('button', { name: 'Show more' }));
    expect(screen.getByRole('button', { name: 'Show less' })).toBeInTheDocument();
  });

  it("shows the memory and who last changed it, or that it couldn't load", async () => {
    vi.mocked(api.memory.get).mockResolvedValueOnce({ ...emptyMemory, memory: { ...emptyMemory.memory, body: 'Uses npm workspaces', updatedAt: Date.now() - 5 * 60_000 } });
    useGruntStore.setState({ projects: [project()] });
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
    useGruntStore.setState({ projects: [project()] });
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
    useGruntStore.getState().setProjects([]);
    render(<ProjectHome projectId="p1" />);
    expect(screen.getByText(/This project no longer exists/)).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Close' }));
    expect(useGruntStore.getState().paneState.tabs).toEqual([]);
  });

  describe('start a chat', () => {
    const box = (): HTMLElement => screen.getByRole('textbox', { name: 'Start a chat in Alpha' });

    it('sends on Enter and shows the new chat; Shift+Enter adds a line; blank does nothing', async () => {
      const user = userEvent.setup();
      useGruntStore.setState({ projects: [project()] });
      vi.mocked(startChat).mockResolvedValue(chat('c9'));
      render(<ProjectHome projectId="p1" />);

      await user.type(box(), '   {Enter}');
      expect(startChat).not.toHaveBeenCalled();
      await user.clear(box());
      await user.type(box(), 'first line{Shift>}{Enter}{/Shift}second');
      expect(startChat).not.toHaveBeenCalled();
      await user.type(box(), '{Enter}');

      expect(startChat).toHaveBeenCalledWith({ projectId: 'p1', text: 'first line\nsecond' });
      await waitFor(() => expect(useGruntStore.getState().activeChatId).toBe('c9'));
    });

    it('keeps the text and shows the error on failure, and a retry sends into the chat already made', async () => {
      const user = userEvent.setup();
      useGruntStore.setState({ projects: [project()] });
      vi.mocked(startChat).mockRejectedValueOnce(new StartChatError(chat('c9'), new ApiError(500, 'The model is unavailable.'))).mockResolvedValueOnce(chat('c9'));
      render(<ProjectHome projectId="p1" />);

      await user.type(box(), 'hello{Enter}');
      expect(await screen.findByRole('alert')).toHaveTextContent('The model is unavailable.');
      expect(box()).toHaveValue('hello');

      await user.type(box(), '{Enter}');
      expect(startChat).toHaveBeenLastCalledWith({ projectId: 'p1', chat: expect.objectContaining({ id: 'c9' }), text: 'hello' });
      await waitFor(() => expect(useGruntStore.getState().activeChatId).toBe('c9'));
    });
  });
});
