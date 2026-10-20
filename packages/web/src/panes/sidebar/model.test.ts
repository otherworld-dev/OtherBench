import { describe, expect, it } from 'vitest';
import type { App, Chat, Project } from '@otherbench/core/ports/store.js';
import { NO_PROJECT_KEY, UNKNOWN_APP_KEY } from '../../state/sidebarGroups.js';
import { ageBucket, allGroups, bucketRuns, buildCodeSidebar, buildSidebar, capRows, moveProjectPatches, moveTarget, placeChatPatches, placeProjectPatches, projectSiblings, titleMatches } from './model.js';

function chat(id: string, over: Partial<Chat> = {}): Chat {
  return { id, title: id, profileId: 'p', headMessageId: null, workspace: null, runsOn: 'node-self', workspaceRoot: null, pinned: false, projectPinned: false, unread: false, archivedAt: null, autoMode: false, projectId: null, appId: null, memoryCursor: null, memoryExcluded: false, sortOrder: 0, createdAt: 1, updatedAt: 1, ...over };
}

function project(id: string, name: string, sortOrder = 0): Project {
  return { id, name, description: '', instructions: '', workspace: null, workspaceRoot: null, defaultProfileId: null, sortOrder, createdAt: 1, updatedAt: 1 };
}

function app(id: string, name: string, sortOrder = 0): App {
  return { id, name, workspace: null, githubRepo: null, linkedProjectId: null, defaultProfileId: null, sortOrder, createdAt: 1, updatedAt: 1 };
}

const ids = (chats: Chat[]): string[] => chats.map((c) => c.id);

describe('buildSidebar and apps (spec 2026-10-20-code-tab-design, "Chats live in one mode only")', () => {
  it('lists only the plain chat when one chat is in an app', () => {
    const model = buildSidebar([chat('in-app', { appId: 'A' }), chat('plain')], [], null);
    expect(model.groups.flatMap((g) => ids(g.chats))).toEqual(['plain']);
  });

  it('leaves app chats out of Pinned, every group and Archived, even when their app is not loaded', () => {
    const model = buildSidebar(
      [
        chat('pinned-app', { appId: 'A', pinned: true }),
        chat('project-app', { appId: 'A', projectId: 'p' }),
        chat('archived-app', { appId: 'A', archivedAt: 5 }),
        chat('unknown-app', { appId: 'gone' }),
        chat('plain', { projectId: 'p' }),
      ],
      [project('p', 'P')],
      null
    );
    expect(model.pinned).toEqual([]);
    expect(allGroups(model).flatMap((g) => [...ids(g.pinnedChats), ...ids(g.chats)])).toEqual(['plain']);
    expect(model.groups.find((g) => g.key === 'p')!.total).toBe(1);
    expect(model.archived).toEqual([]);
  });

  it("while searching, lists Code mode's matching chats apart, newest activity first, archived ones included (I3)", () => {
    const chats = [
      chat('app-old', { appId: 'A', updatedAt: 1 }),
      chat('app-new', { appId: 'gone', archivedAt: 5, updatedAt: 9 }),
      chat('app-miss', { appId: 'A' }),
      chat('plain'),
    ];
    expect(buildSidebar(chats, [], null).otherMode).toEqual([]);
    const model = buildSidebar(chats, [], new Set(['app-old', 'app-new', 'plain']));
    expect(ids(model.otherMode)).toEqual(['app-new', 'app-old']);
    expect(model.groups.flatMap((g) => ids(g.chats))).toEqual(['plain']);
  });
});

describe('buildCodeSidebar', () => {
  it('groups two chats under app A in sortOrder, and puts a chat whose app is not loaded in a trailing Unknown app group', () => {
    const model = buildCodeSidebar(
      [chat('low', { appId: 'A', sortOrder: 1 }), chat('high', { appId: 'A', sortOrder: 2 }), chat('stray', { appId: 'gone' }), chat('plain')],
      [app('A', 'Alpha')],
      null
    );
    expect(model.groups.map((g) => g.key)).toEqual(['A', UNKNOWN_APP_KEY]);
    expect(model.groups[0]!.app?.id).toBe('A');
    expect(ids(model.groups[0]!.chats)).toEqual(['high', 'low']);
    expect(model.groups[0]!.total).toBe(2);
    expect(model.groups[1]!.app).toBeNull();
    expect(ids(model.groups[1]!.chats)).toEqual(['stray']);
  });

  it('orders apps with compareApps, shows an app with no chats, and has no Unknown app group when every app is loaded', () => {
    const model = buildCodeSidebar([chat('a1', { appId: 'a' })], [app('b', 'beta', 1), app('a', 'Alpha', 1), app('z', 'Zed', 0)], null);
    expect(model.groups.map((g) => g.key)).toEqual(['z', 'a', 'b']);
    expect(model.groups[0]!.chats).toEqual([]);
    expect(model.groups[0]!.total).toBe(0);
  });

  it('keeps archived chats out of the groups and lists archived app chats, newest activity first; never a plain chat', () => {
    const model = buildCodeSidebar(
      [
        chat('live', { appId: 'A' }),
        chat('old', { appId: 'A', archivedAt: 5, updatedAt: 1 }),
        chat('new', { appId: 'gone', archivedAt: 6, updatedAt: 9 }),
        chat('plain-archived', { archivedAt: 7 }),
      ],
      [app('A', 'Alpha')],
      null
    );
    expect(model.groups.map((g) => g.key)).toEqual(['A']);
    expect(ids(model.groups[0]!.chats)).toEqual(['live']);
    expect(model.groups[0]!.total).toBe(1);
    expect(ids(model.archived)).toEqual(['new', 'old']);
  });

  it('lists a pinned app chat first in its own group (there is no Pinned section in Code mode)', () => {
    const model = buildCodeSidebar([chat('top', { appId: 'A', sortOrder: 9 }), chat('kept', { appId: 'A', pinned: true, sortOrder: 1 })], [app('A', 'Alpha')], null);
    expect(ids(model.groups[0]!.chats)).toEqual(['kept', 'top']);
  });

  it('while searching, keeps only matching chats and drops apps left with none', () => {
    const model = buildCodeSidebar(
      [chat('hit', { appId: 'A' }), chat('miss', { appId: 'A' }), chat('other', { appId: 'B' }), chat('gone-miss', { appId: 'gone' }), chat('arch', { appId: 'B', archivedAt: 3 })],
      [app('A', 'Alpha'), app('B', 'Beta')],
      new Set(['hit', 'arch'])
    );
    expect(model.groups.map((g) => g.key)).toEqual(['A']);
    expect(ids(model.groups[0]!.chats)).toEqual(['hit']);
    expect(model.groups[0]!.total).toBe(2);
    expect(ids(model.archived)).toEqual(['arch']);
  });

  it("while searching, lists Chat mode's matching chats apart, newest activity first, archived ones included (I3)", () => {
    const chats = [chat('plain-old', { updatedAt: 1 }), chat('plain-new', { projectId: 'p', archivedAt: 5, updatedAt: 9 }), chat('plain-miss'), chat('hit', { appId: 'A' })];
    expect(buildCodeSidebar(chats, [app('A', 'Alpha')], null).otherMode).toEqual([]);
    const model = buildCodeSidebar(chats, [app('A', 'Alpha')], new Set(['plain-old', 'plain-new', 'hit']));
    expect(ids(model.otherMode)).toEqual(['plain-new', 'plain-old']);
    expect(ids(model.groups[0]!.chats)).toEqual(['hit']);
  });
});

describe('buildSidebar', () => {
  it('orders project groups by sortOrder then name, with No project last', () => {
    const model = buildSidebar([], [project('b', 'beta', 1), project('a', 'Alpha', 1), project('z', 'Zed', 0)], null);
    expect(model.groups.map((g) => g.key)).toEqual(['z', 'a', 'b', NO_PROJECT_KEY]);
    expect(model.groups.at(-1)!.project).toBeNull();
  });

  it('leaves archived chats out of the groups and shows pinned chats only under Pinned, while still counting them in their project', () => {
    const model = buildSidebar(
      [chat('pinned', { projectId: 'a', pinned: true }), chat('plain', { projectId: 'a' }), chat('archived', { projectId: 'a', archivedAt: 5 })],
      [project('a', 'Alpha')],
      null
    );
    expect(ids(model.pinned)).toEqual(['pinned']);
    expect(ids(model.groups[0]!.chats)).toEqual(['plain']);
    expect(model.groups[0]!.total).toBe(2);
  });

  it("lists a project's pinned chats first, apart from the rest; a globally pinned chat stays under Pinned; No project ignores the flag", () => {
    const model = buildSidebar(
      [
        chat('plain', { projectId: 'a', sortOrder: 9 }),
        chat('kept-low', { projectId: 'a', projectPinned: true, sortOrder: 1 }),
        chat('kept-high', { projectId: 'a', projectPinned: true, sortOrder: 2 }),
        chat('both', { projectId: 'a', projectPinned: true, pinned: true }),
        chat('loose', { projectPinned: true }), // its project was deleted
      ],
      [project('a', 'Alpha')],
      null
    );
    const alpha = model.groups[0]!;
    expect(ids(alpha.pinnedChats)).toEqual(['kept-high', 'kept-low']);
    expect(ids(alpha.chats)).toEqual(['plain']);
    expect(alpha.total).toBe(4);
    expect(ids(model.pinned)).toEqual(['both']);
    const none = model.groups.at(-1)!;
    expect(ids(none.pinnedChats)).toEqual([]);
    expect(ids(none.chats)).toEqual(['loose']);
  });

  it("filters a project's pinned chats by search too, and drops a group whose only match is pinned in it", () => {
    const chats = [chat('kept', { projectId: 'a', projectPinned: true }), chat('plain', { projectId: 'a' }), chat('other', { projectId: 'b' })];
    const model = buildSidebar(chats, [project('a', 'Alpha'), project('b', 'Beta')], new Set(['kept']));
    expect(model.groups.map((g) => g.key)).toEqual(['a']);
    expect(ids(model.groups[0]!.pinnedChats)).toEqual(['kept']);
    expect(ids(model.groups[0]!.chats)).toEqual([]);
  });

  it('returns archived chats in a separate list, newest activity first, filtered by search (controller ruling R2)', () => {
    const chats = [
      chat('old', { archivedAt: 5, updatedAt: 1, projectId: 'a' }),
      chat('new', { archivedAt: 6, updatedAt: 9, pinned: true }),
      chat('live'),
    ];
    expect(ids(buildSidebar(chats, [project('a', 'Alpha')], null).archived)).toEqual(['new', 'old']);
    expect(ids(buildSidebar(chats, [project('a', 'Alpha')], new Set(['old', 'live'])).archived)).toEqual(['old']);
    expect(buildSidebar([chat('live')], [], null).archived).toEqual([]);
  });

  it('puts a chat whose project is not loaded under No project (review focus 5)', () => {
    const model = buildSidebar([chat('orphan', { projectId: 'gone' })], [project('a', 'Alpha')], null);
    expect(ids(model.groups.find((g) => g.key === NO_PROJECT_KEY)!.chats)).toEqual(['orphan']);
    expect(model.groups.find((g) => g.key === 'a')!.total).toBe(0);
  });

  it('sorts groups and Pinned by sortOrder, highest first, whatever the activity', () => {
    const model = buildSidebar(
      [
        chat('low', { sortOrder: 1, updatedAt: 9 }),
        chat('high', { sortOrder: 9, updatedAt: 1 }),
        chat('mid', { sortOrder: 5 }),
        chat('p1', { pinned: true, sortOrder: 1 }),
        chat('p2', { pinned: true, sortOrder: 2 }),
      ],
      [],
      null
    );
    expect(ids(model.groups[0]!.chats)).toEqual(['high', 'mid', 'low']);
    expect(ids(model.pinned)).toEqual(['p2', 'p1']);
  });

  it('breaks sortOrder ties by newest activity', () => {
    const model = buildSidebar([chat('old', { updatedAt: 1 }), chat('new', { updatedAt: 9 }), chat('mid', { updatedAt: 5 })], [], null);
    expect(ids(model.groups[0]!.chats)).toEqual(['new', 'mid', 'old']);
  });

  it('while searching, filters every list to the matches and drops groups left with none', () => {
    const model = buildSidebar(
      [chat('a1', { projectId: 'a' }), chat('b1', { projectId: 'b' }), chat('b2', { projectId: 'b', pinned: true }), chat('loose')],
      [project('a', 'Alpha'), project('b', 'Beta')],
      new Set(['b1', 'b2'])
    );
    expect(ids(model.pinned)).toEqual(['b2']);
    expect(model.groups.map((g) => g.key)).toEqual(['b']);
    expect(ids(model.groups[0]!.chats)).toEqual(['b1']);
  });
});

describe('moveProjectPatches', () => {
  it('swaps a project with its neighbour', () => {
    const ps = [project('a', 'A', 0), project('b', 'B', 1), project('c', 'C', 2)];
    expect(moveProjectPatches(ps, 'a', 1)).toEqual([
      { id: 'b', sortOrder: 0 },
      { id: 'a', sortOrder: 1 },
    ]);
    expect(moveProjectPatches(ps, 'c', -1)).toEqual([
      { id: 'c', sortOrder: 1 },
      { id: 'b', sortOrder: 2 },
    ]);
  });

  it('returns nothing at either end or for an unknown id', () => {
    const ps = [project('a', 'A', 0), project('b', 'B', 1)];
    expect(moveProjectPatches(ps, 'a', -1)).toEqual([]);
    expect(moveProjectPatches(ps, 'b', 1)).toEqual([]);
    expect(moveProjectPatches(ps, 'nope', 1)).toEqual([]);
  });

  it('renumbers projects that share a sortOrder, so a move always takes effect', () => {
    const ps = [project('a', 'A', 0), project('b', 'B', 0), project('c', 'C', 0)];
    expect(moveProjectPatches(ps, 'c', -1)).toEqual([
      { id: 'c', sortOrder: 1 },
      { id: 'b', sortOrder: 2 },
    ]);
  });
});

describe('placeChatPatches', () => {
  const section = [chat('a', { sortOrder: 30 }), chat('b', { sortOrder: 20 }), chat('c', { sortOrder: 10 })];

  it('puts a chat between two others with one patch, half way', () => {
    expect(placeChatPatches(section, section[2]!, 'b')).toEqual([{ id: 'c', sortOrder: 25 }]);
  });

  it('puts a chat at the top, one above the first, and at the bottom, one below the last', () => {
    expect(placeChatPatches(section, section[2]!, 'a')).toEqual([{ id: 'c', sortOrder: 31 }]);
    expect(placeChatPatches(section, section[0]!, null)).toEqual([{ id: 'a', sortOrder: 9 }]);
  });

  it('places a chat coming from another section', () => {
    expect(placeChatPatches(section, chat('x', { sortOrder: 99 }), 'c')).toEqual([{ id: 'x', sortOrder: 15 }]);
    expect(placeChatPatches([], chat('x', { sortOrder: 99 }), null)).toEqual([{ id: 'x', sortOrder: 99 }]);
  });

  it('returns nothing when the chat is already there, or the target is unknown', () => {
    expect(placeChatPatches(section, section[1]!, 'c')).toEqual([]);
    expect(placeChatPatches(section, section[2]!, null)).toEqual([]);
    expect(placeChatPatches(section, section[0]!, 'nope')).toEqual([]);
  });

  it('renumbers the section when the neighbours are too close to fit a value between', () => {
    const tight = [chat('a', { sortOrder: 1 }), chat('b', { sortOrder: 1 }), chat('c', { sortOrder: 0 })];
    expect(placeChatPatches(tight, tight[2]!, 'b')).toEqual([
      { id: 'a', sortOrder: 3 },
      { id: 'c', sortOrder: 2 },
    ]);
  });
});

describe('moveTarget', () => {
  const section = [chat('a'), chat('b'), chat('c')];

  it('moves up above the previous chat, and down above the one after next', () => {
    expect(moveTarget(section, 'b', -1)).toEqual({ beforeId: 'a' });
    expect(moveTarget(section, 'a', 1)).toEqual({ beforeId: 'c' });
    expect(moveTarget(section, 'b', 1)).toEqual({ beforeId: null });
  });

  it('is undefined at either end or for an unknown chat', () => {
    expect(moveTarget(section, 'a', -1)).toBeUndefined();
    expect(moveTarget(section, 'c', 1)).toBeUndefined();
    expect(moveTarget(section, 'z', 1)).toBeUndefined();
  });
});

describe('buildSidebar sorts', () => {
  const chats = [
    chat('old-high', { sortOrder: 9, updatedAt: 1 }),
    chat('new-low', { sortOrder: 1, updatedAt: 50 }),
    chat('mid', { sortOrder: 5, updatedAt: 20 }),
    chat('a-old-kept', { projectId: 'a', projectPinned: true, sortOrder: 9, updatedAt: 1 }),
    chat('a-new-kept', { projectId: 'a', projectPinned: true, sortOrder: 1, updatedAt: 9 }),
  ];

  it('orders every group by hand when no sort is given', () => {
    const model = buildSidebar(chats, [project('a', 'Alpha')], null);
    expect(model.groups.map((g) => g.sort)).toEqual(['manual', 'manual']);
    expect(ids(model.groups.at(-1)!.chats)).toEqual(['old-high', 'mid', 'new-low']);
  });

  it('orders a recent group, its pinned-in-project chats included, by last activity', () => {
    const model = buildSidebar(chats, [project('a', 'Alpha')], null, () => 'recent');
    expect(model.groups.map((g) => g.sort)).toEqual(['recent', 'recent']);
    expect(ids(model.groups.at(-1)!.chats)).toEqual(['new-low', 'mid', 'old-high']);
    expect(ids(model.groups[0]!.pinnedChats)).toEqual(['a-new-kept', 'a-old-kept']);
  });

  it('sorts each group by its own setting', () => {
    const model = buildSidebar(chats, [project('a', 'Alpha')], null, (key) => (key === NO_PROJECT_KEY ? 'recent' : 'manual'));
    expect(ids(model.groups[0]!.pinnedChats)).toEqual(['a-old-kept', 'a-new-kept']);
    expect(ids(model.groups.at(-1)!.chats)).toEqual(['new-low', 'mid', 'old-high']);
  });
});

describe('capRows', () => {
  const twelve = Array.from({ length: 12 }, (_, i) => chat(`c${i}`));

  it('shows everything at or under the cap', () => {
    expect(capRows(twelve.slice(0, 10), 10, null)).toEqual({ visible: twelve.slice(0, 10), hidden: 0 });
  });

  it('shows the first `cap` and counts the rest', () => {
    const { visible, hidden } = capRows(twelve, 10, null);
    expect(ids(visible)).toEqual(ids(twelve.slice(0, 10)));
    expect(hidden).toBe(2);
  });

  it('keeps the active chat in view past the cap, in its place', () => {
    const { visible, hidden } = capRows(twelve, 10, 'c11');
    expect(ids(visible)).toEqual([...ids(twelve.slice(0, 10)), 'c11']);
    expect(hidden).toBe(1);
    expect(capRows(twelve, 10, 'c3').hidden).toBe(2);
  });
});

describe('ageBucket and bucketRuns', () => {
  // 15:00 local time, so "today" and "7 days ago" are well apart.
  const now = new Date(2026, 9, 15, 15, 0, 0).getTime();
  const day = 24 * 3_600_000;
  const midnight = new Date(2026, 9, 15, 0, 0, 0).getTime();

  it('splits at local midnight, then 7 and 30 days back', () => {
    expect(ageBucket(midnight, now)).toBe('today');
    expect(ageBucket(midnight - 1, now)).toBe('week');
    expect(ageBucket(now - 7 * day, now)).toBe('week');
    expect(ageBucket(now - 7 * day - 1, now)).toBe('month');
    expect(ageBucket(now - 30 * day, now)).toBe('month');
    expect(ageBucket(now - 30 * day - 1, now)).toBe('older');
    expect(ageBucket(now + 5_000, now)).toBe('today');
  });

  it('groups consecutive chats under one heading each', () => {
    const runs = bucketRuns(
      [chat('a', { updatedAt: now - 1 }), chat('b', { updatedAt: midnight + 1 }), chat('c', { updatedAt: now - 2 * day }), chat('d', { updatedAt: now - 90 * day })],
      now
    );
    expect(runs.map((r) => [r.bucket, ids(r.chats)])).toEqual([
      ['today', ['a', 'b']],
      ['week', ['c']],
      ['older', ['d']],
    ]);
    expect(bucketRuns([], now)).toEqual([]);
  });
});

describe('titleMatches', () => {
  it('needs every word, in any order and case', () => {
    expect(titleMatches('Fix the Sidebar overflow', 'sidebar fix')).toBe(true);
    expect(titleMatches('Fix the Sidebar overflow', 'sidebar  FIX ')).toBe(true);
    expect(titleMatches('Fix the Sidebar overflow', 'sidebar tabs')).toBe(false);
  });

  it('matches nothing for a blank query', () => {
    expect(titleMatches('Anything', '   ')).toBe(false);
  });
});

describe('buildSidebar with sub-projects (spec 2026-10-15-sub-projects-design §4)', () => {
  const sub = (id: string, name: string, parentId: string, sortOrder = 0): Project => ({ ...project(id, name, sortOrder), parentId });
  const projects = [project('g', 'OtherBench', 0), sub('d', 'Desktop', 'g', 1), sub('s', 'Sync', 'g', 0), project('p', 'PhD', 1)];
  const chats = [chat('g1', { projectId: 'g' }), chat('d1', { projectId: 'd' }), chat('d2', { projectId: 'd' }), chat('s1', { projectId: 's', pinned: true }), chat('loose')];

  it('nests sub-projects inside their parent, in order, and counts their chats in the parent', () => {
    const model = buildSidebar(chats, projects, null);
    expect(model.groups.map((g) => g.key)).toEqual(['g', 'p', NO_PROJECT_KEY]);
    const otherbench = model.groups[0]!;
    expect(otherbench.children.map((c) => c.key)).toEqual(['s', 'd']);
    expect(ids(otherbench.chats)).toEqual(['g1']);
    expect(ids(otherbench.children[1]!.chats).sort()).toEqual(['d1', 'd2']);
    // Its own chat, Desktop's two and Sync's pinned one.
    expect(otherbench.total).toBe(4);
    expect(otherbench.children[1]!.total).toBe(2);
    expect(model.groups[1]!.children).toEqual([]);
    expect(allGroups(model).map((g) => g.key)).toEqual(['g', 's', 'd', 'p', NO_PROJECT_KEY]);
  });

  it('shows a sub-project whose parent is missing or nested at the top level', () => {
    const model = buildSidebar([], [project('a', 'A', 0), sub('orphan', 'Orphan', 'gone', 1), sub('mid', 'Mid', 'a', 0), sub('deep', 'Deep', 'mid', 2)], null);
    expect(model.groups.map((g) => g.key)).toEqual(['a', 'orphan', 'deep', NO_PROJECT_KEY]);
    expect(model.groups[0]!.children.map((c) => c.key)).toEqual(['mid']);
  });

  it('while searching keeps a parent for a match in a sub-project, and drops sub-projects without one', () => {
    const model = buildSidebar(chats, projects, new Set(['d2']));
    expect(model.groups.map((g) => g.key)).toEqual(['g']);
    expect(ids(model.groups[0]!.chats)).toEqual([]);
    expect(model.groups[0]!.children.map((c) => c.key)).toEqual(['d']);
    expect(ids(model.groups[0]!.children[0]!.chats)).toEqual(['d2']);
  });

  it('projectSiblings: top-level projects together, a parent\'s sub-projects together', () => {
    expect(projectSiblings(projects, 'p').map((p) => p.id)).toEqual(['g', 'p']);
    expect(projectSiblings(projects, 'd').map((p) => p.id)).toEqual(['s', 'd']);
    expect(projectSiblings(projects, 'nope')).toEqual([]);
    // Move up/down among siblings only renumbers them.
    expect(moveProjectPatches(projectSiblings(projects, 'd'), 'd', -1)).toEqual([
      { id: 'd', sortOrder: 0 },
      { id: 's', sortOrder: 1 },
    ]);
  });
});

describe('placeProjectPatches', () => {
  const four = [project('a', 'A', 0), project('b', 'B', 1), project('c', 'C', 2), project('d', 'D', 3)];

  it('moves a project above another, renumbering only the ones that change', () => {
    expect(placeProjectPatches(four, 'd', 'b')).toEqual([
      { id: 'd', sortOrder: 1 },
      { id: 'b', sortOrder: 2 },
      { id: 'c', sortOrder: 3 },
    ]);
    expect(placeProjectPatches(four, 'a', 'c')).toEqual([
      { id: 'b', sortOrder: 0 },
      { id: 'a', sortOrder: 1 },
    ]);
  });

  it('moves a project to the end with a null beforeId', () => {
    expect(placeProjectPatches(four, 'b', null)).toEqual([
      { id: 'c', sortOrder: 1 },
      { id: 'd', sortOrder: 2 },
      { id: 'b', sortOrder: 3 },
    ]);
  });

  it('sends nothing for a drop where it already is, or for an unknown project or target', () => {
    expect(placeProjectPatches(four, 'b', 'c')).toEqual([]);
    expect(placeProjectPatches(four, 'd', null)).toEqual([]);
    expect(placeProjectPatches(four, 'x', 'a')).toEqual([]);
    expect(placeProjectPatches(four, 'a', 'x')).toEqual([]);
  });

  it('orders by compareProjects first, so tied sortOrders still land where dropped', () => {
    const tied = [project('a', 'Alpha', 0), project('b', 'Beta', 0), project('c', 'Gamma', 0)];
    expect(placeProjectPatches(tied, 'c', 'a')).toEqual([
      { id: 'a', sortOrder: 1 },
      { id: 'b', sortOrder: 2 },
    ]);
  });
});
