import { DEFAULT_SCHEDULE_TIME_LIMIT_MINUTES, formatInZone, timeLimitText } from '@otherbench/core/domain/schedule.js';
import type { ScheduleRun } from '@otherbench/core/ports/store.js';

/** A run's status as the Schedules rows and history say it. */
export const STATUS_LABEL: Record<ScheduleRun['status'], string> = {
  running: 'Running',
  complete: 'Complete',
  error: 'Failed',
  cancelled: 'Stopped',
  timed_out: 'Timed out',
  not_started: "Didn't run",
};

function untilText(at: number, now: number): string {
  const minutes = Math.round((at - now) / 60_000);
  if (minutes < 1) return 'in under a minute';
  if (minutes < 60) return `in ${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `in ${hours} h`;
  return `in ${Math.round(hours / 24)} days`;
}

/** "Paused", "Due now", or the next run in the schedule's own zone and how far off it is. */
export function nextRunText(s: { enabled: boolean; nextRunAt: number | null; timezone: string }, now: number): string {
  if (!s.enabled || s.nextRunAt === null) return 'Paused';
  if (s.nextRunAt <= now) return 'Due now';
  return `${formatInZone(s.nextRunAt, s.timezone, 'long')} (${s.timezone}), ${untilText(s.nextRunAt, now)}`;
}

/** " · No time limit" or " · Time limit 2 hours", and nothing for the usual 30 minutes. */
export function timeLimitSuffix(minutes: number | null): string {
  if (minutes === null) return ' · No time limit';
  return minutes === DEFAULT_SCHEDULE_TIME_LIMIT_MINUTES ? '' : ` · Time limit ${timeLimitText(minutes)}`;
}

/** " · 1 file" or " · 3 files" for what each run sends with the prompt, and nothing for none. */
export function filesSuffix(count: number): string {
  if (count === 0) return '';
  return count === 1 ? ' · 1 file' : ` · ${count} files`;
}
