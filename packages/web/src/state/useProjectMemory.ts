import { useEffect, useState } from 'react';
import type { ProjectMemoryView } from '@grunt/core/domain/memory.js';
import { api } from './api.js';

/** How often a project's memory is re-read: the summariser changes it in the background. */
export const MEMORY_POLL_MS = 15_000;

/** A project's memory, loaded on a project switch and then polled. */
export function useProjectMemory(projectId: string): { view: ProjectMemoryView | null; loadFailed: boolean; setView: (view: ProjectMemoryView) => void } {
  const [view, setView] = useState<ProjectMemoryView | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setView(null);
    setLoadFailed(false);
    async function tick(): Promise<void> {
      try {
        const next = await api.memory.get(projectId);
        if (!cancelled) {
          setView(next);
          setLoadFailed(false);
        }
      } catch (err) {
        console.error(`[grunt-web] failed to load memory for project ${projectId}:`, err);
        if (!cancelled) setLoadFailed(true);
      }
      if (!cancelled) timer = setTimeout(() => void tick(), MEMORY_POLL_MS);
    }
    void tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [projectId]);

  return { view, loadFailed, setView };
}
