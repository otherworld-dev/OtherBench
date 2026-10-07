import type { DragEvent, JSX } from 'react';
import type { Chat } from '@grunt/core/ports/store.js';
import { InlineNameInput } from '../../components/InlineNameInput.js';

/** `dataTransfer` type a dragged chat row carries; its value is the chat id. */
export const CHAT_DRAG_MIME = 'application/x-grunt-chat';

/** Where a menu was opened from: the ⋯ button toggles, the context gestures always open. */
export type MenuSource = 'button' | 'context';

/** The keyboard's "open the context menu" gestures: the ContextMenu key, or Shift+F10. */
export function isContextMenuKey(e: { key: string; shiftKey: boolean }): boolean {
  return e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10');
}

/** Which half of a row a dragged chat is over: it would be dropped above (`before`) or below (`after`) it. */
export type DropPosition = 'before' | 'after';

/** Reordering by drag (#823): the row is a drop target for other chats. */
export interface RowReorder {
  /** The line shown while a chat is dragged over this row, or null. */
  indicator: DropPosition | null;
  onOver: (position: DropPosition) => void;
  onLeave: () => void;
  onDrop: (chatId: string, position: DropPosition) => void;
}

function carriesChat(e: DragEvent): boolean {
  return Array.from(e.dataTransfer.types).includes(CHAT_DRAG_MIME);
}

function positionIn(e: DragEvent<HTMLElement>): DropPosition {
  const r = e.currentTarget.getBoundingClientRect();
  return e.clientY < r.top + r.height / 2 ? 'before' : 'after';
}

export interface ChatRowProps {
  chat: Chat;
  active: boolean;
  onSelect: () => void;
  onDragEnd: () => void;
  menuOpen?: boolean;
  renaming?: boolean;
  /** Archived chats in the "Show archived" section: dimmed. */
  muted?: boolean;
  /** Right-click, Shift+F10 / the ContextMenu key, or the ⋯ button. Without it the row has no menu. */
  onOpenMenu?: (position: { x: number; y: number }, source: MenuSource) => void;
  onRename?: (title: string) => void;
  onRenameCancel?: () => void;
  /** Present when chats can be dropped onto this row to reorder; absent for archived rows and while searching. */
  reorder?: RowReorder;
}

/** One chat in the sidebar: select it, drag it onto a group heading or between other chats, or open its menu. */
export function ChatRow({ chat, active, onSelect, onDragEnd, menuOpen = false, renaming = false, muted = false, onOpenMenu, onRename, onRenameCancel, reorder }: ChatRowProps): JSX.Element {
  if (renaming && onRename && onRenameCancel) {
    return (
      <li data-testid={`chat-row-${chat.id}`} className="px-1 py-0.5">
        <InlineNameInput initial={chat.title} label="Chat title" onCommit={onRename} onCancel={onRenameCancel} />
      </li>
    );
  }

  return (
    <li
      data-testid={`chat-row-${chat.id}`}
      data-drop-position={reorder?.indicator ?? undefined}
      onDragOver={
        reorder
          ? (e) => {
              if (!carriesChat(e)) return;
              e.preventDefault();
              e.dataTransfer.dropEffect = 'move';
              const position = positionIn(e);
              if (position !== reorder.indicator) reorder.onOver(position);
            }
          : undefined
      }
      onDragLeave={
        reorder
          ? (e) => {
              if (e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget)) return;
              reorder.onLeave();
            }
          : undefined
      }
      onDrop={
        reorder
          ? (e) => {
              const chatId = e.dataTransfer.getData(CHAT_DRAG_MIME);
              const position = positionIn(e);
              reorder.onLeave();
              if (!chatId) return;
              e.preventDefault();
              reorder.onDrop(chatId, position);
            }
          : undefined
      }
      className={`group flex items-center gap-0.5 rounded ${
        reorder?.indicator === 'before'
          ? 'shadow-[inset_0_2px_0_var(--accent)]'
          : reorder?.indicator === 'after'
            ? 'shadow-[inset_0_-2px_0_var(--accent)]'
            : ''
      }`}
    >
      <button
        type="button"
        data-row-main=""
        draggable={!muted}
        onDragStart={(e) => {
          e.dataTransfer.setData(CHAT_DRAG_MIME, chat.id);
          e.dataTransfer.effectAllowed = 'move';
        }}
        onDragEnd={onDragEnd}
        onClick={onSelect}
        onContextMenu={
          onOpenMenu
            ? (e) => {
                e.preventDefault();
                onOpenMenu({ x: e.clientX, y: e.clientY }, 'context');
              }
            : undefined
        }
        onKeyDown={
          onOpenMenu
            ? (e) => {
                if (!isContextMenuKey(e)) return;
                e.preventDefault();
                const r = e.currentTarget.getBoundingClientRect();
                onOpenMenu({ x: r.left + 16, y: r.bottom }, 'context');
              }
            : undefined
        }
        aria-current={active ? 'true' : undefined}
        className={`min-w-0 flex-1 truncate px-2 py-1.5 text-left text-sm ${
          active
            ? 'rounded-r-sm bg-[var(--bg)] text-[var(--text)] shadow-[inset_2px_0_0_var(--accent)]'
            : `rounded-sm ${muted ? 'text-[var(--text-muted)]' : 'text-[var(--text)]'} hover:bg-[var(--bg-sunken)]`
        }`}
      >
        {chat.pinned && (
          <span className="mr-1" aria-hidden="true">
            📌
          </span>
        )}
        {chat.title}
      </button>
      {chat.memoryExcluded && chat.projectId !== null && (
        <span
          data-testid="memory-excluded-marker"
          role="img"
          aria-label="Not added to project memory"
          title="Not added to project memory"
          className="shrink-0 px-0.5 text-xs text-[var(--text-faint)]"
        >
          ⊘
        </span>
      )}
      {onOpenMenu && (
        <button
          type="button"
          aria-label="Chat actions"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          title="Chat actions"
          // Keep the open menu's outside-click handler from closing it first, so ⋯ toggles.
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            onOpenMenu({ x: r.left, y: r.bottom }, 'button');
          }}
          className={`shrink-0 rounded px-1.5 py-1 text-sm text-[var(--text-muted)] group-hover:opacity-100 hover:bg-[var(--bg-sunken)] focus-visible:opacity-100 ${
            menuOpen ? 'opacity-100' : 'opacity-0'
          }`}
        >
          ⋯
        </button>
      )}
    </li>
  );
}
