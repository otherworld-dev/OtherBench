import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createRef } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FindBar, findStatus } from './FindBar.js';

describe('findStatus', () => {
  it('says where you are among the matches, in plain words', () => {
    expect(findStatus('', -1, 0)).toBe('');
    expect(findStatus('x', -1, 0)).toBe('No matches');
    expect(findStatus('x', 2, 12)).toBe('3 of 12');
    expect(findStatus('x', -1, 1)).toBe('1 match');
    expect(findStatus('x', -1, 4)).toBe('4 matches');
  });
});

describe('FindBar', () => {
  afterEach(cleanup);

  function bar(over: Partial<Parameters<typeof FindBar>[0]> = {}) {
    const props = { query: 'cat', current: 0, total: 2, onQueryChange: vi.fn(), onStep: vi.fn(), onClose: vi.fn(), inputRef: createRef<HTMLInputElement>(), ...over };
    render(<FindBar {...props} />);
    return props;
  }

  it('takes the focus with its text selected when it opens', () => {
    bar();
    const box = screen.getByRole<HTMLInputElement>('textbox', { name: 'Find in this chat' });
    expect(box).toHaveFocus();
    expect([box.selectionStart, box.selectionEnd]).toEqual([0, 3]);
  });

  it('goes on with Enter, back with Shift+Enter, and closes with Escape', async () => {
    const props = bar();
    const user = userEvent.setup();
    await user.keyboard('{Enter}');
    expect(props.onStep).toHaveBeenLastCalledWith(1);
    await user.keyboard('{Shift>}{Enter}{/Shift}');
    expect(props.onStep).toHaveBeenLastCalledWith(-1);
    await user.keyboard('{Escape}');
    expect(props.onClose).toHaveBeenCalled();
  });

  it('has no next or previous with nothing to go to', () => {
    bar({ total: 0, current: -1 });
    expect(screen.getByRole('button', { name: 'Next match' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Previous match' })).toBeDisabled();
    expect(screen.getByRole('status', { name: 'Matches' })).toHaveTextContent('No matches');
  });
});
