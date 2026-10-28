import type { DatabaseSync } from 'node:sqlite';
import { parseRule, SCHEDULE_RUNS_KEPT, type ScheduleRule } from '@otherbench/core/domain/schedule.js';
import type {
  NewSchedule,
  NewScheduleRun,
  Schedule,
  SchedulePatch,
  ScheduleRepo,
  ScheduleRun,
  ScheduleRunPatch,
} from '@otherbench/core/ports/store.js';

/** What a schedule whose stored rule can't be read shows instead; it is disabled and never runs. */
const PLACEHOLDER_RULE: ScheduleRule = { cadence: 'daily', time: '00:00' };

function readRule(text: string): ScheduleRule | string {
  try {
    return parseRule(JSON.parse(text));
  } catch {
    return 'Its rule is not valid JSON.';
  }
}

function toSchedule(row: Record<string, unknown>): Schedule {
  const rule = readRule(row.rule as string);
  const valid = typeof rule !== 'string';
  return {
    id: row.id as string,
    name: row.name as string,
    prompt: row.prompt as string,
    profileId: row.profile_id as string,
    target: row.chat_id !== null ? { kind: 'chat', chatId: row.chat_id as string } : { kind: 'project', projectId: row.project_id as string },
    rule: valid ? rule : PLACEHOLDER_RULE,
    timezone: row.timezone as string,
    enabled: valid && row.enabled === 1,
    nextRunAt: valid ? (row.next_run_at as number | null) : null,
    autoMode: row.auto_mode === 1,
    createdAt: row.created_at as number,
    updatedAt: row.updated_at as number,
    ...(valid ? {} : { invalid: rule }),
  };
}

function toRun(row: Record<string, unknown>): ScheduleRun {
  return {
    id: row.id as string,
    scheduleId: row.schedule_id as string,
    trigger: row.trigger as ScheduleRun['trigger'],
    dueAt: row.due_at as number | null,
    startedAt: row.started_at as number,
    finishedAt: row.finished_at as number | null,
    status: row.status as ScheduleRun['status'],
    detail: row.detail as string | null,
    chatId: row.chat_id as string | null,
    createdChat: row.created_chat === 1,
    userMessageId: row.user_message_id as string | null,
    messageId: row.message_id as string | null,
    refusedCalls: row.refused_calls as number,
  };
}

/** Schedules and their runs (spec 2026-10-12-scheduled-tasks-design §3). Local only: no sync stamps. */
export class SqliteScheduleRepo implements ScheduleRepo {
  constructor(private readonly db: DatabaseSync) {}

  create(s: NewSchedule): Schedule {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO schedule (id, name, prompt, profile_id, chat_id, project_id, rule, timezone, enabled, next_run_at, auto_mode, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        s.id,
        s.name,
        s.prompt,
        s.profileId,
        s.target.kind === 'chat' ? s.target.chatId : null,
        s.target.kind === 'project' ? s.target.projectId : null,
        JSON.stringify(s.rule),
        s.timezone,
        s.enabled ? 1 : 0,
        s.nextRunAt,
        s.autoMode === true ? 1 : 0,
        s.createdAt ?? now,
        s.updatedAt ?? now
      );
    return this.get(s.id)!;
  }

  get(id: string): Schedule | null {
    const row = this.row(id);
    return row ? toSchedule(row) : null;
  }

  list(): Schedule[] {
    return (this.db.prepare('SELECT * FROM schedule ORDER BY created_at ASC, id ASC').all() as Record<string, unknown>[]).map(toSchedule);
  }

  update(id: string, patch: SchedulePatch): Schedule {
    const row = this.row(id);
    if (!row) throw new Error(`schedule: not found: ${id}`);
    const next = { ...toSchedule(row), ...patch };
    this.db
      .prepare('UPDATE schedule SET name = ?, prompt = ?, profile_id = ?, rule = ?, enabled = ?, next_run_at = ?, auto_mode = ?, updated_at = ? WHERE id = ?')
      .run(
        next.name,
        next.prompt,
        next.profileId,
        // An unreadable rule stays as stored until a new one is given.
        patch.rule !== undefined ? JSON.stringify(patch.rule) : (row.rule as string),
        next.enabled ? 1 : 0,
        next.nextRunAt,
        next.autoMode ? 1 : 0,
        next.updatedAt,
        id
      );
    return this.get(id)!;
  }

  delete(id: string): void {
    this.db.prepare('DELETE FROM schedule WHERE id = ?').run(id);
  }

  due(now: number): Schedule[] {
    const rows = this.db
      .prepare('SELECT * FROM schedule WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ? ORDER BY next_run_at ASC, created_at ASC, id ASC')
      .all(now) as Record<string, unknown>[];
    // A row with an unreadable rule comes back disabled: never due.
    return rows.map(toSchedule).filter((s) => s.enabled);
  }

  addRun(r: NewScheduleRun): ScheduleRun {
    const full: ScheduleRun = {
      finishedAt: null,
      detail: null,
      chatId: null,
      createdChat: false,
      userMessageId: null,
      messageId: null,
      refusedCalls: 0,
      ...r,
    };
    const write = (): void => {
      this.db
        .prepare(
          `INSERT INTO schedule_run (id, schedule_id, trigger, due_at, started_at, finished_at, status, detail, chat_id, created_chat, user_message_id, message_id, refused_calls)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          full.id,
          full.scheduleId,
          full.trigger,
          full.dueAt,
          full.startedAt,
          full.finishedAt,
          full.status,
          full.detail,
          full.chatId,
          full.createdChat ? 1 : 0,
          full.userMessageId,
          full.messageId,
          full.refusedCalls
        );
      this.db
        .prepare(
          `DELETE FROM schedule_run WHERE schedule_id = ? AND id NOT IN (
             SELECT id FROM schedule_run WHERE schedule_id = ? ORDER BY started_at DESC, rowid DESC LIMIT ?)`
        )
        .run(full.scheduleId, full.scheduleId, SCHEDULE_RUNS_KEPT);
    };
    // Its own transaction, unless the caller already opened one (Store.transaction).
    if (this.db.isTransaction) {
      write();
    } else {
      this.db.exec('BEGIN');
      try {
        write();
        this.db.exec('COMMIT');
      } catch (err) {
        if (this.db.isTransaction) this.db.exec('ROLLBACK');
        throw err;
      }
    }
    return full;
  }

  updateRun(id: string, patch: ScheduleRunPatch): ScheduleRun | null {
    const row = this.db.prepare('SELECT * FROM schedule_run WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    const next: ScheduleRun = { ...toRun(row), ...patch };
    this.db
      .prepare(
        `UPDATE schedule_run SET trigger = ?, due_at = ?, started_at = ?, finished_at = ?, status = ?, detail = ?, chat_id = ?,
           created_chat = ?, user_message_id = ?, message_id = ?, refused_calls = ? WHERE id = ?`
      )
      .run(
        next.trigger,
        next.dueAt,
        next.startedAt,
        next.finishedAt,
        next.status,
        next.detail,
        next.chatId,
        next.createdChat ? 1 : 0,
        next.userMessageId,
        next.messageId,
        next.refusedCalls,
        id
      );
    return next;
  }

  runs(scheduleId: string): ScheduleRun[] {
    return (this.db.prepare('SELECT * FROM schedule_run WHERE schedule_id = ? ORDER BY started_at DESC, rowid DESC').all(scheduleId) as Record<string, unknown>[]).map(toRun);
  }

  lastRun(scheduleId: string): ScheduleRun | null {
    const row = this.db.prepare('SELECT * FROM schedule_run WHERE schedule_id = ? ORDER BY started_at DESC, rowid DESC LIMIT 1').get(scheduleId) as
      | Record<string, unknown>
      | undefined;
    return row ? toRun(row) : null;
  }

  lastCompleted(scheduleId: string): ScheduleRun | null {
    const row = this.db
      .prepare("SELECT * FROM schedule_run WHERE schedule_id = ? AND status = 'complete' ORDER BY started_at DESC, rowid DESC LIMIT 1")
      .get(scheduleId) as Record<string, unknown> | undefined;
    return row ? toRun(row) : null;
  }

  runningRuns(): ScheduleRun[] {
    return (this.db.prepare("SELECT * FROM schedule_run WHERE status = 'running' ORDER BY started_at ASC, rowid ASC").all() as Record<string, unknown>[]).map(toRun);
  }

  madeChat(chatId: string): boolean {
    return this.db.prepare('SELECT 1 FROM schedule_run WHERE chat_id = ? AND created_chat = 1 LIMIT 1').get(chatId) !== undefined;
  }

  private row(id: string): Record<string, unknown> | undefined {
    return this.db.prepare('SELECT * FROM schedule WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  }
}
