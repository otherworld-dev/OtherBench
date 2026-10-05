import type { Workspace } from '@grunt/core/types/workspace.js';
import type { SqlBindValue } from './crud.js';

/**
 * A chat's or project's folder as its four columns (migration 011), in this
 * order: `workspace_location_id`, `workspace_subpath`, `workspace_root`,
 * `workspace_node`. A location-relative folder fills the first two, a
 * machine-bound one the last two.
 */
export const WORKSPACE_COLUMNS = ['workspace_location_id', 'workspace_subpath', 'workspace_root', 'workspace_node'];

export function workspaceToRow(ws: Workspace | null): SqlBindValue[] {
  if (ws === null) return [null, null, null, null];
  if (ws.kind === 'location') return [ws.locationId, ws.subpath, null, null];
  return [null, null, ws.root, ws.nodeId];
}

/** `selfId` covers a machine-bound row with no node, which only a write that bypassed the repos could leave. */
export function workspaceFromRow(row: Record<string, unknown>, selfId: () => string): Workspace | null {
  const locationId = row.workspace_location_id as string | null;
  if (locationId) return { kind: 'location', locationId, subpath: (row.workspace_subpath as string | null) ?? '' };
  const root = row.workspace_root as string | null;
  if (root) return { kind: 'machine', nodeId: (row.workspace_node as string | null) ?? selfId(), root };
  return null;
}
