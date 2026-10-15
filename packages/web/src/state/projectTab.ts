import { isViewTab } from '../viewer/items.js';

/**
 * A project's home page open as a tab (spec 2026-10-15-project-home-design §1).
 * A chat id never starts with this, the same as the viewer's `view:` prefix.
 */
export const PROJECT_TAB_PREFIX = 'project:';

export function projectTabId(projectId: string): string {
  return PROJECT_TAB_PREFIX + projectId;
}

/** The project id a project tab names, or null when the id isn't one. */
export function parseProjectTab(id: string | null | undefined): string | null {
  if (typeof id !== 'string' || !id.startsWith(PROJECT_TAB_PREFIX)) return null;
  const projectId = id.slice(PROJECT_TAB_PREFIX.length);
  return projectId.length > 0 ? projectId : null;
}

/** A tab or pane id that names a chat, not a viewer item or a project page. */
export function isChatTab(id: string | null | undefined): id is string {
  return typeof id === 'string' && !isViewTab(id) && parseProjectTab(id) === null;
}
