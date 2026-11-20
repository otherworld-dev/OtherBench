import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AddonView } from '../../state/api/addons.js';
import { emitAppEvent } from '../../state/appEventListeners.js';
import { configureTransport } from '../../state/transport.js';
import { AddonsPanel } from './AddonsPanel.js';

const SERVER = 'http://127.0.0.1:5555';
const glow: AddonView = { id: 'glow', name: 'Glow', version: '1.2.0', status: 'loaded', error: null, settingsPage: true };

beforeEach(() => configureTransport({ baseUrl: SERVER, token: 'tok' }));
afterEach(() => {
  cleanup();
  configureTransport({ baseUrl: '', token: null });
});

function frame(): { el: HTMLIFrameElement; post: ReturnType<typeof vi.spyOn> } {
  const el = screen.getByTitle<HTMLIFrameElement>('Glow settings');
  const post = vi.spyOn(el.contentWindow!, 'postMessage').mockImplementation(() => {});
  return { el, post };
}

function fromFrame(el: HTMLIFrameElement, data: unknown, origin = SERVER, source: MessageEventSource | null = el.contentWindow): void {
  act(() => {
    window.dispatchEvent(new MessageEvent('message', { data, origin, source }));
  });
}

describe('AddonsPanel', () => {
  it("shows each add-on, a failed one with the reason it didn't load", () => {
    render(<AddonsPanel addons={[glow, { id: 'bad', name: 'Bad', version: null, status: 'failed', error: 'It failed to start: boom', settingsPage: false }]} />);
    expect(screen.getByRole('heading', { name: /Glow/ })).toBeInTheDocument();
    expect(screen.getByText('1.2.0', { exact: false })).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent("Bad didn't load: It failed to start: boom");
  });

  it("frames a loaded add-on's settings page from the server", () => {
    render(<AddonsPanel addons={[glow]} />);
    expect(screen.getByTitle('Glow settings')).toHaveAttribute('src', `${SERVER}/addons/glow/`);
  });

  it('answers the ready message from its own frame and the server with the API address and token', () => {
    render(<AddonsPanel addons={[glow]} />);
    const { el, post } = frame();
    fromFrame(el, { type: 'otherbench-addon-ready' });
    expect(post).toHaveBeenCalledWith(expect.objectContaining({ type: 'otherbench-host', apiBase: `${SERVER}/api`, token: 'tok', theme: expect.any(Object) }), SERVER);
  });

  it('ignores ready from another origin or another window', () => {
    render(<AddonsPanel addons={[glow]} />);
    const { el, post } = frame();
    fromFrame(el, { type: 'otherbench-addon-ready' }, 'https://evil.example');
    fromFrame(el, { type: 'otherbench-addon-ready' }, SERVER, window);
    expect(post).not.toHaveBeenCalled();
  });

  it('opens a chat the page asks for', () => {
    const onOpenChat = vi.fn();
    render(<AddonsPanel addons={[glow]} onOpenChat={onOpenChat} />);
    const { el } = frame();
    fromFrame(el, { type: 'otherbench-open-chat', chatId: 'chat-9' });
    fromFrame(el, { type: 'otherbench-open-chat', chatId: 42 });
    expect(onOpenChat).toHaveBeenCalledTimes(1);
    expect(onOpenChat).toHaveBeenCalledWith('chat-9');
  });

  it('tells the page when its add-on changed, and not for another', () => {
    render(<AddonsPanel addons={[glow]} />);
    const { post } = frame();
    act(() => emitAppEvent({ type: 'addon-changed', id: 'other' }));
    expect(post).not.toHaveBeenCalled();
    act(() => emitAppEvent({ type: 'addon-changed', id: 'glow' }));
    expect(post).toHaveBeenCalledWith({ type: 'otherbench-changed' }, SERVER);
  });
});
