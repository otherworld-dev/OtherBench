import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { APP_FOLDER_NAME_MAX } from '@otherbench/core/domain/apps.js';
import type { AppFolder } from '@otherbench/core/ports/store.js';
import type { Container } from '../container.js';

/**
 * `/api/app-folders`: the folders that group apps in the Code sidebar (one level; an app is in at most one).
 * Like `/api/apps` this is mounted on the authed API only, never on the peer listener (peer/forward.ts).
 * Deleting a folder moves its apps to the top level through the app repo (so it syncs); no app is deleted.
 */

/** Trimmed, 1 to APP_FOLDER_NAME_MAX characters. */
function requireFolderName(value: unknown): string {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (trimmed.length === 0 || trimmed.length > APP_FOLDER_NAME_MAX) {
    throw new HTTPException(400, { message: `"name" must be 1 to ${APP_FOLDER_NAME_MAX} characters.` });
  }
  return trimmed;
}

function optionalSortOrder(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value)) throw new HTTPException(400, { message: '"sortOrder" must be an integer.' });
  return value;
}

async function bodyOf<T>(c: { req: { json(): Promise<unknown> } }): Promise<T> {
  return (await c.req.json().catch(() => ({}))) as T;
}

export function appFoldersRoutes(container: Container): Hono {
  const app = new Hono();
  const folders = container.store.appFolders;

  const getOrThrow = (id: string): AppFolder => {
    const folder = folders.get(id);
    if (!folder) throw new HTTPException(404, { message: `Folder "${id}" not found.` });
    return folder;
  };

  app.get('/', (c) => c.json(folders.list()));

  app.post('/', async (c) => {
    const body = await bodyOf<{ name?: unknown; sortOrder?: unknown }>(c);
    const name = body.name === undefined ? 'New folder' : requireFolderName(body.name);
    // New folders go to the bottom unless the request places them.
    const sortOrder = optionalSortOrder(body.sortOrder) ?? folders.list().reduce((max, f) => Math.max(max, f.sortOrder), -1) + 1;
    return c.json(folders.create({ id: randomUUID(), name, sortOrder }), 201);
  });

  app.patch('/:id', async (c) => {
    const id = c.req.param('id');
    getOrThrow(id);
    const body = await bodyOf<{ name?: unknown; sortOrder?: unknown }>(c);
    // Every field is validated before anything is written.
    const patch: Partial<Pick<AppFolder, 'name' | 'sortOrder'>> = {};
    if (body.name !== undefined) patch.name = requireFolderName(body.name);
    const sortOrder = optionalSortOrder(body.sortOrder);
    if (sortOrder !== undefined) patch.sortOrder = sortOrder;
    return c.json(folders.update(id, patch));
  });

  app.delete('/:id', (c) => {
    const id = c.req.param('id');
    getOrThrow(id);
    folders.delete(id);
    return c.body(null, 204);
  });

  return app;
}
