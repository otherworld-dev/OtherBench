import { randomUUID } from 'node:crypto';
import { Hono, type Context, type Next } from 'hono';
import { schedulePatchAction, type SchedulePeerChangeAction } from '@otherbench/core/domain/schedule-peers.js';
import type { Container } from '../container.js';
import { schedulesRoutes } from '../routes/schedules.js';

/**
 * This machine's schedules as a paired machine may reach them over the peer listener (docs/features/scheduled-tasks.md,
 * "Across machines"). Mounted inside `forwardedApi` at `/schedules`, so a call has already passed the listener's
 * pinned certificate and token, and the desktop-only gate while computer use may be in control here.
 *
 * Two kinds of call, and nothing else under `/schedules` (an unknown path or method is a 404, so a route added to
 * `/api/schedules` later is never reachable from a paired machine by accident):
 * - A schedule's run history (`GET /schedules/:id/runs`), always: a read, like the `schedules` announcement, and the
 *   runs' chats reach the paired machine by sync anyway.
 * - Managing them: the full list with prompts (`GET /schedules`), create, edit, pause and resume (`POST /schedules`,
 *   `PATCH /schedules/:id`), delete and Run now. Only while this machine lets paired machines
 *   (`peerScheduleControl`, off by default, read on every call and only changeable in this machine's own Settings).
 *   While it is off they answer 404 as they did before the routes existed, with a message saying why.
 *
 * The handlers are `/api/schedules`'s own (`schedulesRoutes`), so a paired machine's create or edit goes through the
 * same checks as this machine's UI: the rule, the time limit, a profile that isn't archived, a target chat that runs
 * here, the zone being this machine's. Each change that succeeds is recorded with the machine it came from
 * (`ScheduleRepo.recordPeerChange`, the caller's authenticated node id, never a header) and logged. A create, an edit
 * (read from what changed, not what was sent) or a delete stays on record until it is 90 days old: only pauses,
 * resumes and Run nows are trimmed to make room, so the paired machine can't bury an edit under a flood of them.
 *
 * A change made here never marks a chat as the paired machine's for computer use (`PeerInfluence`), unlike a turn:
 * a scheduled run is unattended, and computer use refuses an unattended run (`COMPUTER_UNATTENDED_REASON`), so there
 * is nothing for the mark to guard.
 */

interface PeerScheduleEnv {
  Bindings: { peerNodeId: string };
}

type Route = { kind: 'history' } | { kind: 'manage'; scheduleId: string | null; action: 'list' | 'create' | 'patch' | 'delete' | 'run' };

function decoded(raw: string): string | null {
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}

/** Which allowed call this is, or null for anything else (a 404). */
export function peerScheduleRoute(method: string, path: string): Route | null {
  if (path === '/schedules' || path === '/schedules/') {
    if (method === 'GET') return { kind: 'manage', scheduleId: null, action: 'list' };
    if (method === 'POST') return { kind: 'manage', scheduleId: null, action: 'create' };
    return null;
  }
  const match = /^\/schedules\/([^/]+)(\/runs|\/run)?$/.exec(path);
  const id = match?.[1] !== undefined ? decoded(match[1]) : null;
  if (!match || id === null) return null;
  if (match[2] === '/runs') return method === 'GET' ? { kind: 'history' } : null;
  if (match[2] === '/run') return method === 'POST' ? { kind: 'manage', scheduleId: id, action: 'run' } : null;
  if (method === 'PATCH') return { kind: 'manage', scheduleId: id, action: 'patch' };
  if (method === 'DELETE') return { kind: 'manage', scheduleId: id, action: 'delete' };
  return null;
}

/** What a paired machine is told when this machine doesn't let paired machines manage its schedules. */
export function peerSchedulesOffReason(here: string, from: string): string {
  return `${here} doesn't let paired machines manage its schedules, so ${from} can't change them. Turn on "Let paired machines manage this machine's schedules" in Settings → Machines on ${here}, or change them there.`;
}

async function jsonOf(res: Response): Promise<Record<string, unknown> | null> {
  const body = (await res.clone().json().catch(() => null)) as unknown;
  return typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : null;
}

export function peerScheduleRoutes(container: Container): Hono<PeerScheduleEnv> {
  const app = new Hono<PeerScheduleEnv>();
  const { store } = container;

  const gate = async (c: Context<PeerScheduleEnv>, next: Next): Promise<Response | void> => {
    const route = peerScheduleRoute(c.req.method, c.req.path);
    if (!route) return c.json({ error: 'Not found.' }, 404);
    if (route.kind === 'history') return next();
    const fromNode = c.env.peerNodeId;
    const here = store.nodes.self().name;
    const from = store.peers.get(fromNode)?.name ?? 'a paired machine';
    // Read on every call, never trusted from the caller: switching it off here stops the next call.
    if (!store.settings.get().peerScheduleControl) return c.json({ error: peerSchedulesOffReason(here, from), kind: 'peer_schedules_off' }, 404);
    if (route.action === 'list') return next();

    const before = route.scheduleId !== null ? store.schedules.get(route.scheduleId) : null;
    await next();
    if (c.res.status >= 300) return;

    let action: SchedulePeerChangeAction | null;
    let scheduleId = route.scheduleId;
    let scheduleName = before?.name ?? '';
    let runId: string | null = null;
    if (route.action === 'create') {
      const made = await jsonOf(c.res);
      action = 'created';
      scheduleId = typeof made?.['id'] === 'string' ? made['id'] : null;
      scheduleName = typeof made?.['name'] === 'string' ? made['name'] : '';
    } else if (route.action === 'patch') {
      // From what changed, not what was sent: an edit is kept until it ages out, however many pauses follow it, and
      // a call that changed nothing records nothing.
      const after = scheduleId !== null ? store.schedules.get(scheduleId) : null;
      action = before && after ? schedulePatchAction(before, after) : null;
      scheduleName = after?.name ?? scheduleName;
    } else if (route.action === 'run') {
      const run = await jsonOf(c.res);
      action = 'ran';
      runId = typeof run?.['id'] === 'string' ? run['id'] : null;
    } else {
      action = 'deleted';
    }
    if (scheduleId === null || action === null) return;
    store.schedules.recordPeerChange({ id: randomUUID(), scheduleId, scheduleName, action, fromNode, runId });
    console.info(`[otherbench-server] schedule "${scheduleName}" (${scheduleId}) ${action} from paired machine ${from} (${fromNode}).`);
    // Its row here says so: the list re-reads.
    container.events?.emit({ type: 'schedules-changed' });
  };

  // Hono's `/schedules/*` matches `/schedules` itself too, so this one `use` covers every path.
  app.use('/schedules/*', gate);
  app.route('/schedules', schedulesRoutes(container));
  return app;
}
