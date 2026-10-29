import { randomUUID } from 'node:crypto';
import {
  MAX_CONCURRENT_SCHEDULED_RUNS,
  SCHEDULE_CHECK_MAX_MS,
  SCHEDULE_LATE_AFTER_MS,
  SCHEDULE_RUN_TIMEOUT_MS,
  nextRunAt,
  runChatTitle,
  scheduledPromptText,
  type ScheduleRunStatus,
  type ScheduleTrigger,
} from '@otherbench/core/domain/schedule.js';
import { extendToTip } from '@otherbench/core/domain/tree.js';
import { workspaceUnresolvedMessage, type TurnEvent, type TurnInput, type TurnResult } from '@otherbench/core/domain/turn.js';
import type { Schedule, ScheduleRun, Store } from '@otherbench/core/ports/store.js';
import type { ResolvedProfile } from '@otherbench/core/types/config.js';
import type { AppEvent } from '@otherbench/core/types/events.js';
import type { MessageStatus } from '@otherbench/core/types/messages.js';
import type { Workspace, WorkspaceStatus } from '@otherbench/core/types/workspace.js';
import { realScheduler, type Scheduler } from '../memory/scheduler.js';
import { collectMessageTree } from '../routes/chats.js';

export interface ScheduleLimits {
  maxConcurrent: number;
  timeoutMs: number;
  lateAfterMs: number;
  checkMaxMs: number;
}

export const DEFAULT_SCHEDULE_LIMITS: ScheduleLimits = {
  maxConcurrent: MAX_CONCURRENT_SCHEDULED_RUNS,
  timeoutMs: SCHEDULE_RUN_TIMEOUT_MS,
  lateAfterMs: SCHEDULE_LATE_AFTER_MS,
  checkMaxMs: SCHEDULE_CHECK_MAX_MS,
};

export interface ScheduleServiceDeps {
  store: Store;
  turnRunner: { on(cb: (e: TurnEvent) => void): () => void; cancel(messageId: string): void };
  /** `startTurn` bound to the container (turn-start.ts). */
  startTurn: (input: TurnInput) => Promise<TurnResult>;
  /** Rejects with a message the run records (a missing connection, one bound to another machine). */
  resolveProfile: (profileId: string) => Promise<ResolvedProfile>;
  /** A folder resolved on this machine (`workspaceResolver(container)`). */
  resolveWorkspace: (ws: Workspace | null) => WorkspaceStatus;
  /** Whether a reply is being written in the chat (`events.runningTurns()`). */
  isChatBusy: (chatId: string) => boolean;
  /** Whether the chat has messages sent during a reply still to go out (`NotesService.hasWaiting`): they go before a run. */
  hasWaitingNotes?: (chatId: string) => boolean;
  emit: (e: AppEvent) => void;
  now?: () => number;
  scheduler?: Scheduler;
  limits?: Partial<ScheduleLimits>;
  generateId?: () => string;
}

export type ScheduleBusyKind = 'running' | 'busy' | 'full';

/** Run now can't start: the schedule is already running, its chat has a reply on its way, or the scheduled-run slots are full. */
export class ScheduleBusyError extends Error {
  constructor(
    readonly kind: ScheduleBusyKind,
    message: string
  ) {
    super(message);
    this.name = 'ScheduleBusyError';
  }
}

interface ActiveRun {
  runId: string;
  schedule: Schedule;
  chatId: string;
  messageId: string;
  timer: unknown;
  timedOut: boolean;
}

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * Runs schedules (spec 2026-10-12-scheduled-tasks-design §4), patterned on
 * ProjectMemoryService. One timer, re-armed after every check for the
 * earliest future `nextRunAt`, never more than 30 s away, so sleep and clock
 * changes are caught within 30 s. Each check starts what it can of the due
 * schedules, oldest due first: a schedule whose previous run is still going
 * records that slot as not started and moves on; one whose chat has a reply
 * being written, or that would make more than two runs at once, is left due.
 * `nextRunAt` moves on in the same synchronous step that marks a run as
 * starting, so a crash never repeats a slot. Every run is unattended.
 */
export class ScheduleService {
  private readonly store: Store;
  private readonly turnRunner: ScheduleServiceDeps['turnRunner'];
  private readonly startTurn: ScheduleServiceDeps['startTurn'];
  private readonly resolveProfile: ScheduleServiceDeps['resolveProfile'];
  private readonly resolveWorkspace: ScheduleServiceDeps['resolveWorkspace'];
  private readonly isChatBusy: ScheduleServiceDeps['isChatBusy'];
  private readonly hasWaitingNotes: NonNullable<ScheduleServiceDeps['hasWaitingNotes']>;
  private readonly emit: ScheduleServiceDeps['emit'];
  private readonly now: () => number;
  private readonly scheduler: Scheduler;
  private readonly limits: ScheduleLimits;
  private readonly generateId: () => string;
  /** scheduleId -> the chat its run will write in, while the run is being set up (null until a project run has made its chat). */
  private readonly starting = new Map<string, string | null>();
  /** messageId -> the run writing it. */
  private readonly active = new Map<string, ActiveRun>();
  private readonly launches = new Set<Promise<void>>();
  private timer: unknown = null;
  private off: (() => void) | null = null;
  private disposed = false;

  constructor(deps: ScheduleServiceDeps) {
    this.store = deps.store;
    this.turnRunner = deps.turnRunner;
    this.startTurn = deps.startTurn;
    this.resolveProfile = deps.resolveProfile;
    this.resolveWorkspace = deps.resolveWorkspace;
    this.isChatBusy = deps.isChatBusy;
    this.hasWaitingNotes = deps.hasWaitingNotes ?? (() => false);
    this.emit = deps.emit;
    this.now = deps.now ?? Date.now;
    this.scheduler = deps.scheduler ?? realScheduler;
    this.limits = { ...DEFAULT_SCHEDULE_LIMITS, ...deps.limits };
    this.generateId = deps.generateId ?? randomUUID;
  }

  /** Startup: a run left `running` by a previous process is an error (its reply was already reconciled); then listens for replies ending, and checks. */
  start(): void {
    const now = this.now();
    for (const run of this.store.schedules.runningRuns()) {
      this.store.schedules.updateRun(run.id, { status: 'error', detail: 'OtherBench stopped before this run finished.', finishedAt: now });
    }
    this.off = this.turnRunner.on((e) => this.onTurnEvent(e));
    this.check();
  }

  /**
   * Ends the runs whose chat was deleted, starts what it can of the due
   * schedules, then re-arms the timer. A store error is logged and the timer
   * still re-armed, so one bad check never stops the schedules for good.
   */
  check(): void {
    if (this.disposed) return;
    const now = this.now();
    try {
      this.endDeletedRuns();
      for (const schedule of this.store.schedules.due(now)) {
        try {
          if (this.isRunning(schedule.id)) {
            this.skipSlot(schedule, now);
            continue;
          }
          if (schedule.target.kind === 'chat' && this.chatInUse(schedule.target.chatId)) continue;
          if (this.runningCount() >= this.limits.maxConcurrent) continue;
          const due = schedule.nextRunAt ?? now;
          this.begin(schedule, this.triggerFor(now, due), due);
        } catch (err) {
          console.error(`[otherbench-server] schedule ${schedule.id} could not be checked:`, err);
        }
      }
    } catch (err) {
      console.error('[otherbench-server] the schedules could not be checked:', err);
    } finally {
      this.arm(now);
    }
  }

  /** Checks now: after a create, an edit, a resume, and each run's end. Never throws, so a route that pokes never fails over it. */
  poke(): void {
    try {
      this.check();
    } catch (err) {
      console.error('[otherbench-server] the schedules could not be checked:', err);
    }
  }

  /** Starts a `manual` run now, or throws `ScheduleBusyError`. Leaves the timetable alone. */
  runNow(id: string): ScheduleRun {
    const schedule = this.store.schedules.get(id);
    if (!schedule) throw new Error(`Schedule "${id}" not found.`);
    if (this.isRunning(id)) throw new ScheduleBusyError('running', 'This schedule is already running. Wait for it to finish, or stop it.');
    if (schedule.target.kind === 'chat' && this.chatInUse(schedule.target.chatId)) {
      throw new ScheduleBusyError('busy', 'A reply is being written in this chat. Try again when it has finished.');
    }
    if (this.runningCount() >= this.limits.maxConcurrent) {
      throw new ScheduleBusyError('full', `${this.limits.maxConcurrent} scheduled runs are already going. Try again when one has finished.`);
    }
    return this.begin(schedule, 'manual', null);
  }

  isRunning(scheduleId: string): boolean {
    return this.starting.has(scheduleId) || [...this.active.values()].some((r) => r.schedule.id === scheduleId);
  }

  /** The schedule's run whose reply is being written now; null while none is (or one is still being set up). */
  activeRun(scheduleId: string): { runId: string; messageId: string } | null {
    const run = [...this.active.values()].find((r) => r.schedule.id === scheduleId);
    return run ? { runId: run.runId, messageId: run.messageId } : null;
  }

  /** For tests: resolves once every run being set up has started its reply or ended. */
  async idle(): Promise<void> {
    while (this.launches.size > 0) await Promise.all([...this.launches]);
  }

  /** Stops the timer and stops listening. Replies already running are left to the container's shutdown. */
  dispose(): void {
    this.disposed = true;
    if (this.timer !== null) this.scheduler.clearTimeout(this.timer);
    this.timer = null;
    for (const run of this.active.values()) this.scheduler.clearTimeout(run.timer);
    this.off?.();
    this.off = null;
  }

  private runningCount(): number {
    return this.starting.size + this.active.size;
  }

  /** Scheduled runs starting or running now (the desktop updater waits for them: routes/desktop.ts). */
  activeRunCount(): number {
    return this.runningCount();
  }

  /**
   * A reply is being written in the chat, messages sent during one are
   * still to go out (spec 2026-10-18-send-while-replying-design: they go
   * first), or one of this service's runs is about to write one there. The
   * last matters: `turn-started` (what `isChatBusy` sees) only fires once a
   * run's `startTurn` has resolved, so two schedules due together on one chat
   * would otherwise both start off the same parent.
   */
  private chatInUse(chatId: string): boolean {
    if (this.isChatBusy(chatId) || this.hasWaitingNotes(chatId)) return true;
    if ([...this.starting.values()].includes(chatId)) return true;
    return [...this.active.values()].some((r) => r.chatId === chatId);
  }

  private triggerFor(now: number, due: number): ScheduleTrigger {
    return now - due > this.limits.lateAfterMs ? 'late' : 'scheduled';
  }

  /** The previous run is still going: this slot is recorded as not started and the timetable moves on. */
  private skipSlot(schedule: Schedule, now: number): void {
    const due = schedule.nextRunAt ?? now;
    const run = this.store.transaction(() => {
      this.store.schedules.update(schedule.id, { nextRunAt: nextRunAt(schedule.rule, schedule.timezone, Math.max(now, due)) });
      return this.store.schedules.addRun({
        id: this.generateId(),
        scheduleId: schedule.id,
        trigger: this.triggerFor(now, due),
        dueAt: due,
        startedAt: now,
        finishedAt: now,
        status: 'not_started',
        detail: 'The previous run was still going.',
      });
    });
    this.announceFinished(schedule, run);
  }

  /** Synchronously: marks the schedule starting, moves its timetable on (unless manual) and writes the run; then sets the run up in the background. */
  private begin(schedule: Schedule, trigger: ScheduleTrigger, dueAt: number | null): ScheduleRun {
    const now = this.now();
    this.starting.set(schedule.id, schedule.target.kind === 'chat' ? schedule.target.chatId : null);
    let run: ScheduleRun;
    try {
      run = this.store.transaction(() => {
        if (trigger !== 'manual' && dueAt !== null) {
          this.store.schedules.update(schedule.id, { nextRunAt: nextRunAt(schedule.rule, schedule.timezone, Math.max(now, dueAt)) });
        }
        return this.store.schedules.addRun({ id: this.generateId(), scheduleId: schedule.id, trigger, dueAt, startedAt: now, status: 'running' });
      });
    } catch (err) {
      this.starting.delete(schedule.id);
      throw err;
    }
    const launch: Promise<void> = this.launch(schedule, run)
      .catch((err: unknown) => console.error(`[otherbench-server] schedule ${schedule.id} run ${run.id} could not be set up:`, err))
      .finally(() => this.launches.delete(launch));
    this.launches.add(launch);
    return run;
  }

  /**
   * Resolves the profile and the target, sends the turn, and tracks its reply.
   * Any failure before the turn starts ends the run as not started. Disposed
   * meanwhile (shutdown): stops where it is, writing nothing more; a run left
   * `running` is closed by the next start.
   */
  private async launch(schedule: Schedule, run: ScheduleRun): Promise<void> {
    let chatId: string | null = schedule.target.kind === 'chat' ? schedule.target.chatId : null;
    try {
      const profile = await this.profileFor(schedule);
      if (this.disposed) return;
      const target = this.prepareTarget(schedule, run, profile);
      chatId = target.chatId;
      this.starting.set(schedule.id, target.chatId);
      const previous = this.store.schedules.lastCompleted(schedule.id);
      const text = scheduledPromptText({
        name: schedule.name,
        prompt: schedule.prompt,
        timezone: schedule.timezone,
        trigger: run.trigger,
        at: run.startedAt,
        dueAt: run.dueAt,
        previousAt: previous?.startedAt ?? null,
      });
      const result = await this.startTurn({ chatId: target.chatId, parentId: target.parentId, userParts: [{ type: 'text', text }], profiles: [profile], unattended: true });
      // The turn has started, but the container's shutdown owns it now.
      if (this.disposed) return;
      const messageId = result.assistantMessageIds[0];
      if (!messageId) throw new Error('The turn started without a reply.');
      const recorded = this.store.schedules.updateRun(run.id, { userMessageId: result.userMessageId, messageId });
      this.starting.delete(schedule.id);
      // The schedule was deleted meanwhile: the reply finishes unrecorded.
      if (recorded) this.track(schedule, recorded, target.chatId, messageId);
    } catch (err) {
      this.starting.delete(schedule.id);
      if (this.disposed) return;
      const ended = this.store.schedules.updateRun(run.id, { status: 'not_started', detail: errorMessage(err), finishedAt: this.now() });
      if (ended) this.announceFinished(schedule, ended, chatId);
      // A slot is free again: a schedule waiting for one may go now.
      this.poke();
    } finally {
      this.starting.delete(schedule.id);
    }
  }

  private async profileFor(schedule: Schedule): Promise<ResolvedProfile> {
    const profile = await this.resolveProfile(schedule.profileId);
    if (profile.archivedAt !== null) throw new Error(`The profile "${profile.name}" is archived. Choose another profile for this schedule.`);
    return profile;
  }

  /** The chat the run writes in and the message it continues from; a project target makes its chat here. */
  private prepareTarget(schedule: Schedule, run: ScheduleRun, profile: ResolvedProfile): { chatId: string; parentId: string | null } {
    if (schedule.target.kind === 'project') {
      const project = this.store.projects.get(schedule.target.projectId);
      if (!project) throw new Error('The project was deleted.');
      const folder = this.resolveWorkspace(project.workspace);
      if (folder.status === 'unresolved') throw new Error(workspaceUnresolvedMessage(folder));
      // The project's folder, copied as POST /chats copies it; runs on this machine.
      const chat = this.store.chats.create({
        id: this.generateId(),
        title: runChatTitle(schedule.name, run.startedAt, schedule.timezone),
        profileId: profile.id,
        headMessageId: null,
        workspace: project.workspace,
        pinned: false,
        archivedAt: null,
        projectId: project.id,
      });
      // Recorded before the turn starts, so auto-title (routes/chats.ts) already sees that a run made it.
      this.store.schedules.updateRun(run.id, { chatId: chat.id, createdChat: true });
      return { chatId: chat.id, parentId: null };
    }
    const chat = this.store.chats.get(schedule.target.chatId);
    if (!chat) throw new Error('The chat was deleted.');
    if (chat.runsOn !== this.store.nodes.self().id) {
      const machine = this.store.peers.get(chat.runsOn)?.name ?? 'another machine';
      throw new Error(`This chat now runs on ${machine}, so its schedule can't run here.`);
    }
    const folder = this.resolveWorkspace(chat.workspace);
    if (folder.status === 'unresolved') throw new Error(workspaceUnresolvedMessage(folder));
    this.store.schedules.updateRun(run.id, { chatId: chat.id });
    return { chatId: chat.id, parentId: this.tipOf(chat.id, chat.headMessageId) };
  }

  /** The end of the chat's active branch (`extendToTip` from its head), which must be a finished reply; null for an empty chat. */
  private tipOf(chatId: string, headId: string | null): string | null {
    const messages = collectMessageTree(this.store, chatId);
    if (messages.length === 0) return null;
    if (headId === null) throw new Error('This chat has messages but no current one to continue from. Open it and pick a reply.');
    const tip = extendToTip(messages, headId).at(-1) ?? messages.find((m) => m.id === headId);
    if (!tip) throw new Error("This chat's current message is missing. Open it and pick a reply.");
    if (tip.role !== 'assistant') {
      throw new Error('This chat ends in a message with no reply kept (an unpicked compare, or a message with no answer). Pick a reply in the chat, then the schedule can run.');
    }
    if (tip.status === 'streaming') throw new Error('A reply is still being written in this chat.');
    return tip.id;
  }

  /** Watches the run's reply: arms the timeout and announces the start. A reply that already ended (a fast model) is ended here. */
  private track(schedule: Schedule, run: ScheduleRun, chatId: string, messageId: string): void {
    const entry: ActiveRun = { runId: run.id, schedule, chatId, messageId, timer: null, timedOut: false };
    entry.timer = this.scheduler.setTimeout(() => this.onTimeout(entry), this.limits.timeoutMs);
    this.active.set(messageId, entry);
    this.emit({ type: 'schedule-run-started', scheduleId: schedule.id, scheduleName: schedule.name, runId: run.id, chatId, messageId });
    const status = this.store.messages.get(messageId)?.status;
    if (status !== undefined && status !== 'streaming') this.end(entry, status);
  }

  /**
   * The run's time is up. Runs in a timer, so nothing may escape it: a store
   * error here (a locked database) would be an uncaught exception that takes
   * the server down. On one the run is given up on: ended as an error if the
   * store allows, its slot freed, and a check poked so waiting schedules go.
   */
  private onTimeout(entry: ActiveRun): void {
    try {
      if (this.chatDeleted(entry)) {
        this.endDeleted(entry);
        this.poke();
        return;
      }
      entry.timedOut = true;
      this.turnRunner.cancel(entry.messageId);
    } catch (err) {
      console.error(`[otherbench-server] schedule ${entry.schedule.id} run ${entry.runId} could not be stopped at its timeout:`, err);
      this.giveUp(entry, err);
      this.poke();
    }
  }

  /** Best effort, never throws: frees the run's slot and records it as an error. The reply, if it is still going, finishes unrecorded. */
  private giveUp(entry: ActiveRun, cause: unknown): void {
    this.active.delete(entry.messageId);
    try {
      this.scheduler.clearTimeout(entry.timer);
      const run = this.store.schedules.updateRun(entry.runId, {
        status: 'error',
        detail: `OtherBench couldn't stop this run: ${errorMessage(cause)}`,
        finishedAt: this.now(),
      });
      if (run) this.announceFinished(entry.schedule, run, entry.chatId);
    } catch (err) {
      console.error(`[otherbench-server] schedule ${entry.schedule.id} run ${entry.runId} could not be recorded as stopped:`, err);
    }
  }

  private onTurnEvent(e: TurnEvent): void {
    if (e.type !== 'status' || e.status === 'streaming') return;
    const entry = this.active.get(e.messageId);
    if (entry) {
      this.end(entry, e.status);
      return;
    }
    // Another reply ended: a schedule waiting for its chat may go now. After
    // this event's other listeners, so the app event bus has already marked the chat free.
    if (!this.disposed) queueMicrotask(() => this.poke());
  }

  private end(entry: ActiveRun, status: MessageStatus): void {
    if (!this.active.has(entry.messageId)) return;
    if (this.chatDeleted(entry)) {
      this.endDeleted(entry);
    } else {
      this.active.delete(entry.messageId);
      this.scheduler.clearTimeout(entry.timer);
      const final: ScheduleRunStatus = status === 'complete' ? 'complete' : status === 'cancelled' ? (entry.timedOut ? 'timed_out' : 'cancelled') : 'error';
      const detail =
        final === 'timed_out'
          ? `Stopped after ${Math.round(this.limits.timeoutMs / 60_000)} minutes.`
          : final === 'error'
            ? (this.store.messages.get(entry.messageId)?.error?.message ?? null)
            : null;
      const refusedCalls = this.store.audit.list(entry.chatId).filter((a) => a.messageId === entry.messageId && a.grantedBy === 'deny:unattended').length;
      const run = this.store.schedules.updateRun(entry.runId, { status: final, detail, finishedAt: this.now(), refusedCalls });
      if (run) this.announceFinished(entry.schedule, run, entry.chatId);
    }
    this.poke();
  }

  /** The run's reply is gone: its chat was deleted, and the messages with it. */
  private chatDeleted(entry: ActiveRun): boolean {
    return !this.store.messages.get(entry.messageId);
  }

  /**
   * Ends a run whose chat was deleted mid-reply as an error, and stops the
   * reply, which has nowhere left to write. Deleting a chat doesn't stop its
   * reply, so the reply's own end could be up to the 30-minute timeout away:
   * this is swept for at every check. Writes nothing if the schedule went too.
   */
  private endDeleted(entry: ActiveRun): void {
    if (!this.active.delete(entry.messageId)) return;
    this.scheduler.clearTimeout(entry.timer);
    this.turnRunner.cancel(entry.messageId);
    const run = this.store.schedules.updateRun(entry.runId, { status: 'error', detail: 'The chat was deleted.', finishedAt: this.now() });
    if (run) this.announceFinished(entry.schedule, run, null);
  }

  /** Swept at the top of every check: ends the runs whose chat was deleted. */
  private endDeletedRuns(): void {
    for (const entry of [...this.active.values()]) {
      if (this.chatDeleted(entry)) this.endDeleted(entry);
    }
  }

  private announceFinished(schedule: Schedule, run: ScheduleRun, chatId: string | null = run.chatId): void {
    const scheduleChat = schedule.target.kind === 'chat' ? schedule.target.chatId : null;
    this.emit({
      type: 'schedule-run-finished',
      scheduleId: schedule.id,
      scheduleName: schedule.name,
      runId: run.id,
      chatId: run.chatId ?? chatId ?? scheduleChat,
      messageId: run.messageId,
      status: run.status,
      detail: run.detail,
    });
  }

  /** The next check: at the earliest future `nextRunAt`, at most `checkMaxMs` away. A due schedule left waiting counts as "now" only through `poke`, never as a 0 ms timer. */
  private arm(now: number): void {
    if (this.timer !== null) this.scheduler.clearTimeout(this.timer);
    this.timer = null;
    if (this.disposed) return;
    let wait = this.limits.checkMaxMs;
    try {
      for (const s of this.store.schedules.list()) {
        if (s.enabled && s.nextRunAt !== null && s.nextRunAt > now) wait = Math.min(wait, s.nextRunAt - now);
      }
    } catch (err) {
      // Checked again within checkMaxMs either way.
      console.error('[otherbench-server] the schedules could not be listed:', err);
      wait = this.limits.checkMaxMs;
    }
    this.timer = this.scheduler.setTimeout(() => {
      this.timer = null;
      this.check();
    }, wait);
  }
}
