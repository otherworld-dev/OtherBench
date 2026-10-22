import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { App } from '@otherbench/core/ports/store.js';
import type { WikiPage, WikiTree } from '@otherbench/core/types/nextcloud.js';

vi.mock('../state/api.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../state/api.js')>();
  return {
    ...actual,
    api: { ...actual.api, apps: { ...actual.api.apps, wiki: { tree: vi.fn(), page: vi.fn() } } },
  };
});
vi.mock('../desktop/bridge.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../desktop/bridge.js')>();
  return { ...actual, openInBrowser: vi.fn(async () => undefined) };
});

import { openInBrowser } from '../desktop/bridge.js';
import { ApiError, api } from '../state/api.js';
import { useOtherBenchStore } from '../state/store.js';
import { WikiTab } from './WikiTab.js';

const app = (over: Partial<App> = {}): App => ({
  id: 'a1', name: 'OtherBench', workspace: null, githubRepo: null, linkedProjectId: null, defaultProfileId: null, deckBoardId: null, wikiCollective: 'Otherworld Dev', wikiPagePath: 'Products/OtherBench', bookmarkTag: null, sortOrder: 0, createdAt: 1, updatedAt: 1, ...over,
});
const tree = (): WikiTree => ({
  collective: 'Otherworld Dev',
  pagePath: 'Products/OtherBench',
  rootId: 10,
  pages: [
    { id: 10, title: 'OtherBench', parentId: null },
    { id: 12, title: 'Setup', parentId: 10 },
    { id: 11, title: 'Design', parentId: 10 },
    { id: 13, title: 'Specs', parentId: 11 },
  ],
  url: 'https://nc.example/apps/collectives/Otherworld%20Dev/Products/OtherBench',
});
const page = (id: number, title: string, markdown: string, breadcrumbs: string[]): WikiPage => ({
  id, title, breadcrumbs, markdown, url: `https://nc.example/apps/collectives/p/${id}`,
});

beforeEach(() => {
  useOtherBenchStore.setState(useOtherBenchStore.getInitialState(), true);
  vi.mocked(api.apps.wiki.tree).mockResolvedValue(tree());
  vi.mocked(api.apps.wiki.page).mockImplementation(async (_app: string, id: number) =>
    id === 12
      ? page(12, 'Setup', 'Install **it**. See [specs](https://nc.example/apps/collectives/x?fileId=13) and [site](https://example.com/).', ['OtherBench', 'Setup'])
      : id === 13
        ? page(13, 'Specs', 'The specs.', ['OtherBench', 'Design', 'Specs'])
        : page(id, 'Other', 'x', ['OtherBench'])
  );
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe('WikiTab', () => {
  it('without a page it shows the alert and fetches nothing', async () => {
    render(<WikiTab app={app({ wikiPagePath: null })} owner="c1" />);
    expect(await screen.findByRole('alert')).toHaveTextContent('No Collectives page set for this app');
    expect(api.apps.wiki.tree).not.toHaveBeenCalled();
  });

  it('renders the tree with folders collapsed below the root', async () => {
    render(<WikiTab app={app()} owner="c1" />);
    expect(await screen.findByTestId('wiki-row-10')).toHaveTextContent('OtherBench');
    const rows = screen.getAllByTestId(/^wiki-row-/).map((r) => r.textContent);
    expect(rows).toEqual(['OtherBench', 'Design', 'Setup']);
    expect(screen.getByRole('button', { name: 'Expand Design' })).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByTestId('wiki-row-13')).not.toBeInTheDocument();
    expect(api.apps.wiki.tree).toHaveBeenCalledWith('a1');
  });

  it('expanding a folder is remembered for the owner', async () => {
    const user = userEvent.setup();
    const first = render(<WikiTab app={app()} owner="c1" />);
    await screen.findByTestId('wiki-row-10');
    await user.click(screen.getByRole('button', { name: 'Expand Design' }));
    expect(await screen.findByTestId('wiki-row-13')).toHaveTextContent('Specs');
    expect(useOtherBenchStore.getState().wikiViews['c1']?.expanded).toEqual([10, 11]);
    first.unmount();
    render(<WikiTab app={app()} owner="c1" />);
    expect(await screen.findByTestId('wiki-row-13')).toBeInTheDocument();
  });

  it('Find filters by title and shows the match\'s parents', async () => {
    const user = userEvent.setup();
    render(<WikiTab app={app()} owner="c1" />);
    await screen.findByTestId('wiki-row-10');
    await user.type(screen.getByRole('searchbox', { name: 'Find' }), 'SPEC');
    expect(screen.getAllByTestId(/^wiki-row-/).map((r) => r.textContent)).toEqual(['OtherBench', 'Design', 'Specs']);
    expect(screen.queryByTestId('wiki-row-12')).not.toBeInTheDocument();
    await user.clear(screen.getByRole('searchbox', { name: 'Find' }));
    await user.type(screen.getByRole('searchbox', { name: 'Find' }), 'zzz');
    expect(screen.getByText('No pages match')).toBeInTheDocument();
  });

  it('opening a page shows breadcrumbs and markdown; back returns to the same tree state', async () => {
    const user = userEvent.setup();
    render(<WikiTab app={app()} owner="c1" />);
    await user.click(await screen.findByRole('button', { name: 'Expand Design' }));
    await user.click(await screen.findByTestId('wiki-row-12'));
    const view = await screen.findByTestId('wiki-page');
    expect(api.apps.wiki.page).toHaveBeenCalledWith('a1', 12);
    expect(within(view).getByRole('heading', { name: 'Setup' })).toBeInTheDocument();
    expect(within(view).getByText('OtherBench › Setup')).toBeInTheDocument();
    expect(within(view).getByText('it').tagName).toBe('STRONG');
    await user.click(within(view).getByRole('link', { name: /Open in Nextcloud/ }));
    expect(openInBrowser).toHaveBeenCalledWith('https://nc.example/apps/collectives/p/12');
    await user.click(screen.getByRole('button', { name: 'Back to the pages' }));
    expect(await screen.findByTestId('wiki-row-13')).toBeInTheDocument();
    expect(useOtherBenchStore.getState().wikiViews['c1']?.selected).toBeNull();
  });

  it('a fileId link to a page in the tree opens it in the tab', async () => {
    const user = userEvent.setup();
    useOtherBenchStore.getState().setWikiView('c1', { selected: 12 });
    render(<WikiTab app={app()} owner="c1" />);
    const view = await screen.findByTestId('wiki-page');
    await waitFor(() => expect(api.apps.wiki.tree).toHaveBeenCalled());
    await waitFor(() => expect(useOtherBenchStore.getState().wikiTrees['a1']).toBeDefined());
    await user.click(within(view).getByRole('link', { name: 'specs' }));
    await waitFor(() => expect(api.apps.wiki.page).toHaveBeenCalledWith('a1', 13));
    expect(await screen.findByText('The specs.')).toBeInTheDocument();
    expect(useOtherBenchStore.getState().wikiViews['c1']?.selected).toBe(13);
    expect(openInBrowser).not.toHaveBeenCalled();
  });

  it('other links still open in the browser', async () => {
    const user = userEvent.setup();
    useOtherBenchStore.getState().setWikiView('c1', { selected: 12 });
    render(<WikiTab app={app()} owner="c1" />);
    const view = await screen.findByTestId('wiki-page');
    await user.click(within(view).getByRole('link', { name: 'site' }));
    expect(openInBrowser).toHaveBeenCalledWith('https://example.com/');
  });

  it('has no edit button', async () => {
    const user = userEvent.setup();
    render(<WikiTab app={app()} owner="c1" />);
    await screen.findByTestId('wiki-row-10');
    expect(screen.queryByRole('button', { name: /edit/i })).not.toBeInTheDocument();
    await user.click(await screen.findByTestId('wiki-row-12'));
    const view = await screen.findByTestId('wiki-page');
    expect(within(view).queryByRole('button', { name: /edit/i })).not.toBeInTheDocument();
    expect(within(view).queryByRole('textbox')).not.toBeInTheDocument();
  });

  it('a nextcloud-not-found error shows the server message', async () => {
    vi.mocked(api.apps.wiki.tree).mockRejectedValue(new ApiError(404, 'That page is not in Nextcloud.', undefined, { code: 'nextcloud-not-found' }));
    render(<WikiTab app={app()} owner="c1" />);
    expect(await screen.findByRole('alert')).toHaveTextContent('That page is not in Nextcloud.');
  });
});
