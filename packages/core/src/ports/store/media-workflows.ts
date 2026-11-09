import type { MediaWorkflow } from '../../domain/media-workflows.js';

// --- media workflows ---------------------------------------------------------

/** Imported ComfyUI workflows (migration 031); a synced table. Stored rows are never `builtin`. */
export interface MediaWorkflowRepo {
  list(): MediaWorkflow[];
  get(id: string): MediaWorkflow | null;
  create(wf: MediaWorkflow): MediaWorkflow;
  update(id: string, patch: Partial<Omit<MediaWorkflow, 'id' | 'builtin'>>): MediaWorkflow;
  delete(id: string): void;
}
