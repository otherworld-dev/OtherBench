import type { EngineEvent } from '../ports/chat-engine.js';
import type { ApprovalChoice, ApprovalRequest, ToolProvider, UserAsk } from '../ports/tool-provider.js';
import type { MediaProgress } from '../ports/media.js';
import type { MessageStatus, Part, UserNotePart } from '../types/messages.js';
import type { ResolvedProfile } from '../types/config.js';
import type { ClaudeAccountRef } from '../types/claude-accounts.js';
import type { SubagentEvent } from './parts.js';
import type { SaveToolImage } from './tool-images.js';

/**
 * One event out of a turn's lifecycle, tagged with the message id it
 * belongs to. `messageId` is what lets a single subscriber (the SSE
 * transport, task 17) multiplex every variant of a compare turn over one
 * channel: the caller demuxes by `messageId`, not by which `run()` call
 * produced it. `approval-request`/`approval-resolved` (task 26) are relayed
 * here from a `ToolProvider`'s own `onApprovalEvent` -- see `TurnRunner`'s constructor
 * subscription -- rather than originating from `ChatEngine.stream()`,
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
  /** A generation call's progress (the media tools), relayed like asks. Live only: replayed from the stream buffer, never stored. */
  | { type: 'tool-progress'; callId: string; progress: MediaProgress }
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
   * refused, and Claude Code's auto mode is off whatever the chat says
   * (unless `unattendedAuto`). Only
   * the schedule service sets it; no route reads it from a request body.
   * `retry` and `regenerate` never set it: a person is pressing the button.
   */
  unattended?: boolean;
  /**
   * The schedule allows Claude Code's auto mode (`Schedule.autoMode`): an
   * unattended run's calls go to Claude Code's classifier instead of being
   * refused, and OtherBench's own tools are approved as in a chat with Auto
   * on. Only with `unattended`; an attended turn follows the chat's Auto.
   */
  unattendedAuto?: boolean;
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
  /**
   * The Claude account a Claude Code turn on the machine's Claude login runs
   * on (`EngineRequest.claudeAccount`). Asked once per variant, only for a
   * `claude_code` connection with no `baseUrl`, and never for a self-started
   * or follow-on reply (it runs on its process's own account); it may pin the chat to the
   * account it picks. It throws `ClaudeAccountUnavailableError` when the
   * chat names an account this machine doesn't have, which fails the reply
   * before the engine is called. Unset, every turn runs on main.
   */
  claudeAccountFor?: (chatId: string, profile: ResolvedProfile) => ClaudeAccountRef | undefined;
}
