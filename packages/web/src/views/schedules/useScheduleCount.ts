import { useEffect, useState } from 'react';
import type { ScheduleTarget } from '@otherbench/core/domain/schedule.js';
import type { Schedule } from '@otherbench/core/ports/store.js';
import { useChanged } from '../../lib/useChanged.js';
import { api } from '../../state/api.js';

/** How many of `schedules` run on `target`: a chat's, or a project's own (not its sub-projects'). */
export function countSchedulesFor(schedules: Pick<Schedule, 'target'>[], target: ScheduleTarget): number {
  return schedules.filter((s) =>
    target.kind === 'chat' ? s.target.kind === 'chat' && s.target.chatId === target.chatId : s.target.kind === 'project' && s.target.projectId === target.projectId
  ).length;
}

/**
 * How many of `schedules` go when a profile is deleted: those run on it, and
 * those whose target chat is built on it (`chatIds`), since that chat is
 * deleted with the profile and takes its schedules with it (023-schedules
 * cascades from both).
 */
export function countProfileSchedules(schedules: Pick<Schedule, 'profileId' | 'target'>[], profileId: string, chatIds: ReadonlySet<string>): number {
  return schedules.filter((s) => s.profileId === profileId || (s.target.kind === 'chat' && chatIds.has(s.target.chatId))).length;
}

/** The delete dialog's line for a chat, project or profile with schedules, which go with it (023-schedules cascades); null for none. */
export function schedulesDeletedLine(count: number | null): string | null {
  if (count === null || count === 0) return null;
  return count === 1 ? 'Its schedule is deleted too.' : `Its ${count} schedules are deleted too.`;
}

/**
 * The schedule list, read from the server whenever `key` changes to a
 * non-null value, for a delete dialog. Null while it is read, when `key` is
 * null, or when the list can't be read: the dialog then just leaves its line
 * out. Another key goes back to null in the same render, so the last one's
 * list is never counted for it.
 */
function useScheduleList(key: string | null): Schedule[] | null {
  const [list, setList] = useState<Schedule[] | null>(null);
  if (useChanged([key])) setList(null);
  useEffect(() => {
    if (key === null) return;
    let live = true;
    Promise.resolve()
      .then(() => api.schedules.list())
      .then(
        (rows) => {
          if (live && Array.isArray(rows)) setList(rows);
        },
        () => {}
      );
    return () => {
      live = false;
    };
  }, [key]);
  return list;
}

/** How many schedules run on `target`, for its delete dialog; null while unknown (see `useScheduleList`). */
export function useScheduleCount(target: ScheduleTarget | null): number | null {
  const key = target === null ? null : target.kind === 'chat' ? `chat:${target.chatId}` : `project:${target.projectId}`;
  const list = useScheduleList(key);
  return list === null || target === null ? null : countSchedulesFor(list, target);
}

/**
 * How many schedules go with a profile (`countProfileSchedules`), read when
 * its form opens, so the delete confirmation (a synchronous `window.confirm`)
 * has the number ready. Null while unknown.
 */
export function useProfileScheduleCount(profileId: string | null, chatIds: ReadonlySet<string>): number | null {
  const list = useScheduleList(profileId === null ? null : `profile:${profileId}`);
  return list === null || profileId === null ? null : countProfileSchedules(list, profileId, chatIds);
}
