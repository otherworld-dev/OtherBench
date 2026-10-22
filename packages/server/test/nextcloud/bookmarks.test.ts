import { describe, expect, it } from 'vitest';
import { NextcloudError } from '../../src/nextcloud/client.js';
import { addBookmark, editBookmark, listBookmarks, removeBookmark } from '../../src/nextcloud/bookmarks.js';
import { FakeNextcloudClient } from './fake-client.js';

function fake(): FakeNextcloudClient {
  return new FakeNextcloudClient({
    bookmarks: [
      { id: 1, url: 'https://a.example', title: 'A', tags: ['ob'], added: 100 },
      { id: 2, url: 'https://b.example', title: 'B', tags: ['ob', 'x'], added: 300 },
      { id: 3, url: 'https://c.example', title: 'C', tags: ['other'], added: 200 },
    ],
  });
}

async function rejectsWith(p: Promise<unknown>, code: string): Promise<void> {
  const err = await p.then(() => null, (e: unknown) => e);
  expect(err).toBeInstanceOf(NextcloudError);
  expect((err as NextcloudError).code).toBe(code);
}

describe('bookmarks', () => {
  it('listBookmarks sorts newest first', async () => {
    expect((await listBookmarks(fake(), 'ob')).map((b) => b.id)).toEqual([2, 1]);
  });

  it('addBookmark adds the app tag and leaves out an empty title', async () => {
    const c = fake();
    const b = await addBookmark(c, 'ob', { url: 'https://n.example', title: '', tags: ['x'] });
    const body = c.bodies.find((x) => x.call === 'bookmarkCreate')?.body as Record<string, unknown>;
    expect(body.tags).toEqual(['x', 'ob']);
    expect('title' in body).toBe(false);
    expect(b.tags).toContain('ob');
  });

  it('editBookmark updates a tagged bookmark and refuses one without the tag', async () => {
    const c = fake();
    expect((await editBookmark(c, 'ob', 1, { title: 'New' })).title).toBe('New');
    await rejectsWith(editBookmark(c, 'ob', 3, { title: 'No' }), 'nextcloud-not-found');
    expect(c.data.bookmarks.find((b) => b.id === 3)?.title).toBe('C');
  });

  it('removeBookmark refuses a bookmark without the tag', async () => {
    const c = fake();
    await rejectsWith(removeBookmark(c, 'ob', 3), 'nextcloud-not-found');
    expect(c.data.bookmarks).toHaveLength(3);
    await removeBookmark(c, 'ob', 1);
    expect(c.data.bookmarks.map((b) => b.id)).toEqual([2, 3]);
  });
});
