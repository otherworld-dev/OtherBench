import { Hono } from 'hono';
import type { Container } from '../container.js';

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** What would be cut off by restarting now, in words for Settings. Open terminals don't count: an update closes them, and that's accepted. */
export function busyReasons(counts: { runningTurns: number; scheduledRuns: number; backgroundTasks: number }): string[] {
  const reasons: string[] = [];
  if (counts.runningTurns > 0) reasons.push(plural(counts.runningTurns, 'reply being written', 'replies being written'));
  if (counts.scheduledRuns > 0) reasons.push(plural(counts.scheduledRuns, 'scheduled run', 'scheduled runs'));
  if (counts.backgroundTasks > 0) reasons.push(plural(counts.backgroundTasks, 'background task', 'background tasks'));
  return reasons;
}

/**
 * Routes only the desktop shell calls. `GET /busy` is asked by the shell's
 * updater before it installs (desktop/src-tauri/src/update.rs): replies being
 * written count, including Claude Code turns and turns run here for a paired
 * machine, which are all turns on this machine's runner.
 */
export function desktopRoutes(container: Container): Hono {
  const app = new Hono();
  app.get('/busy', (c) => {
    const reasons = busyReasons({
      runningTurns: container.events?.runningTurns().length ?? 0,
      scheduledRuns: container.schedules?.activeRunCount() ?? 0,
      // A Claude Code agent's helpers still running between replies.
      backgroundTasks: (container.events?.backgroundChats() ?? []).reduce((n, c) => n + c.count, 0),
    });
    return c.json({ busy: reasons.length > 0, reasons });
  });
  return app;
}
