import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../desktop/bridge.js', () => ({ isDesktop: vi.fn(() => false), revealPath: vi.fn(async () => true) }));
vi.mock('../state/api.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../state/api.js')>()),
  api: { view: { open: vi.fn(), text: vi.fn() } },
}));

import { isDesktop, revealPath } from '../desktop/bridge.js';
import { ApiError, api, type ViewOpened } from '../state/api.js';
import { ItemView, languageOf } from './ItemView.js';

const opened = (over: Partial<ViewOpened>): ViewOpened => ({ path: 'C:\\ws\\a', name: 'a', kind: 'text', url: null, size: 1, ...over });
const item = (path: string) => ({ kind: 'file' as const, path });

beforeEach(() => {
  vi.mocked(api.view.open).mockReset();
  vi.mocked(api.view.text).mockReset();
});
afterEach(cleanup);

describe('ItemView', () => {
  it('shows an image, a video and a PDF from their links', async () => {
    vi.mocked(api.view.open).mockResolvedValueOnce(opened({ kind: 'image', name: 'pic.png', url: '/view/x/pic.png' }));
    render(<ItemView chatId="c1" item={item('pic.png')} />);
    expect(await screen.findByRole('img', { name: 'pic.png' })).toHaveAttribute('src', '/view/x/pic.png');
    cleanup();

    vi.mocked(api.view.open).mockResolvedValueOnce(opened({ kind: 'video', name: 'clip.mp4', url: '/view/y/clip.mp4' }));
    render(<ItemView chatId="c1" item={item('clip.mp4')} />);
    expect(await screen.findByTestId('viewer-video')).toHaveAttribute('src', '/view/y/clip.mp4');
    cleanup();

    vi.mocked(api.view.open).mockResolvedValueOnce(opened({ kind: 'pdf', name: 'doc.pdf', url: '/view/z/doc.pdf' }));
    render(<ItemView chatId="c1" item={item('doc.pdf')} />);
    const frame = await screen.findByTitle('doc.pdf');
    expect(frame).toHaveAttribute('src', '/view/z/doc.pdf');
    expect(frame).not.toHaveAttribute('sandbox');
  });

  it('runs HTML only in the sandbox, with its source a click away', async () => {
    vi.mocked(api.view.open).mockResolvedValue(opened({ kind: 'html', name: 'page.html', url: '/view/h/page.html' }));
    vi.mocked(api.view.text).mockResolvedValue({ path: 'C:\\ws\\page.html', content: '<p>hi</p>', truncated: false, size: 9 });
    render(<ItemView chatId="c1" item={item('page.html')} />);
    const frame = await screen.findByTitle('page.html');
    expect(frame).toHaveAttribute('sandbox', 'allow-scripts allow-forms');
    expect(frame).toHaveAttribute('referrerpolicy', 'no-referrer');
    await userEvent.setup().click(screen.getByRole('button', { name: 'Source' }));
    // highlight.js splits the source into spans, so check the code block's whole text.
    await waitFor(() => expect(document.querySelector('pre code')?.textContent).toBe('<p>hi</p>'));
    expect(screen.queryByTitle('page.html')).toBeNull();
  });

  it('formats Markdown, shows its source, and says when text was cut off', async () => {
    vi.mocked(api.view.open).mockResolvedValue(opened({ kind: 'markdown', name: 'a.md' }));
    vi.mocked(api.view.text).mockResolvedValue({ path: 'C:\\ws\\a.md', content: '# Title', truncated: true, size: 3_000_000 });
    render(<ItemView chatId="c1" item={item('a.md')} />);
    expect(await screen.findByRole('heading', { name: 'Title' })).toBeInTheDocument();
    expect(screen.getByText(/only the first 2 MB/)).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Source' }));
    await waitFor(() => expect(document.querySelector('pre code')?.textContent).toBe('# Title'));
    expect(screen.queryByRole('heading', { name: 'Title' })).toBeNull();
  });

  it("says why it can't show something, and offers Show in folder in the desktop app", async () => {
    vi.mocked(isDesktop).mockReturnValue(true);
    vi.mocked(api.view.open).mockResolvedValue(opened({ kind: 'other', name: 'tool.exe', path: 'C:\\ws\\tool.exe' }));
    render(<ItemView chatId="c1" item={item('tool.exe')} />);
    expect(await screen.findByText("Can't preview this.")).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Show in folder' }));
    expect(revealPath).toHaveBeenCalledWith('C:\\ws\\tool.exe');
    vi.mocked(isDesktop).mockReturnValue(false);
    cleanup();

    vi.mocked(api.view.open).mockRejectedValue(new ApiError(404, "This isn't in this chat's workspace or folders."));
    render(<ItemView chatId="c1" item={item('C:\\elsewhere\\a.md')} />);
    expect(await screen.findByRole('alert')).toHaveTextContent("This isn't in this chat's workspace or folders.");
  });

  it('asks for a fresh link when an old video link has expired', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.mocked(api.view.open)
      .mockResolvedValueOnce(opened({ kind: 'video', name: 'clip.mp4', url: '/view/old/clip.mp4' }))
      .mockResolvedValueOnce(opened({ kind: 'video', name: 'clip.mp4', url: '/view/new/clip.mp4' }));
    render(<ItemView chatId="c1" item={item('clip.mp4')} />);
    const video = await screen.findByTestId('viewer-video');
    vi.advanceTimersByTime(10 * 60_000);
    video.dispatchEvent(new Event('error'));
    await waitFor(() => expect(screen.getByTestId('viewer-video')).toHaveAttribute('src', '/view/new/clip.mp4'));
    vi.useRealTimers();
  });

  it('picks a highlighting language from the extension', () => {
    expect(languageOf('a/b.ts')).toBe('ts');
    expect(languageOf('C:\\x\\Y.PY')).toBe('py');
    expect(languageOf('Makefile')).toBe('');
  });
});
