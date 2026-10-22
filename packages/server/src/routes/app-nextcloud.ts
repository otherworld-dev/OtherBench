import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { App } from '@otherbench/core/ports/store.js';
import type { Container } from '../container.js';
import { CodeRouteError, codeCall } from '../code/route-errors.js';
import { NextcloudError, type NextcloudClient } from '../nextcloud/client.js';
import { nextcloudOrThrow } from '../nextcloud/config.js';
import { addBookmark, editBookmark, listBookmarks, removeBookmark } from '../nextcloud/bookmarks.js';
import { boardView, createCard } from '../nextcloud/deck.js';
import { wikiPage, wikiTree } from '../nextcloud/wiki.js';
import { getAppOrThrow } from './apps.js';

/**
 * An app's Deck board, wiki subtree and links (spec 2026-10-22-nextcloud-tabs).
 * Mounted at `/api/apps` BEFORE appsRoutes, and defines only paths that router
 * doesn't. Like the rest of the Nextcloud routes these are user actions on the
 * authed API only, never on the peer listener, and none of them needs the app's
 * folder, so they work for an app whose folder is on another machine.
 */

const ID_RE = /^\d{1,9}$/;

function parseId(raw: string | undefined, field: string): number {
  if (raw === undefined || !ID_RE.test(raw)) throw new HTTPException(400, { message: `"${field}" must be a number; got "${raw ?? ''}".` });
  return Number(raw);
}

function boardOrThrow(app: App): number {
  if (app.deckBoardId === null) throw new CodeRouteError(409, 'no-deck-board', "No Deck board set for this app. Add one in the app's settings.");
  return app.deckBoardId;
}

function wikiOrThrow(app: App): { collective: string; pagePath: string } {
  if (app.wikiCollective === null || app.wikiPagePath === null) {
    throw new CodeRouteError(409, 'no-wiki-page', "No wiki page set for this app. Add one in the app's settings.");
  }
  return { collective: app.wikiCollective, pagePath: app.wikiPagePath };
}

function tagOrThrow(app: App): string {
  if (app.bookmarkTag === null) throw new CodeRouteError(409, 'no-bookmark-tag', "No bookmark tag set for this app. Add one in the app's settings.");
  return app.bookmarkTag;
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new HTTPException(400, { message: `"${field}" must be a string.` });
  return value;
}

function optionalTags(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.every((t) => typeof t === 'string' && t.trim() !== '')) {
    throw new HTTPException(400, { message: '"tags" must be a list of tag names.' });
  }
  return (value as string[]).map((t) => t.trim());
}

/** Only http(s) links are bookmarks here: a javascript: or file: URL never reaches Nextcloud. */
function optionalHttpUrl(value: unknown): string | undefined {
  const url = optionalString(value, 'url')?.trim();
  if (url === undefined) return undefined;
  let ok = false;
  try {
    const parsed = new URL(url);
    ok = parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    ok = false;
  }
  if (!ok) throw new HTTPException(400, { message: '"url" must be an http:// or https:// address.' });
  return url;
}

/** Rethrows Nextcloud's not-found from `fn` as `replacement`, so the tab says what's gone instead of "HTTP 404". */
async function notFoundAs<T>(fn: () => Promise<T>, replacement: () => CodeRouteError): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof NextcloudError && err.code === 'nextcloud-not-found') throw replacement();
    throw err;
  }
}

/** The app's board; one Nextcloud no longer has, or this account can't see any more, says so. */
const appBoardView = (client: NextcloudClient, boardId: number) =>
  notFoundAs(() => boardView(client, boardId), () =>
    new CodeRouteError(404, 'nextcloud-not-found', "This app's Deck board isn't in Nextcloud any more. Pick another in the app's settings."));

export function appNextcloudRoutes(container: Container): Hono {
  const app = new Hono();
  const appOf = (c: { req: { param(name: string): string } }): App => getAppOrThrow(container, c.req.param('id'));
  const withClient = async <T>(fn: (client: NextcloudClient) => Promise<T>): Promise<T> => {
    const client = await nextcloudOrThrow(container);
    return codeCall(() => fn(client));
  };
  const bodyOf = async <T>(c: { req: { json(): Promise<unknown> } }): Promise<T> => (await c.req.json().catch(() => ({}))) as T;

  app.get('/:id/deck', async (c) => {
    const boardId = boardOrThrow(appOf(c));
    return c.json(await withClient((client) => appBoardView(client, boardId)));
  });

  app.post('/:id/deck/cards', async (c) => {
    const boardId = boardOrThrow(appOf(c));
    const body = await bodyOf<{ stackId?: unknown; title?: unknown; description?: unknown }>(c);
    if (!Number.isSafeInteger(body.stackId) || (body.stackId as number) < 0) throw new HTTPException(400, { message: '"stackId" must be a column id.' });
    if (typeof body.title !== 'string' || body.title.trim() === '') throw new HTTPException(400, { message: '"title" is required.' });
    const description = optionalString(body.description, 'description');
    const stackId = body.stackId as number;
    const title = body.title.trim();
    const card = await withClient(async (client) => {
      const view = await appBoardView(client, boardId);
      if (!view.stacks.some((s) => s.id === stackId)) throw new HTTPException(400, { message: `Column ${stackId} isn't on this app's Deck board.` });
      return createCard(client, boardId, stackId, { title, ...(description === undefined ? {} : { description }) });
    });
    return c.json(card, 201);
  });

  app.get('/:id/wiki', async (c) => {
    const { collective, pagePath } = wikiOrThrow(appOf(c));
    return c.json(await withClient((client) => wikiTree(client, collective, pagePath)));
  });

  app.get('/:id/wiki/pages/:pageId', async (c) => {
    const { collective, pagePath } = wikiOrThrow(appOf(c));
    const pageId = parseId(c.req.param('pageId'), 'pageId');
    return c.json(await withClient((client) => wikiPage(client, collective, pagePath, pageId)));
  });

  app.get('/:id/links', async (c) => {
    const tag = tagOrThrow(appOf(c));
    // The tag list is a plain query, so a 404 on it means the Bookmarks app itself isn't there.
    const bookmarks = await withClient((client) =>
      notFoundAs(() => listBookmarks(client, tag), () =>
        new CodeRouteError(409, 'nextcloud-app-missing', "Nextcloud's Bookmarks app didn't answer. Check it's installed.")));
    return c.json({ tag, bookmarks });
  });

  app.post('/:id/links', async (c) => {
    const tag = tagOrThrow(appOf(c));
    const body = await bodyOf<{ url?: unknown; title?: unknown; description?: unknown; tags?: unknown }>(c);
    const url = optionalHttpUrl(body.url);
    if (url === undefined) throw new HTTPException(400, { message: '"url" is required.' });
    const title = optionalString(body.title, 'title');
    const description = optionalString(body.description, 'description');
    const tags = optionalTags(body.tags);
    const created = await withClient((client) =>
      addBookmark(client, tag, {
        url,
        ...(title === undefined ? {} : { title }),
        ...(description === undefined ? {} : { description }),
        ...(tags === undefined ? {} : { tags }),
      }));
    return c.json(created, 201);
  });

  app.patch('/:id/links/:bookmarkId', async (c) => {
    const tag = tagOrThrow(appOf(c));
    const id = parseId(c.req.param('bookmarkId'), 'bookmarkId');
    const body = await bodyOf<{ url?: unknown; title?: unknown; description?: unknown; tags?: unknown }>(c);
    const url = optionalHttpUrl(body.url);
    const title = optionalString(body.title, 'title');
    const description = optionalString(body.description, 'description');
    let tags = optionalTags(body.tags);
    // The edit replaces the tag set; the app's own tag must stay on it or the link would leave this app.
    if (tags !== undefined && !tags.includes(tag)) tags = [...tags, tag];
    return c.json(await withClient((client) =>
      editBookmark(client, tag, id, {
        ...(url === undefined ? {} : { url }),
        ...(title === undefined ? {} : { title }),
        ...(description === undefined ? {} : { description }),
        ...(tags === undefined ? {} : { tags }),
      })));
  });

  app.delete('/:id/links/:bookmarkId', async (c) => {
    const tag = tagOrThrow(appOf(c));
    const id = parseId(c.req.param('bookmarkId'), 'bookmarkId');
    await withClient((client) => removeBookmark(client, tag, id));
    return c.body(null, 204);
  });

  return app;
}
