import type { CanonMessage } from '@otherbench/core/types/messages.js';

/**
 * What Up in the message box steps through: the user's own messages on the
 * branch that ends at `tailId`, newest first. Only their text comes back;
 * messages with none are skipped, and a message the same as the newer one
 * next to it is listed once.
 */
export function promptHistory(messages: Readonly<Record<string, CanonMessage>>, tailId: string | null): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (let id = tailId; id !== null && !seen.has(id); ) {
    seen.add(id);
    const message = messages[id];
    if (!message) break;
    if (message.role === 'user') {
      const text = message.parts.flatMap((p) => (p.type === 'text' ? [p.text] : [])).join('\n');
      if (text.trim() && out.at(-1) !== text) out.push(text);
    }
    id = message.parentId;
  }
  return out;
}
