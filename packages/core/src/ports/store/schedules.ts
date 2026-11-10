import type { ScheduleRule, ScheduleRunStatus, ScheduleTarget, ScheduleTrigger } from '../../domain/schedule.js';
import type { SchedulePeerChangeAction } from '../../domain/schedule-peers.js';

// --- schedules (spec 2026-10-12-scheduled-tasks-design) ------------------------

/**
 * A prompt run on a profile on a timetable, with nobody there. Lives and runs
 * only on the machine that made it (never synced in phase 1). `timezone` is
 * that machine's IANA zone when it was made. `nextRunAt` is null while paused.
 */
export interface Schedule {
  id: string;
  name: string;
  prompt: string;
  profileId: string;
  target: ScheduleTarget;
  rule: ScheduleRule;
  timezone: string;
  enabled: boolean;
  nextRunAt: number | null;
  /**
   * Runs use Claude Code's auto mode (a Claude Code profile only): its
   * classifier decides the calls a card would have been needed for, and
   * OtherBench's own tools are approved, instead of all of them being
   * refused. Off by default: nobody watches what the classifier allows.
   */
  autoMode: boolean;
  /**
   * How long a run may go, in minutes, before it is stopped as Stop stops it
   * and recorded as timed out; null for no limit. Counts from the reply's
   * start, a wait on a card included. 30 by default
   * (`DEFAULT_SCHEDULE_TIME_LIMIT_MINUTES`).
   */
  timeLimitMinutes: number | null;
  createdAt: number;
  updatedAt: number;
  /**
   * Set only when the stored rule can't be read (a hand-edited row, say): why.
   * Such a schedule comes back disabled with a placeholder rule and never runs.
   */
  invalid?: string;
}

/** What `ScheduleRepo.create` takes: timestamps default to now, `autoMode` to false, `timeLimitMinutes` to 30. */
export type NewSchedule = Omit<Schedule, 'createdAt' | 'updatedAt' | 'invalid' | 'autoMode' | 'timeLimitMinutes'> & {
  createdAt?: number;
  updatedAt?: number;
  autoMode?: boolean;
  timeLimitMinutes?: number | null;
};

/** What `ScheduleRepo.update` may change. The target is fixed once made. */
export type SchedulePatch = Partial<Pick<Schedule, 'name' | 'prompt' | 'profileId' | 'rule' | 'enabled' | 'nextRunAt' | 'autoMode' | 'timeLimitMinutes' | 'updatedAt'>>;

/** One run of a schedule, kept in its history (the newest `SCHEDULE_RUNS_KEPT`). */
export interface ScheduleRun {
  id: string;
  scheduleId: string;
  trigger: ScheduleTrigger;
  /** The slot it ran for; null for Run now. */
  dueAt: number | null;
  startedAt: number;
  finishedAt: number | null;
  status: ScheduleRunStatus;
  /** Why it didn't start, the reply's error, or "Stopped after 30 minutes."; else null. */
  detail: string | null;
  /** The chat it wrote in; null before it has one, or once that chat is deleted. */
  chatId: string | null;
  /** The run made `chatId` (a project target): auto-title leaves such chats alone. */
  createdChat: boolean;
  userMessageId: string | null;
  messageId: string | null;
  /** How many of the reply's tool calls were refused for needing an approval (`deny:unattended` audit rows). */
  refusedCalls: number;
}

export type NewScheduleRun = Pick<ScheduleRun, 'id' | 'scheduleId' | 'trigger' | 'dueAt' | 'startedAt' | 'status'> &
  Partial<Pick<ScheduleRun, 'finishedAt' | 'detail' | 'chatId' | 'createdChat' | 'userMessageId' | 'messageId' | 'refusedCalls'>>;

export type ScheduleRunPatch = Partial<Omit<ScheduleRun, 'id' | 'scheduleId'>>;

/** A schedule as the API returns it (server routes/schedules.ts): the row plus what the UI shows with it. */
export interface ScheduleView extends Schedule {
  /** The target chat's title or the project's name; '' if it's gone. */
  targetName: string;
  /** `describeRule(rule)`. */
  describe: string;
  /** A run of it is being set up or written right now. */
  running: boolean;
  /** The run whose reply is being written now (what Stop stops); null while none is, or one is still being set up. Not always `lastRun`: a slot it overran is recorded after it. */
  activeRun: { runId: string; messageId: string } | null;
  lastRun: ScheduleRun | null;
  /** `unattendedWarnings` for its profile and target. */
  warnings: string[];
  /** The newest change a paired machine made to it (`ScheduleRepo.peerChanges`), named; absent when none has. */
  changedFrom?: { nodeId: string; machine: string; action: SchedulePeerChangeAction; at: number };
}

/**
 * A change a paired machine made to one of this machine's schedules over the peer listener, while this machine let
 * it (`AppSettings.peerScheduleControl`). Kept after the schedule is deleted, with the name it had, so a delete is
 * recorded too.
 */
export interface SchedulePeerChange {
  id: string;
  scheduleId: string;
  /** The schedule's name when the change was made. */
  scheduleName: string;
  action: SchedulePeerChangeAction;
  /** The paired machine it came from: the caller's authenticated node id, never anything it sent. */
  fromNode: string;
  /** The run it started, for Run now (`ran`); null otherwise. */
  runId: string | null;
  at: number;
}

/**
 * Schedules and their runs. Local only: no change tracking. Deleting a
 * schedule's target chat, project or profile deletes it (and its runs);
 * deleting a run's chat keeps the run with `chatId: null`.
 */
export interface ScheduleRepo {
  /** Throws on a duplicate id. */
  create(s: NewSchedule): Schedule;
  get(id: string): Schedule | null;
  /** Oldest made first. */
  list(): Schedule[];
  /** Throws for an unknown id. */
  update(id: string, patch: SchedulePatch): Schedule;
  /** Also deletes its runs. A no-op for an unknown id. */
  delete(id: string): void;
  /** Enabled schedules whose `nextRunAt` is at or before `now`, oldest due first (then oldest made, then id). */
  due(now: number): Schedule[];
  /** Adds a run (defaults: no finish, detail, chat, ids; 0 refused) and prunes the schedule's runs to the newest `SCHEDULE_RUNS_KEPT`. Throws for an unknown schedule. */
  addRun(r: NewScheduleRun): ScheduleRun;
  /** Merges `patch` into the run; null (and nothing written) when the run is gone. */
  updateRun(id: string, patch: ScheduleRunPatch): ScheduleRun | null;
  /** Newest first (by `startedAt`, then the order added). */
  runs(scheduleId: string): ScheduleRun[];
  lastRun(scheduleId: string): ScheduleRun | null;
  /** The newest run with status `complete`, or null. */
  lastCompleted(scheduleId: string): ScheduleRun | null;
  /** Every run with status `running`, across all schedules. */
  runningRuns(): ScheduleRun[];
  /** Whether some run created this chat. */
  madeChat(chatId: string): boolean;
  /** Points a chat schedule at another chat (a handover's new chat). Throws for a project schedule. */
  retarget(id: string, chatId: string): void;
  /**
   * Records a change a paired machine made (`at` defaults to now) and prunes the record to the newest
   * `SCHEDULE_PEER_CHANGES_KEPT` across all schedules. Not tied to the schedule: deleting it keeps its record.
   */
  recordPeerChange(c: Omit<SchedulePeerChange, 'at'> & { at?: number }): SchedulePeerChange;
  /** Changes paired machines made, newest first (then the newest recorded); every schedule's when `scheduleId` is left out. */
  peerChanges(scheduleId?: string): SchedulePeerChange[];
}
