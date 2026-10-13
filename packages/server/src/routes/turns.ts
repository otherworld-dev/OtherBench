import { Hono, type Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { isCompareSet } from '@grunt/core/domain/tree.js';
import { InvalidAttachmentReferenceError, RegenerateError, workspaceUnresolvedMessage } from '@grunt/core/domain/turn.js';
import type { Part } from '@grunt/core/types/messages.js';
import type { Container } from '../container.js';
import { appDefaultProfileId, resolveProfile } from '../profile-resolution.js';
import { sseStream, STREAM_KEEPALIVE_MS } from '../stream/sse.js';
import { requireNonEmptyString } from '../validation.js';
import { chatView, workspaceResolver } from '../workspace-view.js';

interface TurnBody {
  parentId?: unknown;
  parts?: unknown;
  profileIds?: unknown;
}

interface RegenerateBody {
  messageId?: unknown;
  profileId?: unknown;
}

interface HeadBody {
  messageId?: unknown;
}

const KNOWN_PART_TYPES = new Set(['text', 'reasoning', 'image', 'file', 'tool-call', 'tool-result', 'notice']);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/**
 * Validates one element of `parts` against `Part`'s actual shape (task 32
 * fix round 2, Minor #1): before this, a malformed part -- most
 * concretely, an `image`/`file` part with `attachmentId` missing entirely
 * or given as an object -- sailed straight through `parseParts` untouched
 * ("trust the element shape") and only failed once `TurnRunner.run` handed
 * it to `store.attachments.get(id)`, where SQLite's own parameter binding
 * rejects a non-string/number/null value with a generic driver error --
 * an opaque 500, not a 400 naming what was actually wrong with the request.
 */
function assertValidPart(part: unknown, index: number): void {
  const where = `"parts[${index}]"`;
  if (!isPlainObject(part) || typeof part['type'] !== 'string' || !KNOWN_PART_TYPES.has(part['type'])) {
    throw new HTTPException(400, { message: `${where} must be an object with a recognised "type".` });
  }
  switch (part['type']) {
    case 'text':
    case 'reasoning':
    case 'notice':
      if (typeof part['text'] !== 'string') {
        throw new HTTPException(400, { message: `${where}.text must be a string.` });
      }
      break;
    case 'image':
      if (!isNonEmptyString(part['attachmentId'])) {
        throw new HTTPException(400, { message: `${where}.attachmentId must be a non-empty string.` });
      }
      if (typeof part['mime'] !== 'string') {
        throw new HTTPException(400, { message: `${where}.mime must be a string.` });
      }
      break;
    case 'file':
      if (!isNonEmptyString(part['attachmentId'])) {
        throw new HTTPException(400, { message: `${where}.attachmentId must be a non-empty string.` });
      }
      if (typeof part['mime'] !== 'string' || typeof part['filename'] !== 'string') {
        throw new HTTPException(400, { message: `${where}.mime and .filename must be strings.` });
      }
      break;
    case 'tool-call':
      if (typeof part['id'] !== 'string' || typeof part['name'] !== 'string') {
        throw new HTTPException(400, { message: `${where}.id and .name must be strings.` });
      }
      break;
    case 'tool-result':
      if (typeof part['id'] !== 'string' || typeof part['name'] !== 'string' || typeof part['isError'] !== 'boolean') {
        throw new HTTPException(400, { message: `${where}.id, .name must be strings and .isError a boolean.` });
      }
      break;
  }
}

function parseParts(value: unknown): Part[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new HTTPException(400, { message: '"parts" must be a non-empty array.' });
  }
  value.forEach((part, index) => assertValidPart(part, index));
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

/**
 * A 409 when the chat's folder doesn't resolve on this machine, before any
 * row is written (v2 spec §6): the UI asks where the folder is instead. The
 * turn runner refuses too, for anything that reaches it some other way.
 */
function workspaceRefusal(container: Container, c: Context, chatId: string): Response | null {
  const chat = getChatOrThrow(container, chatId);
  const status = workspaceResolver(container)(chat.workspace);
  if (status.status !== 'unresolved') return null;
  return c.json({ error: workspaceUnresolvedMessage(status), kind: 'workspace_unresolved', workspaceStatus: status }, 409);
}

export function turnsRoutes(container: Container): Hono {
  const app = new Hono();

  app.post('/chats/:id/turns', async (c) => {
    const chatId = c.req.param('id');
    const refusal = workspaceRefusal(container, c, chatId);
    if (refusal) return refusal;

    const body = (await c.req.json().catch(() => ({}))) as TurnBody;
    const parentId = parseParentId(body.parentId);
    const parts = parseParts(body.parts);
    const profileIds = parseProfileIds(body.profileIds);

    const profiles = await Promise.all(profileIds.map((id) => resolveProfile(container, id)));

    // The chat isn't quiet any more (project memory, spec §2). Before run(), so a fast reply's new timer is never cancelled.
    container.memory?.noteTurnStarted(chatId);
    let result;
    try {
      result = await container.turnRunner.run({ chatId, parentId, userParts: parts, profiles });
    } catch (err) {
      // Nothing started, so the chat is quiet again: re-arm its memory timer.
      container.memory?.noteTurnCompleted(chatId);
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
    // The head goes to the new user message (what every client does next
    // anyway) in the same update that marks the chat active, so the
    // chat-updated event this sends never carries a stale head that would
    // undo a client's own move (Task 34).
    container.store.chats.update(chatId, { headMessageId: result.userMessageId, updatedAt: Date.now() });
    container.events?.emit({ type: 'turn-started', chatId, messageIds: result.assistantMessageIds });

    return c.json(result, 202);
  });

  app.post('/messages/:id/cancel', (c) => {
    const messageId = c.req.param('id');
    const message = container.store.messages.get(messageId);
    if (!message) throw new HTTPException(404, { message: `Message "${messageId}" not found.` });

    // Before the turn winds down: a computer-use start of this chat that has not reached the desktop app yet
    // (it waits on an earlier end) is given up now, so no native dialog comes up for a reply that was stopped.
    container.computer?.replyStopping(message.chatId);
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
    // A reply cut off when the machine writing it went away is that machine's
    // (forward.ts keepCutOffReply), and it may still be writing it: rewriting
    // it here would have two machines writing one message. A new reply beside
    // it (regenerate) is this machine's own.
    if (message.error?.kind === 'peer_unreachable') {
      throw new HTTPException(409, { message: `Message "${messageId}" was cut off on another machine; regenerate it instead.` });
    }
    const refusal = workspaceRefusal(container, c, message.chatId);
    if (refusal) return refusal;

    const profile = await resolveProfile(container, message.producedBy.profileId);
    // Reset the SSE buffer *before* kicking off the retry -- same
    // before-any-event-can-arrive ordering `registerTurn` relies on for a
    // fresh turn (see StreamRegistry.resetBuffer's doc).
    container.memory?.noteTurnStarted(message.chatId);
    container.streamRegistry.resetBuffer(message.chatId, messageId);
    container.store.chats.update(message.chatId, { updatedAt: Date.now() });
    container.events?.emit({ type: 'turn-started', chatId: message.chatId, messageIds: [messageId] });
    void container.turnRunner.retry(message.chatId, messageId, profile).catch((err: unknown) => {
      container.memory?.noteTurnCompleted(message.chatId);
      console.error(`[grunt-server] retry ${messageId} failed outside its own error handling:`, err);
    });

    return c.json({ messageId }, 202);
  });

  // Regenerate: one more assistant reply under the user message that
  // `messageId` answers, as a sibling of it (never a new user message). Uses
  // the profile that produced `messageId` unless `profileId` says otherwise,
  // makes the new reply the chat's head so it becomes the active branch, and
  // streams in the background like POST .../turns.
  app.post('/chats/:id/regenerate', async (c) => {
    const chatId = c.req.param('id');
    const refusal = workspaceRefusal(container, c, chatId);
    if (refusal) return refusal;

    const body = (await c.req.json().catch(() => ({}))) as RegenerateBody;
    const messageId = requireNonEmptyString(body.messageId, 'messageId');
    const message = container.store.messages.get(messageId);
    if (!message) throw new HTTPException(404, { message: `Message "${messageId}" not found.` });
    if (message.chatId !== chatId) {
      throw new HTTPException(400, { message: `Message "${messageId}" does not belong to chat "${chatId}".` });
    }
    if (message.role !== 'assistant') {
      throw new HTTPException(400, { message: `Message "${messageId}" is not an assistant reply; only a reply can be regenerated.` });
    }
    // With no profileId given, the reply's own profile, skipping one that has
    // since been archived: then the chat's profile, then the app default.
    const live = (id: string | null | undefined): string | null =>
      id && container.store.profiles.get(id)?.archivedAt === null ? id : null;
    const profileId =
      body.profileId === undefined || body.profileId === null
        ? live(message.producedBy?.profileId) ?? live(container.store.chats.get(chatId)?.profileId) ?? appDefaultProfileId(container.store)
        : requireNonEmptyString(body.profileId, 'profileId');
    if (!profileId) throw new HTTPException(400, { message: 'No profile to regenerate with; pass "profileId".' });
    const profile = await resolveProfile(container, profileId);

    container.memory?.noteTurnStarted(chatId);
    let result;
    try {
      result = await container.turnRunner.regenerate({ chatId, messageId, profile });
    } catch (err) {
      container.memory?.noteTurnCompleted(chatId);
      if (err instanceof RegenerateError) {
        const status = err.code === 'not_found' ? 404 : err.code === 'streaming' || err.code === 'compare' ? 409 : 400;
        throw new HTTPException(status, { message: err.message });
      }
      throw err;
    }
    container.streamRegistry.registerTurn(chatId, [result.assistantMessageId]);
    container.store.chats.update(chatId, { headMessageId: result.assistantMessageId, updatedAt: Date.now() });
    container.events?.emit({ type: 'turn-started', chatId, messageIds: [result.assistantMessageId] });

    return c.json(result, 202);
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

    // Moving the head onto a compare variant is keeping it. Record that on the
    // variant too, so the choice survives the head moving to another branch
    // and back (extendToTip follows the variant kept or continued last).
    if (message.role === 'assistant' && message.parentId && isCompareSet(container.store.messages.children(message.parentId))) {
      container.store.messages.markKept(messageId, Date.now());
    }

    const updated = container.store.chats.update(chatId, { headMessageId: messageId });
    return c.json(chatView(container, updated));
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
      // A reply can go quiet for minutes (thinking, an approval card): the
      // keepalive tells a machine relaying this stream that it's still alive.
      const keepalive = setInterval(() => sink.comment('keepalive'), container.streamTimings?.keepaliveMs ?? STREAM_KEEPALIVE_MS);
      return () => {
        clearInterval(keepalive);
        unsubscribe();
      };
    });
  });

  return app;
}
