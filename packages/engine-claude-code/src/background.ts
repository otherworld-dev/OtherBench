import type { BackgroundHelper, EngineBackgroundEvent } from '@otherbench/core/ports/chat-engine.js';

type Obj = Record<string, unknown>;

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);

/** How many finished tasks are remembered (for SendMessage to resume one onto its card); older ones are forgotten. */
const KEEP_ENDED = 50;
/** How many helper cards are remembered beyond those of the tasks kept. */
const KEEP_CARDS = 200;

/** One task Claude Code reported, and where its card is. */
interface Task {
  helper: BackgroundHelper;
  /** Ended (notification seen); kept so a resume can find its card. */
  ended: boolean;
}

/**
 * The background tasks one Claude Code process has running for its chat
 * (spec 2026-10-17-claude-background-helpers-design): helpers (Task/Agent in
 * the background) and background shells, monitors and the like. It reads
 * every message the process produces, in order, as the process's reader
 * gets it (in a reply or between replies), and reports the chat's live set
 * (`helpers`) and changes to a helper's card in an earlier reply
 * (`helper-event`: it finished, or went back to work). A helper card is noted
 * from the main agent's Task/Agent call, as belonging to the reply running
 * then (`current`); that reply's own cards are left to its event mapper.
 */
export class BackgroundTasks {
  /** The reply that's running, if any: new helper cards are its, and its own cards aren't touched from here. */
  current: string | null = null;
  private readonly tasks = new Map<string, Task>();
  /** Each helper card's reply, by the tool call that started it. */
  private readonly cards = new Map<string, string>();
  /** Which helper made each tool call. */
  private readonly owners = new Map<string, string>();
  /** Who is waiting to learn which helper made a call (whenOwned). */
  private readonly ownerWaiters = new Map<string, (() => void)[]>();
  private lastSent = '';
  /** The task that finished most recently: what a turn Claude Code starts by itself is carrying on after. */
  lastFinished: BackgroundHelper | null = null;

  constructor(
    readonly chatId: string,
    private readonly emit: (event: EngineBackgroundEvent) => void,
    private readonly now: () => number = Date.now
  ) {}

  /** The helper started by the tool call `callId` has its card in the reply `messageId`. */
  noteCard(callId: string, messageId: string): void {
    this.cards.set(callId, messageId);
  }

  /** The running reply has its message id now (a self-started one gets it after its turn began): its cards move with it. */
  renameCurrent(from: string, to: string): void {
    for (const [callId, messageId] of this.cards) if (messageId === from) this.cards.set(callId, to);
    if (this.current === from) this.current = to;
  }

  /** Whether any task is running. */
  get running(): boolean {
    return [...this.tasks.values()].some((t) => !t.ended);
  }

  /** The tasks running now, as the chat shows them. */
  list(): BackgroundHelper[] {
    return [...this.tasks.values()].filter((t) => !t.ended).map((t) => t.helper);
  }

  /** Whether this process is running the task `taskId`. */
  has(taskId: string): boolean {
    const task = this.tasks.get(taskId);
    return task !== undefined && !task.ended;
  }

  /** The helper that made tool call `toolUseId`, with its card's reply, or null. */
  ownerOf(toolUseId: string): { callId: string; label: string; messageId: string } | null {
    const callId = this.owners.get(toolUseId);
    if (callId === undefined) return null;
    const messageId = this.cards.get(callId);
    const task = [...this.tasks.values()].find((t) => t.helper.callId === callId);
    return messageId !== undefined && task ? { callId, label: task.helper.label, messageId } : null;
  }

  /**
   * The helper that made tool call `toolUseId`, waiting up to `ms` for the
   * message that says so: Claude Code can ask about a call (its PreToolUse
   * hook) a moment before this process's reader has read the helper's message
   * naming it. Null when no helper is running, or none claims it in time.
   */
  async whenOwned(toolUseId: string, ms: number): Promise<{ callId: string; label: string; messageId: string } | null> {
    const known = this.ownerOf(toolUseId);
    if (known || !this.running) return known;
    await new Promise<void>((resolve) => {
      const waiters = this.ownerWaiters.get(toolUseId) ?? [];
      const done = (): void => {
        clearTimeout(timer);
        const left = (this.ownerWaiters.get(toolUseId) ?? []).filter((w) => w !== done);
        if (left.length > 0) this.ownerWaiters.set(toolUseId, left);
        else this.ownerWaiters.delete(toolUseId);
        resolve();
      };
      const timer = setTimeout(done, ms);
      timer.unref?.();
      this.ownerWaiters.set(toolUseId, [...waiters, done]);
    });
    return this.ownerOf(toolUseId);
  }

  handle(raw: unknown): void {
    if (typeof raw !== 'object' || raw === null) return;
    const m = raw as Obj;
    if (m['type'] === 'assistant') return this.toolCalls(m);
    if (m['type'] !== 'system') return;
    switch (m['subtype']) {
      case 'background_tasks_changed':
        return this.liveSet(m);
      case 'task_started':
        return this.started(m);
      case 'task_progress':
        return this.progress(m);
      case 'task_notification':
        return this.finished(m);
      default:
        return;
    }
  }

  /** The process is gone: every task ends as stopped. */
  closeAll(): void {
    for (const waiters of [...this.ownerWaiters.values()]) for (const wake of waiters) wake();
    for (const task of this.tasks.values()) {
      if (task.ended) continue;
      task.ended = true;
      this.cardEvent(task, { type: 'end', status: 'cancelled', at: this.now() });
    }
    this.sendList();
  }

  private toolCalls(m: Obj): void {
    const parent = str(m['parent_tool_use_id']);
    if (parent === null) return this.mainCalls(m);
    const task = [...this.tasks.values()].find((t) => t.helper.callId === parent && !t.ended);
    const content = (m['message'] as { content?: unknown } | undefined)?.content;
    for (const block of Array.isArray(content) ? content : []) {
      if (typeof block !== 'object' || block === null || (block as Obj)['type'] !== 'tool_use') continue;
      const id = str((block as Obj)['id']);
      if (id) {
        this.owners.set(id, parent);
        for (const wake of this.ownerWaiters.get(id) ?? []) wake();
      }
      const name = str((block as Obj)['name']);
      if (task && name) task.helper = { ...task.helper, lastActivity: name };
    }
    this.sendList();
  }

  /** The main agent's Task/Agent calls start helper cards in the running reply. */
  private mainCalls(m: Obj): void {
    if (this.current === null) return;
    const content = (m['message'] as { content?: unknown } | undefined)?.content;
    for (const block of Array.isArray(content) ? content : []) {
      if (typeof block !== 'object' || block === null) continue;
      const b = block as Obj;
      const id = str(b['id']);
      if (b['type'] === 'tool_use' && id && (b['name'] === 'Task' || b['name'] === 'Agent')) this.cards.set(id, this.current);
    }
  }

  private liveSet(m: Obj): void {
    const listed = Array.isArray(m['tasks']) ? (m['tasks'] as Obj[]) : [];
    const live = new Set<string>();
    for (const t of listed) {
      const taskId = str(t['task_id']);
      if (!taskId || t['ambient'] === true) continue;
      live.add(taskId);
      const known = this.tasks.get(taskId);
      if (known && !known.ended) continue;
      this.tasks.set(taskId, { helper: { taskId, callId: known?.helper.callId ?? null, kind: str(t['task_type']) ?? 'local_agent', label: str(t['description']) ?? 'Background task', startedAt: this.now(), lastActivity: null }, ended: false });
    }
    // Replace semantics: a task no longer listed has finished (its card hears from its notification).
    for (const [taskId, task] of this.tasks) if (!task.ended && !live.has(taskId)) task.ended = true;
    this.prune();
    this.sendList();
  }

  private started(m: Obj): void {
    const taskId = str(m['task_id']);
    if (!taskId || m['ambient'] === true || m['skip_transcript'] === true) return;
    const known = this.tasks.get(taskId);
    const toolUseId = str(m['tool_use_id']);
    // A known task's card stays the one it started with (a resume comes with SendMessage's call id).
    const callId = known?.helper.callId ?? (toolUseId && this.cards.has(toolUseId) ? toolUseId : null);
    const helper: BackgroundHelper = {
      taskId,
      callId,
      kind: str(m['task_type']) ?? known?.helper.kind ?? 'local_agent',
      label: str(m['description']) ?? known?.helper.label ?? 'Background task',
      startedAt: known && !known.ended ? known.helper.startedAt : this.now(),
      lastActivity: known && !known.ended ? known.helper.lastActivity : null,
    };
    const resumed = known?.ended === true;
    const task = { helper, ended: false };
    this.tasks.delete(taskId);
    this.tasks.set(taskId, task);
    if (resumed) this.cardEvent(task, { type: 'background', at: this.now() });
    this.sendList();
  }

  private progress(m: Obj): void {
    const task = this.tasks.get(str(m['task_id']) ?? '');
    if (!task || task.ended) return;
    const activity = str(m['summary']) ?? str(m['last_tool_name']);
    if (activity) task.helper = { ...task.helper, lastActivity: activity };
    this.sendList();
  }

  private finished(m: Obj): void {
    const task = this.tasks.get(str(m['task_id']) ?? '');
    if (!task) return;
    const wasRunning = !task.ended;
    task.ended = true;
    this.lastFinished = task.helper;
    const summary = str(m['summary']);
    const at = this.now();
    if (wasRunning || this.cards.has(task.helper.callId ?? '')) {
      if (m['status'] === 'completed') {
        if (summary) this.cardEvent(task, { type: 'text-delta', text: summary });
        this.cardEvent(task, { type: 'end', status: 'complete', at });
      } else if (m['status'] === 'failed') {
        this.cardEvent(task, { type: 'end', status: 'error', error: summary ?? 'The helper failed.', at });
      } else {
        this.cardEvent(task, { type: 'end', status: 'cancelled', at });
      }
    }
    this.prune();
    this.sendList();
  }

  /**
   * Forgets what a long-lived process no longer needs: the calls of helpers
   * that finished (a resumed one's new calls are learnt again), finished tasks
   * past the most recent KEEP_ENDED with their cards, and cards past
   * KEEP_CARDS that no task kept has.
   */
  private prune(): void {
    const working = new Set([...this.tasks.values()].filter((t) => !t.ended).map((t) => t.helper.callId));
    for (const [toolUseId, callId] of this.owners) if (!working.has(callId)) this.owners.delete(toolUseId);
    let ended = [...this.tasks.values()].filter((t) => t.ended).length;
    for (const [taskId, task] of this.tasks) {
      if (ended <= KEEP_ENDED) break;
      if (!task.ended) continue;
      this.tasks.delete(taskId);
      if (task.helper.callId !== null) this.cards.delete(task.helper.callId);
      ended--;
    }
    const kept = new Set([...this.tasks.values()].map((t) => t.helper.callId));
    let extra = this.cards.size - kept.size - KEEP_CARDS;
    for (const callId of this.cards.keys()) {
      if (extra <= 0) break;
      if (kept.has(callId)) continue;
      this.cards.delete(callId);
      extra--;
    }
  }

  /** A change to the task's card, when it has one in an earlier reply. */
  private cardEvent(task: Task, event: Extract<EngineBackgroundEvent, { type: 'helper-event' }>['event']): void {
    const callId = task.helper.callId;
    const messageId = callId === null ? undefined : this.cards.get(callId);
    if (callId === null || messageId === undefined || messageId === this.current) return;
    this.emit({ type: 'helper-event', chatId: this.chatId, messageId, callId, event });
  }

  private sendList(): void {
    const list = this.list();
    const key = JSON.stringify(list);
    if (key === this.lastSent) return;
    this.lastSent = key;
    this.emit({ type: 'helpers', chatId: this.chatId, helpers: list });
  }
}
