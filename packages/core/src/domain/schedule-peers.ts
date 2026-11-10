/**
 * Managing a machine's schedules from a paired machine (docs/features/scheduled-tasks.md, "Across machines"). Only
 * while the machine holding them lets it (`AppSettings.peerScheduleControl`, off by default): every change one makes
 * there is recorded with the machine it came from, as an approval is audited with the machine it was decided on.
 */

/** What a paired machine did to a schedule. `ran` is Run now. */
export type SchedulePeerChangeAction = 'created' | 'edited' | 'paused' | 'resumed' | 'deleted' | 'ran';

/**
 * The cheap, repeatable changes: a pause, a resume, a Run now. Only these are ever trimmed by count, per schedule,
 * so a paired machine can't push the record of a create, an edit or a delete out by sending many of them.
 */
export const ROUTINE_SCHEDULE_PEER_CHANGES: readonly SchedulePeerChangeAction[] = ['paused', 'resumed', 'ran'];

/**
 * How long the record of a paired machine's change is kept, in days. A create, an edit or a delete is only ever
 * dropped for age, never to make room.
 */
export const SCHEDULE_PEER_CHANGE_DAYS_KEPT = 90;

/** How many routine changes (pause, resume, Run now) are kept per schedule, besides the newest of each kind. */
export const SCHEDULE_PEER_ROUTINE_KEPT = 20;

/** How a change reads before "from Laptop, 2 min ago" on a schedule's row: "Paused", "Run now". */
export const SCHEDULE_PEER_CHANGE_TEXT: Record<SchedulePeerChangeAction, string> = {
  created: 'Made',
  edited: 'Edited',
  paused: 'Paused',
  resumed: 'Resumed',
  deleted: 'Deleted',
  ran: 'Run now',
};

/** The fields of a schedule whose change is an edit (`schedulePatchAction`). */
export interface ScheduleEditedFields {
  name: string;
  prompt: string;
  profileId: string;
  rule: unknown;
  autoMode: boolean;
  timeLimitMinutes: number | null;
  timezone: string;
  enabled: boolean;
}

/**
 * What a PATCH did, read from the schedule before and after it rather than from what was sent: a change to its
 * name, prompt, profile, rule, auto mode, time limit or time zone is an edit (kept until it ages out, however many pauses
 * follow); a change only to whether it is on is a pause or a resume; nothing changed is null, and nothing is recorded.
 */
export function schedulePatchAction(before: ScheduleEditedFields, after: ScheduleEditedFields): SchedulePeerChangeAction | null {
  const edited =
    before.name !== after.name ||
    before.prompt !== after.prompt ||
    before.profileId !== after.profileId ||
    JSON.stringify(before.rule) !== JSON.stringify(after.rule) ||
    before.autoMode !== after.autoMode ||
    before.timeLimitMinutes !== after.timeLimitMinutes ||
    before.timezone !== after.timezone;
  if (edited) return 'edited';
  if (before.enabled !== after.enabled) return after.enabled ? 'resumed' : 'paused';
  return null;
}
