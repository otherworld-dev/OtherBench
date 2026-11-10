/** Scheduled task calls and shapes for `api.schedules`. */
import type { PublicScheduleAttachment, ScheduleRun, ScheduleView } from '@otherbench/core/ports/store.js';
import type { ScheduleRule } from '@otherbench/core/domain/schedule.js';
import { request, post, patch, del, uploadFile } from './http.js';

/** `POST /api/schedules` (spec 2026-10-12-scheduled-tasks-design). The zone is the server's unless `timezone` is given. */
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
  /** An IANA zone; left out, the server's own. */
  timezone?: string;
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
  /** An IANA zone; a new one recomputes the next run in it. */
  timezone?: string;
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
  /** Adds a file every run sends with the prompt (25MB at most, 10 files a schedule). */
  uploadAttachment: (id: string, file: File) => uploadFile<PublicScheduleAttachment>(`/schedules/${id}/attachments`, file),
  deleteAttachment: (id: string, attachmentId: string) => del(`/schedules/${id}/attachments/${attachmentId}`),
};
