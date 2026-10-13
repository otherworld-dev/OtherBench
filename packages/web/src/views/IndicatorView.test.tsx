import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

let emit: ((payload: { lastAction?: unknown }) => void) | null = null;
const unlisten = vi.fn();

vi.mock('../desktop/bridge.js', () => ({
  onDesktopEvent: vi.fn(async (_name: string, cb: (payload: { lastAction?: unknown }) => void) => {
    emit = cb;
    return unlisten;
  }),
  stopComputerControl: vi.fn(async () => {}),
}));

import { onDesktopEvent, stopComputerControl } from '../desktop/bridge.js';
import { IndicatorView } from './IndicatorView.js';

describe('IndicatorView', () => {
  afterEach(() => {
    cleanup();
    emit = null;
    window.history.replaceState({}, '', '/');
    vi.clearAllMocks();
  });

  it("shows the chat, the shell's last action, and stops through the shell", async () => {
    window.history.replaceState({}, '', '/?view=indicator&title=Budget%20sheet');
    render(<IndicatorView />);
    const bar = screen.getByTestId('computer-indicator');
    expect(bar).toHaveTextContent('Grunt is controlling this computer');
    expect(bar).toHaveTextContent('Budget sheet');
    await vi.waitFor(() => expect(emit).not.toBeNull());
    expect(onDesktopEvent).toHaveBeenCalledWith('computer-indicator', expect.any(Function));
    act(() => emit!({ lastAction: 'click at 1, 2' }));
    expect(screen.getByTestId('computer-indicator-last')).toHaveTextContent('click at 1, 2');
    await userEvent.setup().click(screen.getByRole('button', { name: 'Stop (Ctrl+Alt+Backspace)' }));
    expect(stopComputerControl).toHaveBeenCalledTimes(1);
  });

  it('shows the title and the last action as one clean line each, isolated in <bdi>', async () => {
    window.history.replaceState({}, '', `/?view=indicator&title=${encodeURIComponent('Budget\n\u202Eexe.txt\u200B')}`);
    render(<IndicatorView />);
    const title = screen.getByTestId('computer-indicator-title');
    expect(title.tagName).toBe('BDI');
    expect(title.textContent).toBe('Budget exe.txt');
    await vi.waitFor(() => expect(emit).not.toBeNull());
    act(() => emit!({ lastAction: 'press\nctrl+s\u202E' }));
    const last = screen.getByTestId('computer-indicator-last');
    expect(last.tagName).toBe('BDI');
    expect(last.textContent).toBe('press ctrl+s');
    // Anything that isn't text shows nothing.
    act(() => emit!({ lastAction: { html: '<b>x</b>' } }));
    expect(screen.queryByTestId('computer-indicator-last')).toBeNull();
  });

  it('names no chat it was not given, and stops listening when it goes', async () => {
    window.history.replaceState({}, '', '/?view=indicator');
    const { unmount } = render(<IndicatorView />);
    expect(screen.getByTestId('computer-indicator-title')).toHaveTextContent('a chat');
    await vi.waitFor(() => expect(emit).not.toBeNull());
    unmount();
    expect(unlisten).toHaveBeenCalled();
  });
});
