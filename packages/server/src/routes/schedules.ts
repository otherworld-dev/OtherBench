import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import {
  MAX_SCHEDULES,
  SCHEDULE_NAME_MAX,
  SCHEDULE_PROMPT_MAX,
  describeRule,
  isValidTimeZone,
  nextRunAt,
  parseRule,
  unattendedWarnings,
  type ScheduleRule,
  type ScheduleTarget,
} from '@grunt/core/domain/schedule.js';
import type { Schedule, SchedulePatch, ScheduleView } from '@grunt/core/ports/store.js';
import type { Container } from '../container.js';
import { ScheduleBusyError } from '../schedule/service.js';

interface ScheduleBody {
  name?: unknown;
  prompt?: unknown;
  profileId?: unknown;
  target?: unknown;
  rule?: unknown;
  enabled?: unknown;
}

/** The server machine's IANA zone, which schedules made now are stored in; UTC when the runtime can't say. */
export function serverTimeZone(): string {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return zone && isValidTimeZone(zone) ? zone : 'UTC';
}

function parseName(value: unknown): string {
  const name = typeof value === 'string' ? value.trim() : '';
  if (name.length === 0 || name.length > SCHEDULE_NAME_MAX) throw new HTTPException(400, { message: `"name" must be 1 to ${SCHEDULE_NAME_MAX} characters.` });
  return name;
}

function parsePrompt(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > SCHEDULE_PROMPT_MAX) {
    throw new HTTPException(400, { message: `"prompt" must be 1 to ${SCHEDULE_PROMPT_MAX.toLocaleString('en-US')} characters.` });
  }
  return value;
}

function parseProfile(container: Container, value: unknown): string {
  const id = typeof value === 'string' ? value : '';
  const profile = id ? container.store.profiles.get(id) : null;
  if (!profile) throw new HTTPException(400, { message: `"profileId": profile "${id}" not found.` });
  if (profile.archivedAt !== null) throw new HTTPException(400, { message: `"profileId": profile "${profile.name}" is archived.` });
  return profile.id;
}

function parseTarget(container: Container, value: unknown): ScheduleTarget {
  const t = typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  const chatId = t?.['chatId'];
  const projectId = t?.['projectId'];
  if (typeof chatId === 'string' && projectId === undefined) {
    const chat = container.store.chats.get(chatId);
    if (!chat) throw new HTTPException(400, { message: `"target.chatId": chat "${chatId}" not found.` });
    if (chat.runsOn !== container.store.nodes.self().id) {
      const machine = container.store.peers.get(chat.runsOn)?.name ?? 'another machine';
      throw new HTTPException(400, { message: `This chat runs on ${machine}. A schedule runs on the machine that holds it: make the schedule there, or run the chat here.` });
    }
    return { kind: 'chat', chatId };
  }
  if (typeof projectId === 'string' && chatId === undefined) {
    if (!container.store.projects.get(projectId)) throw new HTTPException(400, { message: `"target.projectId": project "${projectId}" not found.` });
    return { kind: 'project', projectId };
  }
  throw new HTTPException(400, { message: '"target" must be { "chatId": … } or { "projectId": … }.' });
}

function parseRuleBody(value: unknown): ScheduleRule {
  const rule = parseRule(value);
  if (typeof rule === 'string') throw new HTTPException(400, { message: rule });
  return rule;
}

function parseEnabled(value: unknown, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') throw new HTTPException(400, { message: '"enabled" must be true or false.' });
  return value;
}

/** A schedule as the UI shows it: the row plus its target's name, its rule in words, whether it's running, its last run and its warnings. */
export function scheduleView(container: Container, s: Schedule): ScheduleView {
  const { store } = container;
  const chat = s.target.kind === 'chat' ? store.chats.get(s.target.chatId) : null;
  const project = s.target.kind === 'project' ? store.projects.get(s.target.projectId) : null;
  const profile = store.profiles.get(s.profileId);
  const connection = profile ? store.connections.get(profile.connectionId) : null;
  const hasFolder = (chat?.workspace ?? project?.workspace ?? null) !== null;
  return {
    ...s,
    targetName: chat?.title ?? project?.name ?? '',
    describe: describeRule(s.rule),
    running: container.schedules?.isRunning(s.id) ?? false,
    lastRun: store.schedules.lastRun(s.id),
    warnings: profile && connection ? unattendedWarnings(profile.toolPolicy, connection.kind, hasFolder) : [],
  };
}

/**
 * Scheduled tasks (spec 2026-10-12-scheduled-tasks-design §4), at /api/schedules.
 * Behind the app's token, Host and cross-site checks; never on the peer
 * listener (peer/forward.ts mounts only the turns routes). The time zone is
 * this server's, never the body's.
 */
export function schedulesRoutes(container: Container): Hono {
  const app = new Hono();
  const changed = (): void => {
    container.events?.emit({ type: 'schedules-changed' });
    container.schedules?.poke();
  };
  const getOr404 = (id: string): Schedule => {
    const s = container.store.schedules.get(id);
    if (!s) throw new HTTPException(404, { message: `Schedule "${id}" not found.` });
    return s;
  };

  app.get('/', (c) => c.json(container.store.schedules.list().map((s) => scheduleView(container, s))));

  app.post('/', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as ScheduleBody;
    const name = parseName(body.name);
    const prompt = parsePrompt(body.prompt);
    const profileId = parseProfile(container, body.profileId);
    const target = parseTarget(container, body.target);
    const rule = parseRuleBody(body.rule);
    const enabled = parseEnabled(body.enabled, true);
    if (container.store.schedules.list().length >= MAX_SCHEDULES) {
      throw new HTTPException(409, { message: `You have ${MAX_SCHEDULES} schedules, the most Grunt keeps. Delete one first.` });
    }
    const now = Date.now();
    const timezone = serverTimeZone();
    const created = container.store.schedules.create({
      id: randomUUID(),
      name,
      prompt,
      profileId,
      target,
      rule,
      timezone,
      enabled,
      nextRunAt: enabled ? nextRunAt(rule, timezone, now) : null,
      createdAt: now,
      updatedAt: now,
    });
    changed();
    return c.json(scheduleView(container, created), 201);
  });

  app.patch('/:id', async (c) => {
    const current = getOr404(c.req.param('id'));
    const body = (await c.req.json().catch(() => ({}))) as ScheduleBody;
    if (body.target !== undefined) throw new HTTPException(400, { message: '"target" can\'t change. Make a new schedule for another chat or project.' });
    const now = Date.now();
    const patch: SchedulePatch = { updatedAt: now };
    if (body.name !== undefined) patch.name = parseName(body.name);
    if (body.prompt !== undefined) patch.prompt = parsePrompt(body.prompt);
    if (body.profileId !== undefined) patch.profileId = parseProfile(container, body.profileId);
    if (body.rule !== undefined) patch.rule = parseRuleBody(body.rule);
    const enabled = parseEnabled(body.enabled, current.enabled);
    patch.enabled = enabled;
    if (!enabled) {
      patch.nextRunAt = null;
    } else if (patch.rule !== undefined || !current.enabled || current.nextRunAt === null) {
      // A new rule or a resume counts from now: slots missed while paused never fire.
      patch.nextRunAt = nextRunAt(patch.rule ?? current.rule, current.timezone, now);
    }
    const updated = container.store.schedules.update(current.id, patch);
    changed();
    return c.json(scheduleView(container, updated));
  });

  app.delete('/:id', (c) => {
    const s = getOr404(c.req.param('id'));
    // A run still going finishes its reply, unrecorded.
    container.store.schedules.delete(s.id);
    container.events?.emit({ type: 'schedules-changed' });
    return c.body(null, 204);
  });

  app.get('/:id/runs', (c) => c.json(container.store.schedules.runs(getOr404(c.req.param('id')).id)));

  app.post('/:id/run', (c) => {
    const s = getOr404(c.req.param('id'));
    if (!container.schedules) throw new HTTPException(503, { message: "Scheduled tasks aren't running on this server." });
    try {
      const run = container.schedules.runNow(s.id);
      container.events?.emit({ type: 'schedules-changed' });
      return c.json(run, 202);
    } catch (err) {
      if (err instanceof ScheduleBusyError) return c.json({ error: err.message, kind: err.kind }, 409);
      throw err;
    }
  });

  return app;
}
