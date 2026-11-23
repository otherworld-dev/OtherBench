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
export const STATUS_MAX_OPTIONS = 4;
export const STATUS_OPTION_MAX_CHARS = 40;

export const SUBAGENT_STATUS_REFUSAL = "A helper can't set the chat's status; the main agent does that.";

export const STATUS_TOOL_DESCRIPTION =
  "Tell the user whether this chat's work is finished. Call it in any turn in which work was done or agreed, once that work is finished and before your final message. " +
  'The user sees everything you write in the turn, before and after the call, so never write your reply out again after it. ' +
  'Set done: true only when everything you and the user agreed to do in this chat is finished. Otherwise set done: false and list what is still left, one short line each, ' +
  "including things that were discussed and parked for later. This is about the whole conversation, not the current task's steps (that's the checklist). " +
  'Give each item a "who": "you" when it waits on the user (something they must do, check, decide or answer before it can move), ' +
  '"me" when you will do it yourself once the user says carry on, "parked" when it was agreed to leave it for later. ' +
  'Every "you" item also needs "ask": the question or request itself, written to the user in full. ' +
  'Put in it everything they need to act without scrolling back: the exact command to run and where, the choice and what each answer leads to, what to send back. ' +
  'The user cannot see your thinking, so a question you only worked out there has not been asked. ' +
  'The user sees the items in a box under your reply, one line each, and opens an item to read its ask. So keep "text" to a short title, ' +
  "and don't write the same instructions out in your reply as well: say there in a line what is waiting and leave the detail to the ask. " +
  'Give a "you" item a "when": "now" if the user can act on it right away, "optional" if they can skip it and nothing is held up, ' +
  '"later" if they cannot act until something else has happened (say what in the text). Only "now" items count as waiting on them, so mark as "now" only what is. ' +
  'A "you" item with no "options" is a task, and the user ticks it when it is done. For a question with a few set answers, give them as "options" (short labels such as "Yes" and "No"), ' +
  'and the user answers with a click. Their ticks and answers come back to you as their next message. ' +
  'Call it again every turn: a new reply starts with no status.';

/** Who a left item waits on: the user, the agent, or nobody yet (parked). */
export const STATUS_WHO = ['you', 'me', 'parked'] as const;
export type StatusWho = (typeof STATUS_WHO)[number];

/** When a "you" item can be acted on: right away, only if the user wants to, or not until something else has happened. */
export const STATUS_WHEN = ['now', 'optional', 'later'] as const;
export type StatusWhen = (typeof STATUS_WHEN)[number];

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
          when: {
            type: 'string',
            enum: [...STATUS_WHEN],
            description: 'On a "you" item: "now" (the default) they can act on it right away; "optional" they can skip it; "later" it cannot be done until something else happens first.',
          },
          options: {
            type: 'array',
            minItems: 2,
            maxItems: STATUS_MAX_OPTIONS,
            items: { type: 'string', maxLength: STATUS_OPTION_MAX_CHARS },
            description: 'On a "you" item that is a question with set answers: the answers as short labels, shown as buttons. Leave it out for a task, which gets a tick box.',
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
 * request for a "you" item, on replies saved before items carried one. `when` and `options` are a "you" item's only:
 * no `when` means now, and no `options` means a task to tick rather than a question to answer.
 */
export interface StatusItem {
  text: string;
  who?: StatusWho;
  ask?: string;
  when?: StatusWhen;
  options?: string[];
}

/** What the agent last said about the chat's work. */
export interface AgentStatus {
  done: boolean;
  left: StatusItem[];
}

const invalid = (reason: string): Invalid => ({ invalid: reason });

const isWho = (v: unknown): v is StatusWho => typeof v === 'string' && (STATUS_WHO as readonly string[]).includes(v);
const isWhen = (v: unknown): v is StatusWhen => typeof v === 'string' && (STATUS_WHEN as readonly string[]).includes(v);

/** A question's answers: 2 to 4 short labels, trimmed, no two the same. Nothing given is no options. */
function parseOptions(raw: unknown): string[] | undefined | Invalid {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw) || raw.some((o) => typeof o !== 'string' || o.trim() === '')) return invalid('"options" must be a list of short answers.');
  if (raw.length === 0) return undefined;
  const labels = [...new Set((raw as string[]).map((o) => o.trim().slice(0, STATUS_OPTION_MAX_CHARS)))];
  if (labels.length < 2 || labels.length > STATUS_MAX_OPTIONS) return invalid(`"options" takes 2 to ${STATUS_MAX_OPTIONS} different answers; leave it out for a task.`);
  return labels;
}

/** One `left` entry: `{ text, who }`, or a plain line as replies saved before items said who. */
function parseItem(raw: unknown): StatusItem | Invalid {
  if (typeof raw === 'string') {
    return raw.trim() === '' ? invalid('Each item in "left" needs some text.') : { text: raw.trim().slice(0, STATUS_ITEM_MAX_CHARS) };
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return invalid('Each item in "left" is { text, who }.');
  const { text, who, ask, when, options } = raw as Record<string, unknown>;
  if (typeof text !== 'string' || text.trim() === '') return invalid('Each item in "left" needs some text.');
  if (ask !== undefined && ask !== null && typeof ask !== 'string') return invalid('"ask" must be text.');
  const item: StatusItem = { text: text.trim().slice(0, STATUS_ITEM_MAX_CHARS) };
  const asked = typeof ask === 'string' && ask.trim() !== '' ? ask.trim().slice(0, STATUS_ASK_MAX_CHARS) : undefined;
  if (who === undefined || who === null) return item;
  if (!isWho(who)) return invalid('"who" must be "you", "me" or "parked".');
  if (when !== undefined && when !== null && !isWhen(when)) return invalid('"when" must be "now", "optional" or "later".');
  const answers = parseOptions(options);
  if (answers !== undefined && !Array.isArray(answers)) return answers;
  if (who !== 'you') return { ...item, who };
  return {
    ...item,
    who,
    ...(asked !== undefined ? { ask: asked } : {}),
    // "now" is what no `when` means, so it isn't kept.
    ...(isWhen(when) && when !== 'now' ? { when } : {}),
    ...(answers !== undefined ? { options: answers } : {}),
  };
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

/** Which group a left item is shown in. */
export type StatusGroupKey = 'now' | 'optional' | 'later' | 'me' | 'parked' | 'untagged';

export function statusGroupOf(item: StatusItem): StatusGroupKey {
  if (item.who === undefined) return 'untagged';
  if (item.who !== 'you') return item.who;
  return item.when ?? 'now';
}

/** How many of these items the user can act on now: the ones that hold the chat up until they do. */
export function waitingOnUser(items: readonly StatusItem[]): number {
  return items.filter((i) => statusGroupOf(i) === 'now').length;
}

/**
 * How each group of left items is headed, in the order they're shown; untagged items (older replies) come last.
 * `needsUser` marks the groups the user can do something about from the card: a tick or an answer.
 */
export const STATUS_GROUPS: ReadonlyArray<{ key: StatusGroupKey; label: string; needsUser: boolean }> = [
  { key: 'now', label: 'Needs you now', needsUser: true },
  { key: 'optional', label: 'Optional', needsUser: true },
  { key: 'later', label: 'For you later', needsUser: false },
  { key: 'me', label: 'Next from me', needsUser: false },
  { key: 'parked', label: 'Parked', needsUser: false },
  { key: 'untagged', label: 'Left', needsUser: false },
];

export interface StatusGroup {
  key: StatusGroupKey;
  label: string;
  needsUser: boolean;
  items: StatusItem[];
}

/** The left items in their groups, in `STATUS_GROUPS` order, empty groups dropped. */
export function groupLeft(items: readonly StatusItem[]): StatusGroup[] {
  return STATUS_GROUPS.map((g) => ({ ...g, items: items.filter((i) => statusGroupOf(i) === g.key) })).filter((g) => g.items.length > 0);
}

/** What the user did about one item on the card: ticked a task as done, or picked one of a question's answers. */
export type StatusAnswer = { done: true } | { option: string };

/**
 * The user's ticks and answers as the message they send back, one line per item in the card's order; '' when there
 * are none. `answers` is keyed by the item's index in `items`.
 */
export function statusReplyText(items: readonly StatusItem[], answers: Readonly<Record<number, StatusAnswer>>): string {
  return items
    .flatMap((item, i) => {
      const answer = answers[i];
      if (answer === undefined) return [];
      return ['done' in answer ? `Done: ${item.text}` : `${item.text}: ${answer.option}`];
    })
    .join('\n');
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

/**
 * Ends every successful result. Claude Code tells the model to end a turn with text, so a model that wrote its reply
 * before the call wrote the whole reply again after it (2026-11-20, ~1 call in 15); the UI hides the call, so the two
 * copies showed back to back. The model reads this right before deciding what to write next.
 */
export const STATUS_SET_NOTE =
  "Everything you already wrote this turn is on the user's screen: don't repeat it. If your reply is written, end the turn here.";

/** `set_chat_status`: nothing to store or wait for; the row and the card read the call itself. */
export function runStatusCommand(args: unknown): string | ThreadToolError {
  const status = parseChatStatus(args);
  if ('invalid' in status) return inputError(status.invalid);
  const problem = newCallProblem(status);
  if (problem !== null) return inputError(problem);
  if (status.done) return `Status set: done. ${STATUS_SET_NOTE}`;
  const yours = waitingOnUser(status.left);
  return `Status set: ${status.left.length} left${yours > 0 ? `, ${yours} waiting on the user now` : ''}. ${STATUS_SET_NOTE}`;
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
