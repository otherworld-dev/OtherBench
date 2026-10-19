import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../desktop/bridge.js', () => ({ openInBrowser: vi.fn(async () => {}), isDesktop: () => false }));
vi.mock('./ItemView.js', async () => {
  const { MarkdownBody } = await import('../components/MarkdownBody.js');
  return { ItemView: () => <MarkdownBody text="See [the site](https://example.com) and `docs/b.md`." /> };
});

import { openInBrowser } from '../desktop/bridge.js';
import { viewTabId } from './items.js';
import { useViewerStore, viewerFor } from './state.js';
import { ViewerTab } from './ViewerTab.js';

afterEach(cleanup);

describe('ViewerTab', () => {
  it("opens links and paths in a popped-out file the way the chat's panel does, not by navigating the app away", async () => {
    useViewerStore.setState({ viewers: {} });
    render(<ViewerTab tabId={viewTabId('c1', { kind: 'file', path: 'README.md' })} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('link', { name: 'the site' }));
    expect(openInBrowser).toHaveBeenCalledWith('https://example.com');
    await user.click(screen.getByRole('button', { name: 'docs/b.md' }));
    expect(viewerFor(useViewerStore.getState().viewers, 'c1').history).toEqual([{ kind: 'file', path: 'docs/b.md' }]);
  });
});
