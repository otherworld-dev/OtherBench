import { Hono, type Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { ChatSendService } from '../chat-sends/service.js';
import type { Container } from '../container.js';

function serviceOf(container: Container): ChatSendService {
  if (!container.chatSends) throw new HTTPException(503, { message: 'Messaging between chats is not available.' });
  return container.chatSends;
}

/**
 * Chats that message each other (spec 2026-11-06-chat-to-chat-design): what the send card and the
 * "waiting on chats" status read, and the card's Stop. Across machines (spec
 * 2026-11-13-chat-sends-across-machines-design), the card also says which machine each send went to, and a send held
 * for a machine that is off can be sent from here (Run here), left to go when the machine is back (Wait) or cancelled.
 * The chat-scoped routes are forwarded to the machine the chat runs on (peer/forward.ts), so the card works from
 * either machine.
 */
export function chatSendsRoutes(container: Container): Hono {
  const app = new Hono();

  const chatOf = (c: Context): string => {
    const id = c.req.param('id')!;
    if (!container.store.chats.get(id)) throw new HTTPException(404, { message: `Chat "${id}" not found.` });
    return id;
  };

  /** The send `sendId` of chat `id`'s card: one it sent. */
  const sendOf = (c: Context): string => {
    const chatId = chatOf(c);
    const sendId = c.req.param('sendId')!;
    if (container.store.chatSends.get(sendId)?.fromChatId !== chatId) throw new HTTPException(404, { message: `This chat sent no message "${sendId}".` });
    return sendId;
  };

  app.get('/chats/:id/sends', (c) => c.json({ sends: serviceOf(container).views(chatOf(c)) }));

  app.get('/chat-sends/waiting', (c) => {
    const service = serviceOf(container);
    return c.json({ chatIds: service.waitingChatIds(), heldChatIds: service.heldChatIds() });
  });

  app.post('/chat-sends/:messageId/stop', (c) => {
    const id = c.req.param('messageId');
    if (!container.store.messages.get(id)) throw new HTTPException(404, { message: `Message "${id}" not found.` });
    const service = serviceOf(container);
    service.stop(id);
    return c.json({ sends: container.store.chatSends.byFromMessage(id) });
  });

  // The card's Stop, scoped to its chat so it can be forwarded to the machine the chat runs on.
  app.post('/chats/:id/sends/stop', async (c) => {
    const chatId = chatOf(c);
    const body = (await c.req.json().catch(() => ({}))) as { fromMessageId?: unknown };
    if (typeof body.fromMessageId !== 'string' || body.fromMessageId === '') throw new HTTPException(400, { message: '"fromMessageId" is required.' });
    const message = container.store.messages.get(body.fromMessageId);
    if (!message || message.chatId !== chatId) throw new HTTPException(404, { message: `Message "${body.fromMessageId}" not found in this chat.` });
    const service = serviceOf(container);
    service.stop(message.id);
    return c.json({ sends: service.views(chatId) });
  });

  app.post('/chats/:id/sends/:sendId/wait', (c) => {
    const sendId = sendOf(c);
    const service = serviceOf(container);
    if (!service.wait(sendId)) return c.json({ error: "That message isn't waiting for another machine." }, 409);
    return c.json({ sends: service.views(c.req.param('id')) });
  });

  app.post('/chats/:id/sends/:sendId/cancel', (c) => {
    const sendId = sendOf(c);
    const service = serviceOf(container);
    if (!service.cancel(sendId)) return c.json({ error: "That message isn't waiting for another machine." }, 409);
    return c.json({ sends: service.views(c.req.param('id')) });
  });

  app.post('/chats/:id/sends/:sendId/run-here', async (c) => {
    const sendId = sendOf(c);
    const service = serviceOf(container);
    const result = await service.runHere(sendId);
    if ('refused' in result) return c.json({ error: result.refused }, 409);
    return c.json({ sends: service.views(c.req.param('id')) });
  });

  return app;
}
