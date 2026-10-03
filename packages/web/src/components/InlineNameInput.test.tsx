import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InlineNameInput } from './InlineNameInput.js';

afterEach(cleanup);

function setup(initial = 'Old') {
  const onCommit = vi.fn();
  const onCancel = vi.fn();
  const utils = render(<InlineNameInput initial={initial} label="Chat title" onCommit={onCommit} onCancel={onCancel} />);
  return { ...utils, onCommit, onCancel, user: userEvent.setup(), input: screen.getByRole('textbox', { name: 'Chat title' }) as HTMLInputElement };
}

describe('InlineNameInput', () => {
  it('starts focused on the current text', () => {
    const { input } = setup();
    expect(input).toHaveFocus();
    expect(input).toHaveValue('Old');
  });

  it('Enter commits the trimmed text once, even with a second Enter and the blur that follows', async () => {
    const { input, user, onCommit, onCancel } = setup();
    await user.clear(input);
    await user.type(input, '  New name  {Enter}{Enter}');
    await user.tab();

    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith('New name');
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('Escape cancels without committing', async () => {
    const { input, user, onCommit, onCancel } = setup();
    await user.type(input, 'xyz{Escape}');
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('Enter on an empty field is refused: nothing is called and the field is marked invalid until edited', async () => {
    const { input, user, onCommit, onCancel } = setup();
    await user.clear(input);
    await user.keyboard('{Enter}');

    expect(onCommit).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
    expect(input).toHaveAttribute('aria-invalid', 'true');
    await user.type(input, 'a');
    expect(input).not.toHaveAttribute('aria-invalid');
  });

  it('Enter with the text unchanged cancels instead of committing', async () => {
    const { user, onCommit, onCancel } = setup();
    await user.keyboard('{Enter}');
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('losing focus commits a valid change and cancels an empty one', async () => {
    const first = setup();
    await first.user.clear(first.input);
    await first.user.type(first.input, 'Via blur');
    await first.user.tab();
    expect(first.onCommit).toHaveBeenCalledWith('Via blur');
    cleanup();

    const second = setup();
    await second.user.clear(second.input);
    await second.user.tab();
    expect(second.onCancel).toHaveBeenCalledTimes(1);
    expect(second.onCommit).not.toHaveBeenCalled();
  });

  it('keeps what the user typed when `initial` changes underneath it', async () => {
    const { input, user, rerender, onCommit, onCancel } = setup();
    await user.clear(input);
    await user.type(input, 'Mine');

    rerender(<InlineNameInput initial="Auto title" label="Chat title" onCommit={onCommit} onCancel={onCancel} />);

    expect(input).toHaveValue('Mine');
  });
});
