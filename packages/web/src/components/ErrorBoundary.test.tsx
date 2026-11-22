import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import type { JSX } from 'react';
import { ErrorBoundary } from './ErrorBoundary.js';

/** Throws while `broken.on`, so a test can mend it before Try again. */
const broken = { on: true };
let mounts = 0;
function Fragile({ label = 'drawn fine' }: { label?: string }): JSX.Element {
  if (broken.on) throw new Error('unexpected part shape');
  return <p>{label}</p>;
}
function CountsMounts(): JSX.Element {
  mounts += 1;
  return <Fragile />;
}

describe('ErrorBoundary', () => {
  let logged: MockInstance<typeof console.error>;
  beforeEach(() => {
    broken.on = true;
    mounts = 0;
    logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => {
    cleanup();
    logged.mockRestore();
  });

  it('takes out only the piece that threw, says what failed and logs it', () => {
    render(
      <>
        <p>the rest of the app</p>
        <ErrorBoundary what="this message">
          <Fragile />
        </ErrorBoundary>
      </>
    );
    expect(screen.getByText('the rest of the app')).toBeInTheDocument();
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent("Couldn't show this message.");
    expect(alert).toHaveTextContent('unexpected part shape');
    expect(logged.mock.calls.some((call) => String(call[0]).includes("[otherbench-web] couldn't show this message"))).toBe(true);
  });

  it('Try again mounts the piece afresh', async () => {
    render(
      <ErrorBoundary what="this chat">
        <CountsMounts />
      </ErrorBoundary>
    );
    const before = mounts;
    broken.on = false;
    await userEvent.setup().click(screen.getByRole('button', { name: 'Try again' }));
    expect(screen.getByText('drawn fine')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(mounts).toBeGreaterThan(before);
  });

  it('still failing after Try again shows the fallback again', async () => {
    render(
      <ErrorBoundary what="this chat">
        <Fragile />
      </ErrorBoundary>
    );
    await userEvent.setup().click(screen.getByRole('button', { name: 'Try again' }));
    expect(screen.getByRole('alert')).toHaveTextContent("Couldn't show this chat.");
  });

  it('offers the raw content when given some, and no button for it otherwise', async () => {
    const message = { id: 'm1', parts: [{ type: 'from-a-newer-machine', text: 'what it said' }] };
    const { unmount } = render(
      <ErrorBoundary what="this message" raw={message}>
        <Fragile />
      </ErrorBoundary>
    );
    expect(screen.queryByText(/what it said/)).toBeNull();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Show raw content' }));
    expect(screen.getByText(/"text": "what it said"/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Hide raw content' }));
    expect(screen.queryByText(/what it said/)).toBeNull();
    unmount();

    render(
      <ErrorBoundary what="Settings">
        <Fragile />
      </ErrorBoundary>
    );
    expect(screen.queryByRole('button', { name: /raw content/ })).toBeNull();
  });

  it('offers Close when it can be closed', async () => {
    const onClose = vi.fn();
    render(
      <ErrorBoundary what="Settings" onClose={onClose} variant="overlay">
        <Fragile />
      </ErrorBoundary>
    );
    await userEvent.setup().click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('tries again by itself when what it shows changes (another chat in the pane)', () => {
    const { rerender } = render(
      <ErrorBoundary what="this chat" resetKey="chat-1">
        <Fragile />
      </ErrorBoundary>
    );
    expect(screen.getByRole('alert')).toBeInTheDocument();
    broken.on = false;
    // The same thing again stays failed: nothing says it would draw now.
    rerender(
      <ErrorBoundary what="this chat" resetKey="chat-1">
        <Fragile />
      </ErrorBoundary>
    );
    expect(screen.getByRole('alert')).toBeInTheDocument();
    rerender(
      <ErrorBoundary what="this chat" resetKey="chat-2">
        <Fragile label="the other chat" />
      </ErrorBoundary>
    );
    expect(screen.getByText('the other chat')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
