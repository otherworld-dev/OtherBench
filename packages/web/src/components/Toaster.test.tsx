import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { revealPath } = vi.hoisted(() => ({ revealPath: vi.fn() }));
vi.mock('../desktop/bridge.js', () => ({ revealPath }));

import { useOtherBenchStore } from '../state/store.js';
import { Toaster } from './Toaster.js';
import { TOAST_MS, toast, useToasts } from '../lib/toasts.js';

beforeEach(() => {
  useToasts.setState({ toasts: [] });
  revealPath.mockReset();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('Toaster', () => {
  it('shows a saved file with Show in folder, which reveals that path', async () => {
    render(<Toaster />);
    act(() => void toast({ tone: 'ok', text: 'Downloaded a.md to Downloads', path: 'C:\\Users\\a\\Downloads\\a.md' }));
    expect(screen.getByRole('status')).toHaveTextContent('Downloaded a.md to Downloads');
    await userEvent.setup().click(screen.getByRole('button', { name: 'Show in folder' }));
    expect(revealPath).toHaveBeenCalledWith('C:\\Users\\a\\Downloads\\a.md');
  });

  it('has no Show in folder without a path, and Dismiss removes the toast', async () => {
    render(<Toaster />);
    act(() => void toast({ tone: 'ok', text: 'Downloaded chat.md' }));
    expect(screen.queryByRole('button', { name: 'Show in folder' })).not.toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByTestId('toast')).not.toBeInTheDocument();
  });

  it('goes on its own after a while, and keeps at most three', () => {
    vi.useFakeTimers();
    render(<Toaster />);
    act(() => {
      for (const n of [1, 2, 3, 4]) toast({ tone: 'ok', text: `t${n}` });
    });
    expect(screen.getAllByTestId('toast').map((t) => t.textContent)).toEqual(['t2×', 't3×', 't4×']);
    act(() => vi.advanceTimersByTime(TOAST_MS));
    expect(screen.queryByTestId('toast')).not.toBeInTheDocument();
  });

  it('makes a toast with a chat a button that opens the chat and dismisses the toast', async () => {
    render(<Toaster />);
    act(() => void toast({ tone: 'ok', text: 'Fix login moved to VH', chatId: 'c9' }));
    await userEvent.setup().click(screen.getByRole('button', { name: 'Fix login moved to VH' }));
    expect(useOtherBenchStore.getState().activeChatId).toBe('c9');
    expect(screen.queryByTestId('toast')).not.toBeInTheDocument();
  });
});
