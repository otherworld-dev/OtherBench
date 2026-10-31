import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BrowserHandoverCard } from './BrowserHandoverCard.js';

const ask = { kind: 'browser' as const, toolName: 'browser', site: 'example.com', reason: 'Tick the box.', window: true, id: 'b1', chatId: 'c1', messageId: 'm1' };

afterEach(cleanup);

describe('BrowserHandoverCard', () => {
  it('names the site and what is needed, and says where to do it', () => {
    render(<BrowserHandoverCard ask={ask} profileName="Sonnet" onAnswer={vi.fn()} />);
    expect(screen.getByRole('group', { name: 'Sonnet needs you in the browser' })).toHaveAttribute('data-kind', 'browser');
    expect(screen.getByText('example.com')).toBeInTheDocument();
    expect(screen.getByText('Tick the box.')).toBeInTheDocument();
    expect(screen.getByText(/browser window that has opened/)).toBeInTheDocument();
  });

  it('points at the panel when there is no window', () => {
    render(<BrowserHandoverCard ask={{ ...ask, window: false }} profileName="Sonnet" onAnswer={vi.fn()} />);
    expect(screen.queryByText(/browser window that has opened/)).not.toBeInTheDocument();
    expect(screen.getByText(/Use the Browser panel here/)).toBeInTheDocument();
  });

  it('answers done or skip', async () => {
    const onAnswer = vi.fn(async () => undefined);
    render(<BrowserHandoverCard ask={ask} profileName="Sonnet" onAnswer={onAnswer} />);
    await userEvent.click(screen.getByRole('button', { name: "I'm done" }));
    expect(onAnswer).toHaveBeenCalledWith('b1', { approve: true });
  });

  it('comes back with an error if the answer fails', async () => {
    const onAnswer = vi.fn(async () => {
      throw new Error('offline');
    });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    render(<BrowserHandoverCard ask={ask} profileName="Sonnet" onAnswer={onAnswer} />);
    await userEvent.click(screen.getByRole('button', { name: 'Skip' }));
    expect(onAnswer).toHaveBeenCalledWith('b1', { declined: true });
    expect(await screen.findByText('Could not send that. Please try again.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Skip' })).toBeEnabled();
  });
});
