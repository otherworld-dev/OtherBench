import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../desktop/bridge.js', () => ({ openSite: vi.fn(async () => {}), openInBrowser: vi.fn(async () => {}), isDesktop: () => false }));

import { MarkdownBody } from '../components/MarkdownBody.js';
import { Message } from '../components/Message.js';
import { openInBrowser, openSite } from '../desktop/bridge.js';
import { useViewerStore, viewerFor } from './state.js';
import { ViewerContext, viewerActionsFor } from './ViewerContext.js';

const shown = (chatId: string) => viewerFor(useViewerStore.getState().viewers, chatId).history.map((i) => (i.kind === 'file' ? i.path : i.kind === 'artifact' ? i.artifactId : i.kind));

beforeEach(() => useViewerStore.setState({ viewers: {} }));
afterEach(cleanup);

describe('opening things from a chat', () => {
  it("shows an artifact call as a card outside the folded tools, which opens it in the chat's viewer", async () => {
    const outcome = { ok: true, command: 'update', artifactId: 'art', slug: 'calc', title: 'Calc', kind: 'html', number: 4, versionId: 'v4' };
    const message = {
      id: 'm2', chatId: 'c1', parentId: 'u1', role: 'assistant' as const, status: 'complete' as const, error: null, producedBy: null, createdAt: 0,
      parts: [
        { type: 'tool-call' as const, id: 'a', name: 'artifact', args: { command: 'update', id: 'calc', find: '1', replace: '2' } },
        { type: 'tool-result' as const, id: 'a', name: 'artifact', result: JSON.stringify(outcome), isError: false },
        { type: 'tool-call' as const, id: 'b', name: 'read_file', args: { path: 'x.md' } },
        { type: 'tool-result' as const, id: 'b', name: 'read_file', result: 'x', isError: false },
      ],
    };
    render(
      <ViewerContext.Provider value={viewerActionsFor('c1')}>
        <Message message={message as never} />
      </ViewerContext.Provider>
    );
    expect(screen.getByText(/Used 1 tool/)).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('button', { name: /Calc.*Updated to v4/ }));
    expect(viewerFor(useViewerStore.getState().viewers, 'c1').history).toEqual([{ kind: 'artifact', artifactId: 'art', title: 'Calc', versionId: 'v4' }]);
  });

  it('keeps parallel tool calls in one group when an artifact card sits among them', () => {
    const outcome = { ok: true, command: 'create', artifactId: 'art', slug: 'calc', title: 'Calc', kind: 'html', number: 1, versionId: 'v1' };
    const message = {
      id: 'm4', chatId: 'c1', parentId: 'u1', role: 'assistant' as const, status: 'complete' as const, error: null, producedBy: null, createdAt: 0,
      parts: [
        { type: 'tool-call' as const, id: 'a', name: 'artifact', args: { command: 'create' } },
        { type: 'tool-call' as const, id: 'b', name: 'read_file', args: { path: 'x.md' } },
        { type: 'tool-result' as const, id: 'a', name: 'artifact', result: JSON.stringify(outcome), isError: false },
        { type: 'tool-result' as const, id: 'b', name: 'read_file', result: 'x', isError: false },
      ],
    };
    render(<Message message={message as never} />);
    expect(screen.getAllByText(/Used \d+ tools?/)).toHaveLength(1);
    expect(screen.getByText(/Used 1 tool: read_file/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Calc.*Created v1/ })).toBeInTheDocument();
  });

  it('folds a failed artifact call with the other tools, so its error still shows', () => {
    const message = {
      id: 'm3', chatId: 'c1', parentId: 'u1', role: 'assistant' as const, status: 'complete' as const, error: null, producedBy: null, createdAt: 0,
      parts: [
        { type: 'tool-call' as const, id: 'a', name: 'artifact', args: { command: 'view', id: 'nope' } },
        { type: 'tool-result' as const, id: 'a', name: 'artifact', result: JSON.stringify({ error: true, code: 'unknown_id', message: 'No artifact "nope".' }), isError: true },
      ],
    };
    render(<Message message={message as never} />);
    expect(screen.getByText(/Used 1 tool: artifact/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /nope/ })).toBeNull();
  });

  it("opens links as websites (Ctrl-click in the browser) and paths in that chat's own panel", async () => {
    const user = userEvent.setup();
    render(
      <>
        <ViewerContext.Provider value={viewerActionsFor('left')}>
          <MarkdownBody text={'See [the site](https://example.com), [notes](notes/a.md) and `src/main.ts`, not `foo()`.'} />
        </ViewerContext.Provider>
        <ViewerContext.Provider value={viewerActionsFor('right')}>
          <MarkdownBody text={'And `C:\\ws\\b.md`.'} />
        </ViewerContext.Provider>
      </>
    );
    await user.click(screen.getByRole('link', { name: 'the site' }));
    expect(openSite).toHaveBeenCalledWith('https://example.com');
    await user.keyboard('{Control>}');
    await user.click(screen.getByRole('link', { name: 'the site' }));
    await user.keyboard('{/Control}');
    expect(openInBrowser).toHaveBeenCalledWith('https://example.com');

    await user.click(screen.getByRole('link', { name: 'notes' }));
    await user.click(screen.getByRole('button', { name: 'src/main.ts' }));
    await user.click(screen.getByRole('button', { name: 'C:\\ws\\b.md' }));
    expect(screen.queryByRole('button', { name: 'foo()' })).toBeNull();
    expect(shown('left')).toEqual(['notes/a.md', 'src/main.ts']);
    expect(shown('right')).toEqual(['C:\\ws\\b.md']);
  });

  it("offers Open on a file tool call's path, not a folder tool's, and leaves links alone outside a chat", async () => {
    const message = {
      id: 'm1', chatId: 'c1', parentId: 'u1', role: 'assistant' as const, status: 'complete' as const, error: null, producedBy: null, createdAt: 0,
      parts: [
        { type: 'tool-call' as const, id: 'a', name: 'read_file', args: { path: 'notes.md' } },
        { type: 'tool-call' as const, id: 'b', name: 'list_dir', args: { path: '.' } },
      ],
    };
    const user = userEvent.setup();
    render(
      <ViewerContext.Provider value={viewerActionsFor('c1')}>
        <Message message={message as never} />
      </ViewerContext.Provider>
    );
    await user.click(screen.getByText(/Used 2 tools/));
    await user.click(screen.getByRole('button', { name: 'Open notes.md' }));
    expect(shown('c1')).toEqual(['notes.md']);
    expect(screen.queryByRole('button', { name: 'Open .' })).toBeNull();
    cleanup();

    render(<MarkdownBody text={'[x](https://example.com) `src/a.ts`'} />);
    expect(screen.getByRole('link', { name: 'x' })).toHaveAttribute('href', 'https://example.com');
    expect(screen.queryByRole('button', { name: 'src/a.ts' })).toBeNull();
  });
});
