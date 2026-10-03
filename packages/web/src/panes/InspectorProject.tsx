import type { JSX } from 'react';
import type { Chat } from '@grunt/core/ports/store.js';
import { revealSidebarGroup } from '../state/sidebarGroups.js';
import { useGruntStore } from '../state/store.js';

/**
 * The Inspector's "Project" line (spec 2026-10-03-projects-design §4): the
 * chat's project as a link that expands and scrolls to its sidebar group, or
 * "No project". A chat whose project isn't loaded (deleted elsewhere) reads
 * as No project, the same as the sidebar.
 */
export function InspectorProject({ chat }: { chat: Chat }): JSX.Element {
  const project = useGruntStore((s) => (chat.projectId === null ? null : (s.projects.find((p) => p.id === chat.projectId) ?? null)));

  if (!project) {
    return (
      <p data-testid="inspector-project" className="text-sm text-[var(--text-faint)]">
        No project
      </p>
    );
  }
  return (
    <button
      type="button"
      data-testid="inspector-project"
      onClick={() => revealSidebarGroup(project.id)}
      title="Show in the sidebar"
      className="max-w-full truncate text-left text-sm text-[var(--accent)] underline-offset-2 hover:underline"
    >
      {project.name}
    </button>
  );
}
