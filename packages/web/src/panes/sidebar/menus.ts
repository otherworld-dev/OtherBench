import type { Chat, Project } from '@grunt/core/ports/store.js';
import type { MenuItem } from '../../components/Menu.js';
import { NO_PROJECT_KEY } from '../../state/sidebarGroups.js';

export interface ChatMenuHandlers {
  /** Opens the chat as a tab (or goes to its tab) (#824). */
  openInTab(): void;
  rename(): void;
  /** Sets the pin state the menu item asked for (the opposite of the state the menu was built with). */
  setPinned(pinned: boolean): void;
  /** One place up (-1) or down (+1) within its sidebar section (#823). */
  reorder(dir: -1 | 1): void;
  moveTo(projectId: string | null): void;
  /** Makes a new project named after the chat and moves the chat into it. */
  moveToNewProject(): void;
  /** Downloads the chat (#820). */
  exportAs(format: 'markdown' | 'json'): void;
  /** Sets "Don't add to project memory" to the given state (the opposite of the chat's state when the menu was built). */
  setMemoryExcluded(excluded: boolean): void;
  archive(): void;
  unarchive(): void;
  requestDelete(): void;
}

/**
 * The chat row menu (spec §3 "Chat context menu", plus project memory's toggle). `orderedProjects` must be
 * in display order. A chat whose project isn't in the list counts as being in
 * No project, matching where the sidebar shows it. An archived chat gets
 * "Unarchive" in place of "Archive" (controller ruling R2). `position` is the
 * chat's place in its sidebar section; without it (archived, or while
 * searching) there is no Move up / Move down.
 */
export function chatMenuItems(
  chat: Chat,
  orderedProjects: Project[],
  h: ChatMenuHandlers,
  position: { index: number; count: number } | null = null,
  isTab = false
): MenuItem[] {
  const inListedProject = chat.projectId !== null && orderedProjects.some((p) => p.id === chat.projectId);
  const archived = chat.archivedAt !== null;
  // Memory: every chat feeds the global note, and a chat in a project its project's note too
  // (spec 2026-10-08-global-memory-design); one switch covers both.
  const memory: MenuItem[] = [
    {
      id: 'memory',
      label: chat.memoryExcluded ? 'Add to memory' : "Don't add to memory",
      onSelect: () => h.setMemoryExcluded(!chat.memoryExcluded),
    },
  ];
  return [
    { id: 'tab', label: isTab ? 'Go to tab' : 'Open in new tab', onSelect: h.openInTab },
    { id: 'rename', label: 'Rename', onSelect: h.rename },
    ...(archived ? [] : [{ id: 'pin', label: chat.pinned ? 'Unpin' : 'Pin', onSelect: () => h.setPinned(!chat.pinned) }]),
    ...(position
      ? [
          { id: 'up', label: 'Move up', disabled: position.index <= 0, onSelect: () => h.reorder(-1) },
          { id: 'down', label: 'Move down', disabled: position.index >= position.count - 1, onSelect: () => h.reorder(1) },
        ]
      : []),
    {
      id: 'move',
      label: 'Move to project…',
      submenu: [
        ...orderedProjects.map((p) => ({ id: p.id, label: p.name, checked: chat.projectId === p.id, onSelect: () => h.moveTo(p.id) })),
        { id: NO_PROJECT_KEY, label: 'No project', checked: !inListedProject, onSelect: () => h.moveTo(null) },
        { id: 'new-project', label: 'New project…', onSelect: h.moveToNewProject },
      ],
    },
    ...memory,
    {
      id: 'export',
      label: 'Export…',
      submenu: [
        { id: 'markdown', label: 'Markdown (shown conversation)', onSelect: () => h.exportAs('markdown') },
        { id: 'json', label: 'JSON (every branch)', onSelect: () => h.exportAs('json') },
      ],
    },
    archived
      ? { id: 'unarchive', label: 'Unarchive', onSelect: h.unarchive }
      : { id: 'archive', label: 'Archive', onSelect: h.archive },
    { id: 'delete', label: 'Delete…', danger: true, onSelect: h.requestDelete },
  ];
}

export interface ProjectMenuHandlers {
  rename(): void;
  /** Opens the project page for this project. */
  settings(): void;
  move(dir: -1 | 1): void;
  requestDelete(): void;
}

/** A project heading's ⋯ menu (spec §3). `index` of `count` is its display position; Move up/down disable at the ends. */
export function projectMenuItems(index: number, count: number, h: ProjectMenuHandlers): MenuItem[] {
  return [
    { id: 'rename', label: 'Rename', onSelect: h.rename },
    { id: 'settings', label: 'Project settings…', onSelect: h.settings },
    { id: 'up', label: 'Move up', disabled: index <= 0, onSelect: () => h.move(-1) },
    { id: 'down', label: 'Move down', disabled: index >= count - 1, onSelect: () => h.move(1) },
    { id: 'delete', label: 'Delete…', danger: true, onSelect: h.requestDelete },
  ];
}
