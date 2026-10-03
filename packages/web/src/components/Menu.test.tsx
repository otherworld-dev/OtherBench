import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Menu, type MenuItem } from './Menu.js';

afterEach(cleanup);

function items(calls: string[] = []): MenuItem[] {
  return [
    { id: 'rename', label: 'Rename', onSelect: () => calls.push('rename') },
    { id: 'pin', label: 'Pin', disabled: true },
    {
      id: 'move',
      label: 'Move to project…',
      submenu: [
        { id: 'a', label: 'Alpha', checked: false, onSelect: () => calls.push('move:a') },
        { id: 'b', label: 'Beta', checked: true, onSelect: () => calls.push('move:b') },
      ],
    },
    { id: 'delete', label: 'Delete…', danger: true, onSelect: () => calls.push('delete') },
  ];
}

describe('Menu', () => {
  it('focuses the first enabled item; arrows, Home and End move between enabled items and wrap', async () => {
    const user = userEvent.setup();
    render(<Menu label="Chat actions" items={items()} position={{ x: 0, y: 0 }} onClose={vi.fn()} />);

    expect(screen.getByRole('menu', { name: 'Chat actions' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Rename' })).toHaveFocus();
    await user.keyboard('{ArrowDown}');
    expect(screen.getByRole('menuitem', { name: 'Move to project…' })).toHaveFocus(); // Pin is disabled
    await user.keyboard('{ArrowDown}');
    expect(screen.getByRole('menuitem', { name: 'Delete…' })).toHaveFocus();
    await user.keyboard('{ArrowDown}');
    expect(screen.getByRole('menuitem', { name: 'Rename' })).toHaveFocus();
    await user.keyboard('{ArrowUp}');
    expect(screen.getByRole('menuitem', { name: 'Delete…' })).toHaveFocus();
    await user.keyboard('{Home}');
    expect(screen.getByRole('menuitem', { name: 'Rename' })).toHaveFocus();
    await user.keyboard('{End}');
    expect(screen.getByRole('menuitem', { name: 'Delete…' })).toHaveFocus();
  });

  it('Enter on an item closes with "select" first, then runs the action', async () => {
    const user = userEvent.setup();
    const calls: string[] = [];
    render(<Menu label="Chat actions" items={items(calls)} position={{ x: 0, y: 0 }} onClose={(reason) => calls.push(`close:${reason}`)} />);

    await user.keyboard('{Enter}');

    expect(calls).toEqual(['close:select', 'rename']);
  });

  it('ArrowRight opens a submenu on its current choice, ArrowLeft goes back, and choosing in it runs that action', async () => {
    const user = userEvent.setup();
    const calls: string[] = [];
    render(<Menu label="Chat actions" items={items(calls)} position={{ x: 0, y: 0 }} onClose={vi.fn()} />);

    screen.getByRole('menuitem', { name: 'Move to project…' }).focus();
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('menu', { name: 'Move to project…' })).toBeInTheDocument();
    expect(screen.getByRole('menuitemradio', { name: 'Beta' })).toHaveFocus();
    expect(screen.getByRole('menuitemradio', { name: 'Beta' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('menuitemradio', { name: 'Alpha' })).toHaveAttribute('aria-checked', 'false');

    await user.keyboard('{ArrowLeft}');
    expect(screen.queryByRole('menuitemradio', { name: 'Beta' })).toBeNull();
    expect(screen.getByRole('menuitem', { name: 'Move to project…' })).toHaveFocus();

    await user.keyboard('{ArrowRight}{ArrowUp}{Enter}');
    expect(calls).toEqual(['move:a']);
  });

  it('Escape and Tab dismiss', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<Menu label="Chat actions" items={items()} position={{ x: 0, y: 0 }} onClose={onClose} />);

    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenLastCalledWith('dismiss');
    await user.keyboard('{Tab}');
    expect(onClose).toHaveBeenCalledTimes(2);
    expect(onClose).toHaveBeenLastCalledWith('dismiss');
  });

  it('a pointerdown outside or a scroll dismisses; a pointerdown inside does not', () => {
    const onClose = vi.fn();
    render(<Menu label="Chat actions" items={items()} position={{ x: 0, y: 0 }} onClose={onClose} />);

    fireEvent.pointerDown(screen.getByRole('menuitem', { name: 'Rename' }));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.pointerDown(document.body);
    expect(onClose).toHaveBeenCalledWith('dismiss');

    onClose.mockClear();
    fireEvent.scroll(window);
    expect(onClose).toHaveBeenCalledWith('dismiss');
  });
});
