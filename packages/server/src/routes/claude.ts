import { Hono } from 'hono';
import type { Container } from '../container.js';
import { PlanUsageCache, readPlanUsage } from '../plan-usage.js';

/**
 * `GET /api/claude/plan-usage` (Deck #825): how much of the Claude
 * subscription's 5-hour and weekly limits is used, as `{ usage }` (null when
 * there's no Claude login to ask, or it has no plan limits). `?refresh=1`
 * asks for a fresher reading, as a composer does after a Claude Code reply.
 */
export function claudeRoutes(container: Container, cache = new PlanUsageCache(() => readPlanUsage(container))): Hono {
  const app = new Hono();
  app.get('/plan-usage', async (c) => c.json({ usage: await cache.get(c.req.query('refresh') === '1') }));
  return app;
}
