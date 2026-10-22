import { describe, expect, it } from 'vitest';
import { NextcloudError } from '../../src/nextcloud/client.js';
import { wikiPage, wikiTree } from '../../src/nextcloud/wiki.js';
import { FakeNextcloudClient } from './fake-client.js';

const page = (id: number, title: string, parentId: number, text = '') => ({ id, title, parentId, collectiveId: 1, text });

function fake(): FakeNextcloudClient {
  return new FakeNextcloudClient({
    collectives: [{ id: 1, name: 'Otherworld Dev' }],
    pages: [
      { ...page(1, 'Landing', 0), fileName: 'Readme.md' },
      page(2, 'Products', 1),
      page(3, 'OtherBench', 2, '# OtherBench'),
      page(4, 'Design', 3, '# Design'),
      page(5, 'Specs', 4),
      page(6, 'X', 5),
      page(7, 'Other', 2),
    ],
  });
}

async function rejectsWith(p: Promise<unknown>, code: string): Promise<void> {
  const err = await p.then(() => null, (e: unknown) => e);
  expect(err).toBeInstanceOf(NextcloudError);
  expect((err as NextcloudError).code).toBe(code);
}

describe('wiki', () => {
  it('wikiTree returns the page and its descendants only', async () => {
    const tree = await wikiTree(fake(), 'Otherworld Dev', 'Products/OtherBench');
    expect(tree.rootId).toBe(3);
    expect(tree.pages.map((p) => p.id).sort()).toEqual([3, 4, 5, 6]);
    expect(tree.pages.find((p) => p.id === 3)?.parentId).toBeNull();
    expect(tree.pages.find((p) => p.id === 4)?.parentId).toBe(3);
    expect(tree.url).toBe('https://nc.example/index.php/apps/collectives/Otherworld%20Dev/Products/OtherBench');
  });

  it('wikiTree resolves case-insensitively', async () => {
    expect((await wikiTree(fake(), 'otherworld dev', 'products/otherbench')).rootId).toBe(3);
  });

  it('wikiTree on a missing path is nextcloud-not-found', async () => {
    await rejectsWith(wikiTree(fake(), 'Otherworld Dev', 'Products/Nope'), 'nextcloud-not-found');
    await rejectsWith(wikiTree(fake(), 'Nope', 'Products'), 'nextcloud-not-found');
  });

  it('wikiPage returns markdown and breadcrumbs', async () => {
    const p = await wikiPage(fake(), 'Otherworld Dev', 'Products/OtherBench', 4);
    expect(p.markdown).toBe('# Design');
    expect(p.breadcrumbs).toEqual(['OtherBench', 'Design']);
    expect(p.url).toBe('https://nc.example/index.php/apps/collectives/Otherworld%20Dev/Products/OtherBench/Design');
  });

  it('wikiPage refuses a page outside the subtree', async () => {
    await rejectsWith(wikiPage(fake(), 'Otherworld Dev', 'Products/OtherBench', 7), 'nextcloud-not-found');
  });
});
