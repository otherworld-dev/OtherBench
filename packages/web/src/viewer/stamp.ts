import { useGruntStore } from '../state/store.js';

/**
 * Changes whenever the reply a chat shows may have made or changed an
 * artifact (Deck #896): a new head, or a new part or status on the head
 * message, as a reply streams. Artifact views and lists reload on it, so a
 * change made mid-reply shows without waiting for the next message.
 */
export function useArtifactsStamp(chatId: string): string {
  return useGruntStore((s) => {
    const head = s.chats.find((c) => c.id === chatId)?.headMessageId ?? null;
    const message = head ? s.messages[head] : undefined;
    return `${head ?? ''}:${message?.status ?? ''}:${message?.parts.length ?? 0}`;
  });
}
