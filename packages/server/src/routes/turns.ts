import { Hono, type Context } from 'hono';
import { HelperStopError } from '@otherbench/core/ports/chat-engine.js';
import { HTTPException } from 'hono/http-exception';
import { isCompareSet } from '@otherbench/core/domain/tree.js';
import { InvalidAttachmentReferenceError, RegenerateError, workspaceUnresolvedMessage } from '@otherbench/core/domain/turn.js';
import { CLEAR_ON_ITS_OWN, contextLineOf, contextPart, NOTHING_TO_COMPACT, parseContextCommand, type ParsedCommand } from '@otherbench/core/domain/context-lines.js';
import type { Part } from '@otherbench/core/types/messages.js';
import type { ResolvedProfile } from '@otherbench/core/types/config.js';
import type { Container } from '../container.js';
import { writeClearLine } from '../context-commands.js';
import { appDefaultProfileId, resolveProfile } from '../profile-resolution.js';
import { sseStream, STREAM_KEEPALIVE_MS } from '../stream/sse.js';
import { startTurn } from '../turn-start.js';
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

// `context-summary` is never accepted from a client: only a compact reply writes one.
const KNOWN_PART_TYPES = new Set(['text', 'reasoning', 'image', 'file', 'tool-call', 'tool-result', 'notice', 'context']);

/** Refused when a /clear or /compact comes with an image or file. */
export const COMMAND_WITH_ATTACHMENTS = "A command can't carry attachments. Send /clear or /compact on its own.";

/** Refused when a /clear comes while a reply in the chat is still being written: closing its process would cut it off. */
export const CLEAR_MID_REPLY = 'Wait for the reply to finish, or stop it, before clearing.';

/** Refused when /clear (or /reset, /new) comes with more text after it in a Claude Code chat. */
export { CLEAR_ON_ITS_OWN };

/** Refused when a turn is sent while messages sent during the reply are still waiting to go out. */
export const NOTES_WAITING = 'Messages you sent are still waiting for this reply.';

/** Refused when a compact's reply is regenerated: it compacted a session that has moved on since. */
export const COMPACT_NO_REGENERATE = "A compact can't be retried in place. Send /compact again.";

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
    case 'context':
      if (part['kind'] !== 'clear' && part['kind'] !== 'compact') {
        throw new HTTPException(400, { message: `${where}.kind must be "clear" or "compact".` });
      }
      if (part['focus'] !== undefined && typeof part['focus'] !== 'string') {
        throw new HTTPException(400, { message: `${where}.focus must be a string.` });
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

export function parseProfileIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0 || !value.every((v) => typeof v === 'string' && v.length > 0)) {
    throw new HTTPException(400, { message: '"profileIds" must be a non-empty array of non-empty strings.' });
  }
  return value as string[];
}

function parseParentId(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  return requireNonEmptyString(value, 'parentId');
}

/**
 * The context command a turn's parts make (spec 2026-10-17-claude-slash-commands),
 * or null for an ordinary message. An explicit `context` part is one whatever
 * the profiles; typed `/clear` or `/compact` text is one only when a Claude Code
 * profile is answering, so an API chat can still say "/clear" to its model.
 */
export function contextCommandOf(parts: Part[], profiles: ResolvedProfile[]): ParsedCommand | null {
  for (const p of parts) {
    if (p.type === 'context') return p.kind === 'compact' ? { kind: 'compact', focus: p.focus?.trim() ?? '' } : { kind: 'clear' };
  }
  if (!profiles.some((p) => p.connection.kind === 'claude_code')) return null;
  const text = parts.flatMap((p) => (p.type === 'text' ? [p.text] : [])).join('\n');
  return parseContextCommand(text);
}

/**
 * The profile a /compact runs on: the one that wrote the Claude Code reply it
 * sits under, whatever was selected (its session is the one compacted). Null
 * when the message above isn't such a reply, or its profile can't be resolved.
 */
async function compactProfile(container: Container, chatId: string, parentId: string | null): Promise<ResolvedProfile | null> {
  const parent = parentId ? container.store.messages.get(parentId) : null;
  if (!parent || parent.chatId !== chatId || parent.role !== 'assistant' || parent.engineMeta?.engine !== 'claude_code' || !parent.producedBy) return null;
  try {
    return await resolveProfile(container, parent.producedBy.profileId);
  } catch {
    return null;
  }
}

export function getChatOrThrow(container: Container, chatId: string) {
  const chat = container.store.chats.get(chatId);
  if (!chat) throw new HTTPException(404, { message: `Chat "${chatId}" not found.` });
  return chat;
}

/**
 * A 409 when the chat's folder doesn't resolve on this machine, before any
 * row is written (v2 spec §6): the UI asks where the folder is instead. The
 * turn runner refuses too, for anything that reaches it some other way.
 */
export function workspaceRefusal(container: Container, c: Context, chatId: string): Response | null {
  const chat = getChatOrThrow(container, chatId);
  const status = workspaceResolver(container)(chat.workspace);
  if (status.status !== 'unresolved') return null;
  return c.json({ error: workspaceUnresolvedMessage(status), kind: 'workspace_unresolved', workspaceStatus: status }, 409);
}

/**
 * A 409 while messages sent during the chat's reply are still to go out:
 * they go first, as the next turn, so a turn, regenerate or retry now would
 * jump them.
 */
function notesWaiting(container: Container, c: Context, chatId: string): Response | null {
  return container.notes?.hasWaiting(chatId) ? c.json({ kind: 'notes-waiting', error: NOTES_WAITING }, 409) : null;
}

export function turnsRoutes(container: Container): Hono {
  const app = new Hono();

  app.post('/chats/:id/turns', async (c) => {
    const chatId = c.req.param('id');
    const refusal = workspaceRefusal(container, c, chatId) ?? notesWaiting(container, c, chatId);
    if (refusal) return refusal;

    const body = (await c.req.json().catch(() => ({}))) as TurnBody;
    const parentId = parseParentId(body.parentId);
    const parts = parseParts(body.parts);
    const profileIds = parseProfileIds(body.profileIds);

    let profiles = await Promise.all(profileIds.map((id) => resolveProfile(container, id)));
    let userParts = parts;

    const command = contextCommandOf(parts, profiles);
    if (command?.kind === 'clear-with-text') return c.json({ error: CLEAR_ON_ITS_OWN }, 400);
    if (command) {
      if (parts.some((p) => p.type === 'image' || p.type === 'file')) throw new HTTPException(400, { message: COMMAND_WITH_ATTACHMENTS });
      userParts = [contextPart(command)];
      if (command.kind === 'clear') {
        if (container.store.messages.listByStatus('streaming').some((m) => m.chatId === chatId)) return c.json({ error: CLEAR_MID_REPLY }, 409);
        const { userMessageId } = writeClearLine(container, { chatId, parentId });
        return c.json({ userMessageId, assistantMessageIds: [], profileIds: [], userParts }, 202);
      }
      const profile = await compactProfile(container, chatId, parentId);
      if (!profile) return c.json({ error: NOTHING_TO_COMPACT }, 409);
      profiles = [profile];
    }

    // Only these four fields reach the runner: `unattended` is set by the
    // schedule service alone and is never read from a request body.
    let result;
    try {
      result = await startTurn(container, { chatId, parentId, userParts, profiles });
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

    // The profiles that answer, in reply order (a /compact's is not the one selected), and the message as stored.
    return c.json({ ...result, profileIds: profiles.map((p) => p.id), userParts }, 202);
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
    const refusal = workspaceRefusal(container, c, message.chatId) ?? notesWaiting(container, c, message.chatId);
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
      console.error(`[otherbench-server] retry ${messageId} failed outside its own error handling:`, err);
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
    const refusal = workspaceRefusal(container, c, chatId) ?? notesWaiting(container, c, chatId);
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
    const parent = message.parentId ? container.store.messages.get(message.parentId) : null;
    if (parent && contextLineOf(parent)?.kind === 'compact') return c.json({ error: COMPACT_NO_REGENERATE }, 409);
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

  // One of the chat's background tasks (a helper, a background command), stopped (spec 2026-10-17-claude-background-helpers-design).
  app.post('/chats/:id/helpers/:taskId/stop', async (c) => {
    const chatId = c.req.param('id');
    getChatOrThrow(container, chatId);
    let stopped: boolean;
    try {
      stopped = container.engine.stopHelper ? await container.engine.stopHelper(chatId, c.req.param('taskId')) : false;
    } catch (err) {
      // Running, but this engine can't stop it on its own: say why.
      if (err instanceof HelperStopError) return c.json({ error: err.message }, 409);
      throw err;
    }
    if (!stopped) return c.json({ error: 'That background task is not running.' }, 404);
    return c.json({ stopped: true });
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
        ...container.streamRegistry.chatState(chatId),
        // The chat's waiting notes, and what became of recent ones, so a reload doesn't lose or repeat them.
        ...(container.notes?.helloState(chatId) ?? { notes: [], noteOutcomes: [] }),
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
