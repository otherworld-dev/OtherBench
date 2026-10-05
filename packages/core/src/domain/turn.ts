import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import type { ChatEngine, EngineEvent, EngineRequest } from '../ports/chat-engine.js';
import type { Chat, Store } from '../ports/store.js';
import type { ApprovalChoice, ApprovalRequest, ToolProvider } from '../ports/tool-provider.js';
import type { CanonMessage, MessageStatus, Part, SerializedError } from '../types/messages.js';
import type { ResolvedProfile } from '../types/config.js';
import type { WorkspaceStatus } from '../types/workspace.js';
import type { PricingSnapshot, Usage } from '../types/usage.js';
import { estimateCost } from '../types/usage.js';
import { classifyProviderError } from '../types/errors.js';
import { isCompareSet } from './tree.js';
import { hasMemoryContent, projectMemoryPrompt } from './memory.js';
import { translateForNode } from './path-translate.js';
import { resolveWorkspace } from './workspace.js';

/**
 * One event out of a turn's lifecycle, tagged with the message id it
 * belongs to. `messageId` is what lets a single subscriber (the SSE
 * transport, task 17) multiplex every variant of a compare turn over one
 * channel: the caller demuxes by `messageId`, not by which `run()` call
 * produced it. `approval-request`/`approval-resolved` (task 26) are relayed
 * here from a `ToolProvider`'s own `onApprovalEvent` -- see the constructor
 * subscription below -- rather than originating from `ChatEngine.stream()`,
 * since a gated tool's approval wait happens INSIDE a tool's `execute()`,
 * underneath the engine, not as a distinct stream event the engine itself
 * knows how to produce.
 */
export type TurnEvent = { messageId: string } & (
  | EngineEvent
  | { type: 'status'; status: MessageStatus }
  | { type: 'approval-request'; request: ApprovalRequest }
  | { type: 'approval-resolved'; requestId: string; choice: ApprovalChoice['choice'] }
  /**
   * The capability-fallback disclosure (task 21 decision #3), synthesised by
   * `runVariant` itself -- like `approval-request`/`approval-resolved`, this
   * never originates from `ChatEngine.stream()`. Emitted once, synchronously,
   * before the engine is ever called, whenever this variant's `image` parts
   * had to be degraded to text because `profile.model.supportsVision` is
   * false. The SAME text is also appended to `parts` as a `{ type: 'notice' }`
   * Part, so a client that only hydrates from `GET .../messages` (never saw
   * the live event) still sees it -- this event exists purely so a client
   * that IS watching the live stream sees the disclosure immediately, before
   * the first token, rather than only after its next full reload.
   */
  | { type: 'notice'; text: string }
);

export interface TurnInput {
  chatId: string;
  parentId: string | null;
  userParts: Part[];
  profiles: ResolvedProfile[];
}

/**
 * Thrown by `TurnRunner.run()` when a user part's `attachmentId` (an
 * `image`/`file` `Part`) doesn't resolve to an attachment row that belongs
 * to THIS chat -- either the id is unknown, or it names a real attachment
 * that lives in a DIFFERENT chat. Without this check, a turn could bind
 * (see `run()`'s attachment-binding step below) a message to another
 * chat's attachment; that attachment would then dangle the moment the
 * OTHER chat is deleted (its row cascades away there, but this chat's
 * message would still reference it, and `loadAttachment` would fail on
 * every later turn). Thrown BEFORE the user message is created, so a
 * rejected turn never leaves a half-created row behind.
 *
 * Core has no notion of an HTTP status, so this is a plain typed `Error` --
 * the caller (`routes/turns.ts`) catches it by `instanceof` and maps it to
 * a 400, the same pattern `PathEscapeError` (domain/paths.ts) uses for
 * `fs-tools.ts`.
 */
export class InvalidAttachmentReferenceError extends Error {
  constructor(
    readonly attachmentId: string,
    readonly chatId: string
  ) {
    super(`Attachment "${attachmentId}" does not exist or does not belong to chat "${chatId}".`);
    this.name = 'InvalidAttachmentReferenceError';
  }
}

/** Every `attachmentId` an `image`/`file` part in `parts` names, deduplicated. */
function attachmentIdsIn(parts: Part[]): string[] {
  const ids = new Set<string>();
  for (const part of parts) {
    if (part.type === 'image' || part.type === 'file') ids.add(part.attachmentId);
  }
  return [...ids];
}

export type RegenerateErrorCode = 'not_found' | 'wrong_chat' | 'not_assistant' | 'no_parent' | 'streaming' | 'compare';

/**
 * Thrown by `TurnRunner.regenerate()` when the target can't be regenerated.
 * Like `InvalidAttachmentReferenceError`, a plain typed error the route maps
 * to an HTTP status by `code`; nothing has been written when it is thrown.
 */
export class RegenerateError extends Error {
  constructor(
    readonly code: RegenerateErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'RegenerateError';
  }
}

export interface TurnResult {
  userMessageId: string;
  assistantMessageIds: string[];
}

export interface TurnRunnerOptions {
  /** Overridable clock, so the 500ms checkpoint throttle is testable without real delays. */
  now?: () => number;
  /** Overridable id generator; defaults to `randomUUID`. */
  generateId?: () => string;
  /** How often (ms) a streaming variant's partial parts may be re-checkpointed to the store. */
  checkpointIntervalMs?: number;
  /**
   * Supplies the tools a variant's `EngineRequest.tools` is populated with
   * (task 26). Omitted (the default) preserves the pre-task-26 behaviour of
   * every existing test and caller that constructs a `TurnRunner` without
   * one: `tools: []`, no approval events ever raised. When supplied,
   * `listTools(profile.toolPolicy)` is called once per variant (so a
   * profile's own policy -- not some global default -- governs what that
   * variant's model may call), and this runner subscribes to its
   * `onApprovalEvent` for the lifetime of the runner, relaying every event
   * as a `TurnEvent` tagged with the `messageId` the underlying
   * `ApprovalRequest` already carries (see the `ToolApprovalEvent` port
   * type's doc for why per-variant isolation falls out of that for free).
   */
  toolProvider?: ToolProvider;
  /**
   * Loads an attachment's raw bytes by id; threaded straight through onto
   * every `EngineRequest.loadAttachment` this runner builds (task 21).
   * Omitted (the default) preserves the pre-task-21 behaviour of every
   * existing caller: `EngineRequest.loadAttachment` stays `undefined`, and
   * `AiSdkChatEngine` falls back to its own "attachment loading not wired
   * up" stub -- fine for any request whose messages carry no `image`/`file`
   * parts, which is every test and caller before this task.
   */
  loadAttachment?: (id: string) => Promise<Buffer>;
  /** Whether a folder exists, for resolving a chat's workspace. Defaults to `fs.existsSync`. */
  pathExists?: (path: string) => boolean;
}

const DEFAULT_CHECKPOINT_INTERVAL_MS = 500;

/** What a chat's unresolved folder means for a turn, in words for the error shown on the reply. */
export function workspaceUnresolvedMessage(status: Extract<WorkspaceStatus, { status: 'unresolved' }>): string {
  switch (status.reason) {
    case 'no-location-path':
      return "This chat's folder is in a location that has no path on this machine yet. Choose where it is here, or run the chat on the machine that has it.";
    case 'other-machine':
      return `This chat's folder (${status.hint?.path ?? 'on another machine'}) is on another machine. Choose a folder here, or run the chat on that machine.`;
    case 'missing':
      return `This chat's folder ${status.hint?.path ?? ''} doesn't exist on this machine any more. Choose where it is now.`;
  }
}

/** Thrown inside a variant whose chat's folder doesn't resolve here: it ends the reply before the engine is called. */
class WorkspaceUnresolvedError extends Error {
  constructor(readonly status: Extract<WorkspaceStatus, { status: 'unresolved' }>) {
    super(workspaceUnresolvedMessage(status));
    this.name = 'WorkspaceUnresolvedError';
  }
}

/**
 * Written for a variant cancelled before the engine ever reported usage --
 * see the comment at this file's only use site (the end of `runVariant`) for
 * why zero, rather than an estimate, is the honest answer here.
 */
const ZERO_USAGE: Usage = { tokensIn: 0, tokensOut: 0, tokensCached: 0, tokensReasoning: 0 };

/**
 * Appends streamed text (or reasoning) onto `parts`, merging into the
 * trailing part when it is already the same kind (the common case -- a
 * run of `text-delta` events building up one paragraph) rather than
 * fragmenting one logical span of text into one `Part` per network chunk.
 * A different kind arriving (e.g. a tool-call between two text spans, or
 * the very first delta) starts a new part instead.
 */
function appendDelta(parts: Part[], kind: 'text' | 'reasoning', text: string): Part[] {
  const last = parts.at(-1);
  if (last && last.type === kind) {
    const merged = { ...last, text: last.text + text } as Part;
    return [...parts.slice(0, -1), merged];
  }
  return [...parts, { type: kind, text } as Part];
}

/**
 * The honest, human-readable disclosure text for `degradeImagesForVision`'s
 * result -- task 21 decision #3 ("the user must be told which happened, not
 * silently downgraded"). Lists every degraded attachment's real filename
 * (from the `AttachmentRepo` row, not any guess derived from the id) so the
 * note is actually useful, not just "something was changed".
 */
function degradedAttachmentsNotice(degraded: { filename: string }[], modelId: string): string {
  const names = degraded.map((d) => `"${d.filename}"`).join(', ');
  const noun = degraded.length === 1 ? 'image attachment' : 'image attachments';
  return `${degraded.length} ${noun} (${names}) sent as text to "${modelId}" because this model does not support image input.`;
}

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
  private readonly loadAttachment?: (id: string) => Promise<Buffer>;
  private readonly pathExists: (path: string) => boolean;
  private readonly listeners = new Set<(e: TurnEvent) => void>();
  private readonly controllers = new Map<string, AbortController>();

  constructor(
    private readonly store: Store,
    private readonly engine: ChatEngine,
    options: TurnRunnerOptions = {}
  ) {
    this.now = options.now ?? Date.now;
    this.generateId = options.generateId ?? randomUUID;
    this.checkpointIntervalMs = options.checkpointIntervalMs ?? DEFAULT_CHECKPOINT_INTERVAL_MS;
    this.toolProvider = options.toolProvider;
    this.loadAttachment = options.loadAttachment;
    this.pathExists = options.pathExists ?? existsSync;
    this.toolProvider?.onApprovalEvent((event) => {
      if (event.type === 'request') {
        this.emit({ messageId: event.request.messageId, type: 'approval-request', request: event.request });
      } else {
        this.emit({ messageId: event.messageId, type: 'approval-resolved', requestId: event.requestId, choice: event.choice });
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
      void this.runVariant(input.chatId, userMessage.id, message.id, profile).catch((err: unknown) => {
        console.error(`[TurnRunner] variant ${message.id} failed outside its own error handling:`, err);
      });
    }

    return {
      userMessageId: userMessage.id,
      assistantMessageIds: variants.map((v) => v.message.id),
    };
  }

  /** Aborts one variant's stream. A no-op if `messageId` isn't currently running (already finished, or unknown). */
  cancel(messageId: string): void {
    this.controllers.get(messageId)?.abort();
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

  private async runVariant(
    chatId: string,
    userMessageId: string,
    messageId: string,
    profile: ResolvedProfile
  ): Promise<void> {
    const controller = new AbortController();
    this.controllers.set(messageId, controller);
    const startedAt = this.now();

    let parts: Part[] = [];
    let lastCheckpointAt = this.now();
    let status: MessageStatus = 'complete';
    let error: SerializedError | null = null;
    let usage: Usage | null = null;
    // Whether the signal was aborted by someone else (cancel()) BEFORE the
    // teardown abort below -- that one must not turn a clean finish into a
    // cancellation.
    let cancelled = false;

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
      const autoMode = chat?.autoMode ?? false;
      const requestProfile = this.withProjectMemory(profile, chat);
      // Other machines' folder paths in tool calls and results, as they are
      // on this machine (spec §6); the stored messages are untouched.
      const history = translateForNode(this.buildRequestMessages(userMessageId, requestProfile), selfNodeId, locationPaths);
      // Listed fresh per variant (not cached on the runner) so each variant's
      // request reflects THIS profile's own toolPolicy, and so a grant
      // revoked or an MCP server re-enabled between turns is picked up on
      // the very next call rather than requiring a restart -- ToolProvider
      // implementations are expected to keep their own MCP-connection state
      // long-lived internally; this call is just "what does this policy
      // currently allow", not "go reconnect everything".
      const tools = this.toolProvider ? await this.toolProvider.listTools(profile.toolPolicy) : [];

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
      const { messages: requestMessages, degraded } = this.degradeImagesForVision(history, vision);
      // The LIVE emit of this notice is deliberately deferred to inside the
      // loop below (its first iteration), NOT fired here -- see the comment
      // at that call site for why emitting it this early loses a real race
      // against `routes/turns.ts`'s `registerTurn()`. The persisted copy
      // (`parts`/`checkpoint`) has no such race -- a direct store write, not
      // a broadcast -- so that part happens right away regardless.
      let pendingNoticeText: string | null = null;
      if (degraded.length > 0) {
        pendingNoticeText = degradedAttachmentsNotice(degraded, profile.modelId);
        parts = [{ type: 'notice', text: pendingNoticeText }];
        // Forced (not throttled): the disclosure must be visible even if the
        // stream that follows errors out before its first checkpoint-worthy
        // event -- see this method's `checkpoint` doc.
        checkpoint(true);
      }

      const request: EngineRequest = {
        profile: requestProfile,
        messages: requestMessages,
        tools,
        signal: controller.signal,
        chatId,
        messageId,
        workspaceRoot,
        loadAttachment: this.loadAttachment,
        purpose: 'turn',
        autoMode,
        latestMessageForSession: (sessionId: string) => this.store.messages.latestBySession(chatId, sessionId)?.id ?? null,
      };

      for await (const event of this.engine.stream(request)) {
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
        this.emit({ messageId, ...event });

        switch (event.type) {
          case 'notice':
            parts = [...parts, { type: 'notice', text: event.text }];
            checkpoint(true);
            break;
          case 'text-delta':
            parts = appendDelta(parts, 'text', event.text);
            checkpoint(false);
            break;
          case 'reasoning-delta':
            parts = appendDelta(parts, 'reasoning', event.text);
            checkpoint(false);
            break;
          case 'tool-call':
            parts = [...parts, { type: 'tool-call', id: event.id, name: event.name, args: event.args }];
            checkpoint(true);
            break;
          case 'tool-result':
            parts = [
              ...parts,
              { type: 'tool-result', id: event.id, name: event.name, result: event.result, isError: event.isError },
            ];
            checkpoint(true);
            break;
          case 'finish':
            usage = event.usage;
            break;
          case 'error':
            status = event.error.kind === 'cancelled' ? 'cancelled' : 'error';
            error = event.error;
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
          : classifyProviderError(err);
    } finally {
      this.controllers.delete(messageId);
      cancelled = controller.signal.aborted;
      // Whatever ended this variant (finish, error, throw, cancel), nothing
      // may still be waiting on it. Aborting releases anything tied to its
      // signal -- above all a tool call parked on an approval card, which the
      // tool provider settles as a denial and drops from the broker. Only this
      // variant's own controller: siblings have their own.
      controller.abort();
    }

    // The engine can end a stream cleanly on abort (no `error` event at
    // all -- MockChatEngine and this package's own `FakeChatEngine` both
    // do this, mirroring `streamText`'s observed behaviour, see
    // task-14-15-report.md). If nothing else already classified the
    // outcome, an aborted signal means this was a cancellation.
    if (cancelled && status === 'complete' && error === null) {
      status = 'cancelled';
    }

    checkpoint(true);
    this.store.messages.updateStatus(messageId, status, error);
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
    } else if (status === 'cancelled') {
      this.writeUsage(chatId, messageId, profile, ZERO_USAGE, this.now() - startedAt);
    }
  }

  /**
   * The conversation this variant sees: every ancestor of the user message
   * down to (and including) it, with the profile's system prompt prepended
   * as a synthetic (unpersisted) system message when set. `Store.messages`
   * has no notion of a system message row -- the system prompt lives on
   * `Profile`, not in the tree -- so this is assembled fresh per variant
   * rather than read back from the store.
   */
  private buildRequestMessages(userMessageId: string, profile: ResolvedProfile): CanonMessage[] {
    const history = this.store.messages.pathToRoot(userMessageId);
    if (!profile.systemPrompt) return history;

    const systemMessage: CanonMessage = {
      id: `system:${profile.id}`,
      chatId: history[0]?.chatId ?? '',
      parentId: null,
      role: 'system',
      parts: [{ type: 'text', text: profile.systemPrompt }],
      status: 'complete',
      error: null,
      producedBy: null,
      createdAt: 0,
    };
    return [systemMessage, ...history];
  }

  /**
   * The profile this variant's request carries: `profile` itself, or, for a
   * chat in a project whose memory note has any content, a copy whose system
   * prompt ends with the note (spec 2026-10-03-project-memory-design §3).
   * Both engines read it from here: the AI SDK engine through the synthetic
   * system message `buildRequestMessages` adds, Claude Code as its appended
   * system prompt (sent with every query, so a resumed session sees the
   * current note). Excluded chats still get it; exclusion only stops a chat
   * contributing.
   */
  private withProjectMemory(profile: ResolvedProfile, chat: Chat | null): ResolvedProfile {
    if (!chat?.projectId) return profile;
    const project = this.store.projects.get(chat.projectId);
    const memory = this.store.projectMemory.get(chat.projectId);
    if (!project || !memory || !hasMemoryContent(memory.body)) return profile;
    const block = projectMemoryPrompt(project.name, memory.body);
    return { ...profile, systemPrompt: profile.systemPrompt ? `${profile.systemPrompt}\n\n${block}` : block };
  }

  /**
   * Task 21's capability fallback, hoisted up to THIS layer rather than left
   * solely inside `toModelMessages` (engine-aisdk/convert.ts, which already
   * has an equivalent `caps.vision` branch): `AiSdkChatEngine` only ever
   * calls `toModelMessages` for a REAL (non-mock) connection -- a `mock`-kind
   * connection (and therefore `FakeChatEngine` in every test) is handed the
   * request as-is, bypassing convert.ts entirely. Doing the degrade here
   * instead means every `ChatEngine` implementation -- mock or real --
   * receives the same already-degraded `messages`, which is what makes it
   * possible to assert the fallback happened by inspecting
   * `FakeChatEngine.requests` (see packages/core/test/turn.test.ts).
   *
   * Returns a NEW array (and new per-message objects where changed);
   * `messages` itself is never mutated, so a sibling variant with a
   * vision-capable model still sees the original `image` parts untouched.
   *
   * `vision: true` is a no-op (bytes are loaded later, inside convert.ts,
   * via `EngineRequest.loadAttachment`). `vision: false` replaces every
   * `image` part with a `text` part: the attachment's own `extractedText`
   * (task 21 decision #2) when the store has one -- populated on upload for
   * `text/*`, `.md`, `.csv` and PDF, never for a genuine photo, so this is
   * the common case only for a document that happened to be sent as an
   * `image` part -- or else a generic placeholder naming the file when there
   * is no extracted text (the overwhelmingly common case for an actual
   * image: nothing here does OCR).
   */
  private degradeImagesForVision(
    messages: CanonMessage[],
    vision: boolean
  ): { messages: CanonMessage[]; degraded: { attachmentId: string; filename: string }[] } {
    if (vision) return { messages, degraded: [] };

    const degraded: { attachmentId: string; filename: string }[] = [];
    const seen = new Set<string>();

    const next = messages.map((message) => {
      if (!message.parts.some((p) => p.type === 'image')) return message;

      const parts = message.parts.map((part): Part => {
        if (part.type !== 'image') return part;

        const attachment = this.store.attachments.get(part.attachmentId);
        const filename = attachment?.filename ?? part.attachmentId;
        if (!seen.has(part.attachmentId)) {
          seen.add(part.attachmentId);
          degraded.push({ attachmentId: part.attachmentId, filename });
        }

        const text = attachment?.extractedText
          ? `[Image "${filename}" is not supported by this model; showing its extracted text instead.]\n\n${attachment.extractedText}`
          : `[Image "${filename}" (${part.mime}) is not supported by this model, and no extracted text is available for it.]`;
        return { type: 'text', text };
      });

      return { ...message, parts };
    });

    return { messages: next, degraded };
  }

  /** Re-reads the model row at finish time (not the possibly-stale `ResolvedProfile.model` captured when the request began) so pricing reflects whatever is current right now. */
  private writeUsage(
    chatId: string,
    messageId: string,
    profile: ResolvedProfile,
    usage: Usage,
    latencyMs: number
  ): void {
    const currentModel = profile.model ? this.store.models.get(profile.model.id) : null;
    const pricingSnapshot: PricingSnapshot = currentModel
      ? {
          priceInPer1m: currentModel.priceInPer1m,
          priceOutPer1m: currentModel.priceOutPer1m,
          priceCachedPer1m: currentModel.priceCachedPer1m,
          currency: currentModel.currency,
        }
      : { priceInPer1m: null, priceOutPer1m: null, priceCachedPer1m: null, currency: 'USD' };

    this.store.usage.create({
      id: this.generateId(),
      chatId,
      messageId,
      profileId: profile.id,
      connectionId: profile.connectionId,
      modelId: profile.modelId,
      tokensIn: usage.tokensIn,
      tokensOut: usage.tokensOut,
      tokensCached: usage.tokensCached,
      tokensReasoning: usage.tokensReasoning,
      costEstimate: estimateCost(usage, pricingSnapshot),
      pricingSnapshot,
      latencyMs,
    });
  }
}
