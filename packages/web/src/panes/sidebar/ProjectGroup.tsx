import type { DragEvent, JSX, ReactNode } from 'react';
import { PROJECT_NAME_MAX } from '@otherbench/core/domain/projects.js';
import { InlineNameInput } from '../../components/InlineNameInput.js';
import { STATUS_LABELS, StatusDot } from '../../components/StatusDot.js';
import type { ChatStatus } from '../../state/chatStatus.js';
import { groupDomId } from '../../state/sidebarGroups.js';
import { CHAT_DRAG_MIME, isContextMenuKey, positionIn, type DropPosition, type MenuSource } from './ChatRow.js';

/** `dataTransfer` type a dragged project heading carries; its value is the project id. */
export const PROJECT_DRAG_MIME = 'application/x-otherbench-project';

/**
 * Reordering projects by dragging their headings: this heading can be dragged,
 * and is a drop target while a sibling project is dragged (`target`).
 */
export interface ProjectReorder {
  /** Off while searching or filtering, as for chats. */
  draggable: boolean;
  onDragStart: () => void;
  onDragEnd: () => void;
  /** A sibling project is being dragged, so a drop here places it above or below this one. */
  target: boolean;
  /** The line shown while a sibling is dragged over this heading, or null. */
  indicator: DropPosition | null;
  onOver: (position: DropPosition) => void;
  onLeave: () => void;
  onDrop: (position: DropPosition) => void;
}

export interface ProjectGroupProps {
  groupKey: string;
  /** Heading text: the project's name, or "No project". */
  name: string;
  /** Unarchived chats in the group, pinned ones included. */
  count: number;
  /** No unarchived chats at all: shows "No chats yet". */
  empty: boolean;
  collapsed: boolean;
  dropActive: boolean;
  onToggle: () => void;
  onDragTarget: (active: boolean) => void;
  onDropChat: (chatId: string) => void;
  children: ReactNode;
  /** Projects only: the heading's + button. */
  onNewChat?: () => void;
  newChatDisabled?: boolean;
  menuOpen?: boolean;
  renaming?: boolean;
  /** The ⋯ button, a right-click or Shift+F10 on the heading. */
  onOpenMenu?: (position: { x: number; y: number }, source: MenuSource) => void;
  /** The ⋯ button's name. */
  menuLabel?: string;
  onRename?: (name: string) => void;
  onRenameCancel?: () => void;
  /** The most urgent status among the group's chats, shown on the heading whether it's open or collapsed. */
  status?: ChatStatus | null;
  /** The group's statuses counted ("2 replies ready · 1 replying"): the heading dot's hover text and what a screen reader hears. */
  statusSummary?: string;
  /** Projects only: the name opens the project's page, and the arrow alone collapses the group. */
  onOpen?: () => void;
  /** The project's page is the focused tab. */
  active?: boolean;
  /** Projects only: drag this heading to reorder it among its siblings. */
  reorder?: ProjectReorder;
  /** The rename field's name and length cap; an app heading (Code mode) passes its own. */
  renameLabel?: string;
  renameMaxLength?: number;
  /** The name's hover text when it opens a page. */
  openTitle?: string;
  /** What `count` counts: chats, or an app folder's apps (Code mode). */
  countNoun?: 'chat' | 'app';
  /** Shown under the heading when `empty`. */
  emptyText?: string;
}

function carriesChat(e: DragEvent): boolean {
  return Array.from(e.dataTransfer.types).includes(CHAT_DRAG_MIME);
}

function carriesProject(e: DragEvent): boolean {
  return Array.from(e.dataTransfer.types).includes(PROJECT_DRAG_MIME);
}

/**
 * A collapsible sidebar group (a project, or No project; in Code mode an app folder, an app, or Unknown app) whose
 * heading is also a drop target for chat rows.
 */
export function ProjectGroup(props: ProjectGroupProps): JSX.Element {
  const { groupKey, name, count, empty, collapsed, dropActive, onToggle, onDragTarget, onDropChat, children } = props;
  const { onNewChat, newChatDisabled = false, menuOpen = false, renaming = false, onOpenMenu, onRename, onRenameCancel, status = null, statusSummary, onOpen, active = false } = props;
  const { menuLabel = 'Project actions', reorder, renameLabel = 'Project name', renameMaxLength = PROJECT_NAME_MAX, openTitle = 'Open the project page' } = props;
  const { countNoun = 'chat', emptyText = 'No chats yet' } = props;
  const counted = count === 1 ? countNoun : `${countNoun}s`;
  const listId = `${groupDomId(groupKey)}-list`;

  return (
    <div role="group" aria-label={name} id={groupDomId(groupKey)} data-testid={`group-${groupKey}`} className="mb-1.5">
      <div
        data-testid={`group-heading-${groupKey}`}
        data-drop-active={dropActive ? 'true' : undefined}
        data-drop-position={reorder?.indicator ?? undefined}
        onDragOver={(e) => {
          if (carriesProject(e)) {
            // A project only lands among its siblings; anywhere else the drop does nothing.
            if (!reorder?.target) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            const position = positionIn(e);
            if (position !== reorder.indicator) reorder.onOver(position);
            return;
          }
          if (!carriesChat(e)) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
          if (!dropActive) onDragTarget(true);
        }}
        onDragLeave={(e) => {
          if (e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget)) return;
          onDragTarget(false);
          reorder?.onLeave();
        }}
        onDrop={(e) => {
          if (carriesProject(e)) {
            reorder?.onLeave();
            if (!reorder?.target) return;
            e.preventDefault();
            reorder.onDrop(positionIn(e));
            return;
          }
          const chatId = e.dataTransfer.getData(CHAT_DRAG_MIME);
          onDragTarget(false);
          if (!chatId) return;
          e.preventDefault();
          onDropChat(chatId);
        }}
        className={`flex items-center gap-0.5 rounded ${dropActive ? 'bg-[var(--bg-sunken)] ring-2 ring-[var(--accent)]' : ''} ${
          reorder?.indicator === 'before' ? 'shadow-[inset_0_2px_0_var(--accent)]' : reorder?.indicator === 'after' ? 'shadow-[inset_0_-2px_0_var(--accent)]' : ''
        }`}
      >
        {renaming && onRename && onRenameCancel ? (
          <InlineNameInput initial={name} label={renameLabel} maxLength={renameMaxLength} onCommit={onRename} onCancel={onRenameCancel} />
        ) : (
          <>
          {/* Before the h3, not in it: inside, the heading would read "Collapse Alpha Alpha 1 chat". */}
          {onOpen && (
            <button
              type="button"
              aria-label={`${collapsed ? 'Expand' : 'Collapse'} ${name}`}
              aria-expanded={!collapsed}
              aria-controls={collapsed || empty ? undefined : listId}
              onClick={onToggle}
              className="shrink-0 rounded py-1 pl-2 text-xs text-[var(--text-muted)] hover:text-[var(--text)]"
            >
              <span aria-hidden="true">{collapsed ? '▸' : '▾'}</span>
            </button>
          )}
          <h3 className="m-0 flex min-w-0 flex-1 items-center text-xs font-normal">
          <button
            type="button"
            data-heading-main=""
            draggable={reorder?.draggable === true}
            onDragStart={
              reorder?.draggable
                ? (e) => {
                    e.dataTransfer.setData(PROJECT_DRAG_MIME, groupKey);
                    e.dataTransfer.effectAllowed = 'move';
                    reorder.onDragStart();
                  }
                : undefined
            }
            onDragEnd={reorder ? () => reorder.onDragEnd() : undefined}
            // With a page to open, the arrow controls the list and this opens the page.
            aria-expanded={onOpen ? undefined : !collapsed}
            aria-controls={onOpen || collapsed || empty ? undefined : listId}
            aria-current={active ? 'true' : undefined}
            title={onOpen ? openTitle : undefined}
            onClick={onOpen ?? onToggle}
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
            className={`label-caps flex min-w-0 flex-1 items-center gap-1 rounded py-1 pr-2 text-left ${onOpen ? 'pl-1' : 'pl-2'} ${
              active ? 'bg-[var(--bg)] text-[var(--text)] shadow-[inset_2px_0_0_var(--accent)]' : 'text-[var(--text-muted)]'
            }`}
          >
            {!onOpen && <span aria-hidden="true">{collapsed ? '▸' : '▾'}</span>}
            <span className="truncate">{name}</span>{' '}
            {/* The count first and the dot well clear of it, so the two don't read as "27 unread". */}
            <span className="ml-auto flex items-center gap-2.5 pl-1">
              <span className="font-normal tabular-nums" title={`${count} ${counted}`} data-testid={`group-count-${groupKey}`}>
                {count}
              </span>
              {status && <StatusDot status={status} testId={`group-status-${groupKey}`} hidden {...(statusSummary ? { title: statusSummary } : {})} />}
            </span>
            <span className="sr-only"> {counted}</span>
            {status && <span className="sr-only">, {statusSummary || STATUS_LABELS[status]}</span>}
          </button>
          </h3>
          </>
        )}
        {onNewChat && (
          <button
            type="button"
            aria-label={`New chat in ${name}`}
            title={`New chat in ${name}`}
            // aria-disabled, not disabled: a disabled button drops keyboard focus while a chat is being created.
            aria-disabled={newChatDisabled || undefined}
            onClick={newChatDisabled ? undefined : onNewChat}
            className="shrink-0 rounded px-1.5 py-0.5 text-sm text-[var(--text-muted)] hover:bg-[var(--bg-sunken)] hover:text-[var(--text)] aria-disabled:opacity-40"
          >
            +
          </button>
        )}
        {onOpenMenu && (
          <button
            type="button"
            aria-label={menuLabel}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            title={menuLabel}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              onOpenMenu({ x: r.left, y: r.bottom }, 'button');
            }}
            className="shrink-0 rounded px-1.5 py-0.5 text-sm text-[var(--text-muted)] hover:bg-[var(--bg-sunken)] hover:text-[var(--text)]"
          >
            ⋯
          </button>
        )}
      </div>
      {!collapsed &&
        (empty ? (
          <p className="px-2 py-1 text-sm text-[var(--text-faint)]">{emptyText}</p>
        ) : (
          // The guide line sits under the heading's chevron, marking the chats as the group's.
          <ul id={listId} className="ml-3 border-l border-[var(--border)] pl-1">
            {children}
          </ul>
        ))}
    </div>
  );
}
