/** Scheduled task calls and shapes for `api.schedules`. */
import type { ScheduleRun, ScheduleView } from '@otherbench/core/ports/store.js';
import type { ScheduleRule } from '@otherbench/core/domain/schedule.js';
import { request, post, patch, del } from './http.js';

/** `POST /api/schedules` (spec 2026-10-12-scheduled-tasks-design). The server sets the time zone. */
export interface CreateScheduleBody {
  name: string;
  prompt: string;
  profileId: string;
  target: { chatId: string } | { projectId: string };
  rule: ScheduleRule;
  enabled?: boolean;
  autoMode?: boolean;
  /** Minutes, or null for no limit; left out on create it is 30. */
  timeLimitMinutes?: number | null;
}

/** `PATCH /api/schedules/:id`: any of these; the target can't change. */
export interface PatchScheduleBody {
  name?: string;
  prompt?: string;
  profileId?: string;
  rule?: ScheduleRule;
  enabled?: boolean;
  autoMode?: boolean;
  /** Minutes, or null for no limit; left out on create it is 30. */
  timeLimitMinutes?: number | null;
}

/** Scheduled tasks: local to the server machine. Run now answers 409 with a reason when it can't start. */
export const schedulesApi = {
  list: () => request<ScheduleView[]>('/schedules'),
  create: (body: CreateScheduleBody) => post<ScheduleView>('/schedules', body),
  patch: (id: string, body: PatchScheduleBody) => patch<ScheduleView>(`/schedules/${id}`, body),
  delete: (id: string) => del(`/schedules/${id}`),
  /** Newest first. */
  runs: (id: string) => request<ScheduleRun[]>(`/schedules/${id}/runs`),
  run: (id: string) => post<ScheduleRun>(`/schedules/${id}/run`),
};
