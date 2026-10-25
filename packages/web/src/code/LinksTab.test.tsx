import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { App } from '@otherbench/core/ports/store.js';
import type { Bookmark } from '@otherbench/core/types/nextcloud.js';

vi.mock('../state/api.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../state/api.js')>();
  return {
    ...actual,
    api: {
      ...actual.api,
      apps: { ...actual.api.apps, links: { list: vi.fn(), add: vi.fn(), update: vi.fn(), remove: vi.fn() } },
    },
  };
});
vi.mock('../desktop/bridge.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../desktop/bridge.js')>();
  return { ...actual, openInBrowser: vi.fn(async () => undefined) };
});

import { openInBrowser } from '../desktop/bridge.js';
import { ApiError, api } from '../state/api.js';
import { useOtherBenchStore } from '../state/store.js';
import { LinksTab } from './LinksTab.js';

const app = (over: Partial<App> = {}): App => ({
  id: 'a1', name: 'OtherBench', workspace: null, githubRepo: null, linkedProjectId: null, defaultProfileId: null, deckBoardId: null, wikiCollective: null, wikiPagePath: null, bookmarkTag: 'otherbench', folderId: null, sortOrder: 0, createdAt: 1, updatedAt: 1, ...over,
});
const bm = (id: number, over: Partial<Bookmark> = {}): Bookmark => ({
  id, url: `https://example.com/page${id}`, title: `Link ${id}`, description: '', tags: ['otherbench'], added: 1_760_000_000 + id, ...over,
});

beforeEach(() => {
  useOtherBenchStore.setState(useOtherBenchStore.getInitialState(), true);
  vi.mocked(api.apps.links.list).mockResolvedValue({ tag: 'otherbench', bookmarks: [bm(1), bm(3, { description: 'three', tags: ['otherbench', 'docs'] }), bm(2, { title: '', url: 'javascript:alert(1)' })] });
  vi.mocked(api.apps.links.add).mockResolvedValue(bm(9));
  vi.mocked(api.apps.links.update).mockResolvedValue(bm(3));
  vi.mocked(api.apps.links.remove).mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe('LinksTab', () => {
  it('without a tag it shows the alert and fetches nothing', async () => {
    render(<LinksTab app={app({ bookmarkTag: null })} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('No bookmark tag set for this app');
    expect(api.apps.links.list).not.toHaveBeenCalled();
  });

  it('lists newest first and opens a link in the browser', async () => {
    vi.mocked(api.apps.links.list).mockResolvedValue({ tag: 'otherbench', bookmarks: [bm(1), bm(3), bm(2)] });
    const user = userEvent.setup();
    render(<LinksTab app={app()} />);
    const rows = await screen.findAllByRole('listitem');
    expect(rows.map((r) => r.getAttribute('data-link'))).toEqual(['3', '2', '1']);
    expect(screen.getByText('Tag otherbench · 3')).toBeInTheDocument();
    expect(within(rows[0]!).getByText('example.com/page3')).toBeInTheDocument();
    await user.click(within(rows[0]!).getByRole('link', { name: /Link 3/ }));
    expect(openInBrowser).toHaveBeenCalledWith('https://example.com/page3');
  });

  it('a non-http link is not opened', async () => {
    const user = userEvent.setup();
    render(<LinksTab app={app()} />);
    const row = await screen.findByTestId('link-row-2');
    expect(row).toHaveTextContent('javascript:alert(1)');
    const link = within(row).getByRole('link');
    // No href, so a middle or Ctrl-click has nothing to follow; still reachable from the keyboard.
    expect(link).not.toHaveAttribute('href');
    expect(link).toHaveAttribute('tabindex', '0');
    expect(link).toHaveAttribute('aria-disabled', 'true');
    await user.click(link);
    expect(openInBrowser).not.toHaveBeenCalled();
    const web = within(await screen.findByTestId('link-row-1')).getByRole('link');
    expect(web).toHaveAttribute('href', 'https://example.com/page1');
  });

  it('Add sends url, title and extra tags', async () => {
    const user = userEvent.setup();
    render(<LinksTab app={app()} />);
    await screen.findByTestId('link-row-1');
    await user.click(screen.getByRole('button', { name: '+ Add' }));
    const add = screen.getByRole('button', { name: 'Add' });
    expect(add).toBeDisabled();
    await user.type(screen.getByRole('textbox', { name: 'URL' }), 'https://new.example/x');
    await user.type(screen.getByRole('textbox', { name: 'Title' }), 'New');
    await user.type(screen.getByRole('textbox', { name: 'Extra tags' }), 'docs, ref ,');
    await user.click(add);
    await waitFor(() => expect(api.apps.links.add).toHaveBeenCalledWith('a1', { url: 'https://new.example/x', title: 'New', tags: ['docs', 'ref'] }));
    await waitFor(() => expect(api.apps.links.list).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole('form', { name: 'New link' })).not.toBeInTheDocument();
  });

  it('Edit keeps the app tag', async () => {
    const user = userEvent.setup();
    render(<LinksTab app={app()} />);
    const row = await screen.findByTestId('link-row-3');
    await user.click(within(row).getByRole('button', { name: 'Actions for Link 3' }));
    await user.click(screen.getByRole('menuitem', { name: 'Edit' }));
    const form = screen.getByRole('form', { name: 'Edit link' });
    expect(within(form).getByRole('textbox', { name: 'App tag' })).toBeDisabled();
    expect(within(form).getByRole('textbox', { name: 'App tag' })).toHaveValue('otherbench');
    const extra = within(form).getByRole('textbox', { name: 'Extra tags' });
    expect(extra).toHaveValue('docs');
    await user.clear(extra);
    await user.type(extra, 'docs, new');
    await user.click(within(form).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(api.apps.links.update).toHaveBeenCalledWith('a1', 3, {
        url: 'https://example.com/page3',
        title: 'Link 3',
        description: 'three',
        tags: ['otherbench', 'docs', 'new'],
      })
    );
    await waitFor(() => expect(api.apps.links.list).toHaveBeenCalledTimes(2));
  });

  it('Delete asks first', async () => {
    const user = userEvent.setup();
    render(<LinksTab app={app()} />);
    const row = await screen.findByTestId('link-row-1');
    await user.click(within(row).getByRole('button', { name: 'Actions for Link 1' }));
    await user.click(screen.getByRole('menuitem', { name: 'Delete' }));
    const dialog = screen.getByRole('alertdialog', { name: 'Delete this link?' });
    expect(api.apps.links.remove).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(api.apps.links.remove).toHaveBeenCalledWith('a1', 1));
    await waitFor(() => expect(api.apps.links.list).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it('refreshes on window focus and shows a load failure', async () => {
    render(<LinksTab app={app()} />);
    await screen.findByTestId('link-row-1');
    vi.mocked(api.apps.links.list).mockRejectedValue(new ApiError(409, 'Nextcloud is not configured.', undefined, { code: 'nextcloud-not-configured' }));
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });
    expect(await screen.findByRole('alert')).toHaveTextContent("Nextcloud isn't set up on this machine");
  });
});
