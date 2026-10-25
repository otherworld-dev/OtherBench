import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { App, Project } from '@otherbench/core/ports/store.js';
import type { Profile } from '@otherbench/core/types/config.js';

vi.mock('../desktop/bridge.js', () => ({ isDesktop: vi.fn(() => true), pickFolder: vi.fn() }));
vi.mock('../state/api.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../state/api.js')>();
  return {
    ...actual,
    api: {
      ...actual.api,
      apps: { ...actual.api.apps, create: vi.fn(), patch: vi.fn(), detectRepo: vi.fn() },
      nextcloud: { ...actual.api.nextcloud, boards: vi.fn(), collectives: vi.fn(), collectivePages: vi.fn(), detectLinks: vi.fn() },
      health: vi.fn(async () => ({ status: 'ok', time: '', platform: 'linux' })),
    },
  };
});

import { isDesktop, pickFolder } from '../desktop/bridge.js';
import { ApiError, api } from '../state/api.js';
import { useOtherBenchStore } from '../state/store.js';
import { AppView, folderName } from './AppView.js';

const mockedCreate = vi.mocked(api.apps.create);
const mockedPatch = vi.mocked(api.apps.patch);
const mockedDetect = vi.mocked(api.apps.detectRepo);
const mockedPick = vi.mocked(pickFolder);
const mockedBoards = vi.mocked(api.nextcloud.boards);
const mockedCollectives = vi.mocked(api.nextcloud.collectives);
const mockedCollectivePages = vi.mocked(api.nextcloud.collectivePages);
const mockedLinks = vi.mocked(api.nextcloud.detectLinks);
const NO_LINKS = { deckBoard: null, collective: null, pagePath: null, bookmarkTag: null, deckBoardId: null };
const NC = { deckBoardId: null, wikiCollective: null, wikiPagePath: null, bookmarkTag: null };

const profile: Profile = {
  id: 'profile-1',
  name: 'Everyday',
  description: null,
  colour: null,
  connectionId: 'conn-1',
  modelId: 'm',
  systemPrompt: null,
  params: {},
  toolPolicy: { fs: 'off', shell: false, mcpServerIds: [], approvalMode: 'always_ask' },
  isDefault: true,
  archivedAt: null,
};

function project(over: Partial<Project> & { id: string }): Project {
  return { name: over.id, description: '', instructions: '', workspace: null, workspaceRoot: null, defaultProfileId: null, sortOrder: 0, createdAt: 1, updatedAt: 1, ...over };
}

function app(over: Partial<App> & { id: string }): App {
  return { name: over.id, workspace: null, workspaceRoot: null, githubRepo: null, linkedProjectId: null, defaultProfileId: null, deckBoardId: null, wikiCollective: null, wikiPagePath: null, bookmarkTag: null, folderId: null, sortOrder: 0, createdAt: 1, updatedAt: 1, ...over };
}

beforeEach(() => {
  useOtherBenchStore.setState(useOtherBenchStore.getInitialState(), true);
  useOtherBenchStore.setState({
    profiles: [profile],
    projects: [project({ id: 'p-a', name: 'Planning', sortOrder: 0 }), project({ id: 'p-b', name: 'Design', parentId: 'p-a' })],
  });
  vi.mocked(isDesktop).mockReturnValue(true);
  mockedCreate.mockReset();
  mockedPatch.mockReset();
  mockedDetect.mockReset().mockResolvedValue({ githubRepo: null, isRepo: false });
  mockedPick.mockReset();
  mockedBoards.mockReset().mockResolvedValue([{ id: 7, title: 'OtherBench' }]);
  mockedCollectives.mockReset().mockResolvedValue(['Otherworld Dev', 'PhD']);
  mockedCollectivePages.mockReset().mockResolvedValue([]);
  mockedLinks.mockReset().mockResolvedValue(NO_LINKS);
});
afterEach(cleanup);

describe('folderName', () => {
  it("is a path's last segment, either separator, ignoring a trailing one", () => {
    expect(folderName('/home/me/otherbench')).toBe('otherbench');
    expect(folderName('E:\\Git\\OtherBench\\')).toBe('OtherBench');
    expect(folderName('')).toBe('');
  });
});

describe('AppView, creating (spec 2026-10-20-code-tab-design, "Creating an app")', () => {
  it('picking a folder detects its GitHub repo and names the app after the folder; Create sends every field', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    mockedPick.mockResolvedValue('/home/me/otherbench');
    mockedDetect.mockResolvedValue({ githubRepo: 'o/r', isRepo: true });
    mockedCreate.mockResolvedValue(app({ id: 'a-new', name: 'otherbench', workspaceRoot: '/home/me/otherbench', githubRepo: 'o/r' }));
    render(<AppView page={{ mode: 'create' }} onClose={onClose} />);

    await user.click(screen.getByRole('button', { name: 'Choose…' }));
    expect(mockedDetect).toHaveBeenCalledWith('/home/me/otherbench');
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'GitHub repo' })).toHaveValue('o/r'));
    expect(screen.getByRole('textbox', { name: 'Folder' })).toHaveValue('/home/me/otherbench');
    expect(screen.getByRole('textbox', { name: 'Name' })).toHaveValue('otherbench');

    await user.selectOptions(screen.getByRole('combobox', { name: 'Linked chat project' }), 'p-b');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Default profile' }), 'profile-1');
    await user.click(screen.getByRole('button', { name: 'Create app' }));

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(mockedCreate).toHaveBeenCalledWith({
      name: 'otherbench',
      workspacePath: '/home/me/otherbench',
      githubRepo: 'o/r',
      linkedProjectId: 'p-b',
      defaultProfileId: 'profile-1',
      ...NC,
    });
    expect(useOtherBenchStore.getState().apps.map((a) => a.id)).toEqual(['a-new']);
  });

  it('sends null for an empty GitHub repo, project and profile', async () => {
    const user = userEvent.setup();
    mockedDetect.mockResolvedValue({ githubRepo: null, isRepo: false });
    mockedCreate.mockResolvedValue(app({ id: 'a-new' }));
    render(<AppView page={{ mode: 'create' }} onClose={vi.fn()} />);
    await user.type(screen.getByRole('textbox', { name: 'Folder' }), '/home/me/notes');
    await user.tab();
    await waitFor(() => expect(mockedDetect).toHaveBeenCalledWith('/home/me/notes'));
    await user.click(screen.getByRole('button', { name: 'Create app' }));
    await waitFor(() =>
      expect(mockedCreate).toHaveBeenCalledWith({ name: 'notes', workspacePath: '/home/me/notes', githubRepo: null, linkedProjectId: null, defaultProfileId: null, ...NC })
    );
  });

  it('a typed folder is checked when the field is left; a GitHub repo or name the user typed is never overwritten', async () => {
    const user = userEvent.setup();
    mockedDetect.mockResolvedValue({ githubRepo: 'o/r', isRepo: true });
    render(<AppView page={{ mode: 'create' }} onClose={vi.fn()} />);
    await user.type(screen.getByRole('textbox', { name: 'Name' }), 'Mine');
    await user.type(screen.getByRole('textbox', { name: 'GitHub repo' }), 'me/fork');
    await user.type(screen.getByRole('textbox', { name: 'Folder' }), '/home/me/otherbench');
    await user.tab();

    await waitFor(() => expect(mockedDetect).toHaveBeenCalledWith('/home/me/otherbench'));
    expect(screen.getByRole('textbox', { name: 'GitHub repo' })).toHaveValue('me/fork');
    expect(screen.getByRole('textbox', { name: 'Name' })).toHaveValue('Mine');
  });

  it('a later folder replaces a detected repo the user left alone', async () => {
    const user = userEvent.setup();
    mockedPick.mockResolvedValueOnce('/home/a').mockResolvedValueOnce('/home/b');
    mockedDetect.mockResolvedValueOnce({ githubRepo: 'o/a', isRepo: true }).mockResolvedValueOnce({ githubRepo: null, isRepo: false });
    render(<AppView page={{ mode: 'create' }} onClose={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: 'Choose…' }));
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'GitHub repo' })).toHaveValue('o/a'));
    await user.click(screen.getByRole('button', { name: 'Choose…' }));
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'GitHub repo' })).toHaveValue(''));
    expect(screen.getByRole('textbox', { name: 'Name' })).toHaveValue('b');
  });

  it('says so under an empty GitHub repo', async () => {
    const user = userEvent.setup();
    render(<AppView page={{ mode: 'create' }} onClose={vi.fn()} />);
    expect(screen.getByText('No GitHub repo set for this app')).toBeInTheDocument();
    await user.type(screen.getByRole('textbox', { name: 'GitHub repo' }), 'o/r');
    expect(screen.queryByText('No GitHub repo set for this app')).toBeNull();
  });

  it('lists sub-projects as "Parent / Child" in Linked chat project', () => {
    render(<AppView page={{ mode: 'create' }} onClose={vi.fn()} />);
    const options = Array.from((screen.getByRole('combobox', { name: 'Linked chat project' }) as HTMLSelectElement).options).map((o) => o.textContent);
    expect(options).toEqual(['None', 'Planning', 'Planning / Design']);
  });

  it('asks for a folder, and a valid GitHub repo, before sending anything', async () => {
    const user = userEvent.setup();
    mockedDetect.mockResolvedValue({ githubRepo: null, isRepo: false });
    render(<AppView page={{ mode: 'create' }} onClose={vi.fn()} />);
    await user.type(screen.getByRole('textbox', { name: 'Name' }), 'X');
    await user.click(screen.getByRole('button', { name: 'Create app' }));
    expect(screen.getByRole('alert')).toHaveTextContent("Choose the app's folder.");

    await user.type(screen.getByRole('textbox', { name: 'Folder' }), '/home/x');
    await user.type(screen.getByRole('textbox', { name: 'GitHub repo' }), 'not a repo');
    await user.click(screen.getByRole('button', { name: 'Create app' }));
    expect(screen.getByRole('alert')).toHaveTextContent('owner/name');
    expect(mockedCreate).not.toHaveBeenCalled();
  });

  it("keeps the form open with the server's message when it refuses", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    mockedDetect.mockResolvedValue({ githubRepo: null, isRepo: false });
    mockedCreate.mockRejectedValue(new ApiError(400, 'That folder does not exist.'));
    render(<AppView page={{ mode: 'create' }} onClose={onClose} />);
    await user.type(screen.getByRole('textbox', { name: 'Folder' }), '/nope');
    await user.click(screen.getByRole('button', { name: 'Create app' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('That folder does not exist.');
    expect(onClose).not.toHaveBeenCalled();
  });

  it('Create clicked straight after typing a folder waits for its repo lookup and sends the detected repo (D2)', async () => {
    const user = userEvent.setup();
    let answer: (v: { githubRepo: string | null; isRepo: boolean }) => void = () => {};
    mockedDetect.mockImplementation(() => new Promise((resolve) => (answer = resolve)));
    mockedCreate.mockResolvedValue(app({ id: 'a-new' }));
    render(<AppView page={{ mode: 'create' }} onClose={vi.fn()} />);
    await user.type(screen.getByRole('textbox', { name: 'Folder' }), '/home/me/otherbench');
    // The click itself leaves the field: the lookup starts, and Create comes before its answer.
    await user.click(screen.getByRole('button', { name: 'Create app' }));
    expect(mockedDetect).toHaveBeenCalledWith('/home/me/otherbench');
    expect(mockedCreate).not.toHaveBeenCalled();
    answer({ githubRepo: 'o/r', isRepo: true });
    await waitFor(() =>
      expect(mockedCreate).toHaveBeenCalledWith({ name: 'otherbench', workspacePath: '/home/me/otherbench', githubRepo: 'o/r', linkedProjectId: null, defaultProfileId: null, ...NC })
    );
  });

  it('Escape with nothing typed closes; with a draft it asks first', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<AppView page={{ mode: 'create' }} onClose={onClose} />);
    await user.type(screen.getByRole('textbox', { name: 'Name' }), 'X');
    fireEvent.keyDown(screen.getByTestId('app-view'), { key: 'Escape' });
    expect(screen.getByRole('alertdialog', { name: 'Discard changes?' })).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe('AppView, editing', () => {
  const existing = app({ id: 'A', name: 'Alpha', workspaceRoot: '/alpha', githubRepo: 'o/alpha', linkedProjectId: 'p-a', defaultProfileId: null });

  it('starts from the app and sends only what changed', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    useOtherBenchStore.setState({ apps: [existing] });
    mockedPatch.mockResolvedValue({ ...existing, name: 'Alpha 2' });
    render(<AppView page={{ mode: 'edit', appId: 'A' }} onClose={onClose} />);

    expect(screen.getByRole('textbox', { name: 'Folder' })).toHaveValue('/alpha');
    expect(screen.getByRole('textbox', { name: 'GitHub repo' })).toHaveValue('o/alpha');
    expect(screen.getByRole('combobox', { name: 'Linked chat project' })).toHaveValue('p-a');
    await user.clear(screen.getByRole('textbox', { name: 'Name' }));
    await user.type(screen.getByRole('textbox', { name: 'Name' }), 'Alpha 2');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(mockedPatch).toHaveBeenCalledWith('A', { name: 'Alpha 2' });
    expect(mockedDetect).not.toHaveBeenCalled();
    expect(useOtherBenchStore.getState().apps[0]!.name).toBe('Alpha 2');
  });

  it('opens with the Name field focused, so Escape closes the form straight away (D3)', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    useOtherBenchStore.setState({ apps: [existing] });
    render(<AppView page={{ mode: 'edit', appId: 'A' }} onClose={onClose} />);
    expect(screen.getByRole('textbox', { name: 'Name' })).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('says so when the app is gone', () => {
    render(<AppView page={{ mode: 'edit', appId: 'gone' }} onClose={vi.fn()} />);
    expect(screen.getByText(/This app no longer exists/)).toBeInTheDocument();
  });
});

describe('AppView, Nextcloud fields', () => {
  const links = { deckBoard: 'OtherBench', collective: 'Otherworld Dev', pagePath: 'Products/OtherBench', bookmarkTag: 'otherbench', deckBoardId: 7 };

  it('creating fills board, page and tag from CLAUDE.md', async () => {
    const user = userEvent.setup();
    mockedPick.mockResolvedValue('/home/me/otherbench');
    mockedDetect.mockResolvedValue({ githubRepo: null, isRepo: true });
    mockedLinks.mockResolvedValue(links);
    mockedCreate.mockResolvedValue(app({ id: 'a-new' }));
    render(<AppView page={{ mode: 'create' }} onClose={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: 'Choose…' }));
    expect(mockedLinks).toHaveBeenCalledWith('/home/me/otherbench');
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Deck board' })).toHaveValue('7'));
    expect(screen.getByRole('combobox', { name: 'Collectives page' })).toHaveValue('Otherworld Dev');
    expect(screen.getByRole('textbox', { name: 'Collectives page path' })).toHaveValue('Products/OtherBench');
    expect(screen.getByRole('textbox', { name: 'Bookmark tag' })).toHaveValue('otherbench');
    await user.click(screen.getByRole('button', { name: 'Create app' }));
    await waitFor(() =>
      expect(mockedCreate).toHaveBeenCalledWith(
        expect.objectContaining({ deckBoardId: 7, wikiCollective: 'Otherworld Dev', wikiPagePath: 'Products/OtherBench', bookmarkTag: 'otherbench' })
      )
    );
  });

  it("lists the chosen collective's pages, and picking one fills the path", async () => {
    const user = userEvent.setup();
    mockedCollectivePages.mockResolvedValue(['Products', 'Products/OtherBench', 'Products/OtherBench/Design']);
    mockedCreate.mockResolvedValue(app({ id: 'a-new' }));
    render(<AppView page={{ mode: 'create' }} onClose={vi.fn()} />);
    await user.type(screen.getByRole('textbox', { name: 'Folder' }), '/home/me/otherbench');
    await user.tab();
    await waitFor(() => expect(within(screen.getByRole('combobox', { name: 'Collectives page' })).getAllByRole('option')).toHaveLength(3));
    await user.selectOptions(screen.getByRole('combobox', { name: 'Collectives page' }), 'Otherworld Dev');
    expect(mockedCollectivePages).toHaveBeenCalledWith('Otherworld Dev');
    const pick = await screen.findByRole('combobox', { name: 'Pick a page in Otherworld Dev' });
    await waitFor(() => expect(within(pick).getByRole('option', { name: 'Products/OtherBench' })).toBeInTheDocument());
    await user.selectOptions(pick, 'Products/OtherBench');
    expect(screen.getByRole('textbox', { name: 'Collectives page path' })).toHaveValue('Products/OtherBench');
    await user.click(screen.getByRole('button', { name: 'Create app' }));
    await waitFor(() => expect(mockedCreate).toHaveBeenCalledWith(expect.objectContaining({ wikiCollective: 'Otherworld Dev', wikiPagePath: 'Products/OtherBench' })));
  });

  it('a typed field is not overwritten by detection', async () => {
    const user = userEvent.setup();
    mockedLinks.mockResolvedValue(links);
    render(<AppView page={{ mode: 'create' }} onClose={vi.fn()} />);
    await user.type(screen.getByRole('textbox', { name: 'Bookmark tag' }), 'mine');
    await user.type(screen.getByRole('textbox', { name: 'Folder' }), '/home/me/otherbench');
    await user.tab();
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Collectives page path' })).toHaveValue('Products/OtherBench'));
    expect(screen.getByRole('textbox', { name: 'Bookmark tag' })).toHaveValue('mine');
  });

  it('editing: Fill from CLAUDE.md overwrites', async () => {
    const user = userEvent.setup();
    const existing = app({ id: 'A', name: 'Alpha', workspaceRoot: '/alpha', bookmarkTag: 'old' });
    useOtherBenchStore.setState({ apps: [existing] });
    mockedLinks.mockResolvedValue(links);
    render(<AppView page={{ mode: 'edit', appId: 'A' }} onClose={vi.fn()} />);
    expect(mockedLinks).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Fill from CLAUDE.md' }));
    expect(mockedLinks).toHaveBeenCalledWith('/alpha');
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Bookmark tag' })).toHaveValue('otherbench'));
    expect(screen.getByRole('combobox', { name: 'Deck board' })).toHaveValue('7');
  });

  it('an unknown board name shows the not-found hint', async () => {
    const user = userEvent.setup();
    mockedLinks.mockResolvedValue({ ...links, deckBoard: 'Nope', deckBoardId: null });
    render(<AppView page={{ mode: 'create' }} onClose={vi.fn()} />);
    await user.type(screen.getByRole('textbox', { name: 'Folder' }), '/home/me/x');
    await user.tab();
    expect(await screen.findByText('CLAUDE.md names the board "Nope", which wasn\'t found.')).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Deck board' })).toHaveValue('');
  });

  it("a collective that isn't in Nextcloud is not filled in, and says so", async () => {
    const user = userEvent.setup();
    mockedLinks.mockResolvedValue({ ...links, collective: 'Gone Collective' });
    render(<AppView page={{ mode: 'create' }} onClose={vi.fn()} />);
    await screen.findByRole('option', { name: 'PhD' });
    await user.type(screen.getByRole('textbox', { name: 'Folder' }), '/home/me/x');
    await user.tab();
    expect(await screen.findByText(`CLAUDE.md names the collective "Gone Collective", which wasn't found.`)).toBeInTheDocument();
    const select = screen.getByRole('combobox', { name: 'Collectives page' });
    expect(select).toHaveValue('');
    expect(within(select).queryByRole('option', { name: 'Gone Collective' })).not.toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Collectives page path' })).toHaveValue('');
    // The rest of the suggestion still lands.
    expect(screen.getByRole('textbox', { name: 'Bookmark tag' })).toHaveValue('otherbench');
  });

  it('a suggested collective is checked when the list loads after it', async () => {
    const user = userEvent.setup();
    let loadCollectives: (names: string[]) => void = () => {};
    mockedCollectives.mockReturnValue(new Promise((resolve) => (loadCollectives = resolve)));
    mockedLinks.mockResolvedValue({ ...links, collective: 'Gone Collective' });
    render(<AppView page={{ mode: 'create' }} onClose={vi.fn()} />);
    await user.type(screen.getByRole('textbox', { name: 'Folder' }), '/home/me/x');
    await user.tab();
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Collectives page path' })).toHaveValue('Products/OtherBench'));
    await act(async () => loadCollectives(['Otherworld Dev', 'PhD']));
    expect(await screen.findByText(`CLAUDE.md names the collective "Gone Collective", which wasn't found.`)).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Collectives page' })).toHaveValue('');
    expect(screen.getByRole('textbox', { name: 'Collectives page path' })).toHaveValue('');
  });

  it("Fill from CLAUDE.md says so when it can't read the file", async () => {
    const user = userEvent.setup();
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    useOtherBenchStore.setState({ apps: [app({ id: 'A', name: 'Alpha', workspaceRoot: '/alpha' })] });
    mockedLinks.mockRejectedValue(new ApiError(404, 'Folder not found.'));
    render(<AppView page={{ mode: 'edit', appId: 'A' }} onClose={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: 'Fill from CLAUDE.md' }));
    expect(await screen.findByText("Couldn't read CLAUDE.md from this folder.")).toBeInTheDocument();
    mockedLinks.mockResolvedValue(links);
    await user.click(screen.getByRole('button', { name: 'Fill from CLAUDE.md' }));
    await waitFor(() => expect(screen.queryByText("Couldn't read CLAUDE.md from this folder.")).not.toBeInTheDocument());
    quiet.mockRestore();
  });

  it("without Nextcloud an unresolved board isn't called not found", async () => {
    const user = userEvent.setup();
    mockedBoards.mockRejectedValue(new ApiError(409, 'Nextcloud is not set up.'));
    mockedLinks.mockResolvedValue({ ...links, deckBoardId: null });
    render(<AppView page={{ mode: 'create' }} onClose={vi.fn()} />);
    expect(await screen.findByText('Set up Nextcloud in Settings to pick a board.')).toBeInTheDocument();
    await user.type(screen.getByRole('textbox', { name: 'Folder' }), '/home/me/x');
    await user.tab();
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Bookmark tag' })).toHaveValue('otherbench'));
    expect(screen.queryByTestId('app-board-not-found')).not.toBeInTheDocument();
  });

  it('patch sends only changed Nextcloud fields', async () => {
    const user = userEvent.setup();
    const existing = app({ id: 'A', name: 'Alpha', workspaceRoot: '/alpha', deckBoardId: 7, wikiCollective: 'PhD', wikiPagePath: 'X', bookmarkTag: 'a' });
    useOtherBenchStore.setState({ apps: [existing] });
    mockedPatch.mockResolvedValue(existing);
    render(<AppView page={{ mode: 'edit', appId: 'A' }} onClose={vi.fn()} />);
    await user.clear(screen.getByRole('textbox', { name: 'Bookmark tag' }));
    await user.selectOptions(screen.getByRole('combobox', { name: 'Deck board' }), '');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(mockedPatch).toHaveBeenCalledWith('A', { deckBoardId: null, bookmarkTag: null }));
  });

  it('a collective without a page path is a form problem', async () => {
    const user = userEvent.setup();
    const existing = app({ id: 'A', name: 'Alpha', workspaceRoot: '/alpha' });
    useOtherBenchStore.setState({ apps: [existing] });
    render(<AppView page={{ mode: 'edit', appId: 'A' }} onClose={vi.fn()} />);
    await screen.findByRole('option', { name: 'PhD' });
    await user.selectOptions(screen.getByRole('combobox', { name: 'Collectives page' }), 'PhD');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(screen.getByRole('alert')).toHaveTextContent('path');
    expect(mockedPatch).not.toHaveBeenCalled();
  });

  it('without Nextcloud the board select is disabled with the hint', async () => {
    mockedBoards.mockRejectedValue(new ApiError(409, 'Nextcloud is not set up.'));
    render(<AppView page={{ mode: 'create' }} onClose={vi.fn()} />);
    expect(await screen.findByText('Set up Nextcloud in Settings to pick a board.')).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Deck board' })).toBeDisabled();
    expect(screen.getByRole('textbox', { name: 'Folder' })).toBeEnabled();
  });
});
