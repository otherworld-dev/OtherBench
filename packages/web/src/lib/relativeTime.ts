/** "just now", "5 min ago", "3 h ago", then the local date and time after a day. */
export function formatRelativeTime(at: number, now: number = Date.now()): string {
  const seconds = Math.max(0, Math.floor((now - at) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return new Date(at).toLocaleString();
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** A sidebar row's age, as short as it gets: "now", "5m", "3h", "2d", "5w", "4mo", "2y". */
export function formatAge(at: number, now: number = Date.now()): string {
  const ms = Math.max(0, now - at);
  if (ms < MINUTE) return 'now';
  if (ms < HOUR) return `${Math.floor(ms / MINUTE)}m`;
  if (ms < DAY) return `${Math.floor(ms / HOUR)}h`;
  const days = Math.floor(ms / DAY);
  if (days < 7) return `${days}d`;
  if (days < 30) return `${Math.floor(days / 7)}w`;
  if (days < 365) return `${Math.floor(days / 30)}mo`;
  return `${Math.floor(days / 365)}y`;
}
