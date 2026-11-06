import type { AppSettings, Chat } from '../ports/store.js';
import type { CanonMessage } from '../types/messages.js';

/**
 * Handing a big Claude Code chat over to a fresh one (spec
 * 2026-11-06-fresh-chat-handover-design): when the chat's latest reply read
 * more context per call than the threshold, a card offers a fresh chat that
 * starts from a summary the old chat's own session writes.
 */

/** What the old chat's session is asked for. It answers with no tools (the engine refuses every call). */
export const HANDOVER_PROMPT =
  'This conversation is moving to a fresh chat that will see only what you write now, not this history. Write a self-contained handover summary for whoever picks it up, covering: the goal; what has been decided and what was ruled out, with reasons; the current state of the work; the files, paths and artifacts that matter, by exact path or name; open questions; and the next steps in order. Use headings and keep it as short as it can be while losing nothing the next chat needs. Don\'t use any tools: write from what you already know.';

/** Every tool call in a handover summary is refused with this. */
export const HANDOVER_NO_TOOLS = 'No tools during a handover summary. Write it from what you already know.';

/** A handover with no Claude Code session to write the summary. */
export const NOTHING_TO_HAND_OVER = "There's no Claude Code session here to hand over. Send a message first.";

/** Refused when a handover's summary is regenerated. */
export const HANDOVER_NO_REGENERATE = "A handover can't be retried in place. Use Start fresh chat again.";

export const DEFAULT_HANDOVER_THRESHOLD = 300_000;

/** The context size per call from which the card shows for this chat: its own after "Not now", else the setting. */
export function handoverThreshold(chat: Pick<Chat, 'handoverAskAt'>, settings: Pick<AppSettings, 'handoverThresholdTokens'>): number {
  return chat.handoverAskAt ?? settings.handoverThresholdTokens;
}

/** Whether the fresh chat card shows for this chat now. */
export function suggestsHandover(
  chat: Pick<Chat, 'contextTokens' | 'handoverAskAt' | 'handoverSuggest'>,
  settings: Pick<AppSettings, 'handoverEnabled' | 'handoverThresholdTokens'>
): boolean {
  if (!settings.handoverEnabled || chat.handoverSuggest === false) return false;
  const tokens = chat.contextTokens;
  return typeof tokens === 'number' && tokens >= handoverThreshold(chat, settings);
}

/** Where "Not now" puts the chat's next ask: half as much again. */
export function nextAskAt(contextTokens: number): number {
  return Math.round(contextTokens * 1.5);
}

/** The new chat's title: "Rig (continued)", then "Rig (continued 2)" for a chat handed over again. */
export function continuedTitle(title: string): string {
  const m = /^(.*) \(continued(?: (\d+))?\)$/.exec(title);
  if (!m) return `${title} (continued)`;
  return `${m[1]} (continued ${m[2] ? Number(m[2]) + 1 : 2})`;
}

/** Whether `m` is the user message asking for a handover summary. */
export function isHandoverRequest(m: CanonMessage): boolean {
  return m.role === 'user' && m.parts.some((p) => p.type === 'handover-request');
}

/** A summary reply's text, its tool calls left out. */
export function summaryOf(m: CanonMessage): string {
  return m.parts
    .flatMap((p) => (p.type === 'text' ? [p.text.trim()] : []))
    .filter((t) => t.length > 0)
    .join('\n\n');
}
