import type { JSX } from 'react';
import { projectParentOf, type ProjectLookup } from '@otherbench/core/domain/projects.js';
import type { App, AppFolder, Chat, Project } from '@otherbench/core/ports/store.js';
import { ConfirmDialog } from '../../components/ConfirmDialog.js';
import { Menu } from '../../components/Menu.js';
import { NO_PROJECT_KEY } from '../../state/sidebarGroups.js';
import { groupSortOf, setGroupSort, type GroupSort } from '../../state/sidebarSort.js';
import { useOtherBenchStore } from '../../state/store.js';
import { focusLater, headingSelector, LIST_SELECTOR } from './focus.js';
import { appMenuItems, chatMenuItems, groupSortItem, projectMenuItems } from './menus.js';
import type { AppHeadings } from './useAppHeadings.js';
import type { ChatActions, ChatMenuAt } from './useChatActions.js';
import type { ProjectHeadings } from './useProjectHeadings.js';

/**
 * The sidebar's menus and delete confirmations: a chat's, a project's, No project's and an app's menu, each closing
 * back to the row or heading it came from, and the dialogs that delete a chat, an app or a project.
 */
export function SidebarMenus({
  chatMenu,
  menuChat,
  setChatMenu,
  chat,
  project,
  app,
  projects,
  orderedProjects,
  lookup,
  groupSorts,
  apps,
  appFolders,
  paneTabs,
}: {
  chatMenu: ChatMenuAt | null;
  menuChat: Chat | null;
  setChatMenu: (menu: ChatMenuAt | null) => void;
  chat: ChatActions;
  project: ProjectHeadings;
  app: AppHeadings;
  projects: Project[];
  orderedProjects: Project[];
  lookup: ProjectLookup;
  groupSorts: ReadonlyMap<string, GroupSort>;
  apps: App[];
  appFolders: AppFolder[];
  paneTabs: string[];
}): JSX.Element {
  const openTab = useOtherBenchStore((s) => s.openTab);
  const openSchedules = useOtherBenchStore((s) => s.openSchedules);
  const openProjectPage = useOtherBenchStore((s) => s.openProjectPage);
  const openAppPage = useOtherBenchStore((s) => s.openAppPage);
  const {
    setRenamingChatId,
    setPinned,
    setProjectPinned,
    reorderChat,
    moveChat,
    moveToNewProject,
    moveChatToApp,
    exportChat,
    setMemoryExcluded,
    archiveChat,
    unarchiveChat,
    setDeletingChatId,
    menuPosition,
    currentRowSelector,
    deletingChat,
    chatSchedulesLine,
    deleteChat,
  } = chat;
  const {
    projectMenu,
    setProjectMenu,
    menuProject,
    menuSiblings,
    setRenamingProjectId,
    moveProject,
    moveProjectUnder,
    setDeletingProjectId,
    noProjectMenu,
    setNoProjectMenu,
    deletingProject,
    projectSchedulesLine,
    deleteProject,
  } = project;
  const { appMenu, setAppMenu, menuApp, setRenamingAppId, closeApp, keepApp, moveApp, setDeletingAppId, appPlace, deletingApp, deleteApp } = app;

  return (
    <>
      {chatMenu && menuChat && (
        <Menu
          key={`chat:${menuChat.id}`}
          label="Chat actions"
          position={chatMenu.position}
          items={chatMenuItems(
            menuChat,
            orderedProjects,
            {
              openInTab: () => openTab(menuChat.id),
              rename: () => setRenamingChatId(menuChat.id),
              setPinned: (pinned) => void setPinned(menuChat, pinned),
              setProjectPinned: (pinned) => void setProjectPinned(menuChat, pinned),
              reorder: (dir) => void reorderChat(menuChat, dir),
              moveTo: (projectId) => void moveChat(menuChat.id, projectId),
              moveToNewProject: () => void moveToNewProject(menuChat),
              moveToApp: (appId) => void moveChatToApp(menuChat.id, appId),
              moveOutOfApp: () => void moveChatToApp(menuChat.id, null),
              exportAs: (format) => void exportChat(menuChat, format),
              schedule: () => openSchedules({ kind: 'chat', chatId: menuChat.id }),
              setMemoryExcluded: (excluded) => void setMemoryExcluded(menuChat, excluded),
              archive: () => void archiveChat(menuChat),
              unarchive: () => void unarchiveChat(menuChat),
              requestDelete: () => setDeletingChatId(menuChat.id),
            },
            menuPosition(menuChat),
            paneTabs.includes(menuChat.id),
            apps,
            appFolders
          )}
          onClose={(reason) => {
            setChatMenu(null);
            // Esc, Tab or a scroll: back to the opener. A click elsewhere keeps focus where the user put it.
            if (reason === 'dismiss') focusLater(currentRowSelector(menuChat.id), LIST_SELECTOR);
          }}
        />
      )}

      {deletingChat && (
        <ConfirmDialog
          title={`Delete '${deletingChat.title}'? This can't be undone.`}
          {...(chatSchedulesLine ? { message: chatSchedulesLine } : {})}
          confirmLabel="Delete"
          onConfirm={() => deleteChat(deletingChat.id)}
          onCancel={() => {
            setDeletingChatId(null);
            focusLater(currentRowSelector(deletingChat.id), LIST_SELECTOR);
          }}
        />
      )}

      {projectMenu && menuProject && (
        <Menu
          key={`project:${menuProject.id}`}
          label="Project actions"
          position={projectMenu.position}
          items={projectMenuItems(
            menuSiblings.findIndex((p) => p.id === menuProject.id),
            menuSiblings.length,
            groupSortOf(groupSorts, menuProject.id),
            {
              rename: () => setRenamingProjectId(menuProject.id),
              settings: () => openProjectPage({ mode: 'edit', projectId: menuProject.id, returnFocus: headingSelector(menuProject.id) }),
              schedule: () => openSchedules({ kind: 'project', projectId: menuProject.id }),
              move: (dir) => void moveProject(menuProject.id, dir),
              setSort: (sort) => {
                setGroupSort(menuProject.id, sort);
                focusLater(headingSelector(menuProject.id), LIST_SELECTOR);
              },
              newSubProject: () => openProjectPage({ mode: 'create', parentId: menuProject.id, returnFocus: headingSelector(menuProject.id) }),
              moveUnder: (parentId) => void moveProjectUnder(menuProject.id, parentId),
              requestDelete: () => setDeletingProjectId(menuProject.id),
            },
            {
              parentId: projectParentOf(menuProject, lookup)?.id ?? null,
              candidates: orderedProjects.filter((p) => p.id !== menuProject.id && projectParentOf(p, lookup) === null),
              // As the server checks it: any project naming this one as its parent.
              hasChildren: projects.some((p) => p.parentId === menuProject.id),
            }
          )}
          onClose={(reason) => {
            setProjectMenu(null);
            if (reason === 'dismiss') focusLater(headingSelector(menuProject.id), LIST_SELECTOR);
          }}
        />
      )}

      {noProjectMenu && (
        <Menu
          key="no-project"
          label="No project actions"
          position={noProjectMenu}
          items={[
            groupSortItem(groupSortOf(groupSorts, NO_PROJECT_KEY), (sort) => {
              setGroupSort(NO_PROJECT_KEY, sort);
              focusLater(headingSelector(NO_PROJECT_KEY), LIST_SELECTOR);
            }),
          ]}
          onClose={(reason) => {
            setNoProjectMenu(null);
            if (reason === 'dismiss') focusLater(headingSelector(NO_PROJECT_KEY), LIST_SELECTOR);
          }}
        />
      )}

      {appMenu && menuApp && (
        <Menu
          key={`app:${menuApp.id}`}
          label="App actions"
          position={appMenu.position}
          items={appMenuItems(
            {
              rename: () => setRenamingAppId(menuApp.id),
              edit: () => openAppPage({ mode: 'edit', appId: menuApp.id, returnFocus: headingSelector(menuApp.id) }),
              close: () => void closeApp(menuApp),
              keep: () => void keepApp(menuApp),
              move: (dir) => void moveApp(menuApp.id, dir),
              requestDelete: () => setDeletingAppId(menuApp.id),
            },
            menuApp.open,
            appPlace(menuApp.id)
          )}
          onClose={(reason) => {
            setAppMenu(null);
            if (reason === 'dismiss') focusLater(headingSelector(menuApp.id), LIST_SELECTOR);
          }}
        />
      )}

      {deletingApp && (
        <ConfirmDialog
          title={`Delete ${deletingApp.name}?`}
          message="Its chats move back to Chat mode; nothing is deleted."
          confirmLabel="Delete"
          onConfirm={() => deleteApp(deletingApp.id)}
          onCancel={() => {
            setDeletingAppId(null);
            focusLater(headingSelector(deletingApp.id), LIST_SELECTOR);
          }}
        />
      )}

      {deletingProject && (
        <ConfirmDialog
          title={`Delete project '${deletingProject.name}'?`}
          message={[
            projects.some((p) => p.parentId === deletingProject.id)
              ? 'Its chats move to No project. Its sub-projects become top-level projects.'
              : 'Its chats move to No project.',
            projectSchedulesLine,
          ]
            .filter((line) => line !== null)
            .join(' ')}
          confirmLabel="Delete"
          onConfirm={() => deleteProject(deletingProject.id)}
          onCancel={() => {
            setDeletingProjectId(null);
            focusLater(headingSelector(deletingProject.id), LIST_SELECTOR);
          }}
        />
      )}
    </>
  );
}
