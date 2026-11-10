import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import {
  DEFAULT_SCHEDULE_TIME_LIMIT_MINUTES,
  MAX_SCHEDULE_ATTACHMENTS,
  MAX_SCHEDULES,
  SCHEDULE_NAME_MAX,
  SCHEDULE_PROMPT_MAX,
  TIME_ZONE_PROBLEM,
  canonicalTimeZone,
  describeRule,
  isValidTimeZone,
  nextRunAt,
  parseRule,
  parseTimeLimit,
  unattendedWarnings,
  type ScheduleRule,
  type ScheduleTarget,
} from '@otherbench/core/domain/schedule.js';
import { projectDisplayName } from '@otherbench/core/domain/projects.js';
import type { Schedule, SchedulePatch, ScheduleView } from '@otherbench/core/ports/store.js';
import type { Container } from '../container.js';
import { releaseBlobs, scheduleBlobShas, toPublicScheduleAttachment } from '../schedule/attachments.js';
import { ScheduleBusyError } from '../schedule/service.js';
import { limitUploadBody, readUploadedFile, storeUpload } from './attachments.js';

interface ScheduleBody {
  name?: unknown;
  prompt?: unknown;
  profileId?: unknown;
  target?: unknown;
  rule?: unknown;
  enabled?: unknown;
  autoMode?: unknown;
  timeLimitMinutes?: unknown;
  timezone?: unknown;
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

/** Minutes, or null for no limit; left out on create it is 30. */
function parseTimeLimitBody(value: unknown): number | null {
  const limit = parseTimeLimit(value);
  if (typeof limit === 'string') throw new HTTPException(400, { message: limit });
  return limit;
}

/** An IANA zone, canonically spelt (`canonicalTimeZone`); anything else is a 400. */
function parseTimeZoneBody(value: unknown): string {
  const zone = canonicalTimeZone(value);
  if (zone === null) throw new HTTPException(400, { message: TIME_ZONE_PROBLEM });
  return zone;
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

function parseFlag(field: 'enabled' | 'autoMode', value: unknown, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') throw new HTTPException(400, { message: `"${field}" must be true or false.` });
  return value;
}

/** A schedule as the UI shows it: the row plus its target's name, its rule in words, whether it's running (and the run Stop stops), its last run and its warnings. */
export function scheduleView(container: Container, s: Schedule): ScheduleView {
  const { store } = container;
  const chat = s.target.kind === 'chat' ? store.chats.get(s.target.chatId) : null;
  const project = s.target.kind === 'project' ? store.projects.get(s.target.projectId) : null;
  const profile = store.profiles.get(s.profileId);
  const connection = profile ? store.connections.get(profile.connectionId) : null;
  const hasFolder = (chat?.workspace ?? project?.workspace ?? null) !== null;
  return {
    ...s,
    targetName: chat?.title ?? (project ? projectDisplayName(project, (id) => store.projects.get(id)) : null) ?? '',
    describe: describeRule(s.rule),
    running: container.schedules?.isRunning(s.id) ?? false,
    activeRun: container.schedules?.activeRun(s.id) ?? null,
    lastRun: store.schedules.lastRun(s.id),
    warnings: profile && connection ? unattendedWarnings(profile.toolPolicy, connection.kind, hasFolder, s.autoMode) : [],
    attachments: store.schedules.attachments(s.id).map(toPublicScheduleAttachment),
  };
}

/**
 * Scheduled tasks (spec 2026-10-12-scheduled-tasks-design §4), at /api/schedules.
 * Behind the app's token, Host and cross-site checks; never on the peer
 * listener (peer/forward.ts mounts only the turns routes). The time zone is
 * the body's `timezone` when given (the editor sends the one it showed),
 * else this server's; either way an IANA zone this runtime knows.
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
    const enabled = parseFlag('enabled', body.enabled, true);
    const autoMode = parseFlag('autoMode', body.autoMode, false);
    const timeLimitMinutes = body.timeLimitMinutes === undefined ? DEFAULT_SCHEDULE_TIME_LIMIT_MINUTES : parseTimeLimitBody(body.timeLimitMinutes);
    const timezone = body.timezone === undefined ? serverTimeZone() : parseTimeZoneBody(body.timezone);
    if (container.store.schedules.list().length >= MAX_SCHEDULES) {
      throw new HTTPException(409, { message: `You have ${MAX_SCHEDULES} schedules, the most OtherBench keeps. Delete one first.` });
    }
    const now = Date.now();
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
      autoMode,
      timeLimitMinutes,
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
    if (body.autoMode !== undefined) patch.autoMode = parseFlag('autoMode', body.autoMode, current.autoMode);
    // A run going now keeps the limit it started with.
    if (body.timeLimitMinutes !== undefined) patch.timeLimitMinutes = parseTimeLimitBody(body.timeLimitMinutes);
    if (body.timezone !== undefined) {
      const timezone = parseTimeZoneBody(body.timezone);
      if (timezone !== current.timezone) patch.timezone = timezone;
    }
    const enabled = parseFlag('enabled', body.enabled, current.enabled);
    patch.enabled = enabled;
    if (!enabled) {
      patch.nextRunAt = null;
    } else if (patch.rule !== undefined || patch.timezone !== undefined || !current.enabled || current.nextRunAt === null) {
      // A new rule, a new zone or a resume counts from now: slots missed while paused never fire.
      patch.nextRunAt = nextRunAt(patch.rule ?? current.rule, patch.timezone ?? current.timezone, now);
    }
    const updated = container.store.schedules.update(current.id, patch);
    changed();
    return c.json(scheduleView(container, updated));
  });

  app.delete('/:id', async (c) => {
    const s = getOr404(c.req.param('id'));
    const shas = scheduleBlobShas(container.store, [s]);
    // A run still going finishes its reply, unrecorded. Its files go with it (ON DELETE CASCADE), and then their blobs.
    container.store.schedules.delete(s.id);
    container.events?.emit({ type: 'schedules-changed' });
    await releaseBlobs(container.store, container.blobStore, shas);
    return c.body(null, 204);
  });

  /**
   * Adds a file the schedule sends with its prompt on every run: the same
   * upload, 25MB cap and text extraction as a chat attachment
   * (routes/attachments.ts), stored as a `ScheduleAttachment`. At most
   * `MAX_SCHEDULE_ATTACHMENTS`, checked before the body is read and again
   * as the row is written, so two uploads at once can't pass it.
   */
  app.post('/:id/attachments', limitUploadBody, async (c) => {
    const s = getOr404(c.req.param('id'));
    const full = (): HTTPException => new HTTPException(409, { message: `A schedule can carry at most ${MAX_SCHEDULE_ATTACHMENTS} files.` });
    if (container.store.schedules.attachments(s.id).length >= MAX_SCHEDULE_ATTACHMENTS) throw full();
    const { data, filename, mime } = await readUploadedFile(c);
    const created = await storeUpload(container, data, filename, mime, (blob, extractedText) => {
      if (!container.store.schedules.get(s.id)) throw new HTTPException(404, { message: `Schedule "${s.id}" not found.` });
      if (container.store.schedules.attachments(s.id).length >= MAX_SCHEDULE_ATTACHMENTS) throw full();
      return container.store.schedules.addAttachment({
        id: randomUUID(),
        scheduleId: s.id,
        filename,
        mime,
        size: blob.size,
        sha256: blob.sha256,
        storagePath: blob.path,
        extractedText,
        createdAt: Date.now(),
      });
    });
    container.events?.emit({ type: 'schedules-changed' });
    return c.json(toPublicScheduleAttachment(created), 201);
  });

  /** Removes one of the schedule's files, and its blob once nothing else holds it. Runs already sent keep their own copies. */
  app.delete('/:id/attachments/:attachmentId', async (c) => {
    const s = getOr404(c.req.param('id'));
    const attachment = container.store.schedules.getAttachment(c.req.param('attachmentId'));
    if (!attachment || attachment.scheduleId !== s.id) throw new HTTPException(404, { message: `Attachment "${c.req.param('attachmentId')}" not found.` });
    container.store.schedules.deleteAttachment(attachment.id);
    container.events?.emit({ type: 'schedules-changed' });
    await releaseBlobs(container.store, container.blobStore, [attachment.sha256]);
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
