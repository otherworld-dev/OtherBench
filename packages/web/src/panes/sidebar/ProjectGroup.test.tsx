import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CHAT_DRAG_MIME } from './ChatRow.js';
import { ProjectGroup, type ProjectGroupProps } from './ProjectGroup.js';

afterEach(cleanup);

function renderGroup(props: Partial<ProjectGroupProps> = {}) {
  const handlers = { onToggle: vi.fn(), onDragTarget: vi.fn(), onDropChat: vi.fn() };
  render(
    <ProjectGroup groupKey="p-a" name="Alpha" count={2} empty={false} collapsed={false} dropActive={false} {...handlers} {...props}>
      <li>row</li>
    </ProjectGroup>
  );
  return handlers;
}

function dataTransfer(types: string[], chatId = '') {
  return { types, getData: (type: string) => (type === CHAT_DRAG_MIME ? chatId : ''), dropEffect: 'none' };
}

describe('ProjectGroup', () => {
  it('is a named group whose heading button toggles, with aria-expanded and the chat count', async () => {
    const h = renderGroup();
    expect(screen.getByRole('group', { name: 'Alpha' })).toBeInTheDocument();
    const heading = screen.getByRole('button', { name: /^Alpha/ });
    expect(heading).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByTestId('group-count-p-a')).toHaveTextContent('2');
    expect(screen.getByText('row')).toBeInTheDocument();
    await userEvent.setup().click(heading);
    expect(h.onToggle).toHaveBeenCalled();
  });

  it('wraps the heading button in an h3 so heading navigation finds the group', () => {
    renderGroup();
    const h3 = screen.getByRole('heading', { level: 3 });
    expect(within(h3).getByRole('button', { name: /^Alpha/ })).toHaveAttribute('aria-expanded', 'true');
  });

  it("shows its chats' status on the heading, open or collapsed, and says it in the heading button", () => {
    renderGroup({ collapsed: true, status: 'ready' });
    expect(screen.getByTestId('group-status-p-a')).toHaveAttribute('data-status', 'ready');
    expect(screen.getByRole('button', { name: /^Alpha.*reply ready/ })).toHaveAttribute('aria-expanded', 'false');
    cleanup();

    renderGroup({ collapsed: false, status: 'working' });
    expect(screen.getByTestId('group-status-p-a')).toHaveAttribute('data-status', 'working');
    expect(screen.getByRole('button', { name: /^Alpha.*replying/ })).toHaveAttribute('aria-expanded', 'true');
    cleanup();

    renderGroup({ collapsed: false, status: null });
    expect(screen.queryByTestId('group-status-p-a')).toBeNull();
  });

  it('hides its list when collapsed', () => {
    renderGroup({ collapsed: true });
    expect(screen.getByRole('button', { name: /^Alpha/ })).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('row')).toBeNull();
  });

  it('says "No chats yet" when empty', () => {
    renderGroup({ empty: true, count: 0 });
    expect(screen.getByText('No chats yet')).toBeInTheDocument();
  });

  it('shows + and ⋯ only when their handlers are given', async () => {
    renderGroup();
    expect(screen.queryByRole('button', { name: 'New chat in Alpha' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Project actions' })).toBeNull();
    cleanup();

    const onNewChat = vi.fn();
    const onOpenMenu = vi.fn();
    renderGroup({ onNewChat, onOpenMenu });
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'New chat in Alpha' }));
    await user.click(screen.getByRole('button', { name: 'Project actions' }));
    expect(onNewChat).toHaveBeenCalled();
    expect(onOpenMenu).toHaveBeenCalledWith(expect.any(Object), 'button');
  });

  it('right-click and Shift+F10 on the heading open the menu when there is one', () => {
    const onOpenMenu = vi.fn();
    renderGroup({ onOpenMenu });
    const heading = screen.getByRole('button', { name: /^Alpha/ });
    fireEvent.contextMenu(heading, { clientX: 5, clientY: 6 });
    expect(onOpenMenu).toHaveBeenLastCalledWith({ x: 5, y: 6 }, 'context');
    fireEvent.keyDown(heading, { key: 'F10', shiftKey: true });
    expect(onOpenMenu).toHaveBeenCalledTimes(2);
  });

  it('accepts a dragged chat on its heading and ignores other drags', () => {
    const h = renderGroup();
    const heading = screen.getByTestId('group-heading-p-a');

    fireEvent.dragOver(heading, { dataTransfer: dataTransfer(['Files']) });
    expect(h.onDragTarget).not.toHaveBeenCalled();

    fireEvent.dragOver(heading, { dataTransfer: dataTransfer([CHAT_DRAG_MIME], 'chat-9') });
    expect(h.onDragTarget).toHaveBeenLastCalledWith(true);
    fireEvent.drop(heading, { dataTransfer: dataTransfer([CHAT_DRAG_MIME], 'chat-9') });
    expect(h.onDragTarget).toHaveBeenLastCalledWith(false);
    expect(h.onDropChat).toHaveBeenCalledWith('chat-9');
  });

  it('marks the heading while it is the drop target', () => {
    renderGroup({ dropActive: true });
    expect(screen.getByTestId('group-heading-p-a')).toHaveAttribute('data-drop-active', 'true');
  });

  it('shows the rename field', () => {
    renderGroup({ renaming: true, onRename: vi.fn(), onRenameCancel: vi.fn() });
    expect(screen.getByRole('textbox', { name: 'Project name' })).toHaveValue('Alpha');
  });
});

describe('ProjectGroup with a page to open', () => {
  it('gives the arrow its own collapse button and makes the name open the page', async () => {
    const user = userEvent.setup();
    const onOpen = vi.fn();
    const h = renderGroup({ onOpen });
    const arrow = screen.getByRole('button', { name: 'Collapse Alpha' });
    expect(arrow).toHaveAttribute('aria-expanded', 'true');
    const name = screen.getByRole('button', { name: /^Alpha/ });
    expect(name).not.toHaveAttribute('aria-expanded');
    expect(name).toHaveAttribute('data-heading-main');

    await user.click(name);
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(h.onToggle).not.toHaveBeenCalled();
    await user.click(arrow);
    expect(h.onToggle).toHaveBeenCalledTimes(1);
  });

  it('names the arrow Expand when collapsed', () => {
    renderGroup({ onOpen: vi.fn(), collapsed: true });
    expect(screen.getByRole('button', { name: 'Expand Alpha' })).toHaveAttribute('aria-expanded', 'false');
  });

  it('keeps the menu gestures on the name', () => {
    const onOpenMenu = vi.fn();
    renderGroup({ onOpen: vi.fn(), onOpenMenu });
    fireEvent.contextMenu(screen.getByRole('button', { name: /^Alpha/ }));
    expect(onOpenMenu).toHaveBeenCalledWith(expect.anything(), 'context');
  });

  it('keeps the arrow out of the h3, so the heading reads as just the project, and says the name opens its page', () => {
    renderGroup({ onOpen: vi.fn() });
    const h3 = screen.getByRole('heading', { level: 3 });
    expect(h3).toHaveAccessibleName(/^Alpha/);
    expect(within(h3).queryByRole('button', { name: 'Collapse Alpha' })).toBeNull();
    expect(screen.getByRole('button', { name: /^Alpha/ })).toHaveAccessibleDescription('Open the project page');
  });

  it('marks the name current while its page is the focused tab', () => {
    renderGroup({ onOpen: vi.fn(), active: true });
    expect(screen.getByRole('button', { name: /^Alpha/ })).toHaveAttribute('aria-current', 'true');
  });
});
