import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState, type JSX } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConfirmDialog } from './ConfirmDialog.js';
import { Overlay } from './Overlay.js';

/** An app with a button that opens a view over it, as App does with Settings. */
function Harness({ onEscape, children, restoreFocus }: { onEscape?: () => void; children?: JSX.Element; restoreFocus?: boolean }): JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <div data-testid="app-behind">
        <button type="button" onClick={() => setOpen(true)}>
          Open
        </button>
      </div>
      <div data-testid="toasts" data-overlay-keep="">
        <button type="button">Undo</button>
      </div>
      {open && (
        <Overlay
          label="Settings"
          testId="the-view"
          {...(restoreFocus === undefined ? {} : { restoreFocus })}
          onEscape={() => {
            onEscape?.();
            setOpen(false);
          }}
        >
          {children ?? <button type="button">Inside</button>}
        </Overlay>
      )}
    </div>
  );
}

describe('Overlay', () => {
  afterEach(cleanup);

  it('is a modal dialog named for its view', async () => {
    render(<Harness />);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Open' }));
    const dialog = screen.getByRole('dialog', { name: 'Settings' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toBe(screen.getByTestId('the-view'));
  });

  it('moves focus into the view when it opens and back to the opener when it closes', async () => {
    render(<Harness />);
    const user = userEvent.setup();
    const opener = screen.getByRole('button', { name: 'Open' });
    await user.click(opener);
    expect(screen.getByTestId('the-view')).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(screen.queryByTestId('the-view')).toBeNull();
    expect(opener).toHaveFocus();
  });

  it('leaves focus on what the view focused itself, or sends it to the element that asks for it', async () => {
    const user = userEvent.setup();
    const own = render(<Harness><input aria-label="Name" autoFocus /></Harness>);
    await user.click(screen.getByRole('button', { name: 'Open' }));
    expect(screen.getByRole('textbox', { name: 'Name' })).toHaveFocus();
    own.unmount();

    render(
      <Harness>
        <>
          <button type="button">First</button>
          <button type="button" data-autofocus="">
            Chosen
          </button>
        </>
      </Harness>
    );
    await user.click(screen.getByRole('button', { name: 'Open' }));
    expect(screen.getByRole('button', { name: 'Chosen' })).toHaveFocus();
  });

  it("doesn't put focus back itself for a view that does that (restoreFocus off)", async () => {
    render(<Harness restoreFocus={false} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Open' }));
    await user.keyboard('{Escape}');
    expect(screen.getByRole('button', { name: 'Open' })).not.toHaveFocus();
  });

  it('makes the rest of the app inert while open, toasts apart, and gives it back after', async () => {
    render(<Harness />);
    const user = userEvent.setup();
    const behind = screen.getByTestId('app-behind');
    expect(behind).not.toHaveAttribute('inert');
    await user.click(screen.getByRole('button', { name: 'Open' }));
    expect(behind).toHaveAttribute('inert');
    expect(screen.getByTestId('toasts')).not.toHaveAttribute('inert');
    expect(screen.getByTestId('the-view')).not.toHaveAttribute('inert');
    await user.keyboard('{Escape}');
    expect(behind).not.toHaveAttribute('inert');
  });

  it('Escape closes from anywhere, focus on the page included', async () => {
    const onEscape = vi.fn();
    render(<Harness onEscape={onEscape} />);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Open' }));
    (document.activeElement as HTMLElement).blur();
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(onEscape).toHaveBeenCalledTimes(1);
  });

  it('leaves Escape to a question or a field inside that takes it', async () => {
    const onEscape = vi.fn();
    const onCancel = vi.fn();
    const user = userEvent.setup();
    const question = render(
      <Harness onEscape={onEscape}>
        <ConfirmDialog title="Discard changes?" confirmLabel="Discard" onConfirm={async () => {}} onCancel={onCancel} />
      </Harness>
    );
    await user.click(screen.getByRole('button', { name: 'Open' }));
    await user.keyboard('{Escape}');
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onEscape).not.toHaveBeenCalled();
    question.unmount();

    // A field that uses Escape itself (to cancel a rename) marks it handled.
    render(
      <Harness onEscape={onEscape}>
        <input aria-label="Rename" autoFocus onKeyDown={(e) => e.key === 'Escape' && e.preventDefault()} />
      </Harness>
    );
    await user.click(screen.getByRole('button', { name: 'Open' }));
    await user.keyboard('{Escape}');
    expect(onEscape).not.toHaveBeenCalled();
    expect(screen.getByTestId('the-view')).toBeInTheDocument();
  });
});
