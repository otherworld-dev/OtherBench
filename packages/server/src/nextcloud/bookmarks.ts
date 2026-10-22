import type { Bookmark } from '@otherbench/core/types/nextcloud.js';
import { NextcloudError, type BookmarkFields, type NextcloudClient, type RawBookmark } from './client.js';

/** Bookmarks operations over a `NextcloudClient`, following nc.py's bm_* commands. An app's bookmarks are the ones carrying its tag. */

export function toBookmark(raw: RawBookmark): Bookmark {
  return {
    id: raw.id,
    url: raw.url,
    title: raw.title ?? '',
    description: raw.description ?? '',
    tags: [...(raw.tags ?? [])],
    added: raw.added ?? 0,
  };
}

/** Newest `added` first. */
export async function listBookmarks(client: NextcloudClient, tag: string): Promise<Bookmark[]> {
  return (await client.bookmarks(tag)).map(toBookmark).sort((a, b) => b.added - a.added);
}

/** `tags` always includes `tag` (added if missing). An empty title is left out so Nextcloud fetches the page's own. */
export async function addBookmark(
  client: NextcloudClient,
  tag: string,
  input: { url: string; title?: string; description?: string; tags?: string[] },
): Promise<Bookmark> {
  const tags = input.tags ?? [];
  const fields: BookmarkFields = { url: input.url, tags: tags.includes(tag) ? [...tags] : [...tags, tag] };
  if (input.title) fields.title = input.title;
  if (input.description !== undefined) fields.description = input.description;
  return toBookmark(await client.bookmarkCreate(fields));
}

async function requireTagged(client: NextcloudClient, tag: string, id: number): Promise<void> {
  if (!(await client.bookmarks(tag)).some((b) => b.id === id)) {
    throw new NextcloudError('nextcloud-not-found', 'The bookmark was not found in Nextcloud.');
  }
}

/** NextcloudError('nextcloud-not-found') unless the bookmark currently carries `tag`. `tags`, when given, replaces the set. */
export async function editBookmark(
  client: NextcloudClient,
  tag: string,
  id: number,
  input: { url?: string; title?: string; description?: string; tags?: string[] },
): Promise<Bookmark> {
  await requireTagged(client, tag, id);
  const fields: BookmarkFields = {};
  if (input.url !== undefined) fields.url = input.url;
  if (input.title !== undefined) fields.title = input.title;
  if (input.description !== undefined) fields.description = input.description;
  if (input.tags !== undefined) fields.tags = [...input.tags];
  return toBookmark(await client.bookmarkUpdate(id, fields));
}

export async function removeBookmark(client: NextcloudClient, tag: string, id: number): Promise<void> {
  await requireTagged(client, tag, id);
  await client.bookmarkDelete(id);
}
