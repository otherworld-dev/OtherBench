import { randomUUID } from 'node:crypto';
import type { Store } from '@otherbench/core/ports/store.js';
import { recordUsage, type UsageWrite } from '@otherbench/core/domain/usage-record.js';

/**
 * Records what a call OtherBench made by itself (a chat's title, a memory
 * update) used, against the reply it was about, so it counts in the usage
 * report. Never throws: the chat may have been deleted while the call ran,
 * and a missing row must never fail the call itself.
 */
export function recordBackgroundUsage(store: Pick<Store, 'models' | 'usage'>, w: Omit<UsageWrite, 'id' | 'purpose'> & { purpose: NonNullable<UsageWrite['purpose']> }): void {
  try {
    recordUsage(store, { ...w, id: randomUUID() });
  } catch (err) {
    console.warn(`[otherbench] could not record the ${w.purpose} call's usage for chat ${w.chatId}:`, err instanceof Error ? err.message : err);
  }
}
