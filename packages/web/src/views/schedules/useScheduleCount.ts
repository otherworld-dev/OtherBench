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

/** The delete dialog's line for a chat or project with schedules, which go with it (023-schedules cascades); null for none. */
export function schedulesDeletedLine(count: number | null): string | null {
  if (count === null || count === 0) return null;
  return count === 1 ? 'Its schedule is deleted too.' : `Its ${count} schedules are deleted too.`;
}

/**
 * How many schedules run on `target`, read from the server when it is set,
 * for a delete dialog. Null while it is read, when there is no target, or
 * when the list can't be read: the dialog then just leaves the line out.
 */
export function useScheduleCount(target: ScheduleTarget | null): number | null {
  const [count, setCount] = useState<number | null>(null);
  const key = target === null ? null : target.kind === 'chat' ? `chat:${target.chatId}` : `project:${target.projectId}`;
  // Another target goes back to null in the same render, so the last one's count is never said of it.
  if (useChanged([key])) setCount(null);
  useEffect(() => {
    if (target === null) return;
    let live = true;
    Promise.resolve()
      .then(() => api.schedules.list())
      .then(
        (list) => {
          if (live && Array.isArray(list)) setCount(countSchedulesFor(list, target));
        },
        () => {}
      );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `key` stands for `target`, a new object on every render.
  }, [key]);
  return count;
}
