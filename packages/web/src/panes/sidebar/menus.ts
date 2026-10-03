import type { Chat, Project } from '@grunt/core/ports/store.js';
import type { MenuItem } from '../../components/Menu.js';
import { NO_PROJECT_KEY } from '../../state/sidebarGroups.js';

export interface ChatMenuHandlers {
  rename(): void;
  /** Sets the pin state the menu item asked for (the opposite of the state the menu was built with). */
  setPinned(pinned: boolean): void;
  moveTo(projectId: string | null): void;
  archive(): void;
  unarchive(): void;
  requestDelete(): void;
}

/**
 * The chat row menu (spec §3 "Chat context menu"). `orderedProjects` must be
 * in display order. A chat whose project isn't in the list counts as being in
 * No project, matching where the sidebar shows it. An archived chat gets
 * "Unarchive" in place of "Archive" (controller ruling R2).
 */
export function chatMenuItems(chat: Chat, orderedProjects: Project[], h: ChatMenuHandlers): MenuItem[] {
  const inListedProject = chat.projectId !== null && orderedProjects.some((p) => p.id === chat.projectId);
  const archived = chat.archivedAt !== null;
  return [
    { id: 'rename', label: 'Rename', onSelect: h.rename },
    ...(archived ? [] : [{ id: 'pin', label: chat.pinned ? 'Unpin' : 'Pin', onSelect: () => h.setPinned(!chat.pinned) }]),
    {
      id: 'move',
      label: 'Move to project…',
      submenu: [
        ...orderedProjects.map((p) => ({ id: p.id, label: p.name, checked: chat.projectId === p.id, onSelect: () => h.moveTo(p.id) })),
        { id: NO_PROJECT_KEY, label: 'No project', checked: !inListedProject, onSelect: () => h.moveTo(null) },
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
  setFolder(): void;
  setDefaultProfile(): void;
  move(dir: -1 | 1): void;
  requestDelete(): void;
}

/** A project heading's ⋯ menu (spec §3). `index` of `count` is its display position; Move up/down disable at the ends. */
export function projectMenuItems(index: number, count: number, h: ProjectMenuHandlers): MenuItem[] {
  return [
    { id: 'rename', label: 'Rename', onSelect: h.rename },
    { id: 'folder', label: 'Set folder…', onSelect: h.setFolder },
    { id: 'profile', label: 'Default profile…', onSelect: h.setDefaultProfile },
    { id: 'up', label: 'Move up', disabled: index <= 0, onSelect: () => h.move(-1) },
    { id: 'down', label: 'Move down', disabled: index >= count - 1, onSelect: () => h.move(1) },
    { id: 'delete', label: 'Delete…', danger: true, onSelect: h.requestDelete },
  ];
}
