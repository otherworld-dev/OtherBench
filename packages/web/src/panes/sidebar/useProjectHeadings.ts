import { useState, type Dispatch, type SetStateAction } from 'react';
import type { Project } from '@otherbench/core/ports/store.js';
import type { Profile } from '@otherbench/core/types/config.js';
import { ApiError, api } from '../../state/api.js';
import { projectTabId } from '../../state/projectTab.js';
import { NO_PROJECT_KEY, setGroupCollapsed } from '../../state/sidebarGroups.js';
import { useOtherBenchStore } from '../../state/store.js';
import { schedulesDeletedLine, useScheduleCount } from '../../views/schedules/useScheduleCount.js';
import type { DropPosition, MenuSource } from './ChatRow.js';
import { errorText } from './errorText.js';
import { focusLater, headingSelector, LIST_SELECTOR, neighbourHeadingSelector } from './focus.js';
import { moveProjectPatches, placeProjectPatches, projectSiblings } from './model.js';
import type { ProjectGroupProps } from './ProjectGroup.js';
import type { ChatMenuAt } from './useChatActions.js';

/**
 * Chat mode's project headings, and No project's: each one's menu, rename, Move under, delete, and reordering among
 * its siblings by drag or Move up / Move down. Opening a heading's menu closes the chat menu and the other heading's.
 */
export function useProjectHeadings({
  projects,
  profiles,
  searching,
  activeChatId,
  creating,
  createChat,
  setError,
  setChatMenu,
}: {
  projects: Project[];
  profiles: Profile[];
  searching: boolean;
  activeChatId: string | null;
  creating: boolean;
  createChat: (into?: { projectId: string } | { appId: string }) => Promise<void>;
  setError: Dispatch<SetStateAction<string | null>>;
  setChatMenu: Dispatch<SetStateAction<ChatMenuAt | null>>;
}) {
  const setActiveChatId = useOtherBenchStore((s) => s.setActiveChatId);
  const upsertProject = useOtherBenchStore((s) => s.upsertProject);
  const removeProject = useOtherBenchStore((s) => s.removeProject);
  const setProjects = useOtherBenchStore((s) => s.setProjects);
  const [noProjectMenu, setNoProjectMenu] = useState<{ x: number; y: number } | null>(null);
  // The project heading being dragged, and the sibling heading it's over: where a drop would place it.
  const [draggingProjectId, setDraggingProjectId] = useState<string | null>(null);
  const [projectDrop, setProjectDrop] = useState<{ projectId: string; position: DropPosition } | null>(null);
  const [projectMenu, setProjectMenu] = useState<{ projectId: string; position: { x: number; y: number } } | null>(null);
  const [renamingProjectId, setRenamingProjectId] = useState<string | null>(null);
  const [deletingProjectId, setDeletingProjectId] = useState<string | null>(null);
  const menuProject = projectMenu ? (projects.find((p) => p.id === projectMenu.projectId) ?? null) : null;
  const menuSiblings = menuProject ? projectSiblings(projects, menuProject.id) : [];
  const deletingProject = deletingProjectId ? (projects.find((p) => p.id === deletingProjectId) ?? null) : null;
  const projectSchedulesLine = schedulesDeletedLine(useScheduleCount(deletingProjectId ? { kind: 'project', projectId: deletingProjectId } : null));

  function openProjectMenu(projectId: string, position: { x: number; y: number }, source: MenuSource): void {
    setChatMenu(null);
    setNoProjectMenu(null);
    if (source === 'button' && projectMenu?.projectId === projectId) {
      setProjectMenu(null);
      focusLater(headingSelector(projectId), LIST_SELECTOR);
      return;
    }
    setProjectMenu({ projectId, position });
  }

  async function renameProject(projectId: string, name: string): Promise<void> {
    setRenamingProjectId(null);
    setError(null);
    try {
      upsertProject(await api.projects.patch(projectId, { name }));
    } catch (err) {
      console.error(`[otherbench-web] failed to rename project ${projectId}:`, err);
      setError(errorText(err, "Couldn't rename the project"));
    }
    focusLater(headingSelector(projectId), LIST_SELECTOR);
  }

  /** Puts a project under a top-level one (opening that group so it stays in view), or back at the top level. */
  async function moveProjectUnder(projectId: string, parentId: string | null): Promise<void> {
    setError(null);
    try {
      upsertProject(await api.projects.patch(projectId, { parentId }));
      if (parentId) setGroupCollapsed(parentId, false);
    } catch (err) {
      console.error(`[otherbench-web] failed to move project ${projectId}:`, err);
      setError(errorText(err, "Couldn't move the project"));
    }
    focusLater(headingSelector(projectId), LIST_SELECTOR);
  }

  /** Sends project order PATCHes one by one; on a failure says so and shows the server's order, since part may have landed. */
  async function sendProjectOrder(patches: { id: string; sortOrder: number }[], focusId: string): Promise<void> {
    setError(null);
    try {
      for (const { id, sortOrder } of patches) upsertProject(await api.projects.patch(id, { sortOrder }));
    } catch (err) {
      console.error('[otherbench-web] failed to reorder projects:', err);
      setError(errorText(err, "Couldn't reorder the projects"));
      try {
        setProjects(await api.projects.list());
      } catch {
        // the error line above already says something went wrong.
      }
    }
    focusLater(headingSelector(focusId), LIST_SELECTOR);
  }

  /** Puts a dragged project above or below sibling `targetId` (a drop on its heading). */
  async function placeProject(movingId: string, targetId: string, position: DropPosition): Promise<void> {
    const siblings = projectSiblings(projects, movingId);
    if (movingId === targetId || !siblings.some((p) => p.id === targetId)) return;
    let beforeId: string | null = targetId;
    if (position === 'after') {
      const rest = siblings.filter((p) => p.id !== movingId);
      beforeId = rest[rest.findIndex((p) => p.id === targetId) + 1]?.id ?? null;
    }
    const patches = placeProjectPatches(siblings, movingId, beforeId);
    if (patches.length > 0) await sendProjectOrder(patches, movingId);
  }

  async function moveProject(projectId: string, dir: -1 | 1): Promise<void> {
    await sendProjectOrder(moveProjectPatches(projectSiblings(projects, projectId), projectId, dir), projectId);
  }

  function openNoProjectMenu(position: { x: number; y: number }, source: MenuSource): void {
    setChatMenu(null);
    setProjectMenu(null);
    if (source === 'button' && noProjectMenu !== null) {
      setNoProjectMenu(null);
      focusLater(headingSelector(NO_PROJECT_KEY), LIST_SELECTOR);
      return;
    }
    setNoProjectMenu(position);
  }

  /** Rejects on failure, which keeps the confirmation dialog open with the message. */
  async function deleteProject(projectId: string): Promise<void> {
    const next = neighbourHeadingSelector(projectId);
    try {
      await api.projects.delete(projectId);
    } catch (err) {
      // Already gone (deleted in another tab): same end state the user asked for.
      if (!(err instanceof ApiError && err.status === 404)) throw err;
    }
    removeProject(projectId); // its chats move to No project here too, as on the server
    setDeletingProjectId(null);
    focusLater(next, LIST_SELECTOR);
  }

  /** The project-only props of a group heading. */
  function projectGroupProps(project: Project): Partial<ProjectGroupProps> {
    // A heading takes a dragged project only from its own siblings (top level, or the same parent's sub-projects).
    const target = draggingProjectId !== null && draggingProjectId !== project.id && projectSiblings(projects, project.id).some((p) => p.id === draggingProjectId);
    return {
      reorder: {
        draggable: !searching,
        onDragStart: () => setDraggingProjectId(project.id),
        onDragEnd: () => {
          setDraggingProjectId(null);
          setProjectDrop(null);
        },
        target,
        indicator: target && projectDrop?.projectId === project.id ? projectDrop.position : null,
        onOver: (position) => setProjectDrop({ projectId: project.id, position }),
        onLeave: () => setProjectDrop((current) => (current?.projectId === project.id ? null : current)),
        onDrop: (position) => {
          const moving = draggingProjectId;
          setDraggingProjectId(null);
          setProjectDrop(null);
          if (moving) void placeProject(moving, project.id, position);
        },
      },
      onNewChat: () => void createChat({ projectId: project.id }),
      onOpen: () => setActiveChatId(projectTabId(project.id)),
      active: activeChatId === projectTabId(project.id),
      newChatDisabled: creating || profiles.length === 0,
      menuOpen: projectMenu?.projectId === project.id,
      renaming: renamingProjectId === project.id,
      onOpenMenu: (position, source) => openProjectMenu(project.id, position, source),
      onRename: (name) => void renameProject(project.id, name),
      onRenameCancel: () => {
        setRenamingProjectId(null);
        focusLater(headingSelector(project.id), LIST_SELECTOR);
      },
    };
  }

  return {
    projectMenu,
    setProjectMenu,
    noProjectMenu,
    setNoProjectMenu,
    openNoProjectMenu,
    menuProject,
    menuSiblings,
    deletingProject,
    projectSchedulesLine,
    setRenamingProjectId,
    setDeletingProjectId,
    moveProject,
    moveProjectUnder,
    deleteProject,
    projectGroupProps,
  };
}

export type ProjectHeadings = ReturnType<typeof useProjectHeadings>;
