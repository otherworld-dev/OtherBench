import { describe, expect, it } from 'vitest';
import { NextcloudError, type RawCardPut } from '../../src/nextcloud/client.js';
import {
  archiveCard, boardView, changeLabels, completeCard, createCard, deckCardUrl, deleteCard, findCard,
  isDoingTitle, moveCard, reopenCard, stripCardPrefix, updateCard, withCardPrefix,
} from '../../src/nextcloud/deck.js';
import { FakeNextcloudClient, type FakeSeed } from './fake-client.js';

/** Board 1 "OtherBench": Backlog(10), To Do(11), Doing(12), Done(13); board 2 "Other": Inbox(20). */
function seed(over: Partial<FakeSeed> = {}): FakeSeed {
  return {
    boards: [
      { id: 1, title: 'OtherBench', labels: [{ id: 7, title: 'bug', color: 'ff0000' }, { id: 8, title: 'ui', color: '00ff00' }] },
      { id: 2, title: 'Other' },
    ],
    stacks: [
      { id: 12, boardId: 1, title: 'Doing', order: 2 },
      { id: 10, boardId: 1, title: 'Backlog', order: 0 },
      { id: 11, boardId: 1, title: 'To Do', order: 1 },
      { id: 13, boardId: 1, title: 'Done', order: 3 },
      { id: 20, boardId: 2, title: 'Inbox', order: 0 },
    ],
    cards: [
      { id: 966, stackId: 12, title: '#966 Terminal', description: 'long body', owner: { uid: 'adam' }, order: 4, duedate: '2026-11-01T00:00:00+00:00', createdAt: 1_760_000_000 },
      { id: 5, stackId: 10, title: 'Plain card' },
      { id: 300, stackId: 20, title: '#300 Elsewhere' },
    ],
    ...over,
  };
}

async function rejectsWith(p: Promise<unknown>, code: string): Promise<NextcloudError> {
  const err = await p.then(() => null, (e: unknown) => e);
  expect(err).toBeInstanceOf(NextcloudError);
  expect((err as NextcloudError).code).toBe(code);
  return err as NextcloudError;
}

describe('deck helpers', () => {
  it('strips and adds the #id prefix only for the card\'s own id', () => {
    expect(stripCardPrefix(966, '#966 Terminal')).toBe('Terminal');
    expect(stripCardPrefix(966, '#12 Terminal')).toBe('#12 Terminal');
    expect(stripCardPrefix(966, 'Terminal')).toBe('Terminal');
    expect(withCardPrefix(966, 'Terminal')).toBe('#966 Terminal');
    expect(withCardPrefix(966, '#966 Terminal')).toBe('#966 Terminal');
    expect(withCardPrefix(966, '#12 Terminal')).toBe('#966 #12 Terminal');
  });

  it('isDoingTitle matches the in-progress names', () => {
    for (const t of ['Doing', 'in progress', 'In-Progress', ' WIP ']) expect(isDoingTitle(t)).toBe(true);
    for (const t of ['Done', 'To Do', 'Doing next']) expect(isDoingTitle(t)).toBe(false);
  });

  it('deckCardUrl', () => {
    expect(deckCardUrl('https://nc', 1, 966)).toBe('https://nc/index.php/apps/deck/board/1/card/966');
  });
});

describe('boardView', () => {
  it('orders stacks, strips prefixes, finds Doing', async () => {
    const c = new FakeNextcloudClient(seed());
    const v = await boardView(c, 1);
    expect(v.board).toEqual({ id: 1, title: 'OtherBench' });
    expect(v.stacks.map((s) => s.title)).toEqual(['Backlog', 'To Do', 'Doing', 'Done']);
    const doing = v.stacks.find((s) => s.title === 'Doing')!;
    expect(doing.cards.map((x) => x.title)).toEqual(['Terminal']);
    expect(doing.cards[0]).toMatchObject({ id: 966, stackId: 12, done: false, archived: false, duedate: '2026-11-01T00:00:00+00:00' });
    expect(v.doingStackId).toBe(12);
    expect(v.labels).toEqual([{ id: 7, title: 'bug', color: 'ff0000' }, { id: 8, title: 'ui', color: '00ff00' }]);
    expect(v.url).toBe('https://nc.example/index.php/apps/deck/board/1');
  });

  it('has no Doing stack id when no column is in progress', async () => {
    const c = new FakeNextcloudClient(seed({ stacks: [{ id: 10, boardId: 1, title: 'Backlog', order: 0 }] }));
    expect((await boardView(c, 1)).doingStackId).toBeNull();
  });

  it('keeps done-but-unarchived cards in their column', async () => {
    const c = new FakeNextcloudClient(seed({
      cards: [{ id: 40, stackId: 13, title: 'Shipped', done: '2026-10-01T00:00:00+00:00', archived: false }],
    }));
    const v = await boardView(c, 1);
    expect(v.stacks.find((s) => s.title === 'Done')!.cards).toMatchObject([{ id: 40, done: true, archived: false }]);
    expect(v.archived).toEqual([]);
  });

  it('lists archived cards', async () => {
    const c = new FakeNextcloudClient(seed({
      cards: [
        { id: 41, stackId: 13, title: '#41 Old', done: '2026-09-01T00:00:00+00:00', archived: true },
        { id: 42, stackId: 10, title: 'Open' },
      ],
    }));
    const v = await boardView(c, 1);
    expect(c.calls).toContain('deckArchivedStacks 1');
    expect(v.archived).toMatchObject([{ id: 41, title: 'Old', stackId: 13, done: true, archived: true }]);
    expect(v.stacks.flatMap((s) => s.cards).map((x) => x.id)).toEqual([42]);
  });
});

describe('findCard', () => {
  it('looks on the preferred board, then archived, then other boards', async () => {
    const c = new FakeNextcloudClient(seed());
    const d = await findCard(c, 300, 1);
    expect(d).toMatchObject({ id: 300, boardId: 2, boardTitle: 'Other', stackId: 20, stackTitle: 'Inbox', title: 'Elsewhere' });
    expect(d.url).toBe('https://nc.example/index.php/apps/deck/board/2/card/300');
    const order = c.calls.filter((x) => x.startsWith('deckStacks') || x.startsWith('deckArchivedStacks'));
    expect(order).toEqual(['deckStacks 1', 'deckArchivedStacks 1', 'deckStacks 2']);
    await rejectsWith(findCard(c, 999, 1), 'nextcloud-not-found');
  });

  it('returns the full card with its description and creation time', async () => {
    const c = new FakeNextcloudClient(seed());
    const d = await findCard(c, 966, 1);
    expect(d).toMatchObject({
      id: 966, title: 'Terminal', description: 'long body', boardId: 1, boardTitle: 'OtherBench',
      stackTitle: 'Doing', createdAt: 1_760_000_000, archived: false,
    });
  });

  it('finds an archived card on the preferred board', async () => {
    const c = new FakeNextcloudClient(seed({ cards: [{ id: 41, stackId: 13, title: 'Old', archived: true }] }));
    expect(await findCard(c, 41, 1)).toMatchObject({ id: 41, archived: true, stackTitle: 'Done' });
  });

  it('searches every board without a preferred one', async () => {
    const c = new FakeNextcloudClient(seed());
    expect(await findCard(c, 300)).toMatchObject({ boardId: 2 });
  });
});

describe('updateCard', () => {
  it('keeps the #id prefix only when the card had it', async () => {
    const c = new FakeNextcloudClient(seed());
    const d = await updateCard(c, 966, { title: 'New' }, 1);
    expect(c.card(966).title).toBe('#966 New');
    expect(d.title).toBe('New');
    await updateCard(c, 5, { title: 'New' }, 1);
    expect(c.card(5).title).toBe('New');
  });

  it('PUTs every field from a fresh GET, as nc.py does', async () => {
    const c = new FakeNextcloudClient(seed());
    await updateCard(c, 966, { description: 'changed' }, 1);
    const put = c.bodies.find((b) => b.call === 'deckPutCard 1 12 966')!.body as RawCardPut;
    expect(put).toEqual({
      title: '#966 Terminal', type: 'plain', owner: 'adam', description: 'changed', order: 4,
      duedate: '2026-11-01T00:00:00+00:00', done: null, archived: false,
    });
  });

  it('clears the due date with null', async () => {
    const c = new FakeNextcloudClient(seed());
    await updateCard(c, 966, { duedate: null }, 1);
    expect(c.card(966).duedate).toBeNull();
  });
});

describe('createCard', () => {
  it('prefixes the new card\'s title with its id', async () => {
    const c = new FakeNextcloudClient(seed());
    const d = await createCard(c, 1, 10, { title: 'Fresh', description: 'why' });
    expect(c.calls.findIndex((x) => x.startsWith('deckCreateCard 1 10'))).toBeLessThan(
      c.calls.findIndex((x) => x.startsWith(`deckPutCard 1 10 ${d.id}`)),
    );
    expect(c.card(d.id).title).toBe(`#${d.id} Fresh`);
    expect(d).toMatchObject({ title: 'Fresh', description: 'why', stackId: 10, boardId: 1 });
  });
});

describe('moveCard', () => {
  it('uses the documented route when it works', async () => {
    const c = new FakeNextcloudClient(seed());
    await moveCard(c, 5, 11, 1);
    expect(c.card(5).stackId).toBe(11);
    expect(c.calls.filter((x) => x.startsWith('deckReorder '))).toEqual(['deckReorder 1 10 5 11 0']);
    expect(c.calls.some((x) => x.startsWith('deckReorderInternal'))).toBe(false);
  });

  it('falls back to the internal route', async () => {
    const c = new FakeNextcloudClient(seed());
    c.ignoreReorder = true;
    await moveCard(c, 5, 11, 1);
    expect(c.card(5).stackId).toBe(11);
    expect(c.calls).toContain('deckReorderInternal 5 11 0');
  });

  it('never recreates', async () => {
    const c = new FakeNextcloudClient(seed());
    c.ignoreReorder = true;
    c.ignoreInternalReorder = true;
    const err = await rejectsWith(moveCard(c, 5, 11, 1), 'deck-move-ignored');
    expect(err.message).toBe("Nextcloud didn't move the card. It's still in Backlog.");
    expect(c.calls.some((x) => x.startsWith('deckCreateCard') || x.startsWith('deckDeleteCard'))).toBe(false);
    expect(c.card(5)).toMatchObject({ id: 5, stackId: 10 });
  });

  it('treats a failing internal route as an ignored move', async () => {
    const c = new FakeNextcloudClient(seed());
    c.ignoreReorder = true;
    c.failOn = { call: 'deckReorderInternal', error: new NextcloudError('nextcloud-not-found', 'Nextcloud answered HTTP 404.') };
    await rejectsWith(moveCard(c, 5, 11, 1), 'deck-move-ignored');
    expect(c.card(5).stackId).toBe(10);
  });

  it('refuses a column on another board', async () => {
    const c = new FakeNextcloudClient(seed());
    await rejectsWith(moveCard(c, 5, 20, 1), 'nextcloud-not-found');
    expect(c.calls.some((x) => x.startsWith('deckReorder'))).toBe(false);
  });

  it('does nothing when the card is already there', async () => {
    const c = new FakeNextcloudClient(seed());
    await moveCard(c, 5, 10, 1);
    expect(c.calls.some((x) => x.startsWith('deckReorder'))).toBe(false);
  });
});

describe('completeCard', () => {
  it('moves to Done, marks done, archives', async () => {
    const c = new FakeNextcloudClient(seed());
    await completeCard(c, 966, 1);
    expect(c.card(966).stackId).toBe(13);
    expect(c.card(966).done).toBeTruthy();
    expect(Number.isNaN(Date.parse(String(c.card(966).done)))).toBe(false);
    expect(c.card(966).archived).toBe(true);
  });

  it('with no Done column, marks done and archives in place', async () => {
    const c = new FakeNextcloudClient(seed({ stacks: seed().stacks!.filter((s) => s.title !== 'Done') }));
    await completeCard(c, 966, 1);
    expect(c.card(966)).toMatchObject({ stackId: 12, archived: true });
    expect(c.card(966).done).toBeTruthy();
    expect(c.calls.some((x) => x.startsWith('deckReorder'))).toBe(false);
  });

  it('stops without marking anything when the move is ignored', async () => {
    const c = new FakeNextcloudClient(seed());
    c.ignoreReorder = true;
    c.ignoreInternalReorder = true;
    await rejectsWith(completeCard(c, 966, 1), 'deck-move-ignored');
    expect(c.card(966).stackId).toBe(12);
    expect(c.card(966).archived ?? false).toBe(false);
    expect(c.card(966).done ?? null).toBeNull();
    expect(c.calls.some((x) => x.startsWith('deckPutCard'))).toBe(false);
  });
});

describe('reopenCard', () => {
  it('clears done and unarchives, leaving the column', async () => {
    const c = new FakeNextcloudClient(seed({
      cards: [{ id: 41, stackId: 13, title: 'Old', done: '2026-09-01T00:00:00+00:00', archived: true }],
    }));
    await reopenCard(c, 41, 1);
    expect(c.card(41)).toMatchObject({ stackId: 13, done: null, archived: false });
  });
});

describe('archiveCard', () => {
  it('archives without marking done', async () => {
    const c = new FakeNextcloudClient(seed());
    await archiveCard(c, 5, 1);
    expect(c.card(5)).toMatchObject({ archived: true, stackId: 10 });
    expect(c.card(5).done ?? null).toBeNull();
  });
});

describe('changeLabels', () => {
  it('assigns and removes', async () => {
    const c = new FakeNextcloudClient(seed({
      cards: [{ id: 5, stackId: 10, title: 'Plain', labels: [{ id: 8, title: 'ui', color: '00ff00' }] }],
    }));
    await changeLabels(c, 5, { add: [7], remove: [8] }, 1);
    expect(c.card(5).labels!.map((l) => l.id)).toEqual([7]);
    expect(c.calls).toContain('deckAssignLabel 1 10 5 7');
    expect(c.calls).toContain('deckRemoveLabel 1 10 5 8');
  });

  it('skips labels already in the wanted state', async () => {
    const c = new FakeNextcloudClient(seed({
      cards: [{ id: 5, stackId: 10, title: 'Plain', labels: [{ id: 8, title: 'ui', color: '00ff00' }] }],
    }));
    await changeLabels(c, 5, { add: [8], remove: [7] }, 1);
    expect(c.calls.some((x) => x.startsWith('deckAssignLabel') || x.startsWith('deckRemoveLabel'))).toBe(false);
  });
});

describe('deleteCard', () => {
  it('deletes on the card\'s own board and stack', async () => {
    const c = new FakeNextcloudClient(seed());
    await deleteCard(c, 300, 1);
    expect(c.calls).toContain('deckDeleteCard 2 20 300');
    expect(c.hasCard(300)).toBe(false);
  });
});

describe('FakeNextcloudClient', () => {
  it('throws the fail knob once', async () => {
    const c = new FakeNextcloudClient(seed());
    c.fail = new NextcloudError('nextcloud-auth', 'no');
    await rejectsWith(c.deckBoards(), 'nextcloud-auth');
    expect(await c.deckBoards()).toHaveLength(2);
  });

  it('holds collectives, pages and bookmarks', async () => {
    const c = new FakeNextcloudClient({
      collectives: [{ id: 3, name: 'Otherworld Dev' }],
      pages: [{ id: 1, collectiveId: 3, title: 'Landing', parentId: 0, text: '# Hi' }],
      bookmarks: [{ id: 9, url: 'https://a', title: 'A', tags: ['ob'] }, { id: 10, url: 'https://b', title: 'B', tags: [] }],
    });
    expect(await c.collectives()).toEqual([{ id: 3, name: 'Otherworld Dev' }]);
    const pages = await c.collectivePages(3);
    expect(pages.map((p) => p.title)).toEqual(['Landing']);
    expect(await c.pageText(pages[0]!)).toBe('# Hi');
    expect((await c.bookmarks('ob')).map((b) => b.id)).toEqual([9]);
    const made = await c.bookmarkCreate({ url: 'https://c', tags: ['ob'] });
    expect(c.bodies.at(-1)).toEqual({ call: 'bookmarkCreate', body: { url: 'https://c', tags: ['ob'] } });
    expect((await c.bookmarks('ob')).map((b) => b.id)).toEqual([9, made.id]);
  });
});
