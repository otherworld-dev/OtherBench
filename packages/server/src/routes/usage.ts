import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { buildUsageRollup } from '@grunt/core/domain/usage-rollup.js';
import type { CanonMessage } from '@grunt/core/types/messages.js';
import type { UsageRecord } from '@grunt/core/ports/store.js';
import type { Chat } from '@grunt/core/ports/store.js';
import type { Container } from '../container.js';
import { collectMessageTree } from './chats.js';

/**
 * `GET /api/usage` -- task 28's spend rollup. Scoped to one chat with
 * `?chatId=`, otherwise every chat in the store. Both are the exact same
 * `buildUsageRollup` (packages/core/src/domain/usage-rollup.ts) fed a wider
 * or narrower slice of `usage` rows + assistant messages: the per-chat
 * scoping the inspector's "session spend" section wants and the
 * per-profile/per-chat/date-bucketed breakdown the usage/pricing settings
 * view wants are the same computation, just over a different set of chats.
 *
 * There is no `UsageRepo.listAll()` on the `Store` port -- rather than grow
 * that port for one caller, the global case just loops `store.chats.list()`
 * and calls the existing chat-scoped `usage.list(chatId)` once per chat.
 * Fine at this app's scale (a local, single-user tool); revisit if the
 * per-chat query ever needs to stop being O(1) round trips.
 */
export function usageRoutes(container: Container): Hono {
  const app = new Hono();

  app.get('/', (c) => {
    const chatId = c.req.query('chatId');

    let chats: Chat[];
    if (chatId) {
      const chat = container.store.chats.get(chatId);
      if (!chat) throw new HTTPException(404, { message: `Chat "${chatId}" not found.` });
      chats = [chat];
    } else {
      chats = container.store.chats.list();
    }

    const chatTitles: Record<string, string> = {};
    const usageRows: UsageRecord[] = [];
    const assistantMessages: CanonMessage[] = [];
    for (const chat of chats) {
      chatTitles[chat.id] = chat.title;
      usageRows.push(...container.store.usage.list(chat.id));
      assistantMessages.push(...collectMessageTree(container.store, chat.id).filter((m) => m.role === 'assistant'));
    }

    return c.json(buildUsageRollup(usageRows, assistantMessages, chatTitles));
  });

  return app;
}
