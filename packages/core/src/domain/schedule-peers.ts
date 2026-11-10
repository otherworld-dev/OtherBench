/**
 * Managing a machine's schedules from a paired machine (docs/features/scheduled-tasks.md, "Across machines"). Only
 * while the machine holding them lets it (`AppSettings.peerScheduleControl`, off by default): every change one makes
 * there is recorded with the machine it came from, as an approval is audited with the machine it was decided on.
 */

/** What a paired machine did to a schedule. `ran` is Run now. */
export type SchedulePeerChangeAction = 'created' | 'edited' | 'paused' | 'resumed' | 'deleted' | 'ran';

/** How many changes from paired machines a machine keeps, newest first, across all its schedules. */
export const SCHEDULE_PEER_CHANGES_KEPT = 500;

/** How a change reads after "Changed from Laptop": "paused", "run now". */
export const SCHEDULE_PEER_CHANGE_TEXT: Record<SchedulePeerChangeAction, string> = {
  created: 'made',
  edited: 'edited',
  paused: 'paused',
  resumed: 'resumed',
  deleted: 'deleted',
  ran: 'run now',
};

/**
 * What a PATCH body did, for the record: a body that only sets `enabled` is a pause or a resume (as the row's
 * Pause and Resume send it), anything else is an edit.
 */
export function patchAction(body: unknown, wasEnabled: boolean): SchedulePeerChangeAction {
  const keys = typeof body === 'object' && body !== null && !Array.isArray(body) ? Object.keys(body) : [];
  if (keys.length === 1 && keys[0] === 'enabled') {
    const enabled = (body as { enabled: unknown }).enabled;
    if (enabled === false) return 'paused';
    if (enabled === true) return wasEnabled ? 'edited' : 'resumed';
  }
  return 'edited';
}
