import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { NoteAttachment } from '@otherbench/core/types/messages.js';
import type { Container } from '../container.js';
import { resolveProfile } from '../profile-resolution.js';
import { requireNonEmptyString } from '../validation.js';
import { contextCommandOf, getChatOrThrow, parseProfileIds, workspaceRefusal } from './turns.js';

interface NoteBody {
  text?: unknown;
  attachments?: unknown;
  parentId?: unknown;
  profileIds?: unknown;
  clientId?: unknown;
}

/** Refused when a /clear or /compact is sent while a reply is running. */
export const COMMAND_MID_REPLY = 'Wait for the reply to finish, or stop it, before sending a command.';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The message a note follows: a message of this chat, or null for none. */
function parseParentId(container: Container, chatId: string, value: unknown): string | null {
  if (value === null) return null;
  const id = requireNonEmptyString(value, 'parentId');
  if (container.store.messages.get(id)?.chatId !== chatId) {
    throw new HTTPException(400, { message: `Message "${id}" does not belong to chat "${chatId}".` });
  }
  return id;
}

/**
 * The note's attachments, as stored: each must be one of this chat's, not
 * yet sent and not already on another waiting note. Only the id is read
 * from the client; the type and name are the stored row's.
 */
function parseAttachments(container: Container, chatId: string, value: unknown): NoteAttachment[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new HTTPException(400, { message: '"attachments" must be an array.' });
  const held = new Set(container.notes?.heldAttachmentIds(chatId) ?? []);
  const taken = new Set<string>();
  return value.map((a: unknown, index) => {
    const id = isPlainObject(a) ? a['attachmentId'] : undefined;
    if (typeof id !== 'string' || id.length === 0) {
      throw new HTTPException(400, { message: `"attachments[${index}].attachmentId" must be a non-empty string.` });
    }
    const row = container.store.attachments.get(id);
    if (!row || row.chatId !== chatId) throw new HTTPException(400, { message: `Attachment "${id}" is not in chat "${chatId}".` });
    if (row.messageId !== null) throw new HTTPException(400, { message: `Attachment "${id}" has already been sent.` });
    if (held.has(id) || taken.has(id)) throw new HTTPException(400, { message: `Attachment "${id}" is already on a message waiting to be sent.` });
    taken.add(id);
    return { attachmentId: row.id, mime: row.mime, filename: row.filename };
  });
}

/**
 * Messages sent while a reply runs (spec 2026-10-18-send-while-replying-design):
 * `NotesService` decides where each goes. A chat with nothing running is
 * refused as `idle`, and the client sends a normal turn instead.
 */
export function notesRoutes(container: Container): Hono {
  const app = new Hono();

  app.post('/chats/:id/notes', async (c) => {
    const chatId = c.req.param('id');
    const refusal = workspaceRefusal(container, c, chatId);
    if (refusal) return refusal;

    const body = (await c.req.json().catch(() => ({}))) as NoteBody;
    if (typeof body.text !== 'string') throw new HTTPException(400, { message: '"text" must be a string.' });
    const text = body.text;
    const clientId = requireNonEmptyString(body.clientId, 'clientId');
    const profileIds = parseProfileIds(body.profileIds);
    const parentId = parseParentId(container, chatId, body.parentId);
    const attachments = parseAttachments(container, chatId, body.attachments);
    if (text.trim().length === 0 && attachments.length === 0) {
      throw new HTTPException(400, { message: '"text" must not be empty unless the message has attachments.' });
    }
    const profiles = await Promise.all(profileIds.map((id) => resolveProfile(container, id)));

    const notes = container.notes;
    if (!notes?.isBusy(chatId)) return c.json({ kind: 'idle' }, 409);
    if (contextCommandOf([{ type: 'text', text }], profiles)) return c.json({ kind: 'command', error: COMMAND_MID_REPLY }, 409);

    const note = await notes.send({ chatId, text, attachments, parentId, profileIds, clientId });
    // The chat went quiet meanwhile: the client sends it as a normal turn.
    if (!note) return c.json({ kind: 'idle' }, 409);
    return c.json({ note }, 202);
  });

  app.delete('/chats/:id/notes/:noteId', async (c) => {
    const chatId = c.req.param('id');
    getChatOrThrow(container, chatId);
    const note = (await container.notes?.withdraw(chatId, c.req.param('noteId'))) ?? null;
    // Claude already read it, or it has already gone out (or back).
    if (!note) return c.json({ kind: 'read' }, 409);
    return c.json({ note });
  });

  return app;
}
