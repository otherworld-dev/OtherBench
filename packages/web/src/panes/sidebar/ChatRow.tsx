import type { JSX } from 'react';
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
}

/** One chat in the sidebar: select it, drag it onto a group heading, or open its menu. */
export function ChatRow({ chat, active, onSelect, onDragEnd, menuOpen = false, renaming = false, muted = false, onOpenMenu, onRename, onRenameCancel }: ChatRowProps): JSX.Element {
  if (renaming && onRename && onRenameCancel) {
    return (
      <li data-testid={`chat-row-${chat.id}`} className="px-1 py-0.5">
        <InlineNameInput initial={chat.title} label="Chat title" onCommit={onRename} onCancel={onRenameCancel} />
      </li>
    );
  }

  return (
    <li data-testid={`chat-row-${chat.id}`} className="group flex items-center gap-0.5">
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
        className={`min-w-0 flex-1 truncate rounded px-2 py-1.5 text-left text-sm ${
          active ? 'bg-[var(--accent)] text-[var(--accent-text)]' : `${muted ? 'text-[var(--text-muted)]' : 'text-[var(--text)]'} hover:bg-[var(--bg-sunken)]`
        }`}
      >
        {chat.pinned && (
          <span className="mr-1" aria-hidden="true">
            📌
          </span>
        )}
        {chat.title}
      </button>
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
