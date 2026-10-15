import type { DragEvent, JSX, ReactNode } from 'react';
import { PROJECT_NAME_MAX } from '@grunt/core/domain/projects.js';
import { InlineNameInput } from '../../components/InlineNameInput.js';
import { STATUS_LABELS, StatusDot } from '../../components/StatusDot.js';
import type { ChatStatus } from '../../state/chatStatus.js';
import { groupDomId } from '../../state/sidebarGroups.js';
import { CHAT_DRAG_MIME, isContextMenuKey, type MenuSource } from './ChatRow.js';

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
  /** Projects only: the ⋯ button, a right-click or Shift+F10 on the heading. */
  onOpenMenu?: (position: { x: number; y: number }, source: MenuSource) => void;
  onRename?: (name: string) => void;
  onRenameCancel?: () => void;
  /** The most urgent status among the group's chats, shown on the heading whether it's open or collapsed. */
  status?: ChatStatus | null;
  /** Projects only: the name opens the project's page, and the arrow alone collapses the group. */
  onOpen?: () => void;
  /** The project's page is the focused tab. */
  active?: boolean;
}

function carriesChat(e: DragEvent): boolean {
  return Array.from(e.dataTransfer.types).includes(CHAT_DRAG_MIME);
}

/** A collapsible sidebar group (a project, or No project) whose heading is also a drop target for chat rows. */
export function ProjectGroup(props: ProjectGroupProps): JSX.Element {
  const { groupKey, name, count, empty, collapsed, dropActive, onToggle, onDragTarget, onDropChat, children } = props;
  const { onNewChat, newChatDisabled = false, menuOpen = false, renaming = false, onOpenMenu, onRename, onRenameCancel, status = null, onOpen, active = false } = props;
  const listId = `${groupDomId(groupKey)}-list`;

  return (
    <div role="group" aria-label={name} id={groupDomId(groupKey)} data-testid={`group-${groupKey}`} className="mb-1.5">
      <div
        data-testid={`group-heading-${groupKey}`}
        data-drop-active={dropActive ? 'true' : undefined}
        onDragOver={(e) => {
          if (!carriesChat(e)) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
          if (!dropActive) onDragTarget(true);
        }}
        onDragLeave={(e) => {
          if (e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget)) return;
          onDragTarget(false);
        }}
        onDrop={(e) => {
          const chatId = e.dataTransfer.getData(CHAT_DRAG_MIME);
          onDragTarget(false);
          if (!chatId) return;
          e.preventDefault();
          onDropChat(chatId);
        }}
        className={`flex items-center gap-0.5 rounded ${dropActive ? 'bg-[var(--bg-sunken)] ring-2 ring-[var(--accent)]' : ''}`}
      >
        {renaming && onRename && onRenameCancel ? (
          <InlineNameInput initial={name} label="Project name" maxLength={PROJECT_NAME_MAX} onCommit={onRename} onCancel={onRenameCancel} />
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
            // With a page to open, the arrow controls the list and this opens the page.
            aria-expanded={onOpen ? undefined : !collapsed}
            aria-controls={onOpen || collapsed || empty ? undefined : listId}
            aria-current={active ? 'true' : undefined}
            title={onOpen ? 'Open the project page' : undefined}
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
            <span className="ml-auto flex items-center gap-1.5 pl-1">
              {status && <StatusDot status={status} testId={`group-status-${groupKey}`} hidden />}
              <span className="font-normal tabular-nums" data-testid={`group-count-${groupKey}`}>
                {count}
              </span>
            </span>
            <span className="sr-only">{count === 1 ? ' chat' : ' chats'}</span>
            {status && <span className="sr-only">, {STATUS_LABELS[status]}</span>}
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
            aria-label="Project actions"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            title="Project actions"
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
          <p className="px-2 py-1 text-sm text-[var(--text-faint)]">No chats yet</p>
        ) : (
          // The guide line sits under the heading's chevron, marking the chats as the group's.
          <ul id={listId} className="ml-3 border-l border-[var(--border)] pl-1">
            {children}
          </ul>
        ))}
    </div>
  );
}
