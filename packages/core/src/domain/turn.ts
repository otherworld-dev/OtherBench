import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import type { ChatEngine, EngineEvent, EngineRequest, ToolImageLoader, ToolImageSizer } from '../ports/chat-engine.js';
import type { Store } from '../ports/store.js';
import type { ToolProvider } from '../ports/tool-provider.js';
import type { CanonMessage, MessageStatus, Part, SerializedError, UserNotePart } from '../types/messages.js';
import type { ResolvedProfile } from '../types/config.js';
import type { Usage } from '../types/usage.js';
import type { ClaudeAccountRef } from '../types/claude-accounts.js';
import { recordUsage } from './usage-record.js';
import { classifyProviderError } from '../types/errors.js';
import { isCompareSet } from './tree.js';
import { translateForNode } from './path-translate.js';
import { PLAN_MODE_NOTE, PLAN_TOOL, createPlanGate } from './thread-tools.js';
import { isHandoverRequest } from './handover.js';
import { mergeFolders, resolveFolders, resolveWorkspace } from './workspace.js';
import { appendDelta, applySubagentEvent } from './parts.js';
import type { SubagentEvent } from './parts.js';
import { SubagentRunner } from './subagent.js';
import { attachmentBound, bindHistoryAttachments, MAX_HISTORY_ATTACHMENT_BYTES } from './attachment-binding.js';
import { bindToolImages, keepToolImages, MAX_TOOL_IMAGE_BYTES, toolImageBound, type SaveToolImage } from './tool-images.js';
import { attachmentIdsIn, degradedAttachmentsNotice, degradeImagesForVision, filesForModel, unreadFilesNotice } from './turn-attachments.js';
import { ClaudeAccountUnavailableError, InvalidAttachmentReferenceError, RegenerateError, WorkspaceUnresolvedError } from './turn-errors.js';
import { TurnPromptBuilder } from './turn-prompt.js';
import type { TurnEvent, TurnInput, TurnResult, TurnRunnerOptions } from './turn-types.js';

// `appendDelta` lives in parts.ts now (the web folds with it too); kept exported here for peer/forward.ts.
export { appendDelta } from './parts.js';
// The turn's types, errors and attached-file text live beside it; exported here too, where callers import them from.
export type { TurnEvent, TurnInput, TurnResult, TurnRunnerOptions } from './turn-types.js';
export { ClaudeAccountUnavailableError, InvalidAttachmentReferenceError, RegenerateError, type RegenerateErrorCode, workspaceUnresolvedMessage } from './turn-errors.js';
export { fencedFileText } from './turn-attachments.js';


const DEFAULT_CHECKPOINT_INTERVAL_MS = 500;

/**
 * Written for a variant cancelled before the engine ever reported usage --
 * see the comment at this file's only use site (the end of `runVariant`) for
 * why zero, rather than an estimate, is the honest answer here.
 */
const ZERO_USAGE: Usage = { tokensIn: 0, tokensOut: 0, tokensCached: 0, tokensReasoning: 0 };

/**
 * Runs the lifecycle of one user turn: persists the user message, fans it
 * out to one assistant message per profile (a "compare turn" when there is
 * more than one), and streams each variant from the `ChatEngine`
 * independently -- one variant erroring, being cancelled, or running slow
 * never affects its siblings, because each is its own `AbortController` and
 * its own unawaited async task. `run()` itself only awaits the synchronous
 * bookkeeping (creating the rows); the actual streaming continues in the
 * background and is observed via `on()`.
 */
export class TurnRunner {
  private readonly now: () => number;
  private readonly generateId: () => string;
  private readonly checkpointIntervalMs: number;
  private readonly toolProvider?: ToolProvider;
  private readonly resolveProfile?: (id: string) => Promise<ResolvedProfile>;
  private readonly loadAttachment?: (id: string) => Promise<Buffer>;
  private readonly pathExists: (path: string) => boolean;
  private readonly canonicalPath: (path: string) => string;
  private readonly saveToolImage?: SaveToolImage;
  private readonly claudeAccountFor?: (chatId: string, profile: ResolvedProfile) => ClaudeAccountRef | undefined;
  private readonly listeners = new Set<(e: TurnEvent) => void>();
  private readonly controllers = new Map<string, AbortController>();
  /** messageId -> the notice `cancel` was given, for the reply to end with (a scheduled run's time limit). */
  private readonly stopNotices = new Map<string, string>();
  /** Running variants' chat and unattended flag, kept and cleared with `controllers`. */
  private readonly running = new Map<string, { chatId: string; unattended: boolean }>();
  /** The same running variants by chat, in start order, so `runningIn` doesn't scan every chat's. */
  private readonly runningByChat = new Map<string, Set<string>>();
  private readonly takeNote?: (messageId: string, noteId: string) => UserNotePart | null;
  private readonly heldAttachment?: (attachmentId: string, chatId: string) => boolean;
  /** The system prompt's blocks and the user message's notes, with the memory blocks and notes it holds steady. */
  private readonly prompts: TurnPromptBuilder;

  constructor(
    private readonly store: Store,
    private readonly engine: ChatEngine,
    options: TurnRunnerOptions = {}
  ) {
    this.now = options.now ?? Date.now;
    this.generateId = options.generateId ?? randomUUID;
    this.checkpointIntervalMs = options.checkpointIntervalMs ?? DEFAULT_CHECKPOINT_INTERVAL_MS;
    this.toolProvider = options.toolProvider;
    this.takeNote = options.takeNote;
    this.heldAttachment = options.heldAttachment;
    this.resolveProfile = options.resolveProfile;
    this.loadAttachment = options.loadAttachment;
    this.pathExists = options.pathExists ?? existsSync;
    this.canonicalPath = options.canonicalPath ?? ((p) => p);
    this.saveToolImage = options.saveToolImage;
    this.claudeAccountFor = options.claudeAccountFor;
    this.prompts = new TurnPromptBuilder(store, this.now, this.canonicalPath);
    this.toolProvider?.onApprovalEvent((event) => {
      switch (event.type) {
        case 'request':
          this.emit({ messageId: event.request.messageId, type: 'approval-request', request: event.request });
          break;
        case 'resolved':
          this.emit({ messageId: event.messageId, type: 'approval-resolved', requestId: event.requestId, choice: event.choice });
          break;
        case 'ask':
          this.emit({ messageId: event.ask.messageId, type: 'ask-request', ask: event.ask });
          break;
        case 'ask-resolved':
          this.emit({ messageId: event.messageId, type: 'ask-resolved', askId: event.askId });
          break;
        case 'progress':
          this.emit({ messageId: event.messageId, type: 'tool-progress', callId: event.callId, progress: event.progress });
          break;
      }
    });
  }

  /** Subscribes to every `TurnEvent` this runner emits, across every turn/chat it drives. Returns an unsubscribe function. */
  on(cb: (e: TurnEvent) => void): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  /**
   * Each listener is invoked in its own try/catch: `emit()` is called from
   * inside `runVariant`'s own try block (see `run()`'s call site below), so
   * an uncaught throw from any one subscriber -- plausibly `controller.enqueue()`
   * in the SSE transport when a client disconnect races its unsubscribe --
   * would otherwise propagate out of `emit()`, be caught by `runVariant`'s
   * `catch`, and mis-persist that variant as a provider error via
   * `classifyProviderError`. A broadcast fault must never corrupt the
   * variant's own state, nor stop the remaining listeners from seeing the
   * event.
   */
  private emit(event: TurnEvent): void {
    for (const cb of this.listeners) {
      try {
        cb(event);
      } catch (err) {
        console.error(`[TurnRunner] listener threw while handling '${event.type}' for message ${event.messageId}:`, err);
      }
    }
  }

  async run(input: TurnInput): Promise<TurnResult> {
    // Validated BEFORE the user message is created, so a bad reference
    // rejects the whole turn rather than leaving a half-created row behind
    // -- see InvalidAttachmentReferenceError's doc.
    const referencedAttachments = attachmentIdsIn(input.userParts).map((id) => {
      const attachment = this.store.attachments.get(id);
      if (!attachment || attachment.chatId !== input.chatId) {
        throw new InvalidAttachmentReferenceError(id, input.chatId);
      }
      return attachment;
    });

    const userMessage = this.store.messages.create({
      id: this.generateId(),
      chatId: input.chatId,
      parentId: input.parentId,
      role: 'user',
      parts: input.userParts,
      status: 'complete',
      error: null,
      producedBy: null,
    });

    // Binds each referenced attachment to the message that just carried it
    // -- the "sent" mark DELETE /api/attachments/:id checks (routes/
    // attachments.ts decision #1). An attachment already bound to an
    // EARLIER message (e.g. editing an earlier user message creates a
    // sibling that reuses the same upload) keeps that first binding rather
    // than being rebound here -- it only needs to stay non-null, not point
    // at the most recent message.
    for (const attachment of referencedAttachments) {
      if (attachment.messageId === null) {
        this.store.attachments.update(attachment.id, { messageId: userMessage.id });
      }
    }

    const variants: { message: CanonMessage; profile: ResolvedProfile }[] = [];
    for (const profile of input.profiles) {
      const assistantMessage = this.store.messages.create({
        id: this.generateId(),
        chatId: input.chatId,
        parentId: userMessage.id,
        role: 'assistant',
        parts: [],
        status: 'streaming',
        error: null,
        producedBy: {
          profileId: profile.id,
          profileName: profile.name,
          connectionId: profile.connectionId,
          modelId: profile.modelId,
        },
      });
      variants.push({ message: assistantMessage, profile });
    }

    // Fire-and-forget: `run()` returns as soon as the rows exist. Each
    // variant is its own independent async task from here on, so a
    // rejection or slow stream in one cannot block or fail the others --
    // `runVariant` itself never throws (it catches internally), but the
    // `.catch` here is a last-resort backstop against a bug in that catch
    // logic turning into an unhandled rejection.
    for (const { message, profile } of variants) {
      void this.runVariant(input.chatId, userMessage.id, message.id, profile, input.unattended === true, { unattendedAuto: input.unattendedAuto === true }).catch((err: unknown) => {
        console.error(`[TurnRunner] variant ${message.id} failed outside its own error handling:`, err);
      });
    }

    return {
      userMessageId: userMessage.id,
      assistantMessageIds: variants.map((v) => v.message.id),
    };
  }

  /**
   * Aborts one variant's stream. A no-op if `messageId` isn't currently
   * running (already finished, or unknown). `notice`, when given, says why in
   * the reply: a notice part added as it ends stopped (the schedule service's
   * time limit). Only the first stop's notice counts; a reply already
   * stopping keeps none.
   */
  cancel(messageId: string, notice?: string): void {
    const controller = this.controllers.get(messageId);
    if (!controller) return;
    if (notice !== undefined && !controller.signal.aborted) this.stopNotices.set(messageId, notice);
    controller.abort();
  }

  /** The chat and unattended flag of a reply running now, or null when it isn't running here. */
  runningInfo(messageId: string): { chatId: string; unattended: boolean } | null {
    return this.running.get(messageId) ?? null;
  }

  /** The ids of the replies running here now in `chatId`, whether or not the chat still has a row. */
  runningIn(chatId: string): string[] {
    return [...(this.runningByChat.get(chatId) ?? [])];
  }

  /**
   * Re-runs one existing assistant message IN PLACE (same id, same
   * `parentId`) -- task 27's per-tab Retry on a failed compare variant.
   * Unlike `run()`, this never creates a new user message: the whole point
   * is that a retried variant stays the same sibling in its compare set,
   * not a duplicate turn hanging off a fresh (identical-text) user message.
   *
   * Resets the row's `parts`/`status`/`error` and emits a `status:
   * 'streaming'` event *synchronously*, before this function's first
   * `await` -- a caller (the turns route) that needs to reset a
   * `StreamRegistry` buffer for this message id can do so and then call
   * this, confident the reset lands before any new event does (same
   * ordering guarantee `registerTurn` relies on in `run()`, see
   * routes/turns.ts).
   *
   * Rejects if `messageId` is unknown, has no `parentId` to rebuild history
   * from (a retried message is always a reply, never a root), or is not
   * currently `'error'`. `'error'` is the only retryable status:
   *
   *   - `'streaming'` is already in flight -- retrying it makes no sense
   *     (cancel it first).
   *   - `'complete'` already holds a real answer with a real usage row; the
   *     defect this guard closes is exactly a retry silently discarding that
   *     content and writing a *second* usage row for the same logical
   *     variant, double-counting spend.
   *   - `'cancelled'` is deliberately excluded too, even though a user
   *     re-running a stream they themselves cancelled is a reasonable thing
   *     to want: a cancellation always writes a zeroed usage row (see
   *     `ZERO_USAGE` below) so the cancellation itself is never invisible to
   *     `usage.list()`. That row is keyed by this same `messageId`, and the
   *     usage rollup (`usage-rollup.ts`) attributes a usage row's bucket
   *     (measured vs. cancelled) from the *current* status of the message it
   *     points to, not from anything stored on the row itself. If retry
   *     reused this id and the message went on to complete, that old zeroed
   *     row would silently flip from "cancelled" into "measured" and inflate
   *     `completeCount` for a call that never happened -- not a cost error
   *     (the row is zero), but a phantom call. `'error'` doesn't have this
   *     problem: the ordinary error path (no `finish` ever raced the error)
   *     writes no usage row at all, so there is nothing stale left to
   *     misattribute. Re-running a cancelled turn is still possible -- it
   *     just goes through `run()` as a new turn, same as any other resend.
   */
  async retry(chatId: string, messageId: string, profile: ResolvedProfile): Promise<void> {
    const message = this.store.messages.get(messageId);
    if (!message) throw new Error(`retry: unknown message "${messageId}"`);
    if (!message.parentId) throw new Error(`retry: message "${messageId}" has no parent to rebuild history from`);
    if (message.status !== 'error') {
      throw new Error(`retry: message "${messageId}" is ${message.status}, not error -- only an errored message can be retried`);
    }

    // The images the failed run stored for this reply are tied to nothing once
    // its parts are cleared: they go with them, so a retry starts the reply's
    // image budget from zero without the old ones piling up behind it. (Blobs
    // nothing references any more are collected by the server's sweep.)
    for (const stranded of this.store.attachments.list(chatId)) {
      if (stranded.messageId === messageId) this.store.attachments.delete(stranded.id);
    }
    this.store.messages.updateParts(messageId, []);
    this.store.messages.updateStatus(messageId, 'streaming'); // omitting `error` clears it -- see MessageRepo.updateStatus's doc.
    this.emit({ messageId, type: 'status', status: 'streaming' });

    await this.runVariant(chatId, message.parentId, messageId, profile);
  }

  /**
   * Adds one more assistant reply under the user message that `messageId`
   * answers, using `profile` -- the third use of the sibling mechanism next
   * to compare turns and edits. Never creates a user message: the new reply
   * is a sibling of `messageId`, which stays in the tree untouched. Any
   * reply that isn't mid-stream can be the seed (complete, errored or
   * cancelled); the profile defaults are the caller's business.
   *
   * Everything after the row is created is `runVariant`, so streaming,
   * checkpoints, usage, approvals and per-variant isolation are shared with
   * `run()`. Like `run()` it returns once the row exists and streams in the
   * background; it does not move `head_message_id`.
   */
  async regenerate(input: {
    chatId: string;
    messageId: string;
    profile: ResolvedProfile;
  }): Promise<{ userMessageId: string; assistantMessageId: string }> {
    const target = this.store.messages.get(input.messageId);
    if (!target) throw new RegenerateError('not_found', `Message "${input.messageId}" not found.`);
    if (target.chatId !== input.chatId) {
      throw new RegenerateError('wrong_chat', `Message "${input.messageId}" does not belong to chat "${input.chatId}".`);
    }
    if (target.role !== 'assistant') {
      throw new RegenerateError('not_assistant', `Message "${input.messageId}" is not an assistant reply.`);
    }
    if (target.status === 'streaming') {
      throw new RegenerateError('streaming', `Message "${input.messageId}" is still streaming; stop it first.`);
    }
    const parent = target.parentId ? this.store.messages.get(target.parentId) : null;
    if (!parent || parent.role !== 'user') {
      throw new RegenerateError('no_parent', `Message "${input.messageId}" has no user message to regenerate from.`);
    }

    // A compare turn's variant is picked by the user ("Keep"), never replaced
    // by regenerating: that would add a reply to the tabs and move the head.
    if (isCompareSet(this.store.messages.children(parent.id))) {
      throw new RegenerateError('compare', `Message "${input.messageId}" is a variant of a compare turn; keep one instead of regenerating.`);
    }

    const profile = input.profile;
    const assistantMessage = this.store.messages.create({
      id: this.generateId(),
      chatId: input.chatId,
      parentId: parent.id,
      role: 'assistant',
      parts: [],
      status: 'streaming',
      error: null,
      producedBy: {
        profileId: profile.id,
        profileName: profile.name,
        connectionId: profile.connectionId,
        modelId: profile.modelId,
        regenerated: true,
      },
    });

    void this.runVariant(input.chatId, parent.id, assistantMessage.id, profile).catch((err: unknown) => {
      console.error(`[TurnRunner] variant ${assistantMessage.id} failed outside its own error handling:`, err);
    });

    return { userMessageId: parent.id, assistantMessageId: assistantMessage.id };
  }

  /**
   * A reply nobody sent a message for: the engine's agent carried on by
   * itself (Claude Code after a background helper reported back, spec
   * 2026-10-17-claude-background-helpers-design). It follows `parentId` (the
   * reply it continues), starts with `notice`, and runs like any reply, but
   * from `stream` (the engine's own turn) rather than a new engine call. It
   * gets a fresh, closed plan gate when the chat is in plan mode, so it can't
   * change anything before a plan is approved.
   */
  async runSelfStarted(input: {
    chatId: string;
    parentId: string;
    profile: ResolvedProfile;
    notice: string;
    unattended: boolean;
    /** Carried over with `unattended`: the schedule that started the run allows auto mode. */
    unattendedAuto?: boolean;
    stream: (req: EngineRequest) => AsyncIterable<EngineEvent>;
    /** Called once the reply has ended, however it ended (also when it ended before `stream` was called). */
    onEnd?: () => void;
  }): Promise<{ assistantMessageId: string }> {
    const { profile } = input;
    const message = this.store.messages.create({
      id: this.generateId(),
      chatId: input.chatId,
      parentId: input.parentId,
      role: 'assistant',
      parts: [],
      status: 'streaming',
      error: null,
      producedBy: { profileId: profile.id, profileName: profile.name, connectionId: profile.connectionId, modelId: profile.modelId },
    });
    void this.runVariant(input.chatId, input.parentId, message.id, profile, input.unattended, { stream: input.stream, notice: input.notice, unattendedAuto: input.unattendedAuto === true })
      .catch((err: unknown) => {
        console.error(`[TurnRunner] self-started reply ${message.id} failed outside its own error handling:`, err);
      })
      .finally(() => input.onEnd?.());
    return { assistantMessageId: message.id };
  }

  /**
   * A user turn the engine runs itself: the notes the user sent mid-reply,
   * which Claude Code carries on with after the reply ended. Makes the user
   * message (`userParts`) under `parentId` and a reply under it, then runs the
   * reply from `stream` like `runSelfStarted`; attended, with no notice.
   */
  async runFollowOn(input: {
    chatId: string;
    parentId: string;
    userParts: Part[];
    profile: ResolvedProfile;
    stream: (req: EngineRequest) => AsyncIterable<EngineEvent>;
    /** Called once the reply has ended, however it ended. */
    onEnd?: () => void;
  }): Promise<{ userMessageId: string; assistantMessageId: string }> {
    const { profile } = input;
    const userMessage = this.store.messages.create({
      id: this.generateId(),
      chatId: input.chatId,
      parentId: input.parentId,
      role: 'user',
      parts: input.userParts,
      status: 'complete',
      error: null,
      producedBy: null,
    });
    // Its attachments are bound to it as run() binds a turn's (the notes' attachments were held unsent until now).
    for (const id of attachmentIdsIn(input.userParts)) {
      const attachment = this.store.attachments.get(id);
      if (attachment?.chatId === input.chatId && attachment.messageId === null) this.store.attachments.update(id, { messageId: userMessage.id });
    }
    const message = this.store.messages.create({
      id: this.generateId(),
      chatId: input.chatId,
      parentId: userMessage.id,
      role: 'assistant',
      parts: [],
      status: 'streaming',
      error: null,
      producedBy: { profileId: profile.id, profileName: profile.name, connectionId: profile.connectionId, modelId: profile.modelId },
    });
    void this.runVariant(input.chatId, userMessage.id, message.id, profile, false, { stream: input.stream })
      .catch((err: unknown) => {
        console.error(`[TurnRunner] follow-on reply ${message.id} failed outside its own error handling:`, err);
      })
      .finally(() => input.onEnd?.());
    return { userMessageId: userMessage.id, assistantMessageId: message.id };
  }

  private async runVariant(
    chatId: string,
    userMessageId: string,
    messageId: string,
    profile: ResolvedProfile,
    unattended = false,
    variant: { stream?: (req: EngineRequest) => AsyncIterable<EngineEvent>; notice?: string; unattendedAuto?: boolean } = {}
  ): Promise<void> {
    const controller = new AbortController();
    this.controllers.set(messageId, controller);
    this.running.set(messageId, { chatId, unattended });
    const inChat = this.runningByChat.get(chatId) ?? new Set<string>();
    this.runningByChat.set(chatId, inChat.add(messageId));
    const startedAt = this.now();

    let parts: Part[] = [];
    const imageBudget = { kept: 0 };
    let lastCheckpointAt = this.now();
    let status: MessageStatus = 'complete';
    let error: SerializedError | null = null;
    let usage: Usage | null = null;
    // Whether the signal was aborted by someone else (cancel()) BEFORE the
    // teardown abort below -- that one must not turn a clean finish into a
    // cancellation.
    let cancelled = false;
    // Why it was stopped, when whoever stopped it said (`cancel`'s notice).
    let stopNotice: string | null = null;
    // This reply's sub-agent runner, when it offers the subagent tool.
    let subagents: SubagentRunner | null = null;

    const checkpoint = (force: boolean): void => {
      const nowTs = this.now();
      if (force || nowTs - lastCheckpointAt >= this.checkpointIntervalMs) {
        this.store.messages.updateParts(messageId, parts);
        lastCheckpointAt = nowTs;
      }
    };

    try {
      // Read fresh per variant: a workspace, Auto or project-memory change
      // made between turns applies from the very next turn (and to a retry),
      // never mid-turn.
      const chat = this.store.chats.get(chatId);
      // Resolved on this machine at turn time, never read raw: a folder from
      // another machine, or a location with no path here, must not reach the
      // tools as if it were local (v2 spec §6).
      const selfNodeId = this.store.nodes.self().id;
      const locationPaths = this.store.locations.allPaths();
      const workspace = resolveWorkspace(chat?.workspace ?? null, selfNodeId, locationPaths, this.pathExists);
      if (workspace.status === 'unresolved') {
        // Yield first so the turns route has registered this reply's stream
        // and the failure reaches live subscribers (see the notice comment below).
        await new Promise((resolve) => setTimeout(resolve, 0));
        throw new WorkspaceUnresolvedError(workspace);
      }
      const workspaceRoot = workspace.status === 'ok' ? workspace.root : null;
      // Which Claude login this turn runs on, resolved fresh per variant (a
      // chat moved off a limited main stays moved). Endpoint backends have none.
      // A self-started or follow-on reply streams from a process already running,
      // on that process's own account: it is never asked, so it can't pin the chat.
      let claudeAccount: ClaudeAccountRef | undefined;
      if (profile.connection.kind === 'claude_code' && !profile.connection.baseUrl && !variant.stream && this.claudeAccountFor) {
        try {
          claudeAccount = this.claudeAccountFor(chatId, profile);
        } catch (err) {
          // Yield first, as for an unresolved folder, so the failure reaches live subscribers.
          if (err instanceof ClaudeAccountUnavailableError) await new Promise((resolve) => setTimeout(resolve, 0));
          throw err;
        }
      }
      // Extra folders: a parent project's, the project's and the chat's, each
      // resolved here; one not on this machine is left out, and none apply
      // without a workspace (spec 2026-10-07-extra-folders).
      const projectFolders = this.prompts.projectChain(chat).map((p) => p.folders);
      const folders = workspaceRoot === null ? [] : resolveFolders(mergeFolders(...projectFolders, chat?.folders), selfNodeId, locationPaths, this.pathExists, workspaceRoot);
      const autoMode = chat?.autoMode ?? false;
      const effort = chat?.effort ?? null;
      // A handover summary (spec 2026-11-06-fresh-chat-handover-design) uses no tools, so it never plans.
      const userMessage = this.store.messages.get(userMessageId);
      const handover = userMessage !== null && isHandoverRequest(userMessage);
      // A self-started reply is held to the chat's plan mode like any other (a fresh, closed gate):
      // nothing changes before a plan is approved, however the turn began.
      const planMode = chat?.planMode === true && !handover;
      // Listed fresh per variant (not cached on the runner) so each variant's
      // request reflects THIS profile's own toolPolicy, and so a grant
      // revoked or an MCP server re-enabled between turns is picked up on
      // the very next call rather than requiring a restart -- ToolProvider
      // implementations are expected to keep their own MCP-connection state
      // long-lived internally; this call is just "what does this policy
      // currently allow", not "go reconnect everything".
      const listed = this.toolProvider ? await this.toolProvider.listTools(profile.toolPolicy) : [];
      // Artifacts, recall, the thread tools and sub-agents are offered by
      // the profile's switches (or on by default), so a model that can't use
      // tools (as its model row says) isn't sent a tool it would refuse the
      // whole request over.
      const usable =
        profile.model?.supportsTools === false
          ? listed.filter((t) => t.source !== 'artifact' && t.source !== 'recall' && t.source !== 'thread' && t.source !== 'subagent' && t.source !== 'chats')
          : listed;
      // Claude Code runs its own sub-agents (Task/Agent); OtherBench's tool is for API profiles only.
      const offered = profile.connection.kind === 'claude_code' ? usable.filter((t) => t.source !== 'subagent') : usable;
      // propose_plan only while the chat's Plan mode is on (spec 2026-10-12-thread-cards-design §4).
      const tools = planMode ? offered : offered.filter((t) => !(t.source === 'thread' && t.name === PLAN_TOOL));
      // One gate per reply: compare variants, retries and the next message each start closed.
      const plan = planMode && tools.some((t) => t.source === 'thread' && t.name === PLAN_TOOL) ? createPlanGate() : undefined;
      const canRecall = tools.some((t) => t.source === 'recall');
      const prompts = this.prompts;
      const requestProfile = prompts.withRecall(
        prompts.withArtifacts(prompts.withTools(prompts.withSandbox(prompts.withFolders(prompts.withAppNotes(prompts.withProjectMemory(prompts.withProjectInstructions(prompts.withGlobalMemory(profile, chat, canRecall), chat), chat), chat), folders), workspaceRoot, folders), tools), tools),
        canRecall
      );
      // Other machines' folder paths in tool calls and results, as they are
      // on this machine (spec §6); the stored messages are untouched.
      const translated = prompts.withNotes(
        translateForNode(prompts.buildRequestMessages(userMessageId, requestProfile), selfNodeId, locationPaths),
        [...prompts.artifactsListNotes(tools, chatId, userMessageId), ...(plan !== undefined ? [PLAN_MODE_NOTE] : [])],
        userMessageId,
        profile
      );
      // The attachments the history names are checked LAST, after every rewrite
      // above (so nothing can change a reference once it has passed): an
      // image or file of the user's must be in this chat, and an image a tool
      // result refers to must be stored for this chat and the message that holds
      // it. Anything else is a note, and the turn goes on.
      const history = bindToolImages(
        bindHistoryAttachments(translated, (id) => this.attachmentInChat(id, chatId)),
        chatId,
        (id) => this.store.attachments.get(id)
      );
      // The only way an engine gets a stored tool image's bytes back: for this
      // chat, a message on this thread, and the row stored for exactly that
      // pair. Anything else (an id from tool output, another chat's history)
      // gets nothing, and no blob is read.
      const threadIds = new Set(history.map((m) => m.id));
      const loadStored = this.loadAttachment;
      const toolImageRow = (ref: { chatId: string; messageId: string; attachmentId: string }): { size: number } | null => {
        if (ref.chatId !== chatId || !threadIds.has(ref.messageId)) return null;
        const row = this.store.attachments.get(ref.attachmentId);
        return row && toolImageBound(row, chatId, ref.messageId) ? { size: row.size } : null;
      };
      const loadToolImage: ToolImageLoader | undefined = loadStored
        ? async (ref) => {
            if (toolImageRow(ref) === null) return null;
            const bytes = await loadStored(ref.attachmentId);
            return bytes.length > MAX_TOOL_IMAGE_BYTES ? null : bytes;
          }
        : undefined;
      const toolImageSize: ToolImageSizer | undefined = loadStored ? (ref) => toolImageRow(ref)?.size ?? null : undefined;
      const attachmentSize = loadStored ? (id: string): number | null => (this.attachmentLoadable(id, chatId) ? (this.store.attachments.get(id)?.size ?? null) : null) : undefined;

      // Capability fallback (task 21): degrade every `image` part in THIS
      // variant's own copy of history when its profile's model doesn't
      // declare vision support -- never mutates the messages another
      // variant's request (or the persisted conversation) sees, since
      // `buildRequestMessages` already returns a fresh array/clone per call.
      // Conservative default matches AiSdkChatEngine's own
      // (`model?.supportsVision ?? false`): an unknown model is assumed NOT
      // to accept images, since sending bytes it silently drops would be
      // worse than a placeholder it can at least read as text.
      const vision = profile.model?.supportsVision ?? false;
      const { messages: visionMessages, degraded } = degradeImagesForVision(this.store, history, vision);
      // Attached files (spec 2026-10-12-office-files §2): text for every
      // engine, except a PDF for one that takes PDFs.
      const { messages: requestMessages, unread } = filesForModel(this.store, visionMessages,profile.connection.kind !== 'claude_code');
      // The LIVE emit of this notice is deliberately deferred to inside the
      // loop below (its first iteration), NOT fired here -- see the comment
      // at that call site for why emitting it this early loses a real race
      // against `routes/turns.ts`'s `registerTurn()`. The persisted copy
      // (`parts`/`checkpoint`) has no such race -- a direct store write, not
      // a broadcast -- so that part happens right away regardless.
      let pendingNoticeText: string | null = null;
      const notices = [
        ...(variant.notice ? [variant.notice] : []),
        ...(degraded.length > 0 ? [degradedAttachmentsNotice(degraded, profile.modelId)] : []),
        ...(unread.length > 0 ? [unreadFilesNotice(unread, profile.modelId)] : []),
      ];
      if (notices.length > 0) {
        // One notice holds both sentences when both apply.
        pendingNoticeText = notices.join(' ');
        parts = [{ type: 'notice', text: pendingNoticeText }];
        // Forced (not throttled): the disclosure must be visible even if the
        // stream that follows errors out before its first checkpoint-worthy
        // event -- see this method's `checkpoint` doc.
        checkpoint(true);
      }

      if (this.toolProvider && tools.some((t) => t.source === 'subagent')) {
        subagents = new SubagentRunner({
          store: this.store,
          engine: this.engine,
          toolProvider: this.toolProvider,
          ...(this.resolveProfile ? { resolveProfile: this.resolveProfile } : {}),
          canonicalPath: this.canonicalPath,
          // The reply's plan gate and unattended flag go with every sub-agent it starts.
          ...(plan ? { plan } : {}),
          ...(unattended ? { unattended: true } : {}),
          // A sub-agent's tool images are kept like this reply's own, against it and under its one budget.
          keepImages: (result, toolName) => keepToolImages(result, this.saveToolImage, chatId, messageId, imageBudget, toolName),
          now: this.now,
          generateId: this.generateId,
          chatId,
          messageId,
          parent: profile,
          workspaceRoot,
          folders,
          signal: controller.signal,
          emit: (callId, event) => this.emit({ messageId, type: 'subagent', callId, event }),
          updateParts: (fn, force) => {
            parts = fn(parts);
            checkpoint(force);
          },
          writeUsage: (subProfile, subUsage, latencyMs, callId) => this.writeUsage(chatId, messageId, subProfile, subUsage, latencyMs, callId),
        });
      }

      const request: EngineRequest = {
        profile: requestProfile,
        messages: requestMessages,
        tools,
        signal: controller.signal,
        chatId,
        messageId,
        workspaceRoot,
        ...(folders.length > 0 ? { folders } : {}),
        ...(claudeAccount ? { claudeAccount } : {}),
        ...(subagents ? { subagents } : {}),
        ...(this.loadAttachment ? { loadAttachment: this.chatScopedLoader(this.loadAttachment, chatId) } : {}),
        ...(loadToolImage ? { loadToolImage } : {}),
        ...(toolImageSize ? { toolImageSize } : {}),
        ...(attachmentSize ? { attachmentSize } : {}),
        purpose: 'turn',
        // Nobody can catch what auto mode's classifier allows in a scheduled
        // run (the classifier isn't a security boundary), so it is used there
        // only when the schedule says so, never because of the chat's Auto.
        autoMode: unattended ? variant.unattendedAuto === true : autoMode,
        ...(unattended ? { unattended: true } : {}),
        ...(effort ? { effort } : {}),
        ...(plan ? { plan } : {}),
        ...(handover ? { handover: true } : {}),
        latestMessageForSession: (sessionId: string) => this.store.messages.latestBySession(chatId, sessionId)?.id ?? null,
      };

      for await (const event of variant.stream ? variant.stream(request) : this.engine.stream(request)) {
        if (pendingNoticeText !== null) {
          // Fired on this variant's FIRST live-emitted event, not
          // immediately after computing it above. `runVariant` reaches the
          // point above after just one microtask hop past
          // `toolProvider.listTools()` (which typically resolves with no
          // internal `await` of its own) -- comfortably BEFORE the turns
          // route's `await turnRunner.run(...)` continuation has had a
          // chance to call `registerTurn()`. `StreamRegistry.handleEvent`
          // silently drops any event for a message id it doesn't have a
          // buffer for yet (by design -- it has no chatId to file an
          // unknown message under, see registry.ts's class doc), so an
          // eager emit here doesn't error, it just silently vanishes from
          // every live subscriber. Every OTHER event type never had this
          // problem pre-task-21 because NOTHING was emitted until the
          // engine itself produced a value -- a real network call, or even
          // `MockChatEngine`'s own per-chunk delay, both genuinely slower
          // than a bare microtask hop -- which is exactly what this `for
          // await`'s first iteration also waits on, restoring the same
          // safety margin. Found via a real-browser Playwright test
          // (packages/web/e2e/attachments.spec.ts); the FakeChatEngine unit
          // tests in this file never exercise StreamRegistry at all, so
          // they could not have caught it.
          this.emit({ messageId, type: 'notice', text: pendingNoticeText });
          pendingNoticeText = null;
        }
        if (event.type === 'engine-meta') {
          // Engine-owned state, persisted straight away (a cancelled turn
          // still records its session) and never broadcast: clients read it
          // from the message row.
          this.store.messages.updateEngineMeta(messageId, event.meta);
          continue;
        }
        if (event.type === 'note-picked') {
          // Claude read a note the user sent mid-reply: it becomes a part here, in order, and the client gets the part, not the pick.
          const part = this.takeNote?.(messageId, event.noteId) ?? null;
          if (part) {
            parts = [...parts, part];
            checkpoint(true);
            this.emit({ messageId, type: 'user-note', part });
          }
          continue;
        }
        // Images in a tool result go to the blob store before anyone sees
        // the result (spec 2026-10-12-computer-use-design section 6): base64
        // never reaches an SSE client or a message row.
        const out: EngineEvent =
          event.type === 'tool-result'
            ? { ...event, result: await keepToolImages(event.result, this.saveToolImage, chatId, messageId, imageBudget, event.name) }
            : event;
        this.emit({ messageId, ...out });

        switch (out.type) {
          case 'notice':
            parts = [...parts, { type: 'notice', text: out.text }];
            checkpoint(true);
            break;
          case 'context-summary':
            parts = [
              ...parts,
              {
                type: 'context-summary',
                text: out.text,
                ...(out.preTokens !== undefined ? { preTokens: out.preTokens } : {}),
                ...(out.postTokens !== undefined ? { postTokens: out.postTokens } : {}),
              },
            ];
            checkpoint(true);
            // The chat is that size now (or unknown): the fresh chat card mustn't go on showing the size before the compact.
            if (this.store.chats.get(chatId)) this.store.chats.update(chatId, { contextTokens: out.postTokens ?? null });
            break;
          case 'text-delta':
            parts = appendDelta(parts, 'text', out.text);
            checkpoint(false);
            break;
          case 'reasoning-delta':
            parts = appendDelta(parts, 'reasoning', out.text);
            checkpoint(false);
            break;
          case 'tool-call':
            parts = [...parts, { type: 'tool-call', id: out.id, name: out.name, args: out.args }];
            checkpoint(true);
            break;
          case 'tool-result':
            parts = [
              ...parts,
              { type: 'tool-result', id: out.id, name: out.name, result: out.result, isError: out.isError },
            ];
            checkpoint(true);
            break;
          case 'subagent':
            parts = applySubagentEvent(parts, out.callId, out.event);
            // A start, a tool call or result and the end are kept straight away; text can wait for the next checkpoint.
            checkpoint(out.event.type !== 'text-delta' && out.event.type !== 'reasoning-delta');
            break;
          case 'finish':
            usage = out.usage;
            break;
          case 'error':
            status = out.error.kind === 'cancelled' ? 'cancelled' : 'error';
            error = out.error;
            break;
          default:
            break;
        }
      }
    } catch (err) {
      status = 'error';
      error =
        err instanceof WorkspaceUnresolvedError
          ? { kind: 'workspace_unresolved', message: err.message, retryable: false, detail: err.status }
          : err instanceof ClaudeAccountUnavailableError
            ? { kind: 'auth', message: err.message, retryable: false }
            : classifyProviderError(err);
    } finally {
      this.controllers.delete(messageId);
      stopNotice = this.stopNotices.get(messageId) ?? null;
      this.stopNotices.delete(messageId);
      this.running.delete(messageId);
      const inChat = this.runningByChat.get(chatId);
      inChat?.delete(messageId);
      if (inChat?.size === 0) this.runningByChat.delete(chatId);
      cancelled = controller.signal.aborted;
      // Whatever ended this variant (finish, error, throw, cancel), nothing
      // may still be waiting on it. Aborting releases anything tied to its
      // signal -- above all a tool call parked on an approval card, which the
      // tool provider settles as a denial and drops from the broker. Only this
      // variant's own controller: siblings have their own.
      controller.abort();
    }

    // Every sub-agent was told to stop by the abort above (or finished
    // before the stream did). Wait for each to send its `end` and write its
    // usage, so the stored parts never keep a running sub-agent and every
    // `end` goes out before this reply's terminal status.
    if (subagents) await subagents.settled();

    // A helper the engine started and never said had finished (the reply was
    // stopped, or the engine went away) can't finish now: it ends here as
    // stopped, so the stored card never shows it working.
    for (const part of parts) {
      if (part.type !== 'subagent' || (part.status !== 'queued' && part.status !== 'running')) continue;
      const end: SubagentEvent = { type: 'end', status: 'cancelled', at: this.now() };
      parts = applySubagentEvent(parts, part.callId, end);
      this.emit({ messageId, type: 'subagent', callId: part.callId, event: end });
    }

    // The engine can end a stream cleanly on abort (no `error` event at
    // all -- MockChatEngine and this package's own `FakeChatEngine` both
    // do this, mirroring `streamText`'s observed behaviour, see
    // task-14-15-report.md). If nothing else already classified the
    // outcome, an aborted signal means this was a cancellation.
    if (cancelled && status === 'complete' && error === null) {
      status = 'cancelled';
    }

    // Stopped with a reason: the reply says so, as a notice part like any other,
    // kept with the parts below and sent live before the terminal status.
    if (stopNotice !== null && status !== 'complete') {
      parts = [...parts, { type: 'notice', text: stopNotice }];
      this.emit({ messageId, type: 'notice', text: stopNotice });
    }

    // The end is announced even when these writes fail -- above all when the
    // chat was deleted mid-reply and its messages cascaded away. Listeners
    // (the stream registry, the schedule service) wait on this event to let
    // the reply go; without it they would wait until a restart.
    try {
      checkpoint(true);
      this.store.messages.updateStatus(messageId, status, error);
    } catch (err) {
      console.error(`[TurnRunner] variant ${messageId} could not record its end:`, err);
    }
    this.emit({ messageId, type: 'status', status });

    // Usage is recorded whenever the engine reported it, regardless of the
    // final status: a cancellation that happens to race a `finish` event
    // (or, in the ordinary case, a `complete` run) both keep whatever
    // usage the engine actually reported.
    //
    // A cancellation that DIDN'T race a `finish` -- the common case, since
    // an abort ends the stream cleanly with no terminal event at all (see
    // the comment above) -- has no usage to keep: the `ChatEngine` port has
    // no incremental-usage event, only a terminal `finish { usage }`, so
    // there is genuinely no partial token count available here. Rather than
    // silently writing nothing (which made every cancellation invisible to
    // `usage.list()`/billing views), a zeroed usage row is written instead
    // so the cancellation is still recorded. The zeros are a known,
    // documented limitation of the current engine port -- not an estimate
    // of tokens actually consumed -- and should be revisited if `ChatEngine`
    // ever grows a way to report partial usage before completion.
    if (usage) {
      this.writeUsage(chatId, messageId, profile, usage, this.now() - startedAt);
      // What the chat's calls read now, for the fresh chat card. A chat deleted mid-reply has nothing to keep it on.
      if (typeof usage.contextTokens === 'number' && this.store.chats.get(chatId)) this.store.chats.update(chatId, { contextTokens: usage.contextTokens });
    } else if (status === 'cancelled') {
      this.writeUsage(chatId, messageId, profile, ZERO_USAGE, this.now() - startedAt);
    }
  }

  /** Whether attachment `id` may be replayed in chat `chatId`: its row is in that chat, within the size cap, and was sent in a message of that chat. */
  private attachmentInChat(id: string, chatId: string): boolean {
    const row = this.store.attachments.get(id);
    if (!row || row.chatId !== chatId || !(row.size >= 0 && row.size <= MAX_HISTORY_ATTACHMENT_BYTES)) return false;
    return attachmentBound(row, row.messageId === null ? null : (this.store.messages.get(row.messageId)?.chatId ?? null));
  }

  /** Whether a reply in chat `chatId` may load attachment `id`: one it may replay, or one on a note waiting in that chat (in the chat, within the cap). */
  private attachmentLoadable(id: string, chatId: string): boolean {
    if (this.attachmentInChat(id, chatId)) return true;
    if (!this.heldAttachment?.(id, chatId)) return false;
    const row = this.store.attachments.get(id);
    return row !== null && row.chatId === chatId && row.size >= 0 && row.size <= MAX_HISTORY_ATTACHMENT_BYTES;
  }

  /** `load` for one chat: it refuses an attachment `attachmentLoadable` would not let through, and bytes over the cap, so no engine can read across chats by id. */
  private chatScopedLoader(load: (id: string) => Promise<Buffer>, chatId: string): (id: string) => Promise<Buffer> {
    return async (id) => {
      if (!this.attachmentLoadable(id, chatId)) throw new Error(`Attachment "${id}" is not available in this chat.`);
      const bytes = await load(id);
      if (bytes.length > MAX_HISTORY_ATTACHMENT_BYTES) throw new Error(`Attachment "${id}" is over the size limit.`);
      return bytes;
    };
  }

  /** Prices the row at finish time (see recordUsage) so pricing reflects whatever is current right now. */
  private writeUsage(
    chatId: string,
    messageId: string,
    profile: ResolvedProfile,
    usage: Usage,
    latencyMs: number,
    subagentCallId?: string
  ): void {
    recordUsage(this.store, { id: this.generateId(), chatId, messageId, profile, usage, latencyMs, ...(subagentCallId ? { subagentCallId } : {}) });
  }
}
