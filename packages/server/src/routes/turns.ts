import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { InvalidAttachmentReferenceError } from '@grunt/core/domain/turn.js';
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

    let result;
    try {
      result = await container.turnRunner.run({ chatId, parentId, userParts: parts, profiles });
    } catch (err) {
      // A part naming an attachment that doesn't exist, or belongs to a
      // DIFFERENT chat, is a client-supplied bad reference -- 400, not the
      // 500 an uncaught throw here would otherwise become. See
      // InvalidAttachmentReferenceError's doc (domain/turn.ts).
      if (err instanceof InvalidAttachmentReferenceError) {
        throw new HTTPException(400, { message: err.message });
      }
      throw err;
    }
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

  // Task 27: per-tab "Retry" on a failed compare variant. Re-runs the SAME
  // message row in place (TurnRunner.retry) rather than posting a new turn,
  // so the retried reply stays the same tab/sibling instead of spawning a
  // duplicate user message. Fire-and-forget, same shape as POST .../turns:
  // the 202 response confirms the retry was accepted, not that it finished.
  app.post('/messages/:id/retry', async (c) => {
    const messageId = c.req.param('id');
    const message = container.store.messages.get(messageId);
    if (!message) throw new HTTPException(404, { message: `Message "${messageId}" not found.` });
    if (message.role !== 'assistant' || !message.producedBy) {
      throw new HTTPException(400, { message: `Message "${messageId}" is not a retryable assistant variant.` });
    }
    // 'error' is the only retryable status -- see TurnRunner.retry's doc for
    // why 'complete' (would silently discard a real answer and double-write
    // its usage row -- the defect this guard closes) and 'cancelled' (would
    // leave a stale zeroed usage row misattributed once the retry finishes)
    // are deliberately excluded too, not just 'streaming'. This route is
    // only one caller of `TurnRunner.retry`, which enforces the same
    // invariant itself; the check is duplicated here so the client gets a
    // clean HTTP error without ever reaching the domain layer.
    if (message.status !== 'error') {
      throw new HTTPException(409, {
        message: `Message "${messageId}" is ${message.status}; only an errored message can be retried.`,
      });
    }

    const profile = await resolveProfile(container, message.producedBy.profileId);
    // Reset the SSE buffer *before* kicking off the retry -- same
    // before-any-event-can-arrive ordering `registerTurn` relies on for a
    // fresh turn (see StreamRegistry.resetBuffer's doc).
    container.streamRegistry.resetBuffer(message.chatId, messageId);
    void container.turnRunner.retry(message.chatId, messageId, profile).catch((err: unknown) => {
      console.error(`[grunt-server] retry ${messageId} failed outside its own error handling:`, err);
    });

    return c.json({ messageId }, 202);
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
