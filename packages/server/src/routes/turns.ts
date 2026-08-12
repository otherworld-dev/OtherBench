import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { Part } from '@grunt/core/types/messages.js';
import type { Container } from '../container.js';
import { resolveProfile } from '../profile-resolution.js';
import { sseStream } from '../stream/sse.js';
import { requireNonEmptyString } from '../validation.js';

interface TurnBody {
  parentId?: unknown;
  parts?: unknown;
  profileIds?: unknown;
}

interface HeadBody {
  messageId?: unknown;
}

function parseParts(value: unknown): Part[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new HTTPException(400, { message: '"parts" must be a non-empty array.' });
  }
  // Trusting the element shape rather than re-deriving a bespoke Part schema
  // here, consistent with parseParams()/parseToolPolicy() in routes/profiles.ts.
  return value as Part[];
}

function parseProfileIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0 || !value.every((v) => typeof v === 'string' && v.length > 0)) {
    throw new HTTPException(400, { message: '"profileIds" must be a non-empty array of non-empty strings.' });
  }
  return value as string[];
}

function parseParentId(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  return requireNonEmptyString(value, 'parentId');
}

function getChatOrThrow(container: Container, chatId: string) {
  const chat = container.store.chats.get(chatId);
  if (!chat) throw new HTTPException(404, { message: `Chat "${chatId}" not found.` });
  return chat;
}

export function turnsRoutes(container: Container): Hono {
  const app = new Hono();

  app.post('/chats/:id/turns', async (c) => {
    const chatId = c.req.param('id');
    getChatOrThrow(container, chatId);

    const body = (await c.req.json().catch(() => ({}))) as TurnBody;
    const parentId = parseParentId(body.parentId);
    const parts = parseParts(body.parts);
    const profileIds = parseProfileIds(body.profileIds);

    const profiles = await Promise.all(profileIds.map((id) => resolveProfile(container, id)));

    const result = await container.turnRunner.run({ chatId, parentId, userParts: parts, profiles });
    // Seeds the registry's buffers *before* any client can subscribe, so a
    // `GET /stream` racing this response never sees "unknown message" --
    // see the StreamRegistry class doc for why this ordering matters.
    container.streamRegistry.registerTurn(chatId, result.assistantMessageIds);

    return c.json(result, 202);
  });

  app.post('/messages/:id/cancel', (c) => {
    const messageId = c.req.param('id');
    const message = container.store.messages.get(messageId);
    if (!message) throw new HTTPException(404, { message: `Message "${messageId}" not found.` });

    container.turnRunner.cancel(messageId);
    return c.body(null, 204);
  });

  app.post('/chats/:id/head', async (c) => {
    const chatId = c.req.param('id');
    getChatOrThrow(container, chatId);

    const body = (await c.req.json().catch(() => ({}))) as HeadBody;
    const messageId = requireNonEmptyString(body.messageId, 'messageId');

    const message = container.store.messages.get(messageId);
    if (!message || message.chatId !== chatId) {
      throw new HTTPException(400, { message: `Message "${messageId}" does not belong to chat "${chatId}".` });
    }

    const updated = container.store.chats.update(chatId, { headMessageId: messageId });
    return c.json(updated);
  });

  app.get('/chats/:id/stream', (c) => {
    const chatId = c.req.param('id');
    getChatOrThrow(container, chatId);

    return sseStream((sink) => {
      // Subscribe *before* reading the snapshot, and do both synchronously
      // with no `await` between them: this is what guarantees the replay
      // (the snapshot) and the live feed (everything the subscription
      // delivers from here on) partition every event with no gap and no
      // duplicate -- see the StreamRegistry class doc.
      const unsubscribe = container.streamRegistry.subscribe(chatId, (event) => {
        sink.send(null, event);
      });
      const snapshot = container.streamRegistry.snapshot(chatId);
      sink.send('hello', {
        inFlight: snapshot.map((b) => ({ messageId: b.messageId, status: b.status, events: b.events })),
      });
      return unsubscribe;
    });
  });

  return app;
}
