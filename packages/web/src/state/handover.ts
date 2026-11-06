import { isHandoverRequest } from '@otherbench/core/domain/handover.js';
import { isCompareSet } from '@otherbench/core/domain/tree.js';
import type { CanonMessage } from '@otherbench/core/types/messages.js';

/**
 * Chats this window asked to hand over (spec 2026-11-06-fresh-chat-handover-design): when
 * `chat-handed-over` comes for one, this window opens the new chat; every other window says so.
 */
export const pendingHandovers = new Set<string>();

/**
 * The reply the fresh chat card under `message` hands over, or null for no card: a finished
 * Claude Code reply with nothing after it, or a handover summary that failed or was stopped (then
 * the reply it was asked of, so the card comes back). Never a summary that finished.
 */
export function handoverTarget(message: CanonMessage, pool: Record<string, CanonMessage>): string | null {
  if (message.role !== 'assistant' || message.status === 'streaming') return null;
  const all = Object.values(pool);
  if (all.some((m) => m.parentId === message.id)) return null;
  // A compare turn's reply: the server refuses those.
  if (message.parentId !== null && isCompareSet(all.filter((m) => m.parentId === message.parentId))) return null;
  const parent = message.parentId !== null ? pool[message.parentId] : undefined;
  if (parent && isHandoverRequest(parent)) {
    return message.status === 'complete' ? null : parent.parentId;
  }
  return message.status === 'complete' && message.engineMeta?.engine === 'claude_code' ? message.id : null;
}
