import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { ChatSendService } from '../chat-sends/service.js';
import type { Container } from '../container.js';

function serviceOf(container: Container): ChatSendService {
  if (!container.chatSends) throw new HTTPException(503, { message: 'Messaging between chats is not available.' });
  return container.chatSends;
}

/**
 * Chats that message each other (spec 2026-11-06-chat-to-chat-design): what the send card and the
 * "waiting on chats" status read, and the card's Stop.
 */
export function chatSendsRoutes(container: Container): Hono {
  const app = new Hono();

  app.get('/chats/:id/sends', (c) => {
    const id = c.req.param('id');
    if (!container.store.chats.get(id)) throw new HTTPException(404, { message: `Chat "${id}" not found.` });
    return c.json({ sends: serviceOf(container).sendsOf(id) });
  });

  app.get('/chat-sends/waiting', (c) => c.json({ chatIds: serviceOf(container).waitingChatIds() }));

  app.post('/chat-sends/:messageId/stop', (c) => {
    const id = c.req.param('messageId');
    if (!container.store.messages.get(id)) throw new HTTPException(404, { message: `Message "${id}" not found.` });
    const service = serviceOf(container);
    service.stop(id);
    return c.json({ sends: container.store.chatSends.byFromMessage(id) });
  });

  return app;
}
