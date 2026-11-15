import type { Part } from '../types/messages.js';
import { inputError, type Invalid, type ThreadToolError } from './thread-tools.js';

// The chat's status (spec docs/superpowers/specs/2026-11-15-chat-done-status-design.md):
// the agent says, at the end of a turn, whether everything agreed in the chat
// is done or what is still left. Nothing is stored: the status is read back
// from the reply's own parts (`agentStatusOf`), the way the checklist card is.
// No Node imports: the web UI imports this module.

export const STATUS_TOOL = 'set_chat_status';
export const STATUS_MAX_ITEMS = 20;
export const STATUS_ITEM_MAX_CHARS = 200;

export const SUBAGENT_STATUS_REFUSAL = "A helper can't set the chat's status; the main agent does that.";

export const STATUS_TOOL_DESCRIPTION =
  "Tell the user whether this chat's work is finished. Call it as the last step of any turn in which work was done or agreed. " +
  'Set done: true only when everything you and the user agreed to do in this chat is finished. Otherwise set done: false and list what is still left, one short line each, ' +
  "including things that were discussed and parked for later. This is about the whole conversation, not the current task's steps (that's the checklist). " +
  'Call it again every turn: a new reply starts with no status.';

export const STATUS_TOOL_PARAMETERS: Record<string, unknown> = {
  type: 'object',
  properties: {
    done: { type: 'boolean', description: 'True when nothing agreed in this chat is left to do.' },
    left: {
      type: 'array',
      maxItems: STATUS_MAX_ITEMS,
      items: { type: 'string' },
      description: 'With done: false, what is still left, one short line each. Leave it out with done: true.',
    },
  },
  required: ['done'],
};

/** What the agent last said about the chat's work. */
export interface AgentStatus {
  done: boolean;
  left: string[];
}

const invalid = (reason: string): Invalid => ({ invalid: reason });

/** `set_chat_status` input, held to its limits. */
export function parseChatStatus(args: unknown): AgentStatus | Invalid {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) return invalid('Send { done, left }.');
  const { done, left } = args as Record<string, unknown>;
  if (typeof done !== 'boolean') return invalid('"done" must be true or false.');
  // Some providers send null for an optional field they leave unset.
  const list = left === undefined || left === null ? [] : left;
  if (!Array.isArray(list)) return invalid('"left" must be a list of short lines.');
  if (list.length > STATUS_MAX_ITEMS) return invalid(`"left" can have at most ${STATUS_MAX_ITEMS} items.`);
  const items: string[] = [];
  for (const raw of list) {
    if (typeof raw !== 'string' || raw.trim() === '') return invalid('Each item in "left" needs some text.');
    items.push(raw.trim().slice(0, STATUS_ITEM_MAX_CHARS));
  }
  if (done && items.length > 0) return invalid('With done: true, leave "left" out: nothing is left.');
  if (!done && items.length === 0) return invalid('With done: false, list what is still left in "left".');
  return { done, left: items };
}

/** `set_chat_status`: nothing to store or wait for; the row and the card read the call itself. */
export function runStatusCommand(args: unknown): string | ThreadToolError {
  const status = parseChatStatus(args);
  if ('invalid' in status) return inputError(status.invalid);
  return status.done ? 'Status set: done.' : `Status set: ${status.left.length} left.`;
}

/** A result that is a refusal or an input error: Claude Code sets `isError`; the API engines store `{ error: true }` with isError false. */
function isFailedResult(p: Extract<Part, { type: 'tool-result' }>): boolean {
  return p.isError || (typeof p.result === 'object' && p.result !== null && (p.result as { error?: unknown }).error === true);
}

/** The ids of these parts' `set_chat_status` calls whose result came back without an error. */
function okResults(parts: readonly Part[]): Set<string> {
  const ok = new Set<string>();
  for (const p of parts) if (p.type === 'tool-result' && p.name === STATUS_TOOL && !isFailedResult(p)) ok.add(p.id);
  return ok;
}

/**
 * The ids of these parts' `set_chat_status` calls that didn't take: the result was an error, or the arguments don't
 * parse. The thread shows those as tool calls, so a row that didn't change has a reason; the rest (taken, or still
 * waiting on their result) stay out of it.
 */
export function failedStatusCalls(parts: readonly Part[]): Set<string> {
  const results = new Map<string, Extract<Part, { type: 'tool-result' }>>();
  for (const p of parts) if (p.type === 'tool-result' && p.name === STATUS_TOOL) results.set(p.id, p);
  const failed = new Set<string>();
  for (const p of parts) {
    if (p.type !== 'tool-call' || p.name !== STATUS_TOOL) continue;
    const result = results.get(p.id);
    if (result && (isFailedResult(result) || 'invalid' in parseChatStatus(p.args))) failed.add(p.id);
  }
  return failed;
}

/**
 * The reply's status: its last top-level `set_chat_status` call whose result came back without an error and whose
 * arguments parse. A helper's calls sit inside its `subagent` part, so they never count; a refused call has an error
 * result, so it doesn't either. Null when there is none.
 */
export function agentStatusOf(parts: readonly Part[]): AgentStatus | null {
  const ok = okResults(parts);
  for (let i = parts.length - 1; i >= 0; i--) {
    const p = parts[i];
    if (p?.type !== 'tool-call' || p.name !== STATUS_TOOL || !ok.has(p.id)) continue;
    const status = parseChatStatus(p.args);
    if (!('invalid' in status)) return status;
  }
  return null;
}
