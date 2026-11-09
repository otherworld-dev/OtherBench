import { useEffect, useMemo, useState, type JSX, type ReactNode } from 'react';
import { compareProjects, projectLookup, projectParentOf } from '@otherbench/core/domain/projects.js';
import type { Project } from '@otherbench/core/ports/store.js';
import { FolderPlusIcon } from '../components/icons.js';
import { useNow } from '../lib/useNow.js';
import { ALL_APPS_TAB_ID } from '../state/allAppsTab.js';
import { chatStatus, needsYouChats, useChatActivity } from '../state/chatStatus.js';
import { modeOfChat } from '../state/mode.js';
import { machineQueueOpenKey, setGroupCollapsed, useCollapsedGroups } from '../state/sidebarGroups.js';
import { groupSortOf, useGroupSorts } from '../state/sidebarSort.js';
import { OverviewJumpList } from '../overview/OverviewJumpList.js';
import { useOtherBenchStore } from '../state/store.js';
import { AllAppsEntry } from './sidebar/AllAppsEntry.js';
import { ChatFilters } from './sidebar/ChatFilters.js';
import type { DropPosition } from './sidebar/ChatRow.js';
import { MachineQueueSection } from './sidebar/MachineQueueSection.js';
import { splitByMachine } from './sidebar/machineQueues.js';
import { focusLater, LIST_SELECTOR } from './sidebar/focus.js';
import { buildCodeSidebar, buildSidebar, liveApps } from './sidebar/model.js';
import { ModeSwitch } from './sidebar/ModeSwitch.js';
import { PinDropZone } from './sidebar/PinDropZone.js';
import { sidebarRenderers } from './sidebar/sidebarRenderers.js';
import { SidebarMenus } from './sidebar/SidebarMenus.js';
import { useShowArchived } from './sidebar/showArchived.js';
import { useAppHeadings } from './sidebar/useAppHeadings.js';
import { useChatActions, type ChatMenuAt } from './sidebar/useChatActions.js';
import { useCreateChat } from './sidebar/useCreateChat.js';
import { useProjectHeadings } from './sidebar/useProjectHeadings.js';
import { useSidebarSearch } from './sidebar/useSidebarSearch.js';
import { useTrayNewChat } from './sidebar/useTrayNewChat.js';

export { SHOW_ARCHIVED_STORAGE_KEY } from './sidebar/showArchived.js';

/**
 * Left pane (spec 2026-10-03-projects-design §3): search, then Pinned, each
 * project, and No project, with "+ New chat" and "+ New project" at the
 * bottom. A pinned chat keeps its row in its group and gets a second one
 * under Pinned until unpinned (Deck d961). Search matches chat titles here
 * and message text through `GET /api/search?scope=chats`, and the chips under it keep only chats with
 * a status, or that run on one machine. Any of those filters every group to
 * the matching chats; groups with no match hide, and collapsed or capped
 * groups show in full, while one is active. A group shows its first
 * `GROUP_ROW_CAP` chats until "Show N more", and orders them by hand or, with
 * date headings, by recent activity (its menu's sort item).
 *
 * A Chat | Code switch above the search picks the mode (spec
 * 2026-10-20-code-tab-design, Goal 1). Code mode lists each app with its chats
 * instead (`buildCodeSidebar`), and Chat mode never shows an app chat: a chat
 * lives in one mode only. Search and the chips work the same in both, and
 * while searching a trailing "In Code mode" / "In Chat mode" section lists the
 * other mode's matches; opening one switches mode. An app's
 * heading opens its home, collapses from its arrow, and has a menu (Rename,
 * Edit…, Delete…); each app's list ends with a "+ New chat" row, and "+ New
 * app" takes the place of "+ New chat" at the bottom. In Code mode there is no
 * Pinned section and no reordering by hand: a pinned app chat leads its group.
 * Only open apps are listed (plan 2026-11-04-open-apps), under an All apps
 * entry that opens the page holding every app, where apps are opened, filed in
 * folders and ordered. An app's heading also drags (or its menu's Move up /
 * Move down steps it) past the shown apps of its own folder, leaving closed
 * ones where they are. A heading's × (or its menu's Close app) closes an app,
 * with Undo in a toast; a closed app still shows while one of its chats is on a
 * card or running, saying so under its heading, and a search finds chats in
 * closed apps too.
 *
 * `footer` renders at the end of the New chat / New project row, for
 * app-level controls the caller owns (Settings, Usage). `wrapFooter` lets
 * that row wrap onto a second line instead of running out of the sidebar
 * (signed-in remote access adds a fourth button, which a phone-width sidebar
 * can't fit).
 */
export function ChatList({ footer, wrapFooter = false }: { footer?: ReactNode; wrapFooter?: boolean } = {}): JSX.Element {
  const chats = useOtherBenchStore((s) => s.chats);
  const projects = useOtherBenchStore((s) => s.projects);
  const profiles = useOtherBenchStore((s) => s.profiles);
  const activeChatId = useOtherBenchStore((s) => s.activeChatId);
  const setActiveChatId = useOtherBenchStore((s) => s.setActiveChatId);
  const openProjectPage = useOtherBenchStore((s) => s.openProjectPage);
  const paneTabs = useOtherBenchStore((s) => s.paneState.tabs);
  const machines = useOtherBenchStore((s) => s.machines);
  const apps = useOtherBenchStore((s) => s.apps);
  const appFolders = useOtherBenchStore((s) => s.appFolders);
  const mode = useOtherBenchStore((s) => s.mode);
  const overviewOpen = useOtherBenchStore((s) => s.overviewOpen);
  const openAllApps = useOtherBenchStore((s) => s.openAllApps);
  const openAppPage = useOtherBenchStore((s) => s.openAppPage);
  const codeMode = mode === 'code';
  const collapsedGroups = useCollapsedGroups();
  const groupSorts = useGroupSorts();
  const now = useNow(60_000);
  const activity = useChatActivity();

  const { query, runSearch, trimmedQuery, statusOnly, setStatusOnly, machineFilter, setMachine, searching, matches } = useSidebarSearch(
    chats,
    machines,
    activeChatId,
    activity,
    now
  );
  /** Groups opened past their cap with "Show N more", this session only. */
  const [expandedGroups, setExpandedGroups] = useState<ReadonlySet<string>>(() => new Set());
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [rowDrop, setRowDrop] = useState<{ chatId: string; position: DropPosition } | null>(null);
  // The chat being dragged, while it is: with nothing pinned yet, a "Drop here to pin" target takes the search
  // box's place. Not a new section in the list, which would push every row down under the pointer mid-drag.
  const [draggingChatId, setDraggingChatId] = useState<string | null>(null);
  const [pinZoneActive, setPinZoneActive] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [chatMenu, setChatMenu] = useState<ChatMenuAt | null>(null);
  const [showArchived, toggleArchived] = useShowArchived();

  // While searching every chat stays in its group, so a result is found where it lives.
  // In the order each chat came to need the user, as the server recorded it, so a reload keeps it (`needsYouChats`).
  const queue = useMemo(() => needsYouChats(chats, activity, now), [chats, activity, now]);
  const needsYou = useMemo(
    () => splitByMachine(searching ? [] : queue.filter((c) => modeOfChat(c) === mode), machines),
    [searching, queue, mode, machines]
  );
  /** Whether another machine's section in Needs you is open: they start closed. */
  const machineQueueOpen = (key: string): boolean => collapsedGroups.has(machineQueueOpenKey(key));
  // The chats with a row in the list now: a closed section's chats have none.
  const needsYouIds = useMemo(
    () => new Set([...needsYou.here, ...needsYou.elsewhere.filter((m) => collapsedGroups.has(machineQueueOpenKey(m.key))).flatMap((m) => m.chats)].map((c) => c.id)),
    [needsYou, collapsedGroups]
  );
  // Its row in the group gets the tick too, so a chat can be ticked off where it is, searching or not.
  const queuedIds = useMemo(() => new Set(queue.map((c) => c.id)), [queue]);
  const sidebar = useMemo(() => buildSidebar(chats, projects, matches, (key) => groupSortOf(groupSorts, key)), [chats, projects, matches, groupSorts]);
  // A closed app still shows while one of its chats is on a card or running (plan 2026-11-04-open-apps).
  const live = useMemo(() => liveApps(chats, (c) => chatStatus(c, activity, now)), [chats, activity, now]);
  const codeSidebar = useMemo(() => buildCodeSidebar(chats, apps, appFolders, matches, live), [chats, apps, appFolders, matches, live]);
  const shownAppIds = useMemo(() => new Set(codeSidebar.groups.flatMap((g) => (g.app ? [g.app.id] : []))), [codeSidebar]);
  const archived = codeMode ? codeSidebar.archived : sidebar.archived;
  const otherMode = codeMode ? codeSidebar.otherMode : sidebar.otherMode;
  const lookup = useMemo(() => projectLookup(projects), [projects]);
  /** Sidebar order: each top-level project, then its sub-projects. */
  const orderedProjects = useMemo(() => {
    const sorted = [...projects].sort(compareProjects);
    const parentOf = (p: Project): string | null => projectParentOf(p, lookup)?.id ?? null;
    return sorted.filter((p) => parentOf(p) === null).flatMap((p) => [p, ...sorted.filter((c) => parentOf(c) === p.id)]);
  }, [projects, lookup]);
  // Looked up on every render, so the menu and dialog act on the chat as it is now.
  const menuChat = chatMenu ? (chats.find((c) => c.id === chatMenu.chatId) ?? null) : null;

  const { creating, createChat } = useCreateChat({ profiles, lookup, setError });
  const app = useAppHeadings({ apps, appFolders, searching, shownAppIds, activeChatId, setError, setChatMenu });
  const project = useProjectHeadings({ projects, profiles, searching, activeChatId, creating, createChat, setError, setChatMenu });
  const chat = useChatActions({
    chats,
    sidebar,
    codeMode,
    searching,
    needsYouIds,
    chatMenu,
    setChatMenu,
    setProjectMenu: project.setProjectMenu,
    setNoProjectMenu: project.setNoProjectMenu,
    setAppMenu: app.setAppMenu,
    setError,
  });
  const { placeChat } = chat;

  // The chat under an open menu vanished (deleted or archived from elsewhere): close the menu, keep focus in the list.
  // Closed in the render that finds it gone; the focus, a side effect, waits for the commit (bumped, never reset).
  const [menuGoneCount, setMenuGoneCount] = useState(0);
  if (chatMenu !== null && menuChat === null) {
    setChatMenu(null);
    setMenuGoneCount((n) => n + 1);
  }
  useEffect(() => {
    if (menuGoneCount > 0) focusLater(LIST_SELECTOR);
  }, [menuGoneCount]);

  useTrayNewChat(createChat);

  const { renderGroup, renderAppGroup, renderRow } = sidebarRenderers({
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
    chat,
    project,
    app,
  });

  return (
    <nav aria-label="Chats" data-chat-list="" tabIndex={-1} className="flex h-full w-full flex-col border-r border-[var(--border)] bg-[var(--bg-raised)]">
      <div className="border-b border-[var(--border)] p-2">
        <ModeSwitch />
        {!codeMode && draggingChatId !== null && sidebar.pinned.length === 0 && !searching ? (
          <PinDropZone
            active={pinZoneActive}
            onActiveChange={setPinZoneActive}
            onDragFinished={() => setDraggingChatId(null)}
            onPin={(chatId) => void placeChat(chatId, { chats: [], pinned: true, projectPinned: false, projectId: null, recent: false }, null)}
          />
        ) : (
          <input
            type="search"
            value={query}
            onChange={(e) => void runSearch(e.target.value)}
            placeholder="Search chats..."
            aria-label="Search chats"
            className="w-full rounded-sm border border-[var(--border-strong)] bg-[var(--bg)] px-2 py-1.5 text-sm outline-none focus:border-[var(--accent)] focus-visible:ring-1 focus-visible:ring-[var(--accent)]"
          />
        )}
        <ChatFilters statusOnly={statusOnly} setStatusOnly={setStatusOnly} machines={machines} machineFilter={machineFilter} setMachine={setMachine} />
      </div>

      {/* relative: the group headings' screen-reader text is absolutely positioned, and without a positioned
          ancestor here it was placed against the page, escaped this scroll area's clipping and made the whole
          window scroll once a group sat below the fold. */}
      <div className="relative flex-1 overflow-y-auto px-1.5 py-1" data-testid="chat-list-scroll">
        {overviewOpen ? (
          <OverviewJumpList />
        ) : (
          <>
          {codeMode && <AllAppsEntry active={activeChatId === ALL_APPS_TAB_ID} count={apps.length} onOpen={openAllApps} />}

          {(needsYou.here.length > 0 || needsYou.elsewhere.length > 0) && (
            // A rule under the list: its rows are copies, and without one they ran on into the groups below.
            <div className="mb-2 border-b border-[var(--border-strong)] pb-2" data-testid="group-needs-you">
              <h2 className="label-caps flex justify-between px-2 pb-1 text-[var(--warn)]">
                <span>Needs you</span>
                <span className="font-normal tabular-nums">{needsYou.here.length}</span>
              </h2>
              {needsYou.here.length > 0 && <ul>{needsYou.here.map((c) => renderRow(c, null, false, true))}</ul>}
              {needsYou.elsewhere.map((m) => (
                <MachineQueueSection
                  key={m.key}
                  machineKey={m.key}
                  name={m.name}
                  count={m.chats.length}
                  open={machineQueueOpen(m.key)}
                  onToggle={() => setGroupCollapsed(machineQueueOpenKey(m.key), !machineQueueOpen(m.key))}
                >
                  {m.chats.map((c) => renderRow(c, null, false, true))}
                </MachineQueueSection>
              ))}
            </div>
          )}

          {!codeMode && sidebar.pinned.length > 0 && (
            <div className="mb-1.5" data-testid="group-pinned">
              <h2 className="label-caps px-2 pb-1 text-[var(--text-muted)]">Pinned</h2>
              <ul>{sidebar.pinned.map((c) => renderRow(c, { chats: sidebar.pinned, pinned: true, projectPinned: false, projectId: null, recent: false }))}</ul>
            </div>
          )}

          {searching &&
            (codeMode ? codeSidebar.groups.length === 0 : sidebar.pinned.length === 0 && sidebar.groups.length === 0) &&
            archived.length === 0 &&
            otherMode.length === 0 && (
            <p className="px-2 py-4 text-sm text-[var(--text-faint)]">{trimmedQuery === '' ? 'No chats match these filters.' : 'No chats match your search.'}</p>
          )}

          {codeMode && !searching && apps.length === 0 && codeSidebar.groups.length === 0 && (
            <p className="px-2 py-4 text-sm text-[var(--text-faint)]">No apps yet. An app is a repo folder; its chats show here, under it.</p>
          )}

          {codeMode && !searching && apps.length > 0 && !codeSidebar.groups.some((g) => g.app !== null) && (
            <p data-testid="no-open-apps" className="px-2 py-4 text-sm text-[var(--text-faint)]">
              No apps open. Pick one from{' '}
              <button type="button" onClick={openAllApps} className="underline hover:text-[var(--text)]">
                All apps
              </button>
              .
            </p>
          )}

          {codeMode ? codeSidebar.groups.map(renderAppGroup) : sidebar.groups.map(renderGroup)}

          {archived.length > 0 && (
            <div className="mb-1.5" data-testid="archived-section">
              <button
                type="button"
                aria-expanded={showArchived}
                onClick={toggleArchived}
                className="label-caps w-full rounded-sm px-2 py-1 text-left text-[var(--text-muted)] hover:bg-[var(--bg-sunken)]"
              >
                {showArchived ? 'Hide archived' : `Show archived (${archived.length})`}
              </button>
              {showArchived && <ul>{archived.map((c) => renderRow(c, null))}</ul>}
            </div>
          )}

          {/* While searching, the other mode's matches, so a chat is found from either mode; opening one switches to
              the mode it lives in (spec 2026-10-20-code-tab-design, "Decisions Adam made"). Dimmed and not draggable,
              as rows outside a section are: they don't belong to this mode's groups. */}
          {otherMode.length > 0 && (
            <div className="mb-1.5" data-testid="other-mode-section">
              <h2 className="label-caps px-2 pb-1 text-[var(--text-muted)]">{codeMode ? 'In Chat mode' : 'In Code mode'}</h2>
              <ul>{otherMode.map((c) => renderRow(c, null))}</ul>
            </div>
          )}

          {error && (
            <p role="alert" className="px-2 py-2 text-xs text-[var(--danger)]">
              {error}
            </p>
          )}
          </>
        )}
      </div>

      {/* An @container so the main button's words give way to a bare "+" in a narrow sidebar rather than wrap
          onto a second line; they stay in its accessible name. */}
      <div className={`@container flex items-stretch gap-1 border-t border-[var(--border)] p-2${wrapFooter ? ' flex-wrap' : ''}`}>
        {codeMode ? (
          // In Code mode a new chat starts from its app's "+ New chat" row, so the main button makes an app. Folders are
          // made on the All apps page.
          <button type="button" onClick={() => openAppPage({ mode: 'create' })} title="New app" className="btn btn-primary flex-1 whitespace-nowrap px-2 py-1.5">
            + <span className="@max-[14.125rem]:sr-only">New app</span>
          </button>
        ) : (
          <>
            <button
              type="button"
              onClick={() => void createChat()}
              // aria-disabled, not disabled: a disabled button drops keyboard focus while a chat is being created.
              aria-disabled={creating || profiles.length === 0 || undefined}
              title={profiles.length === 0 ? 'Create a profile before starting a chat.' : 'New chat'}
              className="btn btn-primary flex-1 whitespace-nowrap px-2 py-1.5"
            >
              + <span className="@max-[14.125rem]:sr-only">New chat</span>
            </button>
            <button type="button" onClick={() => openProjectPage({ mode: 'create' })} aria-label="New project" title="New project" className="btn px-2 py-1.5">
              <FolderPlusIcon />
            </button>
          </>
        )}
        {footer}
      </div>

      <SidebarMenus
        chatMenu={chatMenu}
        menuChat={menuChat}
        setChatMenu={setChatMenu}
        chat={chat}
        project={project}
        app={app}
        projects={projects}
        orderedProjects={orderedProjects}
        lookup={lookup}
        groupSorts={groupSorts}
        apps={apps}
        appFolders={appFolders}
        paneTabs={paneTabs}
      />
    </nav>
  );
}
