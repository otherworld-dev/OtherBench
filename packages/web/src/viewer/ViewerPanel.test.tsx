import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Chat } from '@grunt/core/ports/store.js';

vi.mock('../desktop/bridge.js', () => ({ isDesktop: vi.fn(() => false), revealPath: vi.fn(), openSite: vi.fn(async () => {}) }));
vi.mock('./ItemView.js', () => ({ ItemView: ({ item }: { item: { path: string } }) => <div data-testid="item-view">{item.path}</div> }));
vi.mock('../state/api.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../state/api.js')>()),
  api: { view: { roots: vi.fn(), dir: vi.fn() }, artifacts: { list: vi.fn(async () => ({ artifacts: [] })) } },
}));

import { openSite } from '../desktop/bridge.js';
import { api } from '../state/api.js';
import { useGruntStore } from '../state/store.js';
import { viewTabId } from './items.js';
import { useViewerStore, viewerFor } from './state.js';
import { ViewerPanel } from './ViewerPanel.js';

const chat = { id: 'c1', title: 'Chat' } as Chat;
const viewer = () => viewerFor(useViewerStore.getState().viewers, 'c1');

beforeEach(() => {
  useViewerStore.setState({ viewers: {} });
  useGruntStore.setState(useGruntStore.getInitialState(), true);
  vi.mocked(api.view.roots).mockResolvedValue({ roots: [{ path: 'C:\\ws', label: 'ws', access: 'readwrite', workspace: true }, { path: 'D:\\refs', label: 'refs', access: 'read', workspace: false }] });
  vi.mocked(api.view.dir).mockImplementation(async (_c, path) =>
    path === 'C:\\ws'
      ? { path, entries: [{ name: 'src', path: 'C:\\ws\\src', type: 'dir' }, { name: 'a.md', path: 'C:\\ws\\a.md', type: 'file' }] }
      : { path, entries: [{ name: 'main.ts', path: 'C:\\ws\\src\\main.ts', type: 'file' }] }
  );
});
afterEach(cleanup);

describe('ViewerPanel', () => {
  it("lists the chat's artifacts above the folders, and opens one", async () => {
    vi.mocked(api.artifacts.list).mockResolvedValue({ artifacts: [{ id: 'art', slug: 'calc', kind: 'html', language: null, title: 'Calc', versionId: 'v2', number: 2, madeBy: 'model', live: 0 }] });
    render(<ViewerPanel chat={chat} />);
    await userEvent.setup().click(await screen.findByRole('button', { name: /Calc/ }));
    expect(viewer()).toMatchObject({ mode: 'item', history: [{ kind: 'artifact', artifactId: 'art', title: 'Calc' }] });
  });

  it('lists them again as a reply streams, with the head on your message as an ordinary send leaves it', async () => {
    vi.mocked(api.artifacts.list).mockClear();
    const mine = { id: 'u1', chatId: 'c1', parentId: null, role: 'user', parts: [], status: 'complete', error: null, producedBy: null, createdAt: 1 };
    const reply = (parts: unknown[]) => ({ id: 'r1', chatId: 'c1', parentId: 'u1', role: 'assistant', parts, status: 'streaming', error: null, producedBy: null, createdAt: 2 });
    useGruntStore.setState({ chats: [{ id: 'c1', headMessageId: 'u1' } as never], messages: { u1: mine, r1: reply([]) } as never });
    render(<ViewerPanel chat={chat} />);
    await waitFor(() => expect(api.artifacts.list).toHaveBeenCalledTimes(1));
    act(() => useGruntStore.setState({ messages: { u1: mine, r1: reply([{ type: 'text', text: 'x' }]) } as never }));
    await waitFor(() => expect(api.artifacts.list).toHaveBeenCalledTimes(2));
  });

  it("lists the chat's folders, opens folders lazily, and opens a file", async () => {
    const user = userEvent.setup();
    render(<ViewerPanel chat={chat} />);
    const tree = await screen.findByRole('tree', { name: 'Files' });
    expect(within(tree).getByRole('treeitem', { name: /refs \(read-only\)/ })).toBeInTheDocument();
    await user.click(await within(tree).findByRole('button', { name: 'src' }));
    await user.click(await within(tree).findByRole('button', { name: 'main.ts' }));
    expect(viewer()).toMatchObject({ mode: 'item', history: [{ kind: 'file', path: 'C:\\ws\\src\\main.ts' }] });
    expect(screen.getByTestId('item-view')).toHaveTextContent('C:\\ws\\src\\main.ts');
  });

  it('goes back and forward, opens a typed path or a website, pops out to a tab, and closes', async () => {
    const user = userEvent.setup();
    useViewerStore.getState().openItem('c1', { kind: 'file', path: 'a.md' });
    useViewerStore.getState().openItem('c1', { kind: 'file', path: 'b.md' });
    render(<ViewerPanel chat={chat} />);
    await user.click(screen.getByRole('button', { name: 'Back' }));
    expect(screen.getByTestId('item-view')).toHaveTextContent('a.md');
    await user.click(screen.getByRole('button', { name: 'Forward' }));
    expect(screen.getByTestId('item-view')).toHaveTextContent('b.md');

    const address = screen.getByRole('textbox', { name: 'Open a path or web address' });
    await user.type(address, 'docs/c.md{Enter}');
    expect(screen.getByTestId('item-view')).toHaveTextContent('docs/c.md');
    await user.type(address, 'https://example.com{Enter}');
    expect(openSite).toHaveBeenCalledWith('https://example.com');

    await user.click(screen.getByRole('button', { name: 'Open as tab' }));
    expect(useGruntStore.getState().paneState.tabs).toEqual(['c1', viewTabId('c1', { kind: 'file', path: 'docs/c.md' })]);
    // Popped out, not in both places: the chat's panel closes.
    expect(viewer().open).toBe(false);
    useViewerStore.getState().setOpen('c1', true);

    await user.click(screen.getByRole('button', { name: 'Close viewer' }));
    expect(viewer().open).toBe(false);
  });
});
