import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { MAIN_ACCOUNT, MAIN_ACCOUNT_SLUG, type AccountView, type ClaudeAccount } from '@otherbench/core/types/claude-accounts.js';
import { AccountInputError, type ClaudeAccountService } from '../claude-accounts/service.js';
import type { Container } from '../container.js';
import { PlanUsageCache, readPlanUsage } from '../plan-usage.js';

/**
 * The Claude account logins on this machine and their plan usage. Local to
 * this machine: never forwarded to a peer.
 *
 * `GET/POST /api/claude/accounts`, `PATCH/DELETE /api/claude/accounts/:slug`,
 * and `GET /api/claude/plan-usage` (Deck #825): how much of a Claude
 * subscription's 5-hour and weekly limits is used, as `{ usage }` (null when
 * there's no Claude login to ask, or it has no plan limits). `?account=<slug>`
 * picks the account (main without it); `?refresh=1` asks for a fresher
 * reading, as a composer does after a Claude Code reply.
 */
export function claudeRoutes(container: Container, cache = new PlanUsageCache(() => readPlanUsage(container, MAIN_ACCOUNT))): Hono {
  const app = new Hono();

  const accounts = (): ClaudeAccountService => {
    if (!container.claudeAccounts) throw new HTTPException(503, { message: 'Claude accounts are not available.' });
    return container.claudeAccounts;
  };
  const view = (svc: ClaudeAccountService, a: ClaudeAccount | null): AccountView => ({
    slug: a?.slug ?? MAIN_ACCOUNT_SLUG,
    name: a?.name ?? MAIN_ACCOUNT.name,
    colour: a?.colour ?? null,
    configDir: a?.configDir ?? null,
    main: a === null,
    limitedUntil: svc.limitedUntil(a?.slug ?? MAIN_ACCOUNT_SLUG),
    // Filled in by the login runner.
    signedIn: null,
    email: null,
    subscriptionType: null,
    signingIn: false,
  });
  const existing = (svc: ClaudeAccountService, slug: string): ClaudeAccount => {
    const found = svc.list().find((a) => a.slug === slug);
    if (!found) throw new HTTPException(404, { message: `No Claude account named "${slug}" on this machine.` });
    return found;
  };
  const guard = <T>(fn: () => T): T => {
    try {
      return fn();
    } catch (err) {
      if (err instanceof AccountInputError) throw new HTTPException(400, { message: err.message });
      throw err;
    }
  };
  const bodyOf = async (c: { req: { json(): Promise<unknown> } }): Promise<Record<string, unknown>> => {
    const body = await c.req.json().catch(() => ({}));
    return typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
  };
  const text = (value: unknown, field: string): string => {
    if (typeof value !== 'string') throw new HTTPException(400, { message: `"${field}" must be a string.` });
    return value;
  };

  app.get('/accounts', (c) => {
    const svc = accounts();
    return c.json({ accounts: [view(svc, null), ...svc.list().map((a) => view(svc, a))] });
  });

  app.post('/accounts', async (c) => {
    const svc = accounts();
    const body = await bodyOf(c);
    const configDir = body['configDir'] === undefined || body['configDir'] === null ? undefined : text(body['configDir'], 'configDir');
    const account = guard(() => svc.add({ name: text(body['name'], 'name'), colour: text(body['colour'], 'colour'), ...(configDir !== undefined ? { configDir } : {}) }));
    return c.json({ account: view(svc, account) }, 201);
  });

  app.patch('/accounts/:slug', async (c) => {
    const svc = accounts();
    const slug = c.req.param('slug');
    if (slug === MAIN_ACCOUNT_SLUG) throw new HTTPException(400, { message: "The machine's own Claude login (main) has no colour to change." });
    existing(svc, slug);
    const body = await bodyOf(c);
    const colour = body['colour'] === undefined ? undefined : text(body['colour'], 'colour');
    const account = guard(() => svc.update(slug, colour !== undefined ? { colour } : {}));
    return c.json({ account: view(svc, account) });
  });

  app.delete('/accounts/:slug', (c) => {
    const svc = accounts();
    const slug = c.req.param('slug');
    if (slug !== MAIN_ACCOUNT_SLUG) existing(svc, slug);
    guard(() => svc.remove(slug));
    return c.body(null, 204);
  });

  app.get('/plan-usage', async (c) => {
    const refresh = c.req.query('refresh') === '1';
    const slug = c.req.query('account') || MAIN_ACCOUNT_SLUG;
    if (container.claudeAccounts) {
      if (!container.claudeAccounts.ref(slug)) throw new HTTPException(404, { message: `No Claude account named "${slug}" on this machine.` });
      return c.json({ usage: await container.claudeAccounts.usage(slug, refresh) });
    }
    if (slug !== MAIN_ACCOUNT_SLUG) throw new HTTPException(404, { message: `No Claude account named "${slug}" on this machine.` });
    return c.json({ usage: await cache.get(refresh) });
  });

  return app;
}
