import type { DragEvent, JSX } from 'react';
import type { Chat } from '@otherbench/core/ports/store.js';
import { PinIcon } from '../../components/icons.js';
import { InlineNameInput } from '../../components/InlineNameInput.js';
import { StatusWord } from '../../components/StatusWord.js';
import { formatAge, formatRelativeTime } from '../../lib/relativeTime.js';
import type { ChatStatus } from '../../state/chatStatus.js';

/** `dataTransfer` type a dragged chat row carries; its value is the chat id. */
export const CHAT_DRAG_MIME = 'application/x-otherbench-chat';

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

/** Which half of the element under a drag the pointer is in: a drop there lands above (`before`) or below (`after`) it. */
export function positionIn(e: DragEvent<HTMLElement>): DropPosition {
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
  /** Shows the hover pin button. Absent for archived rows (the menu has no Pin for them either). */
  onTogglePin?: () => void;
  /** Shows the pin icon before a pinned chat's title; off inside the Pinned section, whose heading says it. */
  showPinMarker?: boolean;
  /** Shows an outline pin before the title: the chat is pinned at the top of its project. */
  projectPinMarker?: boolean;
  /** Shown faint after the title: the chat's project, for rows in Pinned, which sits outside the project groups. */
  projectName?: string;
  /** A drag of this row has started (ChatList shows the empty Pinned drop zone). */
  onDragStart?: () => void;
  /** The word at the end of the row, in place of the age. */
  status?: ChatStatus | null;
  /** A row in the Needs you list: tinted, bold and not draggable, since its place there isn't the user's to choose. */
  needsYou?: boolean;
  /** Shows the hover tick: there is nothing to do here. Absent while a card waits, which only answering clears. */
  onTick?: () => void;
  /** The current time: shows the chat's age ("3h") from its last activity at the end of the row. */
  now?: number;
}

/**
 * One chat in the sidebar: select it, drag it onto a group heading or between
 * other chats, pin it, or open its menu. The title takes the whole row; the
 * pin and ⋯ buttons sit over its end only on hover, keyboard focus, or while
 * the menu is open (not mouse focus: clicking a row focuses it, and the
 * buttons would then stay over its title).
 */
export function ChatRow(props: ChatRowProps): JSX.Element {
  const { chat, active, onSelect, onDragEnd, menuOpen = false, renaming = false, muted = false, onOpenMenu, onRename, onRenameCancel, reorder } = props;
  const { onTogglePin, showPinMarker = false, projectPinMarker = false, projectName, onDragStart, status = null, needsYou = false, onTick, now } = props;
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
      className={`group relative flex items-center rounded ${needsYou ? 'bg-[var(--warn)]/10' : ''} ${
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
        draggable={!muted && !needsYou}
        onDragStart={(e) => {
          e.dataTransfer.setData(CHAT_DRAG_MIME, chat.id);
          e.dataTransfer.effectAllowed = 'move';
          onDragStart?.();
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
        className={`flex min-w-0 flex-1 items-center gap-1 px-2 py-[3px] text-left text-sm ${
          active
            ? 'rounded-r-sm bg-[var(--bg)] text-[var(--text)] shadow-[inset_2px_0_0_var(--accent)]'
            : `rounded-sm ${muted ? 'text-[var(--text-muted)]' : 'text-[var(--text)]'} hover:bg-[var(--bg-sunken)]`
        }`}
      >
        {showPinMarker && chat.pinned && (
          <span data-testid="pin-marker" className="shrink-0 text-[var(--text-muted)]">
            <PinIcon filled className="h-3 w-3" />
          </span>
        )}
        {projectPinMarker && (
          <span data-testid="project-pin-marker" title="Pinned in project" className="shrink-0 text-[var(--text-muted)]">
            <PinIcon className="h-3 w-3" />
          </span>
        )}
        <span className={`min-w-0 truncate ${needsYou ? 'font-medium' : ''}`}>{chat.title}</span>
        {projectName && (
          <span data-testid="row-project-name" className={`ml-auto max-w-[45%] truncate pl-2 text-xs text-[var(--text-faint)] ${needsYou ? 'min-w-8 shrink-[9]' : 'shrink-0'}`}>
            <span className="sr-only">, in</span> {projectName}
          </span>
        )}
      </button>
      {/* Beside the button, not in it: a button's children are presentational, so a screen reader would skip them. */}
      {status ? <StatusWord status={status} testId={`chat-status-${chat.id}`} className="mx-1" /> : now !== undefined && (
        <span
          data-testid="row-age"
          title={`Last active ${new Date(chat.updatedAt).toLocaleString()}`}
          className="shrink-0 pr-1.5 pl-1 text-xs tabular-nums text-[var(--text-faint)]"
        >
          <span aria-hidden="true">{formatAge(chat.updatedAt, now)}</span>
          <span className="sr-only">Last active {formatRelativeTime(chat.updatedAt, now)}</span>
        </span>
      )}
      {chat.memoryExcluded && (
        <span
          data-testid="memory-excluded-marker"
          role="img"
          aria-label="Not added to memory"
          title="Not added to memory"
          className="shrink-0 px-1 text-xs text-[var(--text-faint)]"
        >
          ⊘
        </span>
      )}
      {(onTick || onTogglePin || onOpenMenu) && (
        <div
          data-row-actions=""
          className={`absolute inset-y-0 right-0 flex items-center gap-0.5 rounded-r-sm pr-0.5 pl-3 ${
            active ? 'bg-[linear-gradient(to_right,transparent,var(--bg)_0.75rem)]' : 'bg-[linear-gradient(to_right,transparent,var(--bg-sunken)_0.75rem)]'
          } ${
            menuOpen
              ? 'opacity-100'
              : 'pointer-events-none opacity-0 group-hover:pointer-events-auto group-hover:opacity-100 group-has-[:focus-visible]:pointer-events-auto group-has-[:focus-visible]:opacity-100'
          }`}
        >
          {onTick && (
            <button
              type="button"
              aria-label="Nothing to do here"
              title="Nothing to do here"
              onClick={onTick}
              className="rounded px-1.5 py-0.5 text-xs leading-none text-[var(--text-muted)] hover:bg-[var(--bg-raised)] hover:text-[var(--text)]"
            >
              ✓
            </button>
          )}
          {onTogglePin && (
            <button
              type="button"
              aria-label={chat.pinned ? 'Unpin chat' : 'Pin chat'}
              title={chat.pinned ? 'Unpin chat' : 'Pin chat'}
              onClick={onTogglePin}
              className={`rounded p-1 hover:bg-[var(--bg-raised)] ${chat.pinned ? 'text-[var(--accent)]' : 'text-[var(--text-muted)] hover:text-[var(--text)]'}`}
            >
              <PinIcon filled={chat.pinned} />
            </button>
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
              className="rounded px-1.5 py-0.5 text-sm leading-none text-[var(--text-muted)] hover:bg-[var(--bg-raised)] hover:text-[var(--text)]"
            >
              ⋯
            </button>
          )}
        </div>
      )}
    </li>
  );
}
