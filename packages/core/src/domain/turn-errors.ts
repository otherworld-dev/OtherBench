import type { WorkspaceStatus } from '../types/workspace.js';

/**
 * Thrown by `TurnRunner.run()` when a user part's `attachmentId` (an
 * `image`/`file` `Part`) doesn't resolve to an attachment row that belongs
 * to THIS chat -- either the id is unknown, or it names a real attachment
 * that lives in a DIFFERENT chat. Without this check, a turn could bind
 * (see `run()`'s attachment-binding step in turn.ts) a message to another
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
export class WorkspaceUnresolvedError extends Error {
  constructor(readonly status: Extract<WorkspaceStatus, { status: 'unresolved' }>) {
    super(workspaceUnresolvedMessage(status));
    this.name = 'WorkspaceUnresolvedError';
  }
}

/** The chat names a Claude account this machine doesn't have: the reply fails rather than run on main. */
export class ClaudeAccountUnavailableError extends Error {
  constructor(readonly slug: string) {
    super(`No Claude account named "${slug}" on this machine.`);
    this.name = 'ClaudeAccountUnavailableError';
  }
}
