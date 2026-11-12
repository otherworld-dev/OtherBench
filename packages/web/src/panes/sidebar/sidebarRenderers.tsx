import type { Dispatch, JSX, SetStateAction } from 'react';
import { projectDisplayName, type ProjectLookup } from '@otherbench/core/domain/projects.js';
import type { App, Chat } from '@otherbench/core/ports/store.js';
import type { Profile } from '@otherbench/core/types/config.js';
import { chatStatus, groupStatusSummary, isOnCard, type ChatActivity, type ChatStatus } from '../../state/chatStatus.js';
import { setGroupCollapsed } from '../../state/sidebarGroups.js';
import { ChatRow, type DropPosition } from './ChatRow.js';
import { focusLater, LIST_SELECTOR, rowSelector, type RowKind } from './focus.js';
import { AGE_BUCKET_LABELS, bucketRuns, capRows, GROUP_ROW_CAP, type CodeSidebarGroup, type SidebarGroup } from './model.js';
import { ProjectGroup } from './ProjectGroup.js';
import type { AppHeadings } from './useAppHeadings.js';
import type { ChatActions, ChatMenuAt, Section } from './useChatActions.js';
import type { ProjectHeadings } from './useProjectHeadings.js';

/** What the list's groups and rows are drawn from: the sidebar's state this render, and its chat, project and app actions. */
export interface SidebarRenderContext {
  searching: boolean;
  now: number;
  activity: ChatActivity;
  lookup: ProjectLookup;
  apps: App[];
  profiles: Profile[];
  activeChatId: string | null;
  setActiveChatId: (id: string | null) => void;
  collapsedGroups: ReadonlySet<string>;
  expandedGroups: ReadonlySet<string>;
  setExpandedGroups: Dispatch<SetStateAction<ReadonlySet<string>>>;
  dropTarget: string | null;
  setDropTarget: Dispatch<SetStateAction<string | null>>;
  rowDrop: { chatId: string; position: DropPosition } | null;
  setRowDrop: Dispatch<SetStateAction<{ chatId: string; position: DropPosition } | null>>;
  setDraggingChatId: Dispatch<SetStateAction<string | null>>;
  setPinZoneActive: Dispatch<SetStateAction<boolean>>;
  chatMenu: ChatMenuAt | null;
  queuedIds: ReadonlySet<string>;
  creating: boolean;
  createChat: (into?: { projectId: string } | { appId: string }) => Promise<void>;
  chat: ChatActions;
  project: ProjectHeadings;
  app: AppHeadings;
}

/**
 * The list's groups and rows, called while rendering: a Chat mode project's (or No project's) group, a Code mode
 * app's group, and one chat's row in any of them, under Pinned, or in Needs you. Each group shows its first
 * `GROUP_ROW_CAP` chats until "Show N more".
 */
export function sidebarRenderers({
  searching,
  now,
  activity,
  lookup,
  apps,
  profiles,
  activeChatId,
  setActiveChatId,
  collapsedGroups,
  expandedGroups,
  setExpandedGroups,
  dropTarget,
  setDropTarget,
  rowDrop,
  setRowDrop,
  setDraggingChatId,
  setPinZoneActive,
  chatMenu,
  queuedIds,
  creating,
  createChat,
  chat: { renamingChatId, setRenamingChatId, setMenuRow, moveChat, moveChatToApp, placeChat, beforeIdFor, rowKindOf, currentRowSelector, openChatMenu, renameChat, setPinned, tickOff },
  project: { noProjectMenu, openNoProjectMenu, projectGroupProps },
  app: { appGroupProps },
}: SidebarRenderContext): {
  renderGroup: (group: SidebarGroup) => JSX.Element;
  renderAppGroup: (group: CodeSidebarGroup) => JSX.Element;
  renderRow: (chat: Chat, section: Section | null, muted?: boolean, listed?: boolean) => JSX.Element;
} {
  /** Opens a capped group in full (focus goes to the first chat it revealed), or caps it again. */
  function setGroupExpanded(key: string, expanded: boolean, firstRevealedId?: string): void {
    setExpandedGroups((current) => {
      const next = new Set(current);
      if (expanded) next.add(key);
      else next.delete(key);
      return next;
    });
    if (firstRevealedId) focusLater(rowSelector(firstRevealedId, 'group'));
  }

  function statusOf(chat: Chat): ChatStatus | null {
    return chatStatus(chat, activity, now);
  }

  /** A pinned chat's project, named after its parent when it's a sub-project. */
  function pinnedProjectName(projectId: string): string | undefined {
    const project = lookup(projectId);
    return project ? projectDisplayName(project, lookup) : undefined;
  }

  /** Every chat shown in a group and its sub-projects, for the heading's status. */
  function groupChats(group: SidebarGroup): Chat[] {
    return [...group.pinnedChats, ...group.chats, ...group.children.flatMap(groupChats)];
  }

  /**
   * One project's (or No project's) group: its chats pinned in the project, then its globally pinned chats, its
   * sub-projects' groups (spec 2026-10-15-sub-projects-design §4), then its other chats, capped and sorted as the
   * group says. The globally pinned ones (the run that leads `group.chats`) reorder among themselves.
   */
  function renderGroup(group: SidebarGroup): JSX.Element {
    const project = group.project;
    const projectId = project?.id ?? null;
    const recent = group.sort === 'recent';
    const pinned = group.chats.filter((c) => c.pinned);
    const others = group.chats.filter((c) => !c.pinned);
    const pinnedRun: Section = { chats: pinned, pinned: false, projectPinned: false, projectId, recent };
    const rest: Section = { chats: others, pinned: false, projectPinned: false, projectId, recent };
    const expanded = searching || expandedGroups.has(group.key);
    const { visible, hidden } = expanded ? { visible: others, hidden: 0 } : capRows(others, GROUP_ROW_CAP, activeChatId);
    const firstHidden = hidden > 0 ? others.find((c) => !visible.includes(c)) : undefined;
    return (
      <ProjectGroup
        key={group.key}
        groupKey={group.key}
        name={project?.name ?? 'No project'}
        count={group.total}
        empty={group.total === 0 && group.children.length === 0}
        collapsed={!searching && collapsedGroups.has(group.key)}
        statusSummary={groupStatusSummary(groupChats(group).map(statusOf))}
        dropActive={dropTarget === group.key}
        onToggle={() => setGroupCollapsed(group.key, !collapsedGroups.has(group.key))}
        onDragTarget={(on) => setDropTarget((current) => (on ? group.key : current === group.key ? null : current))}
        onDropChat={(chatId) => void moveChat(chatId, projectId)}
        {...(project
          ? projectGroupProps(project)
          : {
              menuOpen: noProjectMenu !== null,
              menuLabel: 'No project actions',
              onOpenMenu: openNoProjectMenu,
            })}
      >
        {group.pinnedChats.map((c) => renderRow(c, { chats: group.pinnedChats, pinned: false, projectPinned: true, projectId, recent }))}
        {pinned.map((c) => renderRow(c, pinnedRun))}
        {group.children.map((child) => (
          <li key={`sub-${child.key}`} data-testid={`subgroup-${child.key}`}>
            {renderGroup(child)}
          </li>
        ))}
        {recent
          ? bucketRuns(visible, now).flatMap((run) => [
              <li
                key={`bucket-${run.bucket}`}
                role="presentation"
                data-testid={`bucket-${group.key}-${run.bucket}`}
                className="px-2 pt-1.5 pb-0.5 text-[11px] text-[var(--text-faint)]"
              >
                {AGE_BUCKET_LABELS[run.bucket]}
              </li>,
              ...run.chats.map((c) => renderRow(c, rest)),
            ])
          : visible.map((c) => renderRow(c, rest))}
        {(hidden > 0 || (!searching && expandedGroups.has(group.key) && others.length > GROUP_ROW_CAP)) && (
          // One key for both labels: React keeps the button, so focus stays on it when "Show fewer" folds the group.
          <li key="row-cap-toggle">
            <button
              type="button"
              data-testid={`group-more-${group.key}`}
              onClick={() => setGroupExpanded(group.key, hidden > 0, firstHidden?.id)}
              className="w-full rounded-sm px-2 py-[3px] text-left text-xs text-[var(--text-muted)] hover:bg-[var(--bg-sunken)] hover:text-[var(--text)]"
            >
              {hidden > 0 ? `Show ${hidden} more` : 'Show fewer'}
            </button>
          </li>
        )}
      </ProjectGroup>
    );
  }

  /**
   * One app's group in Code mode, or the Unknown app group (`group.app` null). An app's list always ends with
   * "+ New chat", so it never reads as empty; the name opens the app's home and the arrow folds the list.
   */
  function renderAppGroup(group: CodeSidebarGroup): JSX.Element {
    const app = group.app;
    const expanded = searching || expandedGroups.has(group.key);
    const { visible, hidden } = expanded ? { visible: group.chats, hidden: 0 } : capRows(group.chats, GROUP_ROW_CAP, activeChatId);
    const firstHidden = hidden > 0 ? group.chats.find((c) => !visible.includes(c)) : undefined;
    return (
      <ProjectGroup
        key={group.key}
        groupKey={group.key}
        name={app?.name ?? 'Unknown app'}
        count={group.total}
        empty={false}
        collapsed={!searching && collapsedGroups.has(group.key)}
        statusSummary={groupStatusSummary(group.chats.map(statusOf))}
        dropActive={app !== null && dropTarget === group.key}
        onToggle={() => setGroupCollapsed(group.key, !collapsedGroups.has(group.key))}
        // Dropping a chat on an app's heading files it there, as Move to app… does; Unknown app takes no drops.
        onDragTarget={(on) => {
          if (app) setDropTarget((current) => (on ? group.key : current === group.key ? null : current));
        }}
        onDropChat={(chatId) => {
          if (app) void moveChatToApp(chatId, app.id);
        }}
        {...(app ? appGroupProps(app) : {})}
        note={group.shownBecause === 'card' ? 'Shown because a chat needs you' : group.shownBecause === 'running' ? 'Shown because a chat is running' : undefined}
      >
        {visible.map((c) => renderRow(c, null, false))}
        {(hidden > 0 || (!searching && expandedGroups.has(group.key) && group.chats.length > GROUP_ROW_CAP)) && (
          <li key="row-cap-toggle">
            <button
              type="button"
              data-testid={`group-more-${group.key}`}
              onClick={() => setGroupExpanded(group.key, hidden > 0, firstHidden?.id)}
              className="w-full rounded-sm px-2 py-[3px] text-left text-xs text-[var(--text-muted)] hover:bg-[var(--bg-sunken)] hover:text-[var(--text)]"
            >
              {hidden > 0 ? `Show ${hidden} more` : 'Show fewer'}
            </button>
          </li>
        )}
        {app && (
          <li key="new-chat">
            <button
              type="button"
              data-testid={`app-new-chat-${app.id}`}
              aria-label={`New chat in ${app.name}`}
              // aria-disabled, not disabled: a disabled button drops keyboard focus while a chat is being created.
              aria-disabled={creating || profiles.length === 0 || undefined}
              onClick={() => void createChat({ appId: app.id })}
              className="w-full rounded-sm px-2 py-[3px] text-left text-xs text-[var(--text-muted)] hover:bg-[var(--bg-sunken)] hover:text-[var(--text)] aria-disabled:opacity-40"
            >
              + New chat
            </button>
          </li>
        )}
      </ProjectGroup>
    );
  }

  /** What a row in the Needs you list is filed under: its project, or its app. */
  function homeName(chat: Chat): string | undefined {
    if (chat.appId !== null) return apps.find((a) => a.id === chat.appId)?.name;
    return chat.projectId ? pinnedProjectName(chat.projectId) : undefined;
  }

  /** `muted`: dimmed, as archived rows are; by default every row outside a section is one (Chat mode's archived list). */
  function renderRow(chat: Chat, section: Section | null, muted = section === null, listed = false): JSX.Element {
    const kind: RowKind = listed ? 'list' : section?.pinned ? 'pinned' : 'group';
    // A chat can have up to three rows; its open menu and rename show on the one they came from.
    const current = kind === rowKindOf(chat.id);
    return (
      <ChatRow
        key={chat.id}
        chat={chat}
        status={statusOf(chat)}
        active={chat.id === activeChatId}
        onSelect={() => setActiveChatId(chat.id)}
        onDragStart={() => setDraggingChatId(chat.id)}
        onDragEnd={() => {
          setDropTarget(null);
          setRowDrop(null);
          setDraggingChatId(null);
          setPinZoneActive(false);
        }}
        reorder={
          // Reordering against a filtered list would place chats relative to ones the user can't see; a recent group orders itself.
          section && !searching && !section.recent
            ? {
                indicator: rowDrop?.chatId === chat.id ? rowDrop.position : null,
                onOver: (position) => setRowDrop({ chatId: chat.id, position }),
                onLeave: () => setRowDrop((current) => (current?.chatId === chat.id ? null : current)),
                onDrop: (draggedId, position) => {
                  if (draggedId === chat.id) return;
                  void placeChat(draggedId, section, beforeIdFor(section, chat.id, position, draggedId));
                },
              }
            : undefined
        }
        menuOpen={current && chatMenu?.chatId === chat.id}
        renaming={current && renamingChatId === chat.id}
        muted={muted}
        onTogglePin={chat.archivedAt === null ? () => void setPinned(chat, !chat.pinned, true, kind) : undefined}
        showPinMarker={!section?.pinned}
        projectPinMarker={section?.projectPinned === true}
        projectName={listed ? homeName(chat) : section?.pinned && chat.projectId ? pinnedProjectName(chat.projectId) : undefined}
        needsYou={listed}
        pinnedCopy={kind === 'pinned'}
        onTick={queuedIds.has(chat.id) && !isOnCard(statusOf(chat)) ? () => tickOff(chat) : undefined}
        now={now}
        onOpenMenu={(position, source) => {
          setMenuRow(kind);
          openChatMenu(chat.id, position, source);
        }}
        onRename={(title) => void renameChat(chat, title)}
        onRenameCancel={() => {
          setRenamingChatId(null);
          focusLater(currentRowSelector(chat.id), LIST_SELECTOR);
        }}
      />
    );
  }

  return { renderGroup, renderAppGroup, renderRow };
}
