import type { JSX } from 'react';
import type { Chat } from '@grunt/core/ports/store.js';
import { revealSidebarGroup } from '../state/sidebarGroups.js';
import { useGruntStore } from '../state/store.js';

/**
 * The Inspector's "Project" line (spec 2026-10-03-projects-design §4): the
 * chat's project as a link that expands and scrolls to its sidebar group, or
 * "No project"; plus the project's description and a way into its settings
 * (spec 2026-10-08-project-page-design §3). A chat whose project isn't loaded
 * (deleted elsewhere) reads as No project, the same as the sidebar.
 */
export function InspectorProject({ chat }: { chat: Chat }): JSX.Element {
  const project = useGruntStore((s) => (chat.projectId === null ? null : (s.projects.find((p) => p.id === chat.projectId) ?? null)));
  const openProjectPage = useGruntStore((s) => s.openProjectPage);

  if (!project) {
    return (
      <p data-testid="inspector-project" className="text-sm text-[var(--text-faint)]">
        No project
      </p>
    );
  }
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2">
        <button
          type="button"
          data-testid="inspector-project"
          onClick={() => revealSidebarGroup(project.id)}
          title="Show in the sidebar"
          className="min-w-0 flex-1 truncate text-left text-sm text-[var(--accent)] underline-offset-2 hover:underline"
        >
          {project.name}
        </button>
        <button
          type="button"
          aria-label="Project settings…"
          onClick={() => openProjectPage({ mode: 'edit', projectId: project.id })}
          className="btn shrink-0 px-2 py-0.5"
        >
          Settings…
        </button>
      </div>
      {project.description && (
        <p data-testid="inspector-project-description" title={project.description} className="line-clamp-2 text-xs text-[var(--text-muted)]">
          {project.description}
        </p>
      )}
    </div>
  );
}
