import type { Chat, ProjectMemory } from '@otherbench/core/ports/store.js';
import { formatRelativeTime } from './relativeTime.js';

/** Who last changed a project's memory and when, as the Inspector and the project page say it. */
export function memoryUpdatedLine(memory: ProjectMemory, chats: readonly Pick<Chat, 'id' | 'title'>[], now: number = Date.now()): string {
  if (memory.updatedAt === 0) return 'Not saved yet';
  const when = formatRelativeTime(memory.updatedAt, now);
  if (memory.updatedBy === 'user') return `Updated ${when} by you`;
  const source = memory.sourceChatId === null ? 'a chat' : (chats.find((c) => c.id === memory.sourceChatId)?.title ?? 'a deleted chat');
  return `Updated ${when} from ${source}`;
}
