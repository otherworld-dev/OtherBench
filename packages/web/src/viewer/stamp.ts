import { useGruntStore } from '../state/store.js';

/**
 * Changes whenever a reply in the chat may have made or changed an artifact
 * (Deck #896): a new head (a branch switch), a new message, a new part on
 * any of the chat's messages, or one finishing. Artifact views and lists
 * reload on it, so a change made mid-reply shows without waiting for the
 * next message. Every message counts, not just the head: an ordinary send
 * leaves the head on your message while the reply streams under it, and a
 * compare turn streams several replies at once.
 */
export function useArtifactsStamp(chatId: string): string {
  return useGruntStore((s) => {
    const head = s.chats.find((c) => c.id === chatId)?.headMessageId ?? '';
    let messages = 0;
    let parts = 0;
    let done = 0;
    for (const m of Object.values(s.messages)) {
      if (m.chatId !== chatId) continue;
      messages += 1;
      parts += m.parts.length;
      if (m.status !== 'streaming') done += 1;
    }
    return `${head}:${messages}:${parts}:${done}`;
  });
}
