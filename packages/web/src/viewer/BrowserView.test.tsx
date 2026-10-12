import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../state/api.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../state/api.js')>()),
  api: { browser: { close: vi.fn(async () => undefined), state: vi.fn() } },
}));

import { api } from '../state/api.js';
import type { SseConnect, SseHandlers } from '../state/sse.js';
import { BrowserView } from './BrowserView.js';

function fakeConnect() {
  let handlers: SseHandlers | null = null;
  const urls: string[] = [];
  const closedUrls: string[] = [];
  const connect: SseConnect = (url, h) => {
    urls.push(url);
    handlers = h;
    return {
      close: () => {
        closedUrls.push(url);
        handlers = null;
      },
    };
  };
  const emit = (event: string, data: unknown) => act(() => handlers!.onEvent(event, JSON.stringify(data)));
  return { connect, urls, closedUrls, emit, closed: () => handlers === null };
}

afterEach(cleanup);

describe('BrowserView', () => {
  it("says the model hasn't opened a page when the chat has no browser", () => {
    const s = fakeConnect();
    render(<BrowserView chatId="c1" connect={s.connect} />);
    expect(s.urls[0]).toMatch(/\/api\/chats\/c1\/browser\/live$/);
    s.emit('hello', { open: false });
    expect(screen.getByText("The model hasn't opened a page in this chat.")).toBeInTheDocument();
  });

  it('shows the latest frame as a JPEG with the address and title, and closes on request', async () => {
    const s = fakeConnect();
    render(<BrowserView chatId="c1" connect={s.connect} />);
    s.emit('hello', { open: true, url: 'https://example.com/', title: 'Example', host: 'example.com', holder: null });
    s.emit('message', { type: 'frame', seq: 1, jpeg: 'AAAA' });
    s.emit('message', { type: 'frame', seq: 2, jpeg: 'BBBB' });
    expect(screen.getByRole('img', { name: "Live view of the model's browser" })).toHaveAttribute('src', 'data:image/jpeg;base64,BBBB');
    expect(screen.getByText('Example')).toBeInTheDocument();
    expect(screen.getByText('https://example.com/')).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Close browser' }));
    expect(api.browser.close).toHaveBeenCalledWith('c1');
    s.emit('message', { type: 'state', state: { open: false } });
    expect(screen.getByText("The model hasn't opened a page in this chat.")).toBeInTheDocument();
  });

  it('never shows a frame that is not plain base64', () => {
    const s = fakeConnect();
    render(<BrowserView chatId="c1" connect={s.connect} />);
    s.emit('hello', { open: true, url: 'https://example.com/', title: 'Example' });
    s.emit('message', { type: 'frame', seq: 1, jpeg: '"><script>' });
    expect(screen.queryByRole('img')).toBeNull();
    s.emit('message', { type: 'frame', seq: 2, jpeg: 5 });
    expect(screen.queryByRole('img')).toBeNull();
    // A good frame, then a bad one: the bad one doesn't replace it.
    s.emit('message', { type: 'frame', seq: 3, jpeg: 'AAAA' });
    s.emit('message', { type: 'frame', seq: 4, jpeg: 'AAAA" onerror="x' });
    expect(screen.getByRole('img')).toHaveAttribute('src', 'data:image/jpeg;base64,AAAA');
  });

  it('names the machine when the chat runs elsewhere', () => {
    const s = fakeConnect();
    render(<BrowserView chatId="c1" connect={s.connect} />);
    s.emit('hello', { open: false, elsewhere: 'Gigabyte' });
    expect(screen.getByText('The browser is on Gigabyte.')).toBeInTheDocument();
  });

  it('shows the address and title as one plain line without bidi or zero-width controls', () => {
    const s = fakeConnect();
    render(<BrowserView chatId="c1" connect={s.connect} />);
    s.emit('hello', { open: true, url: 'https://exa\u202Emple.com/\u200Bpath\n<b>x</b>', title: 'Pay\u2066pal\u200B\r\nLogin <i>now</i>' });
    expect(screen.getByText('https://example.com/path <b>x</b>')).toBeInTheDocument();
    expect(screen.getByText('Paypal Login <i>now</i>')).toBeInTheDocument();
    expect(document.querySelector('b, i')).toBeNull();
  });

  it('strips tag characters, variation selectors and Hangul fillers from page text', () => {
    const s = fakeConnect();
    render(<BrowserView chatId="c1" connect={s.connect} />);
    const tag = String.fromCodePoint(0xe0041, 0xe0042);
    s.emit('hello', { open: true, url: `https://example.com/${tag}a\uFE0Fb`, title: `Log\u3164in${tag}` });
    expect(screen.getByText('https://example.com/ab')).toBeInTheDocument();
    expect(screen.getByText('Login')).toBeInTheDocument();
  });

  it('ignores a state event with no state', () => {
    const s = fakeConnect();
    render(<BrowserView chatId="c1" connect={s.connect} />);
    s.emit('hello', { open: false });
    s.emit('message', { type: 'state' });
    expect(screen.getByText("The model hasn't opened a page in this chat.")).toBeInTheDocument();
  });

  it('closes its stream when it unmounts or is pointed at another chat', () => {
    const s = fakeConnect();
    const view = render(<BrowserView chatId="c1" connect={s.connect} />);
    expect(s.closedUrls).toEqual([]);
    view.rerender(<BrowserView chatId="c2" connect={s.connect} />);
    expect(s.closedUrls).toHaveLength(1);
    expect(s.closedUrls[0]).toMatch(/\/chats\/c1\/browser\/live$/);
    expect(s.urls[1]).toMatch(/\/chats\/c2\/browser\/live$/);
    view.unmount();
    expect(s.closedUrls).toHaveLength(2);
    expect(s.closedUrls[1]).toMatch(/\/chats\/c2\/browser\/live$/);
    expect(s.closed()).toBe(true);
  });

  it('shows an error when closing fails', async () => {
    vi.mocked(api.browser.close).mockRejectedValueOnce(new Error('x'));
    const s = fakeConnect();
    render(<BrowserView chatId="c1" connect={s.connect} />);
    s.emit('hello', { open: true, url: 'https://example.com/', title: 'Example' });
    await userEvent.setup().click(screen.getByRole('button', { name: 'Close browser' }));
    expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't close the browser");
  });
});
