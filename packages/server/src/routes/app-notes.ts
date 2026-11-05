import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { validateAppNotes, validateFact } from '@otherbench/core/domain/app-notes.js';
import type { Container } from '../container.js';
import type { AppNotesService } from '../app-notes/service.js';
import { requireNonEmptyString } from '../validation.js';
import { getAppOrThrow } from './apps.js';

/**
 * An app's notes (spec 2026-11-05-app-notes-design), under `/api/apps/:id/notes`:
 * read, save, history and restore, file a fact (`#` or a model's offer), and
 * change, move or take back one line. Mounted BEFORE appsRoutes; like the
 * rest of `/api/apps` these are user actions on the authed API only, never on
 * the peer listener.
 */

interface SaveBody { body?: unknown }
interface FactBody { text?: unknown; section?: unknown; chatId?: unknown }
interface LineBody { line?: unknown; text?: unknown; section?: unknown; replaced?: unknown }

function serviceOrThrow(container: Container): AppNotesService {
  if (!container.appNotes) throw new HTTPException(503, { message: 'App notes are not available on this server.' });
  return container.appNotes;
}

function optionalString(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new HTTPException(400, { message: `"${field}" must be a string.` });
  return value;
}

function factText(value: unknown): string {
  const text = requireNonEmptyString(value, 'text');
  const problem = validateFact(text);
  if (problem) throw new HTTPException(400, { message: problem });
  return text;
}

export function appNotesRoutes(container: Container): Hono {
  const r = new Hono();

  r.get('/:id/notes', (c) => {
    const app = getAppOrThrow(container, c.req.param('id'));
    return c.json(serviceOrThrow(container).view(app));
  });

  r.put('/:id/notes', async (c) => {
    const app = getAppOrThrow(container, c.req.param('id'));
    const { body } = await c.req.json<SaveBody>();
    if (typeof body !== 'string') throw new HTTPException(400, { message: '"body" must be a string.' });
    const problem = validateAppNotes(body);
    if (problem) throw new HTTPException(400, { message: problem });
    return c.json(serviceOrThrow(container).save(app, body));
  });

  r.get('/:id/notes/versions', (c) => {
    const app = getAppOrThrow(container, c.req.param('id'));
    return c.json(container.store.appNotes.versions(app.id).map(({ id, createdAt, sourceChatId, body }) => ({ id, createdAt, sourceChatId, length: body.length })));
  });

  r.get('/:id/notes/versions/:versionId', (c) => {
    const app = getAppOrThrow(container, c.req.param('id'));
    const version = container.store.appNotes.version(c.req.param('versionId'));
    if (!version || version.appId !== app.id) throw new HTTPException(404, { message: 'That version was not found.' });
    return c.json(version);
  });

  r.post('/:id/notes/versions/:versionId/restore', (c) => {
    const app = getAppOrThrow(container, c.req.param('id'));
    const view = serviceOrThrow(container).restore(app, c.req.param('versionId'));
    if (!view) throw new HTTPException(404, { message: 'That version was not found.' });
    return c.json(view);
  });

  r.post('/:id/notes/facts', async (c) => {
    const app = getAppOrThrow(container, c.req.param('id'));
    const body = await c.req.json<FactBody>();
    const text = factText(body.text);
    const section = optionalString(body.section, 'section');
    const chatId = optionalString(body.chatId, 'chatId');
    // Only a chat on this app is named as where a fact came from.
    const source = chatId !== null && container.store.chats.get(chatId)?.appId === app.id ? chatId : null;
    return c.json(await serviceOrThrow(container).addFact(app, text, section && section.trim() !== '' ? section : null, source));
  });

  r.post('/:id/notes/facts/edit', async (c) => {
    const app = getAppOrThrow(container, c.req.param('id'));
    const body = await c.req.json<LineBody>();
    return c.json(serviceOrThrow(container).editFact(app, requireNonEmptyString(body.line, 'line'), factText(body.text)));
  });

  r.post('/:id/notes/facts/move', async (c) => {
    const app = getAppOrThrow(container, c.req.param('id'));
    const body = await c.req.json<LineBody>();
    return c.json(serviceOrThrow(container).moveFact(app, requireNonEmptyString(body.line, 'line'), requireNonEmptyString(body.section, 'section')));
  });

  r.post('/:id/notes/facts/undo', async (c) => {
    const app = getAppOrThrow(container, c.req.param('id'));
    const body = await c.req.json<LineBody>();
    const line = requireNonEmptyString(body.line, 'line');
    return c.json(serviceOrThrow(container).undoFact(app, line, requireNonEmptyString(body.section, 'section'), optionalString(body.replaced, 'replaced')));
  });

  return r;
}
