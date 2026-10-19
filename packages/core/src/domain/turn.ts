import { randomUUID } from 'node:crypto';
import { cutAtContextLine } from './context-lines.js';
import { existsSync } from 'node:fs';
import type { ChatEngine, EngineEvent, EngineRequest, ToolImageLoader, ToolImageSizer } from '../ports/chat-engine.js';
import type { Chat, Project, Store } from '../ports/store.js';
import type { ApprovalChoice, ApprovalRequest, ToolProvider, ToolSpec, UserAsk } from '../ports/tool-provider.js';
import type { CanonMessage, MessageStatus, Part, SerializedError, UserNotePart } from '../types/messages.js';
import { runsShellInSandbox, type ResolvedProfile } from '../types/config.js';
import type { ResolvedFolder, WorkspaceStatus } from '../types/workspace.js';
import type { Usage } from '../types/usage.js';
import { recordUsage } from './usage-record.js';
import { classifyProviderError } from '../types/errors.js';
import { isCompareSet } from './tree.js';
import { MEMORY_QUIET_MS, hasMemoryContent, projectMemoryPrompt } from './memory.js';
import { projectDisplayName, projectInstructionsPrompt, projectParentOf } from './projects.js';
import { PROJECT_INDEX_MAX, aboutUserPrompt, currentFocusLine, defuse, globalMemoryPrompt, projectIndexPrompt } from './global-memory.js';
import { RECALL_GUIDANCE } from './recall.js';
import { translateForNode } from './path-translate.js';
import { availableToolsPrompt, namesItsTools } from './tools-prompt.js';
import { ARTIFACTS_GUIDANCE, artifactsListNote, artifactsOnBranch, branchOf } from './artifacts.js';
import { sandboxPrompt } from './sandbox-paths.js';
import { LIVE_ARTIFACTS_GUIDANCE } from './live-artifacts.js';
import { PLAN_MODE_NOTE, PLAN_TOOL, createPlanGate } from './thread-tools.js';
import { canReachFolders, extraFoldersPrompt, mergeFolders, resolveFolders, resolveWorkspace } from './workspace.js';
import { appendDelta, applySubagentEvent } from './parts.js';
import type { SubagentEvent } from './parts.js';
import { SubagentRunner } from './subagent.js';

// `appendDelta` lives in parts.ts now (the web folds with it too); kept exported here for peer/forward.ts.
export { appendDelta } from './parts.js';
import { attachmentBound, bindHistoryAttachments, MAX_HISTORY_ATTACHMENT_BYTES } from './attachment-binding.js';
import { bindToolImages, keepToolImages, MAX_TOOL_IMAGE_BYTES, toolImageBound, type SaveToolImage } from './tool-images.js';
import { MAX_REQUEST_ATTACHMENTS, omissionNote } from './request-budget.js';

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
  /** A question or plan card raised by this reply's tool call (spec 2026-10-12-thread-cards-design), relayed like approvals. */
  | { type: 'ask-request'; ask: UserAsk }
  | { type: 'ask-resolved'; askId: string }
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
  /** A sub-agent's progress (spec 2026-10-12-api-subagents-design), folded into the reply's parts with `applySubagentEvent`. */
  | { type: 'subagent'; callId: string; event: SubagentEvent }
  /** A note the user sent mid-reply, folded into the reply at the point Claude read it (replaces the engine's `note-picked`). */
  | { type: 'user-note'; part: UserNotePart }
);

export interface TurnInput {
  chatId: string;
  parentId: string | null;
  userParts: Part[];
  profiles: ResolvedProfile[];
  /**
   * A scheduled run with nobody watching (spec 2026-10-12-scheduled-tasks-design):
   * the request is marked unattended, so tool calls that would raise a card are
   * refused, and Claude Code's auto mode is off whatever the chat says. Only
   * the schedule service sets it; no route reads it from a request body.
   * `retry` and `regenerate` never set it: a person is pressing the button.
   */
  unattended?: boolean;
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
  /** Hands over the note Claude just picked up in reply `messageId` as a part, or null when nobody holds it (then it is ignored). */
  takeNote?: (messageId: string, noteId: string) => UserNotePart | null;
  /**
   * Whether attachment `attachmentId` is on a note waiting in chat `chatId`.
   * Such an attachment is unsent (it is bound only once the note is
   * delivered), yet the reply the note goes into must load its images: a
   * reply's loader accepts it too, still only from that chat and within the cap.
   */
  heldAttachment?: (attachmentId: string, chatId: string) => boolean;
  /** Overridable clock, so the 500ms checkpoint throttle is testable without real delays. */
  now?: () => number;
  /** Overridable id generator; defaults to `randomUUID`. */
  generateId?: () => string;
  /** How often (ms) a streaming variant's partial parts may be re-checkpointed to the store. */
  checkpointIntervalMs?: number;
  /**
   * Resolves a profile by id for a sub-agent that runs as another profile
   * (the server passes profile-resolution.ts's `resolveProfile`). Without
   * it, a sub-agent can only run as the reply's own profile.
   */
  resolveProfile?: (id: string) => Promise<ResolvedProfile>;
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
  /**
   * A folder's real path (its on-disk case, and a mapped drive's UNC path),
   * for naming where the sandbox mounts it in the system prompt; it should
   * hand back the path unchanged when it can't tell. Defaults to the path as
   * it is. The server wires `realpathSync.native`, as the sandbox mounts by.
   */
  canonicalPath?: (path: string) => string;
  /**
   * Stores an image a tool returned (spec 2026-10-12-computer-use-design
   * section 6) and returns its attachment id. The container wires it to the
   * blob store plus an attachment row on the reply, so blob GC keeps it.
   * Without it, images in tool results are dropped to a text note: base64 is
   * never broadcast or stored either way.
   */
  saveToolImage?: SaveToolImage;
}

const DEFAULT_CHECKPOINT_INTERVAL_MS = 500;

/** How long a chat must be quiet before its global memory block is rebuilt (see `globalMemoryBlock`). */
const GLOBAL_BLOCK_STEADY_MS = MEMORY_QUIET_MS;

/** What a held memory block was built from that the user changes by hand: when any of it differs, the block is rebuilt at once. */
type UserSaves = Record<string, string>;
type HeldBlock = { block: string | null; at: number; saves: UserSaves };

/**
 * When the user last saved a note, as a held block knows it. A summariser's
 * save since leaves the time as it was, so only the user's own saves rebuild
 * a block that is being held.
 */
function lastUserSave(by: string | null | undefined, at: number | null | undefined, previous: string | undefined): string {
  return by === 'user' ? String(at) : (previous ?? '0');
}

function sameSaves(a: UserSaves, b: UserSaves): boolean {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((k) => a[k] === b[k]);
}

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
 * A file name as one plain line for a fence, a placeholder or a notice: control
 * characters and line separators (U+0085, U+2028, U+2029) become spaces, double
 * quotes single ones, `<`, `>` and `&` underscores, and bidirectional controls
 * (U+202A-202E, U+2066-2069) are dropped, so nothing in it can close the fence,
 * open a tag or reorder the text around it.
 */
function fileLabel(filename: string): string {
  const plain = filename
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ')
    .replace(/[\u202a-\u202e\u2066-\u2069]/g, '')
    .replace(/"/g, "'")
    .replace(/[<>&]/g, '_')
    .trim();
  return defuse(plain, 'attached-file');
}

/**
 * An attached file's text as the model gets it (spec 2026-10-12-office-files
 * §2): fenced and named, with anything inside that would close the fence
 * early defused. It's the user's file, so it may carry instructions; the
 * fence says where it starts and ends.
 */
export function fencedFileText(filename: string, text: string): string {
  return `<attached-file name="${fileLabel(filename)}">\n${defuse(text, 'attached-file')}\n</attached-file>`;
}

/** The notice's sentence for attached files OtherBench had no text for. */
function unreadFilesNotice(unread: { filename: string }[], modelId: string): string {
  const names = unread.map((u) => `"${fileLabel(u.filename)}"`).join(', ');
  return `OtherBench couldn't read ${names} as text, so ${modelId} didn't get ${unread.length === 1 ? 'it' : 'them'}.`;
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
  private readonly resolveProfile?: (id: string) => Promise<ResolvedProfile>;
  private readonly loadAttachment?: (id: string) => Promise<Buffer>;
  private readonly pathExists: (path: string) => boolean;
  private readonly canonicalPath: (path: string) => string;
  private readonly saveToolImage?: SaveToolImage;
  private readonly listeners = new Set<(e: TurnEvent) => void>();
  private readonly controllers = new Map<string, AbortController>();
  /** Running variants' chat and unattended flag, kept and cleared with `controllers`. */
  private readonly running = new Map<string, { chatId: string; unattended: boolean }>();
  private readonly takeNote?: (messageId: string, noteId: string) => UserNotePart | null;
  private readonly heldAttachment?: (attachmentId: string, chatId: string) => boolean;
  /** chatId -> the global memory block it last got, when, and the user saves it reflects. */
  private readonly globalBlocks = new Map<string, HeldBlock>();
  /** Each chat's project memory block, held steady like the global one (see `projectMemoryBlock`). */
  private readonly projectBlocks = new Map<string, HeldBlock>();
  /**
   * The notes each user message was sent with, by message and profile (see
   * `withNotes`), so a later request carries the message exactly as it went.
   */
  private readonly sentNotes = new Map<string, { notes: string[]; at: number }>();

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
      void this.runVariant(input.chatId, userMessage.id, message.id, profile, input.unattended === true).catch((err: unknown) => {
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

  /** The chat and unattended flag of a reply running now, or null when it isn't running here. */
  runningInfo(messageId: string): { chatId: string; unattended: boolean } | null {
    return this.running.get(messageId) ?? null;
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
    void this.runVariant(input.chatId, input.parentId, message.id, profile, input.unattended, { stream: input.stream, notice: input.notice })
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
    variant: { stream?: (req: EngineRequest) => AsyncIterable<EngineEvent>; notice?: string } = {}
  ): Promise<void> {
    const controller = new AbortController();
    this.controllers.set(messageId, controller);
    this.running.set(messageId, { chatId, unattended });
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
      // Extra folders: a parent project's, the project's and the chat's, each
      // resolved here; one not on this machine is left out, and none apply
      // without a workspace (spec 2026-10-07-extra-folders).
      const projectFolders = this.projectChain(chat).map((p) => p.folders);
      const folders = workspaceRoot === null ? [] : resolveFolders(mergeFolders(...projectFolders, chat?.folders), selfNodeId, locationPaths, this.pathExists, workspaceRoot);
      const autoMode = chat?.autoMode ?? false;
      const effort = chat?.effort ?? null;
      // A self-started reply is held to the chat's plan mode like any other (a fresh, closed gate):
      // nothing changes before a plan is approved, however the turn began.
      const planMode = chat?.planMode === true;
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
          ? listed.filter((t) => t.source !== 'artifact' && t.source !== 'recall' && t.source !== 'thread' && t.source !== 'subagent')
          : listed;
      // Claude Code runs its own sub-agents (Task/Agent); OtherBench's tool is for API profiles only.
      const offered = profile.connection.kind === 'claude_code' ? usable.filter((t) => t.source !== 'subagent') : usable;
      // propose_plan only while the chat's Plan mode is on (spec 2026-10-12-thread-cards-design §4).
      const tools = planMode ? offered : offered.filter((t) => !(t.source === 'thread' && t.name === PLAN_TOOL));
      // One gate per reply: compare variants, retries and the next message each start closed.
      const plan = planMode && tools.some((t) => t.source === 'thread' && t.name === PLAN_TOOL) ? createPlanGate() : undefined;
      const canRecall = tools.some((t) => t.source === 'recall');
      const requestProfile = this.withRecall(
        this.withArtifacts(this.withTools(this.withSandbox(this.withFolders(this.withProjectMemory(this.withProjectInstructions(this.withGlobalMemory(profile, chat, canRecall), chat), chat), folders), workspaceRoot, folders), tools), tools),
        canRecall
      );
      // Other machines' folder paths in tool calls and results, as they are
      // on this machine (spec §6); the stored messages are untouched.
      const translated = this.withNotes(
        translateForNode(this.buildRequestMessages(userMessageId, requestProfile), selfNodeId, locationPaths),
        [...this.artifactsListNotes(tools, chatId, userMessageId), ...(plan !== undefined ? [PLAN_MODE_NOTE] : [])],
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
      const { messages: visionMessages, degraded } = this.degradeImagesForVision(history, vision);
      // Attached files (spec 2026-10-12-office-files §2): text for every
      // engine, except a PDF for one that takes PDFs.
      const { messages: requestMessages, unread } = this.filesForModel(visionMessages, profile.connection.kind !== 'claude_code');
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
        ...(subagents ? { subagents } : {}),
        ...(this.loadAttachment ? { loadAttachment: this.chatScopedLoader(this.loadAttachment, chatId) } : {}),
        ...(loadToolImage ? { loadToolImage } : {}),
        ...(toolImageSize ? { toolImageSize } : {}),
        ...(attachmentSize ? { attachmentSize } : {}),
        purpose: 'turn',
        // Nobody can catch what auto mode's classifier allows in a scheduled
        // run, so it is never used there (the classifier isn't a security boundary).
        autoMode: unattended ? false : autoMode,
        ...(unattended ? { unattended: true } : {}),
        ...(effort ? { effort } : {}),
        ...(plan ? { plan } : {}),
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
          : classifyProviderError(err);
    } finally {
      this.controllers.delete(messageId);
      this.running.delete(messageId);
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

  private buildRequestMessages(userMessageId: string, profile: ResolvedProfile): CanonMessage[] {
    const history = cutAtContextLine(this.store.messages.pathToRoot(userMessageId));
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
   * The profile with global memory appended to its system prompt (spec
   * 2026-10-08-global-memory-design §1): About you, then the learned note,
   * then the index of the user's projects, all straight after the profile's
   * own prompt so a project's own text comes later. Nothing for a profile
   * with global memory off. Read fresh each turn.
   */
  private withGlobalMemory(profile: ResolvedProfile, chat: Chat | null, canRecall: boolean): ResolvedProfile {
    if (profile.useGlobalMemory === false) return profile;
    const block = this.globalMemoryBlock(chat, canRecall);
    if (!block) return profile;
    return { ...profile, systemPrompt: profile.systemPrompt ? `${profile.systemPrompt}\n\n${block}` : block };
  }

  /**
   * The chat's global memory block, held steady while the chat is active.
   * The summariser rewrites the note and project notes (their current focus
   * is in the index) a few minutes after any chat goes quiet; letting that
   * change an active chat's system prompt would throw away its prompt cache
   * and restart its Claude Code process. So the block a chat last got is
   * reused until the chat has been quiet for `GLOBAL_BLOCK_STEADY_MS` (its
   * cache is cold by then anyway). The user's own saves of About you or the
   * note apply at once.
   */
  private globalMemoryBlock(chat: Chat | null, canRecall: boolean): string | null {
    const memory = this.store.globalMemory.get();
    // Whether the turn offers recall changes the index's last line, so each
    // kind of turn keeps its own block: a compare between a profile with
    // recall and one without mustn't keep rebuilding both.
    const key = `${chat?.id ?? ''}:${canRecall}`;
    const now = this.now();
    const kept = this.globalBlocks.get(key);
    const saves: UserSaves = { about: String(memory.aboutUpdatedAt), note: lastUserSave(memory.noteUpdatedBy, memory.noteUpdatedAt, kept?.saves['note']) };
    if (kept && sameSaves(kept.saves, saves) && now - kept.at < GLOBAL_BLOCK_STEADY_MS) {
      kept.at = now;
      return kept.block;
    }
    const lookup = (id: string): Project | null => this.store.projects.get(id);
    const index = projectIndexPrompt(
      this.store.projects
        .list()
        .slice(0, PROJECT_INDEX_MAX)
        .map((p) => ({
          name: projectDisplayName(p, lookup),
          description: p.description,
          currentFocus: currentFocusLine(this.store.projectMemory.get(p.id)?.body ?? ''),
          current: p.id === chat?.projectId,
        })),
      canRecall
    );
    const blocks = [aboutUserPrompt(memory.about), globalMemoryPrompt(memory.note), index].filter((b): b is string => b !== null);
    const block = blocks.length === 0 ? null : blocks.join('\n\n');
    this.globalBlocks.set(key, { block, at: now, saves });
    return block;
  }

  /**
   * The profile with the chat's project instructions appended to its system
   * prompt (spec 2026-10-08-project-page-design §2), straight after the
   * profile's own prompt and before project memory. Read fresh each turn, so
   * an edit reaches existing chats on their next message. Both engines read
   * the result, as for memory.
   */
  private withProjectInstructions(profile: ResolvedProfile, chat: Chat | null): ResolvedProfile {
    // A sub-project's chats get the parent's instructions first, then the sub-project's own.
    const blocks = this.projectChain(chat)
      .map((p) => projectInstructionsPrompt(p.name, p.instructions))
      .filter((b): b is string => b !== null);
    if (blocks.length === 0) return profile;
    const block = blocks.join('\n\n');
    return { ...profile, systemPrompt: profile.systemPrompt ? `${profile.systemPrompt}\n\n${block}` : block };
  }

  /**
   * The chat's project and, for a sub-project, its parent first (spec
   * 2026-10-15-sub-projects-design §3): what instructions, memory and extra
   * folders are read from, top down. Empty outside a project.
   */
  private projectChain(chat: Chat | null): Project[] {
    const project = chat?.projectId ? this.store.projects.get(chat.projectId) : null;
    if (!project) return [];
    const parent = projectParentOf(project, (id) => this.store.projects.get(id));
    return parent ? [parent, project] : [project];
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
    const block = this.projectMemoryBlock(chat);
    if (!block) return profile;
    return { ...profile, systemPrompt: profile.systemPrompt ? `${profile.systemPrompt}\n\n${block}` : block };
  }

  /**
   * The chat's project memory block, held steady while the chat is active,
   * for the reason the global block is (`globalMemoryBlock`): the summariser
   * rewrites a project's note a few minutes after any of its chats goes
   * quiet, and that must not change the system prompt of another chat in the
   * project that is still going. The user's own saves, and a renamed or
   * moved project, apply at once.
   */
  private projectMemoryBlock(chat: Chat | null): string | null {
    const chain = this.projectChain(chat);
    if (!chat || chain.length === 0) return null;
    const notes = chain.map((p) => ({ project: p, memory: this.store.projectMemory.get(p.id) }));
    const now = this.now();
    const kept = this.projectBlocks.get(chat.id);
    const saves: UserSaves = Object.fromEntries(
      notes.flatMap(({ project, memory }) => [
        [`${project.id}:name`, project.name],
        [`${project.id}:note`, lastUserSave(memory?.updatedBy, memory?.updatedAt, kept?.saves[`${project.id}:note`])],
      ])
    );
    if (kept && sameSaves(kept.saves, saves) && now - kept.at < GLOBAL_BLOCK_STEADY_MS) {
      kept.at = now;
      return kept.block;
    }
    // A sub-project's chats read the parent's note first, then their own; only their own is written (memory service).
    const blocks = notes.flatMap(({ project, memory }) => (memory && hasMemoryContent(memory.body) ? [projectMemoryPrompt(project.name, memory.body)] : []));
    const block = blocks.length === 0 ? null : blocks.join('\n\n');
    this.projectBlocks.set(chat.id, { block, at: now, saves });
    return block;
  }

  /**
   * The profile with a note naming the turn's extra folders appended to its system prompt (spec
   * 2026-10-07-extra-folders); for reference only when none of its tools can reach them (canReachFolders).
   */
  private withFolders(profile: ResolvedProfile, folders: ResolvedFolder[]): ResolvedProfile {
    if (folders.length === 0) return profile;
    const block = extraFoldersPrompt(folders, canReachFolders(profile.toolPolicy));
    return { ...profile, systemPrompt: profile.systemPrompt ? `${profile.systemPrompt}\n\n${block}` : block };
  }

  /**
   * The profile with the "# Sandbox" block (spec 2026-10-12-sandbox-design,
   * "Model guidance") when its shell runs in the sandbox: what run_command is
   * and where the workspace and each extra folder are in it, or, with file
   * access off, that it has none of them and runs in its own home. A chat
   * with no workspace can't run sandboxed commands at all, so it gets none.
   */
  private withSandbox(profile: ResolvedProfile, workspaceRoot: string | null, folders: ResolvedFolder[]): ResolvedProfile {
    if (workspaceRoot === null || !runsShellInSandbox(profile.toolPolicy)) return profile;
    const block = sandboxPrompt(profile.toolPolicy.fs, workspaceRoot, folders, this.canonicalPath);
    return { ...profile, systemPrompt: profile.systemPrompt ? `${profile.systemPrompt}\n\n${block}` : block };
  }

  /**
   * The profile with a note naming the tools this turn offers appended to its
   * system prompt, so a change to them mid-chat reaches the model even when
   * its own earlier replies say otherwise. Claude Code runs its own tools and
   * gets no note; neither does a turn with no tools.
   */
  private withTools(profile: ResolvedProfile, tools: readonly ToolSpec[]): ResolvedProfile {
    if (tools.length === 0 || !namesItsTools(profile.connection.kind)) return profile;
    const block = availableToolsPrompt(tools.map((t) => t.name));
    return { ...profile, systemPrompt: profile.systemPrompt ? `${profile.systemPrompt}\n\n${block}` : block };
  }

  /**
   * The artifacts guidance (Deck #896) in the system prompt of a turn that
   * can make artifacts, for either engine, plus the live-artifact part (spec
   * 2026-10-12-live-artifacts) for a profile with MCP servers. Both are fixed
   * text, so the prompt stays the same per profile; the branch's artifacts go
   * with the user's message (withArtifactsList).
   */
  private withArtifacts(profile: ResolvedProfile, tools: readonly ToolSpec[]): ResolvedProfile {
    if (!tools.some((t) => t.source === 'artifact')) return profile;
    const guidance = profile.toolPolicy.mcpServerIds.length > 0 ? `${ARTIFACTS_GUIDANCE}\n\n${LIVE_ARTIFACTS_GUIDANCE}` : ARTIFACTS_GUIDANCE;
    return { ...profile, systemPrompt: profile.systemPrompt ? `${profile.systemPrompt}\n\n${guidance}` : guidance };
  }

  /** When to use the recall tool (spec 2026-10-09-recall-design), for a turn that offers it. Fixed text, so it never churns the prompt. */
  private withRecall(profile: ResolvedProfile, canRecall: boolean): ResolvedProfile {
    if (!canRecall) return profile;
    return { ...profile, systemPrompt: profile.systemPrompt ? `${profile.systemPrompt}\n\n${RECALL_GUIDANCE}` : RECALL_GUIDANCE };
  }

  /**
   * This branch's artifacts by id, title, kind and version, as a note for the
   * end of the user's message (`withNotes`). Kept out of the system prompt so
   * that prompt stays the same as artifacts change. Contents stay out: the
   * tool's `view` reads one.
   */
  private artifactsListNotes(tools: readonly ToolSpec[], chatId: string, userMessageId: string): string[] {
    if (!tools.some((t) => t.source === 'artifact')) return [];
    return [artifactsListNote(artifactsOnBranch(this.store, chatId, branchOf(this.store, userMessageId)))];
  }

  /**
   * `notes` (the artifacts list, the Plan mode note) at the end of the user's
   * message, in the request only: the stored message is untouched. Each
   * earlier user message on the branch gets back the notes it was sent with,
   * so the history a request carries is the same from turn to turn and the
   * provider's prompt cache keeps matching it; dropping them would change
   * every turn's previous message. Held for as long as the global memory
   * block is (a chat quiet that long has a cold cache anyway). Not for Claude
   * Code, which keeps its own session and reads only the new message.
   */
  private withNotes(messages: CanonMessage[], notes: string[], userMessageId: string, profile: ResolvedProfile): CanonMessage[] {
    const now = this.now();
    for (const [key, kept] of this.sentNotes) if (now - kept.at >= GLOBAL_BLOCK_STEADY_MS) this.sentNotes.delete(key);
    const keyOf = (messageId: string): string => `${messageId}\u0000${profile.id}`;
    this.sentNotes.set(keyOf(userMessageId), { notes, at: now });
    const replay = profile.connection.kind !== 'claude_code';
    const append = (m: CanonMessage, texts: string[]): CanonMessage => (texts.length === 0 ? m : { ...m, parts: [...m.parts, ...texts.map((text) => ({ type: 'text' as const, text }))] });
    return messages.map((m) => {
      if (m.id === userMessageId) return append(m, notes);
      const kept = replay && m.role === 'user' ? this.sentNotes.get(keyOf(m.id)) : undefined;
      if (!kept) return m;
      kept.at = now;
      return append(m, kept.notes);
    });
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

  /**
   * Attached files as the model gets them (spec 2026-10-12-office-files §2),
   * on this variant's own copy of the messages. A PDF stays a file for an
   * engine that takes PDFs (`pdfNative`: every connection but Claude Code).
   * Every other file part becomes its attachment's extracted text, fenced and
   * named, or a placeholder naming it when there is none: providers refuse
   * most file types outright, which used to fail the whole turn. The stored
   * messages are untouched.
   */
  private filesForModel(
    messages: CanonMessage[],
    pdfNative: boolean
  ): { messages: CanonMessage[]; unread: { attachmentId: string; filename: string }[] } {
    const unread: { attachmentId: string; filename: string }[] = [];
    const seen = new Set<string>();
    // The request's attachment count cap (computer use's ruling 17: at most
    // MAX_REQUEST_ATTACHMENTS, the newest kept) counts the user's images and
    // files as the engines will, newest first, each attachment once. A file
    // sent as its text is held to it too: one that isn't among the newest is
    // left out with the same note the engines give, not sent as text instead.
    // The other way round as well: once a file is text the engines no longer
    // count it, so an image or a PDF past the window is left out here too,
    // or older images would ride on the slots the newer files' text took.
    const counted = new Set<string>();
    for (let m = messages.length - 1; m >= 0 && counted.size < MAX_REQUEST_ATTACHMENTS; m--) {
      const parts = messages[m]!.role === 'system' ? [] : messages[m]!.parts;
      for (let i = parts.length - 1; i >= 0 && counted.size < MAX_REQUEST_ATTACHMENTS; i--) {
        const part = parts[i]!;
        if (part.type === 'file' || part.type === 'image') counted.add(part.attachmentId);
      }
    }
    const next = messages.map((message) => {
      if (message.role === 'system' || !message.parts.some((p) => p.type === 'file' || p.type === 'image')) return message;
      const parts = message.parts.map((part): Part => {
        if (part.type === 'image') return counted.has(part.attachmentId) ? part : { type: 'text', text: omissionNote('over-budget') };
        if (part.type !== 'file') return part;
        const attachment = this.store.attachments.get(part.attachmentId);
        const filename = attachment?.filename ?? part.filename;
        if (!counted.has(part.attachmentId)) return { type: 'text', text: omissionNote('over-budget', filename) };
        if (pdfNative && part.mime === 'application/pdf') return part;
        if (attachment?.extractedText) return { type: 'text', text: fencedFileText(filename, attachment.extractedText) };
        if (!seen.has(part.attachmentId)) {
          seen.add(part.attachmentId);
          unread.push({ attachmentId: part.attachmentId, filename });
        }
        const mime = part.mime.replace(/[^\w.+/-]/g, '');
        return { type: 'text', text: `[Attached file "${fileLabel(filename)}" (${mime}) couldn't be read as text, so it wasn't sent.]` };
      });
      return { ...message, parts };
    });
    return { messages: next, unread };
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
