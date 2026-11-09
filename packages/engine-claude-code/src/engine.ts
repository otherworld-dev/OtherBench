import { existsSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Options } from '@anthropic-ai/claude-agent-sdk';
import { CLEAR_ON_ITS_OWN, NOTHING_TO_COMPACT, type CommandRow } from '@otherbench/core/domain/context-lines.js';
import { NOTHING_TO_HAND_OVER } from '@otherbench/core/domain/handover.js';
import { HelperStopError, type ChatEngine, type ConnectionTestResult, type DiscoveredModel, type EngineBackgroundEvent, type EngineEvent, type EngineRequest } from '@otherbench/core/ports/chat-engine.js';
import type { NoteAttachment } from '@otherbench/core/types/messages.js';
import type { Connection, ResolvedProfile } from '@otherbench/core/types/config.js';
import type { ClaudeAccountRef } from '@otherbench/core/types/claude-accounts.js';
import type { PlanUsage } from '@otherbench/core/types/usage.js';
import type { ClaudeCodeEngineDeps } from './deps.js';
import { backendOf } from './env.js';
import { classifyClaudeCodeFailure } from './errors.js';
import { LivePool, liveKey, type LiveProcess, type OtherBenchServerSwitches } from './live.js';
import { chatCommands } from './commands.js';
import { toPlanUsage } from './plan-usage.js';
import { launchProcess } from './process-launch.js';
import { processOptions } from './process-options.js';
import type { Relay } from './relay.js';
import { prepareReply } from './reply-binding.js';
import { pickSession, SessionClaims, type SessionPlan } from './session.js';
import { probe, utility } from './side-calls.js';
import { cancelNote } from './turn-stop.js';
import { loginAccount, ReplyTurns, type Compaction, type PendingNotice } from './turns.js';
import { compactFocus, newImages, noteContent, omittedImagesNotice, sendsClear, skippedFiles, userContent, userMessage, type ContentBlock } from './user-content.js';

export type { ClaudeCodeEngineDeps, QueryFn } from './deps.js';
export { SECRET_DENY_RULES } from './process-options.js';
export { INTERRUPT_GRACE_MS } from './turns.js';

/** A clean chat's folder name under the scratch root: its id, made a plain name so it can't point outside (the server deletes it by the same rule). */
export function scratchFolderName(chatId: string): string {
  return chatId.replace(/[^A-Za-z0-9_-]/g, '_');
}

/**
 * Runs OtherBench turns through the local Claude Code install via the Agent SDK
 * (spec: docs/superpowers/specs/2026-10-02-claude-code-engine-design.md).
 * Claude Code owns the agent loop and its tools; OtherBench owns permission
 * (every call goes through `approvals.requestApproval`) and the transcript.
 */
export class ClaudeCodeChatEngine implements ChatEngine {
  private readonly claims = new SessionClaims();
  /** Where clean chats run when `deps.scratchRoot` isn't given: made on first use (scratchFolder). */
  private privateScratch: string | undefined;
  /** Claude Code processes kept alive between replies, by session (see live.ts). */
  private readonly pool: LivePool;
  /** Every process started, so `dispose` can stop the busy ones too. */
  private readonly processes = new Set<LiveProcess>();
  /** Each chat's last command list from a live process, so the menu has one while no process is running. */
  private readonly commandLists = new Map<string, CommandRow[]>();
  /** The replies running now (a user's or a self-started one), by message id: where a note sent to one goes. */
  private readonly running = new Map<string, { live: LiveProcess; req: EngineRequest }>();
  /** Notes `sendToReply` is reading the images of, before they're pushed: `withdrawn` once taken back meanwhile. */
  private readonly pendingNotes = new Map<string, { withdrawn: boolean }>();
  /** Reads each reply's turn from its process, and self-started ones (turns.ts). */
  private readonly turns: ReplyTurns;

  constructor(private readonly deps: ClaudeCodeEngineDeps) {
    this.pool = new LivePool(deps.liveIdleMs, deps.maxLive);
    this.turns = new ReplyTurns(deps, this.pool, this.processes, this.running, (chatId) => this.scratchFolder(chatId), (chatId, live) => this.rememberCommands(chatId, live));
  }

  /** Stops every Claude Code process this engine started (server shutdown). */
  dispose(): void {
    this.pool.closeAll();
    for (const live of this.processes) live.close();
    this.processes.clear();
    this.commandLists.clear();
  }

  /**
   * The Claude Code commands a chat's slash menu offers. Only a live process is
   * asked: starting one just to list would run the folder's SessionStart hook.
   * With none, the chat's last list is returned (empty before its first reply).
   */
  async listCommands(input: { chatId: string; profile: ResolvedProfile; workspaceRoot: string | null }): Promise<CommandRow[]> {
    const live = [...this.processes].find((p) => !p.isClosed && p.last?.chatId === input.chatId && p.query.supportedCommands);
    if (live) {
      const rows = await this.rememberCommands(input.chatId, live);
      if (rows) return rows;
    }
    return this.commandLists.get(input.chatId) ?? [];
  }

  /** Asks a live process for its commands and remembers them; null when it can't answer. */
  private async rememberCommands(chatId: string, live: LiveProcess): Promise<CommandRow[] | null> {
    try {
      const rows = chatCommands((await live.query.supportedCommands?.()) ?? []);
      this.commandLists.set(chatId, rows);
      return rows;
    } catch {
      return null;
    }
  }

  onBackground(handler: (event: EngineBackgroundEvent) => void): void {
    this.turns.backgroundHandler = handler;
  }

  async stopHelper(chatId: string, taskId: string): Promise<boolean> {
    for (const live of this.processes) {
      if (live.isClosed || live.background?.chatId !== chatId || !live.background.has(taskId)) continue;
      if (!live.query.stopTask) throw new HelperStopError("This version of Claude Code can't stop one background task. Update Claude Code to stop it from here.");
      await live.query.stopTask(taskId);
      return true;
    }
    return false;
  }

  /**
   * Pushes a note into the running reply's Claude Code with the note's id as
   * its uuid, so its command lifecycle says where it was read (live.ts).
   * False when the reply isn't running here, or this Claude Code doesn't
   * report a message's lifecycle.
   */
  async sendToReply(messageId: string, note: { id: string; text: string; attachments: NoteAttachment[] }): Promise<boolean> {
    const run = this.running.get(messageId);
    if (!run || run.live.isClosed || run.req.signal.aborted || !run.live.capabilities.includes('msg_lifecycle_v1')) return false;
    // Pending while its images are read, so a Take back meanwhile neither finds it unknown nor misses it.
    const pending = { withdrawn: false };
    this.pendingNotes.set(note.id, pending);
    try {
      const content = await noteContent(run.req, note);
      // Taken back, or the reply ended, while its images were read.
      if (pending.withdrawn || this.running.get(messageId) !== run || run.live.isClosed || run.req.signal.aborted) return false;
      run.live.notes.set(note.id, messageId);
      run.live.input.push(userMessage(content, note.id));
      return true;
    } finally {
      this.pendingNotes.delete(note.id);
    }
  }

  /** Takes back a note Claude Code hasn't started. False when no process holds it, it can't cancel one, or it had already started. */
  async withdrawNote(noteId: string): Promise<boolean> {
    const pending = this.pendingNotes.get(noteId);
    if (pending) {
      // Not pushed yet: sendToReply drops it.
      pending.withdrawn = true;
      return true;
    }
    const live = [...this.processes].find((p) => !p.isClosed && p.notes.has(noteId));
    return live ? cancelNote(live, noteId) : false;
  }

  /** Whether note `noteId` is being pushed or an open process still has it (queued, starting or read): false means nothing here will ever report it. */
  knowsNote(noteId: string): boolean {
    return this.pendingNotes.has(noteId) || [...this.processes].some((p) => !p.isClosed && p.knows(noteId));
  }

  /**
   * A chat's settings changed (any chat's, with no id): its running Claude
   * Code is switched to the chat's Auto setting at once, mid-reply too, as VS
   * Code switches modes. A scheduled run's process, and one not on the Claude
   * login, stay in default mode.
   */
  refreshChatSettings(chatId?: string): void {
    for (const live of this.processes) {
      const last = live.last;
      if (!last || live.isClosed || !live.canAuto || last.unattended || (chatId !== undefined && last.chatId !== chatId)) continue;
      const current = this.deps.chatSettings?.(last.chatId, last.profileId);
      if (!current) continue;
      const want = current.autoMode ? 'auto' : 'default';
      // Recorded first: Auto switched off holds at once, whatever becomes of the switch.
      live.wantsAuto = current.autoMode;
      if (live.permissionMode !== want) void live.switchMode(want);
    }
  }

  /** Closes the processes of the chats `gone` picks, ending their background tasks (a chat that was deleted keeps nothing running). */
  closeChats(gone: (chatId: string) => boolean): void {
    for (const live of [...this.processes]) {
      const chatId = live.background?.chatId ?? live.last?.chatId;
      if (chatId === undefined || !gone(chatId)) continue;
      live.close();
      this.processes.delete(live);
    }
  }

  async *stream(req: EngineRequest): AsyncIterable<EngineEvent> {
    if (req.purpose === 'utility') {
      yield* utility(this.deps, req);
      return;
    }
    if (req.workspaceRoot && !existsSync(req.workspaceRoot)) {
      yield { type: 'error', error: { kind: 'unknown', retryable: false, message: `Workspace folder ${req.workspaceRoot} doesn't exist.` } };
      return;
    }
    // No folder: a clean chat, run in the chat's own empty scratch folder.
    const clean = !req.workspaceRoot;
    const cwd = req.workspaceRoot ?? this.scratchFolder(req.chatId);

    // Not yielded yet: an event yielded before the engine has done any real
    // work reaches TurnRunner before the turn's live stream is registered and
    // is dropped from SSE. runTurn yields it right after the init message
    // (or before an error if Claude Code fails before init).
    const skipped = skippedFiles(req.messages[req.messages.length - 1]);
    const notice: PendingNotice = { text: skipped.length > 0 ? `Not sent to Claude Code (only images are): ${skipped.join(', ')}.` : null };

    const conn = req.profile.connection;
    const backend = backendOf(conn, req.claudeAccount);
    const plan = pickSession({ history: req.messages, backend, cwd, latestMessageForSession: req.latestMessageForSession, claims: this.claims });
    try {
      // The new message's images are read once, before either attempt: a retry sends the same ones, and
      // what was left out is said once, in the same notice as the files.
      const images = await newImages(req);
      const leftOut = omittedImagesNotice(images.omitted);
      if (leftOut !== null) notice.text = notice.text === null ? leftOut : `${notice.text} ${leftOut}`;
      const first = yield* this.runTurn(req, plan, backend, notice, cwd, clean, images.blocks);
      // A stopped turn never starts a second Claude Code process.
      if (first === 'missing-session' && !req.signal.aborted) {
        // A /compact has nothing to compact in a new session, nor a handover anything to hand over: runTurn refuses them, without this notice.
        if (compactFocus(req) === null && req.handover !== true) yield { type: 'notice', text: "The earlier Claude Code session couldn't be found, so OtherBench started a new Claude Code session with this chat's history." };
        yield* this.runTurn(req, { mode: 'fresh' }, backend, notice, cwd, clean, images.blocks);
      }
    } finally {
      if (plan.mode === 'continue') this.claims.release(plan.sessionId);
    }
  }

  /**
   * One reply. It continues the session's live Claude Code process when one
   * is waiting with the same options (the planner already checked this
   * message answers the session's tip), else starts a process -- resuming
   * the session or fresh -- that stays alive afterwards for the next message.
   * Returns 'missing-session' (having yielded nothing) when a resume target
   * is gone. Yields `notice.text` once, after the init message or before an
   * error, and clears it.
   */
  private async *runTurn(
    req: EngineRequest,
    plan: SessionPlan,
    backend: string,
    notice: PendingNotice,
    cwd: string,
    clean: boolean,
    images: ContentBlock[]
  ): AsyncGenerator<EngineEvent, 'done' | 'missing-session'> {
    const profile = req.profile;
    // /compact compacts the session this chat continues; a new session has nothing to compact, so no process is started.
    const compacting = compactFocus(req) !== null;
    if (compacting && plan.mode !== 'continue') {
      yield { type: 'error', error: { kind: 'unknown', retryable: false, message: NOTHING_TO_COMPACT } };
      return 'done';
    }
    // A handover summary needs the session that holds the chat: a new one would see only the clipped history.
    if (req.handover === true && plan.mode !== 'continue') {
      yield { type: 'error', error: { kind: 'unknown', retryable: false, message: NOTHING_TO_HAND_OVER } };
      return 'done';
    }
    if (sendsClear(req)) {
      yield { type: 'error', error: { kind: 'unknown', retryable: false, message: CLEAR_ON_ITS_OWN } };
      return 'done';
    }
    const content = userContent(req, plan.mode === 'fresh', images);
    const account = loginAccount(req);
    const { gateCtx, autoMode, own, relay, tickets, helpers, binding, proc } = await prepareReply(this.deps, req, backend, account, clean);
    const compaction: Compaction | null = compacting ? { summary: null } : null;
    if (compaction) binding.compacted = (summary) => (compaction.summary = summary);
    const options = processOptions(this.deps, req, cwd, autoMode, clean);
    const key = liveKey(options, { backend, token: profile.apiKey, configDir: account?.configDir ?? null }, own);
    let taken = plan.mode === 'continue' ? await this.pool.takeWhenFree(plan.sessionId, key, req.signal) : null;
    // Stopped while waiting for the session's busy process (or before it began): no process is started.
    if (taken === null && req.signal.aborted) return 'done';
    // Auto changed since the process's last reply: it's switched, not replaced, so its helpers carry on.
    const mode = options.permissionMode === 'auto' ? 'auto' : 'default';
    if (taken && taken.permissionMode !== mode && !(await taken.switchMode(mode))) {
      taken.close();
      this.processes.delete(taken);
      taken = null;
    }
    const reused = taken !== null;
    const live = taken ?? this.startProcess(options, key, plan, own, relay, backend, account);
    live.wantsAuto = mode === 'auto';
    proc.live = live;
    // A reply stopped before it began starts no turn: a new process is closed, a pooled one goes back.
    if (req.signal.aborted) {
      if (reused) this.pool.release(live);
      else live.close();
      return 'done';
    }
    live.binding = binding;
    live.last = { chatId: req.chatId, messageId: req.messageId, profileId: profile.id, policy: profile.toolPolicy, ctx: gateCtx, autoMode, unattended: req.unattended === true };
    return yield* this.turns.runReplyTurn(req, plan, backend, notice, cwd, live, reused, content, autoMode, helpers, tickets, binding.results, compaction);
  }

  /** A clean chat's own folder, created if need be. A chat id that isn't a plain name is made into one, so it can't point outside. */
  private scratchFolder(chatId: string): string {
    this.privateScratch ??= this.deps.scratchRoot ?? mkdtempSync(join(tmpdir(), 'otherbench-claude-scratch-'));
    const folder = join(this.privateScratch, scratchFolderName(chatId));
    mkdirSync(folder, { recursive: true });
    return folder;
  }

  /** Makes room in the pool, starts a process (process-launch.ts) and tracks it, so `dispose` can stop it. */
  private startProcess(options: Options, key: string, plan: SessionPlan, own: OtherBenchServerSwitches, relay: Relay, backend: string, account: ClaudeAccountRef | undefined): LiveProcess {
    this.pool.makeRoom();
    const process = launchProcess(this.deps, options, key, plan, own, relay, backend, account);
    for (const p of this.processes) if (p.isClosed) this.processes.delete(p);
    this.processes.add(process);
    return process;
  }

  async listModels(conn: Connection, apiKey: string | null): Promise<DiscoveredModel[]> {
    if (conn.baseUrl) return this.deps.listEndpointModels(conn, apiKey);
    const models = await probe(this.deps, conn, (q) => q.supportedModels());
    return models.map((m) => ({ modelId: m.value, displayName: m.displayName, contextWindow: null, supportsVision: true, supportsTools: true }));
  }

  async testConnection(conn: Connection, apiKey: string | null): Promise<ConnectionTestResult> {
    const start = Date.now();
    try {
      if (conn.baseUrl) {
        const models = await this.deps.listEndpointModels(conn, apiKey);
        return { ok: true, message: `Connected; ${models.length} model(s) available.`, latencyMs: Date.now() - start };
      }
      const account = await probe(this.deps, conn, (q) => q.accountInfo());
      const who = account.email ?? 'your Claude account';
      return { ok: true, message: `Logged in as ${who}${account.subscriptionType ? ` (${account.subscriptionType})` : ''}.`, latencyMs: Date.now() - start };
    } catch (err) {
      const error = classifyClaudeCodeFailure(err instanceof Error ? err.message : String(err), { backend: backendOf(conn), modelId: '' });
      return { ok: false, message: error.message, latencyMs: Date.now() - start };
    }
  }

  /**
   * A Claude login's plan usage (Deck #825), read through the SDK's
   * experimental /usage call with the transcript scan skipped: main's, or
   * `account`'s in its own config folder. Null for an endpoint backend (no
   * plan) or an SDK without the call.
   */
  async planUsage(conn: Connection, account?: ClaudeAccountRef): Promise<PlanUsage | null> {
    if (conn.baseUrl) return null;
    const answer = await probe(
      this.deps,
      conn,
      async (q) => (typeof q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET === 'function' ? q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true }) : null),
      account
    );
    return toPlanUsage(answer, Date.now());
  }
}
