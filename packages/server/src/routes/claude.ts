import { Hono } from 'hono';
import { MAIN_ACCOUNT, MAIN_ACCOUNT_SLUG } from '@otherbench/core/types/claude-accounts.js';
import type { Container } from '../container.js';
import { PlanUsageCache, readPlanUsage } from '../plan-usage.js';

/**
 * `GET /api/claude/plan-usage` (Deck #825): how much of the Claude
 * subscription's 5-hour and weekly limits is used, as `{ usage }` (null when
 * there's no Claude login to ask, or it has no plan limits). `?refresh=1`
 * asks for a fresher reading, as a composer does after a Claude Code reply.
 */
export function claudeRoutes(container: Container, cache = new PlanUsageCache(() => readPlanUsage(container, MAIN_ACCOUNT))): Hono {
  const app = new Hono();
  app.get('/plan-usage', async (c) => {
    const refresh = c.req.query('refresh') === '1';
    // Main's reading, through the account service's own cache when there is one (it also notes a full window).
    const usage = container.claudeAccounts ? await container.claudeAccounts.usage(MAIN_ACCOUNT_SLUG, refresh) : await cache.get(refresh);
    return c.json({ usage });
  });
  return app;
}
