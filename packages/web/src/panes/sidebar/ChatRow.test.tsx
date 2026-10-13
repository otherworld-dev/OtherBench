import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Chat } from '@grunt/core/ports/store.js';
import { CHAT_DRAG_MIME, ChatRow, type ChatRowProps } from './ChatRow.js';

afterEach(cleanup);

const chat: Chat = { id: 'chat-1', title: 'Notes', profileId: 'p', headMessageId: null, workspace: null, runsOn: 'node-self', workspaceRoot: null, pinned: false, projectPinned: false, unread: false, archivedAt: null, autoMode: false, projectId: null, memoryCursor: null, memoryExcluded: false, sortOrder: 0, createdAt: 1, updatedAt: 1 };

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
  it('marks a chat that is not added to memory, in a project or not, without changing the row name', () => {
    render(
      <ul>
        <ChatRow chat={{ ...chat, projectId: 'p-a', memoryExcluded: true }} active={false} onSelect={vi.fn()} onDragEnd={vi.fn()} />
        <ChatRow chat={{ ...chat, id: 'loose', projectId: null, memoryExcluded: true }} active={false} onSelect={vi.fn()} onDragEnd={vi.fn()} />
      </ul>
    );
    expect(screen.getAllByRole('img', { name: 'Not added to memory' })).toHaveLength(2);
    // Outside the button: a button's children are presentational, so inside it the marker isn't announced.
    expect(screen.getAllByRole('img', { name: 'Not added to memory' })[0]!.closest('button')).toBeNull();
    expect(screen.getAllByRole('button', { name: 'Notes' })).toHaveLength(2);
    cleanup();

    renderRow();
    expect(screen.queryByTestId('memory-excluded-marker')).toBeNull();
  });

  it('marks a reply ready in bold with a dot, announced beside the button; no status, no dot', () => {
    renderRow({ status: 'ready' });
    const dot = screen.getByRole('img', { name: 'reply ready' });
    expect(dot).toHaveAttribute('data-status', 'ready');
    expect(dot.closest('button')).toBeNull();
    expect(screen.getByText('Notes')).toHaveClass('font-medium');
    // The row's name stays the title.
    expect(screen.getByRole('button', { name: 'Notes' })).toBeInTheDocument();
    cleanup();

    renderRow();
    expect(screen.queryByTestId('chat-status-chat-1')).toBeNull();
    expect(screen.getByText('Notes')).not.toHaveClass('font-medium');
  });

  it('marks a chat replying, or waiting for an approval, with the same dots as its tab', () => {
    renderRow({ status: 'working' });
    expect(screen.getByRole('img', { name: 'replying' })).toHaveAttribute('data-status', 'working');
    expect(screen.getByText('Notes')).not.toHaveClass('font-medium');
    cleanup();

    renderRow({ status: 'waiting' });
    expect(screen.getByRole('img', { name: 'waiting for approval' })).toHaveAttribute('data-status', 'waiting');
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

  it("has a pin button labelled for the chat's state, only when onTogglePin is given", async () => {
    const onTogglePin = vi.fn();
    renderRow({ onTogglePin });
    await userEvent.setup().click(screen.getByRole('button', { name: 'Pin chat' }));
    expect(onTogglePin).toHaveBeenCalled();
    cleanup();
    renderRow({ chat: { ...chat, pinned: true }, onTogglePin });
    expect(screen.getByRole('button', { name: 'Unpin chat' })).toBeInTheDocument();
    cleanup();
    renderRow();
    expect(screen.queryByRole('button', { name: /pin chat/i })).toBeNull();
  });

  it('puts the pin button before ⋯ in tab order', () => {
    renderRow({ onTogglePin: vi.fn() });
    expect(screen.getAllByRole('button').map((b) => b.getAttribute('aria-label') ?? b.textContent)).toEqual(['Notes', 'Pin chat', 'Chat actions']);
  });

  it('shows the pin marker only for a pinned chat with showPinMarker', () => {
    renderRow({ chat: { ...chat, pinned: true }, showPinMarker: true });
    expect(screen.getByTestId('pin-marker')).toBeInTheDocument();
    cleanup();
    renderRow({ chat: { ...chat, pinned: true } });
    expect(screen.queryByTestId('pin-marker')).toBeNull();
    cleanup();
    renderRow({ showPinMarker: true });
    expect(screen.queryByTestId('pin-marker')).toBeNull();
  });

  it('shows an outline pin for a chat pinned in its project, when asked', () => {
    renderRow({ projectPinMarker: true });
    expect(screen.getByTestId('project-pin-marker')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Notes' })).toBeInTheDocument();
    cleanup();
    renderRow();
    expect(screen.queryByTestId('project-pin-marker')).toBeNull();
  });

  it('reports a drag starting', () => {
    const onDragStart = vi.fn();
    renderRow({ onDragStart });
    fireEvent.dragStart(screen.getByRole('button', { name: 'Notes' }), { dataTransfer: { setData: vi.fn(), effectAllowed: 'all' } });
    expect(onDragStart).toHaveBeenCalled();
  });

  it('shows the rename field instead of the buttons while renaming', () => {
    renderRow({ renaming: true });
    expect(screen.getByRole('textbox', { name: 'Chat title' })).toHaveValue('Notes');
    expect(screen.queryByRole('button')).toBeNull();
  });
});
