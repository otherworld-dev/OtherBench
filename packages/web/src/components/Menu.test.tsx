import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Menu, type MenuItem } from './Menu.js';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

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

/** Waits for the next animation frame, when an open menu starts listening for scrolls. */
function nextFrame(): Promise<void> {
  return act(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
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

  it('a pointerdown outside (reason pointer) or a scroll dismisses; a pointerdown inside does not', async () => {
    const onClose = vi.fn();
    render(<Menu label="Chat actions" items={items()} position={{ x: 0, y: 0 }} onClose={onClose} />);

    fireEvent.pointerDown(screen.getByRole('menuitem', { name: 'Rename' }));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.pointerDown(document.body);
    expect(onClose).toHaveBeenCalledWith('pointer');

    onClose.mockClear();
    await nextFrame();
    fireEvent.scroll(window);
    expect(onClose).toHaveBeenCalledWith('dismiss');
  });

  it("ignores the scroll left over from the click that opened it, which the browser sends a frame late", async () => {
    // Right-clicking a row half out of view scrolls the list to it, and that scroll event arrives after the menu is open.
    const onClose = vi.fn();
    render(<Menu label="Chat actions" items={items()} position={{ x: 0, y: 0 }} onClose={onClose} />);
    fireEvent.scroll(screen.getByRole('menuitem', { name: 'Rename' }).ownerDocument);
    expect(onClose).not.toHaveBeenCalled();

    await nextFrame();
    fireEvent.scroll(document);
    expect(onClose).toHaveBeenCalledWith('dismiss');
  });

  it('Space chooses an item', async () => {
    const user = userEvent.setup();
    const calls: string[] = [];
    render(<Menu label="Chat actions" items={items(calls)} position={{ x: 0, y: 0 }} onClose={(r) => calls.push(`close:${r}`)} />);

    await user.keyboard(' ');

    expect(calls).toEqual(['close:select', 'rename']);
  });

  it('scrolling inside the menu does not dismiss, scrolling the page does', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<Menu label="Chat actions" items={items()} position={{ x: 0, y: 0 }} onClose={onClose} />);
    screen.getByRole('menuitem', { name: 'Move to project…' }).focus();
    await user.keyboard('{ArrowRight}');

    fireEvent.scroll(screen.getByRole('menu', { name: 'Move to project…' }));
    fireEvent.scroll(screen.getByRole('menu', { name: 'Chat actions' }));
    expect(onClose).not.toHaveBeenCalled();

    await nextFrame();
    fireEvent.scroll(document);
    expect(onClose).toHaveBeenCalledWith('dismiss');
  });

  describe('edges', () => {
    function stubRects(rects: Record<string, Partial<DOMRect>>): void {
      vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
        const r = rects[this.getAttribute('aria-label') ?? this.firstElementChild?.getAttribute('aria-label') ?? ''] ?? {};
        return { x: 0, y: 0, left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON: () => ({}), ...r } as DOMRect;
      });
    }

    beforeEach(() => {
      vi.stubGlobal('innerWidth', 1000);
      vi.stubGlobal('innerHeight', 700);
    });
    afterEach(() => vi.unstubAllGlobals());

    it('clamps the root inside the viewport using its natural size, and again on resize', () => {
      stubRects({ 'Chat actions': { width: 200, height: 100 } });
      render(<Menu label="Chat actions" items={items()} position={{ x: 950, y: 690 }} onClose={vi.fn()} />);
      const root = screen.getByRole('menu', { name: 'Chat actions' }).parentElement as HTMLElement;

      expect(root.className).toContain('w-max');
      expect(root.style.left).toBe('800px');
      expect(root.style.top).toBe('600px');

      vi.stubGlobal('innerWidth', 600);
      fireEvent(window, new Event('resize'));
      expect(root.style.left).toBe('400px');
    });

    it('opens a submenu to the left and up when it would overflow the right and bottom edges', async () => {
      const user = userEvent.setup();
      stubRects({ 'Move to project…': { left: 900, right: 1100, top: 600, bottom: 800, width: 200, height: 200 } });
      render(<Menu label="Chat actions" items={items()} position={{ x: 0, y: 0 }} onClose={vi.fn()} />);
      screen.getByRole('menuitem', { name: 'Move to project…' }).focus();
      await user.keyboard('{ArrowRight}');

      const sub = screen.getByRole('menu', { name: 'Move to project…' });
      expect(sub.className).toContain('right-full');
      expect(sub.className).not.toContain('left-full');
      expect(sub.style.top).toBe('-100px');
    });

    it('keeps a submenu on the right when it fits', async () => {
      const user = userEvent.setup();
      stubRects({ 'Move to project…': { left: 100, right: 300, top: 10, bottom: 200, width: 200, height: 190 } });
      render(<Menu label="Chat actions" items={items()} position={{ x: 0, y: 0 }} onClose={vi.fn()} />);
      screen.getByRole('menuitem', { name: 'Move to project…' }).focus();
      await user.keyboard('{ArrowRight}');

      const sub = screen.getByRole('menu', { name: 'Move to project…' });
      expect(sub.className).toContain('left-full');
    });
  });
});
