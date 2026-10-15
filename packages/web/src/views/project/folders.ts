import type { Project } from '@grunt/core/ports/store.js';

/**
 * Where a project's main folder is when it isn't on this machine (another
 * machine's path, or a location not set up here), so an empty folder field
 * doesn't read as "no folder". Null when it resolves here or there is none.
 */
export function awayFolderWhere(project: Project | null): string | null {
  if (!project?.workspace || project.workspaceRoot) return null;
  const status = project.workspaceStatus;
  return status?.status === 'unresolved' && status.hint ? `Set on another machine: ${status.hint.path}.` : "Set to a location that isn't set up on this machine.";
}
