import { DEFAULT_SCHEDULE_TIME_LIMIT_MINUTES, MAX_SCHEDULES, SCHEDULE_NAME_MAX, describeRule, type ScheduleRunStatus } from '@otherbench/core/domain/schedule.js';
import { projectDisplayName } from '@otherbench/core/domain/projects.js';
import type { Store } from '@otherbench/core/ports/store.js';
import type { PeerScheduleRow, PeerScheduleSummary } from '@otherbench/core/types/peer.js';

/**
 * Schedules across machines, read-only (docs/HANDOVER.md, "Scheduled tasks"). A machine tells each paired machine
 * what its Schedules rows show on the `schedules` announcement of `/peer/events`, whole each time it changes; the
 * other keeps it per machine and its own UI reads it from `GET /api/peers/schedules`. There is no route on the peer
 * listener for schedules at all, so nothing a paired machine sends can run, change, pause or delete one here.
 */

/** The longest id, rule wording and zone kept from a paired machine. */
const MAX_ID = 200;
const MAX_DESCRIBE = 300;
const MAX_ZONE = 100;

const RUN_STATUSES: ReadonlySet<string> = new Set<ScheduleRunStatus>(['running', 'complete', 'error', 'cancelled', 'timed_out', 'not_started']);

/** What `ownSchedules` needs from the schedule service: whether a run of one is going now. */
export interface ScheduleRunState {
  isRunning(scheduleId: string): boolean;
}

/**
 * This machine's schedules as its paired machines are told them: only what a row shows. The prompt, the warnings
 * and the run in progress (what Stop stops) stay here.
 */
export function ownSchedules(store: Store, runs: ScheduleRunState | undefined): PeerScheduleSummary[] {
  return store.schedules.list().map((s) => {
    const profile = store.profiles.get(s.profileId);
    const connection = profile ? store.connections.get(profile.connectionId) : null;
    const last = store.schedules.lastRun(s.id);
    return {
      id: s.id,
      name: s.name,
      describe: describeRule(s.rule),
      timezone: s.timezone,
      enabled: s.enabled,
      nextRunAt: s.nextRunAt,
      invalid: s.invalid !== undefined,
      target: s.target.kind === 'chat' ? { kind: 'chat', chatId: s.target.chatId } : { kind: 'project', projectId: s.target.projectId },
      profileId: s.profileId,
      // As a run decides it: the schedule's Auto counts only on a Claude Code profile.
      autoMode: s.autoMode && connection?.kind === 'claude_code',
      timeLimitMinutes: s.timeLimitMinutes,
      running: runs?.isRunning(s.id) ?? false,
      lastRun: last ? { status: last.status, startedAt: last.startedAt, chatId: last.chatId } : null,
    };
  });
}

function boundedString(value: unknown, max: number): string | null {
  return typeof value === 'string' && value !== '' && value.length <= max ? value : null;
}

function finiteOrNull(value: unknown): number | null | undefined {
  if (value === null) return null;
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function summaryOf(entry: unknown): PeerScheduleSummary | null {
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return null;
  const e = entry as Record<string, unknown>;
  const id = boundedString(e['id'], MAX_ID);
  const name = boundedString(e['name'], SCHEDULE_NAME_MAX);
  const profileId = boundedString(e['profileId'], MAX_ID);
  const timezone = boundedString(e['timezone'], MAX_ZONE);
  if (!id || !name || !profileId || !timezone) return null;
  const describe = typeof e['describe'] === 'string' ? e['describe'].slice(0, MAX_DESCRIBE) : '';
  const rawTarget = typeof e['target'] === 'object' && e['target'] !== null ? (e['target'] as Record<string, unknown>) : {};
  const chatId = boundedString(rawTarget['chatId'], MAX_ID);
  const projectId = boundedString(rawTarget['projectId'], MAX_ID);
  const target: PeerScheduleSummary['target'] | null =
    rawTarget['kind'] === 'chat' && chatId ? { kind: 'chat', chatId } : rawTarget['kind'] === 'project' && projectId ? { kind: 'project', projectId } : null;
  if (!target) return null;
  const nextRunAt = finiteOrNull(e['nextRunAt']);
  const limit = finiteOrNull(e['timeLimitMinutes']);
  let lastRun: PeerScheduleSummary['lastRun'] = null;
  const rawRun = e['lastRun'];
  if (typeof rawRun === 'object' && rawRun !== null) {
    const r = rawRun as Record<string, unknown>;
    const startedAt = finiteOrNull(r['startedAt']);
    if (typeof r['status'] === 'string' && RUN_STATUSES.has(r['status']) && typeof startedAt === 'number') {
      lastRun = { status: r['status'] as ScheduleRunStatus, startedAt, chatId: boundedString(r['chatId'], MAX_ID) };
    }
  }
  return {
    id,
    name,
    describe,
    timezone,
    enabled: e['enabled'] === true,
    nextRunAt: nextRunAt ?? null,
    invalid: e['invalid'] === true,
    target,
    profileId,
    autoMode: e['autoMode'] === true,
    // Left out or garbled reads as the usual 30 minutes, which the row doesn't mention.
    timeLimitMinutes: limit === undefined ? DEFAULT_SCHEDULE_TIME_LIMIT_MINUTES : limit,
    running: e['running'] === true,
    lastRun,
  };
}

/**
 * A paired machine's `schedules` announcement, as far as it is one: each entry checked and bounded, only the fields
 * a row shows kept, anything else dropped, at most `MAX_SCHEDULES`. Null when it isn't a list at all.
 */
export function peerSchedulesOf(said: unknown): PeerScheduleSummary[] | null {
  const list = typeof said === 'object' && said !== null ? (said as { schedules?: unknown }).schedules : undefined;
  if (!Array.isArray(list)) return null;
  const out: PeerScheduleSummary[] = [];
  for (const entry of list) {
    if (out.length >= MAX_SCHEDULES) break;
    const summary = summaryOf(entry);
    if (summary) out.push(summary);
  }
  return out;
}

/** A paired machine's schedules with names from this machine's own synced rows, null where the row isn't here. */
export function namedPeerSchedules(store: Store, schedules: readonly PeerScheduleSummary[]): PeerScheduleRow[] {
  return schedules.map((s) => {
    const chat = s.target.kind === 'chat' ? store.chats.get(s.target.chatId) : null;
    const project = s.target.kind === 'project' ? store.projects.get(s.target.projectId) : null;
    const targetName = chat?.title ?? (project ? projectDisplayName(project, (id) => store.projects.get(id)) : null);
    // Open needs the chat here; one that hasn't synced (or was deleted) is left out.
    const lastRun = s.lastRun && s.lastRun.chatId !== null && store.chats.get(s.lastRun.chatId) === null ? { ...s.lastRun, chatId: null } : s.lastRun;
    return { ...s, lastRun, targetName, profileName: store.profiles.get(s.profileId)?.name ?? null };
  });
}
