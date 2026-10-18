import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReplyNote } from '@otherbench/core/types/notes.js';

/** A page load: the modules evaluated afresh over the tab's session storage, as a reload does. */
async function pageLoad() {
  vi.resetModules();
  const { CLIENT_ID } = await import('../lib/clientId.js');
  const { useOtherBenchStore } = await import('./store.js');
  return { CLIENT_ID, s: () => useOtherBenchStore.getState() };
}

const note = (id: string, clientId: string): ReplyNote => ({
  id, chatId: 'c1', text: `typed ${id}`, attachments: [], path: 'wait', replyIds: ['r1'], parentId: 'r1', profileIds: ['p1'], clientId, sentAt: 1,
});

describe('notes across a reload of the tab', () => {
  beforeEach(() => sessionStorage.clear());
  afterEach(() => vi.restoreAllMocks());

  it('keeps the tab its client id; a new tab gets its own', async () => {
    const first = await pageLoad();
    const reloaded = await pageLoad();
    expect(reloaded.CLIENT_ID).toBe(first.CLIENT_ID);
    sessionStorage.clear();
    expect((await pageLoad()).CLIENT_ID).not.toBe(first.CLIENT_ID);
  });

  it('a note sent before a reload comes back to the box when it is returned after it', async () => {
    const before = await pageLoad();
    const sent = note('n1', before.CLIENT_ID);
    before.s().noteSent(sent);

    const after = await pageLoad();
    expect(after.s().sentNotes).toEqual({ n1: sent });
    after.s().applyChatEvent('c1', { type: 'note-resolved', chatId: 'c1', noteId: 'n1', outcome: 'returned', clientId: after.CLIENT_ID, note: sent });

    expect(after.s().takeReturnedNotes('c1').map((n) => n.text)).toEqual(['typed n1']);
    // Resolved, so the next load doesn't hold it any more.
    expect((await pageLoad()).s().sentNotes).toEqual({});
  });

  it('a note the server no longer has comes back on the hello after a reload, exactly once', async () => {
    const before = await pageLoad();
    before.s().noteSent(note('n1', before.CLIENT_ID));

    const after = await pageLoad();
    after.s().setChatNotes('c1', [], []);
    expect(after.s().returnedNotes.map((n) => n.id)).toEqual(['n1']);

    const again = await pageLoad();
    again.s().setChatNotes('c1', [], []);
    expect(again.s().returnedNotes).toEqual([]);
  });

  it('works with session storage blocked', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    const page = await pageLoad();
    expect(page.CLIENT_ID).toMatch(/^[0-9a-f-]{36}$/);
    page.s().noteSent(note('n1', page.CLIENT_ID));
    page.s().applyChatEvent('c1', { type: 'note-resolved', chatId: 'c1', noteId: 'n1', outcome: 'returned', clientId: page.CLIENT_ID, note: note('n1', page.CLIENT_ID) });
    expect(page.s().returnedNotes.map((n) => n.id)).toEqual(['n1']);
    expect(page.s().sentNotes).toEqual({});
  });
});
