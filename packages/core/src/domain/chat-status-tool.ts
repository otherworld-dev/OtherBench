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
export const STATUS_ASK_MAX_CHARS = 2000;

export const SUBAGENT_STATUS_REFUSAL = "A helper can't set the chat's status; the main agent does that.";

export const STATUS_TOOL_DESCRIPTION =
  "Tell the user whether this chat's work is finished. Call it as the last step of any turn in which work was done or agreed. " +
  'Set done: true only when everything you and the user agreed to do in this chat is finished. Otherwise set done: false and list what is still left, one short line each, ' +
  "including things that were discussed and parked for later. This is about the whole conversation, not the current task's steps (that's the checklist). " +
  'Give each item a "who": "you" when it waits on the user (something they must do, check, decide or answer before it can move), ' +
  '"me" when you will do it yourself once the user says carry on, "parked" when it was agreed to leave it for later. ' +
  'Every "you" item also needs "ask": the question or request itself, written to the user in full, shown to them under your reply. ' +
  'Put in it everything they need to act without scrolling back: the exact command to run and where, the choice and what each answer leads to, what to send back. ' +
  'The user cannot see your thinking, so a question you only worked out there has not been asked. ' +
  'Call it again every turn: a new reply starts with no status.';

/** Who a left item waits on: the user, the agent, or nobody yet (parked). */
export const STATUS_WHO = ['you', 'me', 'parked'] as const;
export type StatusWho = (typeof STATUS_WHO)[number];

export const STATUS_TOOL_PARAMETERS: Record<string, unknown> = {
  type: 'object',
  properties: {
    done: { type: 'boolean', description: 'True when nothing agreed in this chat is left to do.' },
    left: {
      type: 'array',
      maxItems: STATUS_MAX_ITEMS,
      items: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'What is left, in one short line.' },
          who: {
            type: 'string',
            enum: [...STATUS_WHO],
            description: '"you": waits on the user. "me": you will do it once they say carry on. "parked": agreed to leave for later.',
          },
          ask: {
            type: 'string',
            maxLength: STATUS_ASK_MAX_CHARS,
            description:
              'Required when who is "you", left out otherwise: the question or request in full, addressed to the user (Markdown; put commands in code blocks). They read this, not your thinking.',
          },
        },
        required: ['text', 'who'],
      },
      description: 'With done: false, what is still left. Leave it out with done: true.',
    },
  },
  required: ['done'],
};

/**
 * One thing left. `who` is missing on replies saved before items said who they wait on; `ask`, the full question or
 * request for a "you" item, on replies saved before items carried one.
 */
export interface StatusItem {
  text: string;
  who?: StatusWho;
  ask?: string;
}

/** What the agent last said about the chat's work. */
export interface AgentStatus {
  done: boolean;
  left: StatusItem[];
}

const invalid = (reason: string): Invalid => ({ invalid: reason });

const isWho = (v: unknown): v is StatusWho => typeof v === 'string' && (STATUS_WHO as readonly string[]).includes(v);

/** One `left` entry: `{ text, who }`, or a plain line as replies saved before items said who. */
function parseItem(raw: unknown): StatusItem | Invalid {
  if (typeof raw === 'string') {
    return raw.trim() === '' ? invalid('Each item in "left" needs some text.') : { text: raw.trim().slice(0, STATUS_ITEM_MAX_CHARS) };
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return invalid('Each item in "left" is { text, who }.');
  const { text, who, ask } = raw as Record<string, unknown>;
  if (typeof text !== 'string' || text.trim() === '') return invalid('Each item in "left" needs some text.');
  if (ask !== undefined && ask !== null && typeof ask !== 'string') return invalid('"ask" must be text.');
  const item: StatusItem = { text: text.trim().slice(0, STATUS_ITEM_MAX_CHARS) };
  const asked = typeof ask === 'string' && ask.trim() !== '' ? ask.trim().slice(0, STATUS_ASK_MAX_CHARS) : undefined;
  if (who === undefined || who === null) return item;
  if (!isWho(who)) return invalid('"who" must be "you", "me" or "parked".');
  return who === 'you' && asked !== undefined ? { ...item, who, ask: asked } : { ...item, who };
}

/** `set_chat_status` input, held to its limits. */
export function parseChatStatus(args: unknown): AgentStatus | Invalid {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) return invalid('Send { done, left }.');
  const { done, left } = args as Record<string, unknown>;
  if (typeof done !== 'boolean') return invalid('"done" must be true or false.');
  // Some providers send null for an optional field they leave unset.
  const list = left === undefined || left === null ? [] : left;
  if (!Array.isArray(list)) return invalid('"left" must be a list of items.');
  if (list.length > STATUS_MAX_ITEMS) return invalid(`"left" can have at most ${STATUS_MAX_ITEMS} items.`);
  const items: StatusItem[] = [];
  for (const raw of list) {
    const item = parseItem(raw);
    if ('invalid' in item) return item;
    items.push(item);
  }
  if (done && items.length > 0) return invalid('With done: true, leave "left" out: nothing is left.');
  if (!done && items.length === 0) return invalid('With done: false, list what is still left in "left".');
  return { done, left: items };
}

/** How many of these items wait on the user. */
export function waitingOnUser(items: readonly StatusItem[]): number {
  return items.filter((i) => i.who === 'you').length;
}

/** How each group of left items is headed, in the order they're shown; untagged items (older replies) come last. */
export const STATUS_GROUPS: ReadonlyArray<{ who: StatusWho | undefined; label: string }> = [
  { who: 'you', label: 'Waiting on you' },
  { who: 'me', label: 'Next from me' },
  { who: 'parked', label: 'Parked' },
  { who: undefined, label: 'Left' },
];

/** The left items grouped by who they wait on, in `STATUS_GROUPS` order, empty groups dropped. */
export function groupLeft(items: readonly StatusItem[]): Array<{ who: StatusWho | undefined; label: string; items: StatusItem[] }> {
  return STATUS_GROUPS.map((g) => ({ ...g, items: items.filter((i) => i.who === g.who) })).filter((g) => g.items.length > 0);
}

/**
 * What a new call must also have, beyond what `parseChatStatus` takes from stored replies: every item says who it
 * waits on, and every "you" item carries its `ask`, so a question the agent only put in its (hidden) thinking can't
 * pass as asked.
 */
function newCallProblem(status: AgentStatus): string | null {
  if (status.left.some((i) => i.who === undefined)) return 'Each item in "left" is { text, who }: say who it waits on.';
  const unasked = status.left.find((i) => i.who === 'you' && i.ask === undefined);
  if (unasked) {
    return `"${unasked.text}" waits on the user but has no "ask". Write the question or request out to them in full in "ask" ` +
      '(any command to run and where, the choice and what each answer leads to). They cannot see your thinking.';
  }
  return null;
}

/** `set_chat_status`: nothing to store or wait for; the row and the card read the call itself. */
export function runStatusCommand(args: unknown): string | ThreadToolError {
  const status = parseChatStatus(args);
  if ('invalid' in status) return inputError(status.invalid);
  const problem = newCallProblem(status);
  if (problem !== null) return inputError(problem);
  if (status.done) return 'Status set: done.';
  const yours = waitingOnUser(status.left);
  return `Status set: ${status.left.length} left${yours > 0 ? `, ${yours} waiting on the user` : ''}.`;
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
