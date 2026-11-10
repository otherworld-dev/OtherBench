import { useEffect, useState, type JSX } from 'react';
import { formatInZone } from '@otherbench/core/domain/schedule.js';
import type { ScheduleRun } from '@otherbench/core/ports/store.js';
import { STATUS_LABEL } from './rowText.js';

function triggerText(run: ScheduleRun, timezone: string): string {
  if (run.trigger === 'manual') return 'By hand';
  if (run.trigger === 'late' && run.dueAt !== null) return `Late (due ${formatInZone(run.dueAt, timezone, 'time')})`;
  return 'On time';
}

interface ScheduleHistoryProps {
  schedule: { id: string; timezone: string };
  /** Where the runs come from: this machine's `/api/schedules`, or the paired machine that holds the schedule. */
  load(id: string): Promise<ScheduleRun[]>;
  /** Read again when this changes. */
  refreshKey: string;
  /** Opens a run's chat; left out where the chat may not be on this machine yet (`canOpen`). */
  onOpen(chatId: string): void;
  /** Whether a run's chat can be opened here; every one when left out. */
  canOpen?(chatId: string): boolean;
}

/** A schedule's History list (newest first): when each run started, why, how it ended, and Open for its chat. */
export function ScheduleHistory({ schedule, load, refreshKey, onOpen, canOpen }: ScheduleHistoryProps): JSX.Element {
  const [runs, setRuns] = useState<ScheduleRun[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    load(schedule.id)
      .then((r) => {
        if (!cancelled) setRuns(r);
      })
      .catch((err: unknown) => {
        console.error('[otherbench-web] failed to load a schedule history:', err);
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
    // `load` is a new function on every render of the row; the schedule and the refresh key say when to read again.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- see above
  }, [schedule.id, refreshKey]);

  if (failed) return <p className="text-[var(--danger)]">Couldn&rsquo;t load the history.</p>;
  if (!runs) return <p className="text-[var(--text-faint)]">Loading…</p>;
  if (runs.length === 0) return <p className="text-[var(--text-faint)]">No runs yet.</p>;
  return (
    <ol data-testid={`schedule-history-${schedule.id}`} className="mt-2 space-y-1 border-t border-[var(--border)] pt-2">
      {runs.map((r) => (
        <li key={r.id} data-testid={`schedule-run-${r.id}`} className="flex flex-wrap items-center gap-x-2">
          <span>{formatInZone(r.startedAt, schedule.timezone, 'long')}</span>
          <span className="text-[var(--text-muted)]">{triggerText(r, schedule.timezone)}</span>
          <span data-testid="run-status">{STATUS_LABEL[r.status]}</span>
          {r.detail && <span className="text-[var(--text-muted)]">{r.detail}</span>}
          {r.refusedCalls > 0 && (
            <span className="text-[var(--text-muted)]">
              {r.refusedCalls} tool call{r.refusedCalls === 1 ? '' : 's'} refused (needed approval)
            </span>
          )}
          {r.chatId && (canOpen?.(r.chatId) ?? true) && (
            <button type="button" onClick={() => onOpen(r.chatId!)} className="btn px-1.5 py-0.5 text-xs">
              Open
            </button>
          )}
        </li>
      ))}
    </ol>
  );
}
