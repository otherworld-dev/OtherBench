import { readFile } from 'node:fs/promises';
import { Hono, type Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { containPath, PathEscapeError } from '@otherbench/core/domain/paths.js';
import { parseProjectLinks } from '@otherbench/core/domain/project-links.js';
import type { NextcloudTestResult, ProjectLinksSuggestion } from '@otherbench/core/types/nextcloud.js';
import type { Container } from '../container.js';
import { folderFromQuery } from '../code/folder-query.js';
import { CodeRouteError, codeCall } from '../code/route-errors.js';
import { normaliseBaseUrl, NextcloudError, type NextcloudClient, type RawBoard } from '../nextcloud/client.js';
import { NEXTCLOUD_SECRET_REF, NEXTCLOUD_SETTING_KEY, nextcloudOrThrow, nextcloudSettings } from '../nextcloud/config.js';
import { archiveCard, changeLabels, completeCard, deleteCard, findCard, moveCard, reopenCard, updateCard } from '../nextcloud/deck.js';

/**
 * `/api/nextcloud` (spec 2026-10-22-nextcloud-tabs): this machine's Nextcloud
 * settings, a connection test, the pickers' boards and collectives, reading
 * an app's project links from its CLAUDE.md, and the Deck card actions.
 *
 * Like `/api/apps`, these are USER actions on server routes, never model
 * tools, and the router is mounted only on the authed API, never on the peer
 * listener: a paired machine must not act on this machine's Nextcloud
 * account. The app password goes in and never comes back out.
 */

interface SettingsBody { baseUrl?: unknown; user?: unknown; password?: unknown }
interface CardPatchBody { title?: unknown; description?: unknown; duedate?: unknown }

const ID_RE = /^\d{1,9}$/;

function parseId(raw: string | undefined, field: string): number {
  if (raw === undefined || !ID_RE.test(raw)) throw new HTTPException(400, { message: `"${field}" must be a number; got "${raw ?? ''}".` });
  return Number(raw);
}

/**
 * The card id from the path and the board to look on first from `?board=`.
 * The board is optional: a "Deck #N" link in a chat has only the card id, and
 * the card is then found on whichever board holds it.
 */
function cardRef(c: Context): { cardId: number; boardId: number | undefined } {
  const board = c.req.query('board');
  return { cardId: parseId(c.req.param('cardId'), 'cardId'), boardId: board === undefined ? undefined : parseId(board, 'board') };
}

function requireIdList(value: unknown, field: string): number[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every((v) => Number.isSafeInteger(v) && (v as number) >= 0)) {
    throw new HTTPException(400, { message: `"${field}" must be a list of label ids.` });
  }
  return value as number[];
}

const openBoards = (boards: RawBoard[]): RawBoard[] =>
  boards.filter((b) => !b.archived && !(typeof b.deletedAt === 'number' && b.deletedAt > 0));

/** `<folder>/.claude/CLAUDE.md`, else `<folder>/CLAUDE.md`, else null. A file that resolves outside the folder counts as missing. */
async function readClaudeMd(folder: string): Promise<string | null> {
  for (const rel of ['.claude/CLAUDE.md', 'CLAUDE.md']) {
    let path: string;
    try {
      path = containPath(folder, rel);
    } catch (err) {
      if (err instanceof PathEscapeError) continue;
      throw err;
    }
    try {
      return await readFile(path, 'utf8');
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'EISDIR') continue;
      if (code === 'EACCES' || code === 'EPERM') throw new HTTPException(403, { message: `OtherBench can't read "${path}".` });
      throw err;
    }
  }
  return null;
}

/** The id of the open board titled `title` (case-insensitive); null when Nextcloud isn't set up, the call fails, or there's no such board. */
async function boardIdByTitle(container: Container, title: string): Promise<number | null> {
  try {
    const client = await nextcloudOrThrow(container);
    const wanted = title.trim().toLowerCase();
    return openBoards(await client.deckBoards()).find((b) => b.title.trim().toLowerCase() === wanted)?.id ?? null;
  } catch (err) {
    if (err instanceof CodeRouteError || err instanceof NextcloudError) return null;
    throw err;
  }
}

const NO_APPS: NextcloudTestResult['apps'] = { deck: false, collectives: false, bookmarks: false };

export function nextcloudRoutes(container: Container): Hono {
  const app = new Hono();
  /** Runs `fn` with the client, turning a Nextcloud failure into a CodeRouteError. */
  const withClient = async <T>(fn: (client: NextcloudClient) => Promise<T>): Promise<T> => {
    const client = await nextcloudOrThrow(container);
    return codeCall(() => fn(client));
  };

  app.get('/', async (c) => c.json(await nextcloudSettings(container)));

  /**
   * `PUT /`: `{ baseUrl, user, password? }`. A blank URL and user together
   * clear the stored URL and user. `password` follows the connections
   * pattern: a string sets it, null deletes it, leaving it out keeps it.
   * Everything is checked before anything is written.
   */
  app.put('/', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as SettingsBody;
    if (typeof body.baseUrl !== 'string') throw new HTTPException(400, { message: '"baseUrl" must be a string.' });
    if (typeof body.user !== 'string') throw new HTTPException(400, { message: '"user" must be a string.' });
    const user = body.user.trim();
    const clearing = body.baseUrl.trim() === '' && user === '';
    let baseUrl = '';
    if (!clearing) {
      try {
        baseUrl = normaliseBaseUrl(body.baseUrl);
      } catch (err) {
        if (err instanceof NextcloudError) throw new CodeRouteError(400, err.code, err.message);
        throw err;
      }
      if (!user) throw new HTTPException(400, { message: '"user" must not be blank.' });
    }
    if (body.password !== undefined && body.password !== null && (typeof body.password !== 'string' || body.password.length === 0)) {
      throw new HTTPException(400, { message: '"password" must be a non-empty string, null, or omitted.' });
    }

    container.store.settings.setValue(NEXTCLOUD_SETTING_KEY, clearing ? null : { baseUrl, user });
    if (body.password === null) await container.secrets.delete(NEXTCLOUD_SECRET_REF);
    else if (typeof body.password === 'string') await container.secrets.set(NEXTCLOUD_SECRET_REF, body.password);
    return c.json(await nextcloudSettings(container));
  });

  /** `POST /test`: signs in and probes the three apps. Always a 200: a failure is `ok: false` with its message. */
  app.post('/test', async (c) => {
    try {
      const client = await nextcloudOrThrow(container);
      const me = await client.currentUser();
      const apps = await client.appsAvailable();
      const result: NextcloudTestResult = { ok: true, message: `Signed in as ${me.displayName}.`, apps };
      return c.json(result);
    } catch (err) {
      if (!(err instanceof NextcloudError) && !(err instanceof CodeRouteError)) throw err;
      const result: NextcloudTestResult = { ok: false, message: err.message, apps: { ...NO_APPS } };
      return c.json(result);
    }
  });

  app.get('/boards', async (c) => {
    const boards = await withClient((client) => client.deckBoards());
    return c.json(openBoards(boards).map((b) => ({ id: b.id, title: b.title })));
  });

  app.get('/collectives', async (c) => {
    const collectives = await withClient((client) => client.collectives());
    return c.json(collectives.map((col) => col.name));
  });

  /** `GET /detect-links?path=<abs>`: the folder's CLAUDE.md "Project links", with the board resolved to an id when it can be. */
  app.get('/detect-links', async (c) => {
    const folder = await folderFromQuery(c.req.query('path'));
    const text = await readClaudeMd(folder);
    const links = text === null ? { deckBoard: null, collective: null, pagePath: null, bookmarkTag: null } : parseProjectLinks(text);
    const suggestion: ProjectLinksSuggestion = {
      ...links,
      deckBoardId: links.deckBoard ? await boardIdByTitle(container, links.deckBoard) : null,
    };
    return c.json(suggestion);
  });

  app.get('/cards/:cardId', async (c) => {
    const { cardId, boardId } = cardRef(c);
    return c.json(await withClient((client) => findCard(client, cardId, boardId)));
  });

  app.patch('/cards/:cardId', async (c) => {
    const { cardId, boardId } = cardRef(c);
    const body = (await c.req.json().catch(() => ({}))) as CardPatchBody;
    const patch: { title?: string; description?: string; duedate?: string | null } = {};
    if (body.title !== undefined) {
      if (typeof body.title !== 'string' || body.title.trim() === '') throw new HTTPException(400, { message: '"title" must not be blank.' });
      patch.title = body.title.trim();
    }
    if (body.description !== undefined) {
      if (typeof body.description !== 'string') throw new HTTPException(400, { message: '"description" must be a string.' });
      patch.description = body.description;
    }
    if (body.duedate !== undefined) {
      if (body.duedate !== null && typeof body.duedate !== 'string') throw new HTTPException(400, { message: '"duedate" must be a string or null.' });
      patch.duedate = body.duedate;
    }
    return c.json(await withClient((client) => updateCard(client, cardId, patch, boardId)));
  });

  app.post('/cards/:cardId/move', async (c) => {
    const { cardId, boardId } = cardRef(c);
    const body = (await c.req.json().catch(() => ({}))) as { stackId?: unknown };
    if (!Number.isSafeInteger(body.stackId) || (body.stackId as number) < 0) {
      throw new HTTPException(400, { message: '"stackId" must be a column id.' });
    }
    const stackId = body.stackId as number;
    await withClient((client) => moveCard(client, cardId, stackId, boardId));
    return c.body(null, 204);
  });

  app.post('/cards/:cardId/labels', async (c) => {
    const { cardId, boardId } = cardRef(c);
    const body = (await c.req.json().catch(() => ({}))) as { add?: unknown; remove?: unknown };
    const change = { add: requireIdList(body.add, 'add'), remove: requireIdList(body.remove, 'remove') };
    await withClient((client) => changeLabels(client, cardId, change, boardId));
    return c.body(null, 204);
  });

  const actions = { done: completeCard, reopen: reopenCard, archive: archiveCard } as const;
  for (const [name, action] of Object.entries(actions)) {
    app.post(`/cards/:cardId/${name}`, async (c) => {
      const { cardId, boardId } = cardRef(c);
      await withClient((client) => action(client, cardId, boardId));
      return c.body(null, 204);
    });
  }

  app.delete('/cards/:cardId', async (c) => {
    const { cardId, boardId } = cardRef(c);
    await withClient((client) => deleteCard(client, cardId, boardId));
    return c.body(null, 204);
  });

  return app;
}
