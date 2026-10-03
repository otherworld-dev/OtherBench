import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../state/api.js';
import { ConfirmDialog } from './ConfirmDialog.js';

afterEach(cleanup);

describe('ConfirmDialog', () => {
  it('is an alert dialog named by its question, with focus on Cancel', () => {
    render(<ConfirmDialog title="Delete 'Notes'? This can't be undone." confirmLabel="Delete" onConfirm={vi.fn(async () => {})} onCancel={vi.fn()} />);

    expect(screen.getByRole('alertdialog', { name: "Delete 'Notes'? This can't be undone." })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus();
  });

  it('Escape and Cancel call onCancel; Tab keeps focus inside', async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    render(<ConfirmDialog title="Delete project 'Alpha'?" message="Its chats move to No project." confirmLabel="Delete" onConfirm={vi.fn(async () => {})} onCancel={onCancel} />);

    expect(screen.getByRole('alertdialog')).toHaveAccessibleDescription('Its chats move to No project.');
    await user.keyboard('{Tab}');
    expect(screen.getByRole('button', { name: 'Delete' })).toHaveFocus();
    await user.keyboard('{Tab}');
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(onCancel).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalledTimes(2);
  });

  it('runs onConfirm once even when clicked twice, and shows a failure without closing', async () => {
    const user = userEvent.setup();
    let reject!: (err: Error) => void;
    const onConfirm = vi.fn(() => new Promise<void>((_resolve, r) => { reject = r; }));
    render(<ConfirmDialog title="Delete?" confirmLabel="Delete" onConfirm={onConfirm} onCancel={vi.fn()} />);

    const button = screen.getByRole('button', { name: 'Delete' });
    await user.click(button);
    await user.click(button);
    expect(onConfirm).toHaveBeenCalledTimes(1);

    await act(async () => reject(new ApiError(500, 'Server said no')));
    expect(await screen.findByRole('alert')).toHaveTextContent('Server said no');
    expect(button).toBeEnabled();
  });
});
