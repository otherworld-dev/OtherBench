/** The Overview calls for `api.overview`. */
import type { Overview } from '@otherbench/core/types/overview.js';
import { request, post } from './http.js';

/** The Overview: what needs you across apps (server `routes/overview.ts`). Each call answers the whole Overview. */
export const overviewApi = {
  get: () => request<Overview>('/overview'),
  refresh: () => post<Overview>('/overview/refresh'),
  /** GitHub's Done on a notification thread (spec 2026-10-29-github-inbox-design). */
  markDone: (id: string) => post<Overview>(`/overview/notifications/${encodeURIComponent(id)}/done`),
  markRead: (id: string) => post<Overview>(`/overview/notifications/${encodeURIComponent(id)}/read`),
  /** Chats only: notifications are marked done one at a time. */
  /** Ticks off chats whose reply is older than `olderThan` ms; the server works out the cut-off from its own clock. */
  tickOlder: (olderThan: number) => post<{ chats: number }>('/overview/tick-older', { olderThan }),
};
