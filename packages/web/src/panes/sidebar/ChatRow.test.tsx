import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Chat } from '@grunt/core/ports/store.js';
import { CHAT_DRAG_MIME, ChatRow, type ChatRowProps } from './ChatRow.js';

afterEach(cleanup);

const chat: Chat = { id: 'chat-1', title: 'Notes', profileId: 'p', headMessageId: null, workspaceRoot: null, pinned: false, archivedAt: null, autoMode: false, projectId: null, memoryCursor: null, memoryExcluded: false, sortOrder: 0, createdAt: 1, updatedAt: 1 };

function renderRow(props: Partial<ChatRowProps> = {}) {
  const handlers = { onSelect: vi.fn(), onDragEnd: vi.fn(), onOpenMenu: vi.fn(), onRename: vi.fn(), onRenameCancel: vi.fn() };
  render(
    <ul>
      <ChatRow chat={chat} active={false} {...handlers} {...props} />
    </ul>
  );
  return handlers;
}

describe('ChatRow', () => {
  it('marks a project chat that is not added to project memory, without changing the row name', () => {
    render(
      <ul>
        <ChatRow chat={{ ...chat, projectId: 'p-a', memoryExcluded: true }} active={false} onSelect={vi.fn()} onDragEnd={vi.fn()} />
      </ul>
    );
    expect(screen.getByRole('img', { name: 'Not added to project memory' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Notes' })).toBeInTheDocument();
    cleanup();

    renderRow();
    expect(screen.queryByTestId('memory-excluded-marker')).toBeNull();
  });

  it('selects on click and marks the active row', async () => {
    const h = renderRow({ active: true });
    await userEvent.setup().click(screen.getByRole('button', { name: 'Notes' }));
    expect(h.onSelect).toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Notes' })).toHaveAttribute('aria-current', 'true');
  });

  it('opens the menu from a right-click at the pointer, from Shift+F10 or the context-menu key, and from ⋯', async () => {
    const h = renderRow();
    const row = screen.getByRole('button', { name: 'Notes' });

    fireEvent.contextMenu(row, { clientX: 40, clientY: 50 });
    expect(h.onOpenMenu).toHaveBeenLastCalledWith({ x: 40, y: 50 }, 'context');

    fireEvent.keyDown(row, { key: 'F10', shiftKey: true });
    expect(h.onOpenMenu).toHaveBeenLastCalledWith(expect.objectContaining({ x: expect.any(Number), y: expect.any(Number) }), 'context');
    fireEvent.keyDown(row, { key: 'ContextMenu' });
    expect(h.onOpenMenu).toHaveBeenCalledTimes(3);
    fireEvent.keyDown(row, { key: 'F10' }); // without Shift: not the gesture
    expect(h.onOpenMenu).toHaveBeenCalledTimes(3);

    await userEvent.setup().click(screen.getByRole('button', { name: 'Chat actions' }));
    expect(h.onOpenMenu).toHaveBeenLastCalledWith(expect.any(Object), 'button');
  });

  it('has no ⋯ button and ignores the menu gestures when no onOpenMenu is given', () => {
    render(
      <ul>
        <ChatRow chat={chat} active={false} onSelect={vi.fn()} onDragEnd={vi.fn()} />
      </ul>
    );
    expect(screen.queryByRole('button', { name: 'Chat actions' })).toBeNull();
    expect(fireEvent.contextMenu(screen.getByRole('button', { name: 'Notes' }))).toBe(true); // not prevented: the browser menu shows
  });

  it('is draggable unless muted (archived rows are not)', () => {
    renderRow();
    expect(screen.getByRole('button', { name: 'Notes' })).toHaveAttribute('draggable', 'true');
    cleanup();
    renderRow({ muted: true });
    expect(screen.getByRole('button', { name: 'Notes' })).not.toHaveAttribute('draggable', 'true');
  });

  it('starts a chat drag carrying its id', () => {
    renderRow();
    const dataTransfer = { setData: vi.fn(), effectAllowed: 'all' };
    fireEvent.dragStart(screen.getByRole('button', { name: 'Notes' }), { dataTransfer });
    expect(dataTransfer.setData).toHaveBeenCalledWith(CHAT_DRAG_MIME, 'chat-1');
    expect(dataTransfer.effectAllowed).toBe('move');
  });

  it('shows the rename field instead of the buttons while renaming', () => {
    renderRow({ renaming: true });
    expect(screen.getByRole('textbox', { name: 'Chat title' })).toHaveValue('Notes');
    expect(screen.queryByRole('button')).toBeNull();
  });
});
