import type { ClaudeAccountRef } from '@otherbench/core/types/claude-accounts.js';
import type { PlanUsage } from '@otherbench/core/types/usage.js';
import type { Container } from './container.js';

/** How long a plan-usage reading is served before a request reads it again (Deck #825). */
export const PLAN_USAGE_MAX_AGE_MS = 5 * 60_000;
/** A refresh asked for after a reply finishes still waits this long since the last read, so replies in quick succession share one. */
export const PLAN_USAGE_MIN_REFRESH_MS = 30_000;

/**
 * The last plan-usage reading, so the composers polling it don't each start
 * a Claude Code process. Concurrent requests share one read; a failed read
 * keeps the previous reading (whose `fetchedAt` shows its age) and isn't
 * retried until the next one is due.
 */
export class PlanUsageCache {
  private last: PlanUsage | null = null;
  private readAt: number | null = null;
  private reading: Promise<PlanUsage | null> | null = null;

  constructor(
    private readonly read: () => Promise<PlanUsage | null>,
    private readonly now: () => number = Date.now
  ) {}

  /** The latest reading, read again once it's PLAN_USAGE_MAX_AGE_MS old, or PLAN_USAGE_MIN_REFRESH_MS old when `refresh` asks. */
  get(refresh = false): Promise<PlanUsage | null> {
    const maxAge = refresh ? PLAN_USAGE_MIN_REFRESH_MS : PLAN_USAGE_MAX_AGE_MS;
    if (this.readAt !== null && this.now() - this.readAt < maxAge) return Promise.resolve(this.last);
    this.reading ??= this.readNow().finally(() => {
      this.reading = null;
    });
    return this.reading;
  }

  private async readNow(): Promise<PlanUsage | null> {
    try {
      this.last = await this.read();
    } catch (err) {
      console.error('[otherbench-server] reading the Claude plan usage failed:', err);
    }
    this.readAt = this.now();
    return this.last;
  }
}

/** The plan usage of one of this machine's Claude logins, read through a Claude Code connection that uses the login; null when there's none. */
export function readPlanUsage(container: Pick<Container, 'store' | 'engine'>, account: ClaudeAccountRef): Promise<PlanUsage | null> {
  const conn = container.store.connections.list().find((c) => c.kind === 'claude_code' && !c.baseUrl);
  if (!conn || !container.engine.planUsage) return Promise.resolve(null);
  return container.engine.planUsage(conn, account);
}
