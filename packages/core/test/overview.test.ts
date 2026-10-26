import { describe, expect, it } from 'vitest';
import {
  buildOverview, chatNeedsYou, deckSummary, isBotLogin, issueNeed, type OverviewInput,
} from '../src/domain/overview.js';
import type { App, Chat } from '../src/ports/store.js';
import type { DeckBoardView, DeckCardSummary } from '../src/types/nextcloud.js';
import type { ChatHead, IssueActivity } from '../src/types/overview.js';

describe('isBotLogin', () => {
  it('spots bot accounts', () => {
    expect(isBotLogin('dependabot[bot]')).toBe(true);
    expect(isBotLogin('app/copilot')).toBe(true);
    expect(isBotLogin('bob')).toBe(false);
  });
});

const t = (m: number): string => new Date(Date.UTC(2026, 9, 20, 12, m)).toISOString();
function issue(over: Partial<IssueActivity> = {}): IssueActivity {
  return {
    number: 1, title: 'T', state: 'open', url: 'u', author: 'bob', authorIsBot: false,
    createdAt: t(0), closedAt: null, comments: [], ...over,
  };
}
const c = (author: string, m: number, authorIsBot = false) => ({ author, authorIsBot, createdAt: t(m) });

describe('issueNeed', () => {
  it('a new issue by someone else needs me', () => {
    expect(issueNeed(issue(), 'me', null)).toEqual({ kind: 'new', who: 'bob', at: t(0) });
  });
  it('my later comment settles it', () => {
    expect(issueNeed(issue({ comments: [c('me', 5)] }), 'me', null)).toBeNull();
  });
  it('their comment after mine needs me again', () => {
    expect(issueNeed(issue({ comments: [c('me', 5), c('bob', 10)] }), 'me', null))
      .toEqual({ kind: 'comment', who: 'bob', at: t(10) });
  });
  it('a close after their comment settles it', () => {
    expect(issueNeed(issue({ comments: [c('bob', 10)], state: 'closed', closedAt: t(20) }), 'me', null)).toBeNull();
  });
  it('a comment by someone else after the close needs me', () => {
    const a = issue({ comments: [c('bob', 10), c('alice', 30)], state: 'closed', closedAt: t(20) });
    expect(issueNeed(a, 'me', null)).toEqual({ kind: 'comment', who: 'alice', at: t(30) });
  });
  it('a bot comment after the close does not', () => {
    const a = issue({ comments: [c('bob', 10), c('dependabot[bot]', 30, true)], state: 'closed', closedAt: t(20) });
    expect(issueNeed(a, 'me', null)).toBeNull();
  });
  it('a tick-off through their last comment settles it, a later comment does not', () => {
    const a = issue({ comments: [c('bob', 10)] });
    expect(issueNeed(a, 'me', t(10))).toBeNull();
    expect(issueNeed(issue({ comments: [c('bob', 10), c('bob', 12)] }), 'me', t(10))?.at).toBe(t(12));
  });
  it('an issue I opened with no comments needs nothing', () => {
    expect(issueNeed(issue({ author: 'me' }), 'me', null)).toBeNull();
  });
  it('a bot-opened issue needs nothing', () => {
    expect(issueNeed(issue({ author: 'x[bot]', authorIsBot: true }), 'me', null)).toBeNull();
  });
});

function card(id: number, stackId: number, duedate: string | null, over: Partial<DeckCardSummary> = {}): DeckCardSummary {
  return { id, title: `C${id}`, stackId, labels: [], duedate, done: false, archived: false, ...over };
}
function view(stacks: { id: number; title: string; cards: DeckCardSummary[] }[]): DeckBoardView {
  return {
    board: { id: 1, title: 'B' }, stacks: stacks.map((s, i) => ({ ...s, order: i })),
    archived: [], labels: [], doingStackId: null, url: 'u',
  };
}
const now = new Date(2026, 9, 26, 9, 0);
const day = (offset: number, h = 12): string => new Date(2026, 9, 26 + offset, h, 0).toISOString();

describe('deckSummary', () => {
  it('finds due cards by local day and sorts most overdue first', () => {
    const v = view([
      { id: 1, title: 'Backlog', cards: [card(1, 1, null), card(2, 1, day(-2))] },
      { id: 2, title: 'To Do', cards: [card(3, 2, new Date(2026, 9, 26, 23, 30).toISOString()), card(4, 2, day(1))] },
      { id: 3, title: 'Doing', cards: [card(5, 3, null)] },
      { id: 4, title: 'Done', cards: [card(6, 4, day(-5))] },
    ]);
    const s = deckSummary(v, now);
    expect(s.due.map((d) => [d.cardId, d.overdueDays])).toEqual([[2, 2], [3, 0]]);
    expect([s.backlog, s.todo, s.doing]).toEqual([2, 2, 1]);
  });
  it('skips done and archived cards', () => {
    const v = view([{ id: 1, title: 'Doing', cards: [card(1, 1, day(-1), { done: true }), card(2, 1, day(-1), { archived: true })] }]);
    expect(deckSummary(v, now)).toEqual({ due: [], doing: 0, todo: 0, backlog: 0 });
  });
});

const head = (status: ChatHead['status'], role: ChatHead['role'] = 'assistant', createdAt = 100): ChatHead =>
  ({ chatId: 'c', role, status, createdAt });

describe('chatNeedsYou', () => {
  const open = { archivedAt: null };
  it('a finished assistant reply needs me', () => {
    expect(chatNeedsYou(open, head('complete'), false)).toBe(true);
    expect(chatNeedsYou(open, head('error'), false)).toBe(true);
  });
  it('a streaming or cancelled head does not', () => {
    expect(chatNeedsYou(open, head('streaming'), false)).toBe(false);
    expect(chatNeedsYou(open, head('cancelled'), false)).toBe(false);
  });
  it('dealtWithAt after the head settles it, before does not', () => {
    expect(chatNeedsYou({ archivedAt: null, dealtWithAt: 150 }, head('complete'), false)).toBe(false);
    expect(chatNeedsYou({ archivedAt: null, dealtWithAt: 50 }, head('complete'), false)).toBe(true);
  });
  it('archived is never, waiting is always otherwise', () => {
    expect(chatNeedsYou({ archivedAt: 1 }, head('complete'), true)).toBe(false);
    expect(chatNeedsYou(open, head('streaming', 'user'), true)).toBe(true);
    expect(chatNeedsYou(open, null, false)).toBe(false);
  });
});

function app(id: string, over: Partial<App> = {}): App {
  return {
    id, name: id.toUpperCase(), workspace: null, githubRepo: null, linkedProjectId: null, defaultProfileId: null,
    deckBoardId: null, wikiCollective: null, wikiPagePath: null, bookmarkTag: null, folderId: null,
    sortOrder: 0, createdAt: 0, updatedAt: 0, ...over,
  } as App;
}
function chat(id: string, appId: string | null, over: Partial<Chat> = {}): Chat {
  return { id, title: `chat ${id}`, appId, projectId: null, archivedAt: null, updatedAt: 1, ...over } as Chat;
}
const done = (chatId: string, createdAt: number): ChatHead => ({ chatId, role: 'assistant', status: 'complete', createdAt });
function input(over: Partial<OverviewInput>): OverviewInput {
  return {
    apps: [], chats: [], projects: [], heads: [], waitingChatIds: new Set(), me: 'me', issues: {}, ticks: [], decks: {},
    checkedAt: null, checking: false, loginMismatches: [], unreachableMachines: [], now, ...over,
  };
}

describe('buildOverview', () => {
  it('orders tiles by count, then lit before faded, then input order; adds the Chats tile', () => {
    const o = buildOverview(input({
      apps: [app('a', { deckBoardId: 1 }), app('b', { deckBoardId: 2 }), app('c', { deckBoardId: 3 }), app('d')],
      chats: [chat('1', 'd'), chat('2', 'd'), chat('3', null)],
      heads: [done('1', 1), done('2', 2), done('3', 3)],
      decks: {
        a: { view: view([{ id: 1, title: 'Backlog', cards: [card(1, 1, null)] }]) },
        b: { view: view([{ id: 2, title: 'Doing', cards: [card(2, 2, null)] }]) },
        c: { view: view([{ id: 3, title: 'Backlog', cards: [] }]) },
      },
    }));
    expect(o.tiles.map((x) => [x.key, x.count, x.faded])).toEqual([
      ['d', 2, false], ['chats', 1, false], ['b', 0, false], ['a', 0, true], ['c', 0, true],
    ]);
    expect(o.tiles[1]).toMatchObject({ appId: null, name: 'Chats', issues: null, deck: null });
    expect(o.total).toBe(3);
  });
  it('lists waiting chats first, then newest', () => {
    const o = buildOverview(input({
      apps: [app('a')],
      chats: [chat('1', 'a'), chat('2', 'a'), chat('3', 'a', { projectId: 'p' })],
      heads: [done('1', 10), done('2', 20), { chatId: '3', role: 'user', status: 'complete', createdAt: 5 }],
      waitingChatIds: new Set(['3']), projects: [{ id: 'p', name: 'Proj' }],
    }));
    expect(o.tiles[0]?.chats.map((x) => x.chatId)).toEqual(['3', '2', '1']);
    expect(o.tiles[0]?.chats[0]).toMatchObject({ waiting: true, projectName: 'Proj' });
  });
  it('a tick hides an issue; an error sets issuesError; no repo means null', () => {
    const a1 = issue({ number: 7, comments: [c('bob', 10)] });
    const base = { apps: [app('a', { githubRepo: 'o/a' }), app('b', { githubRepo: 'o/b' }), app('c')] };
    const shown = buildOverview(input({ ...base, issues: { a: { activity: [a1] }, b: { error: 'boom' } } }));
    const byKey = (o: ReturnType<typeof buildOverview>, k: string) => o.tiles.find((x) => x.key === k)!;
    expect(byKey(shown, 'a').issues).toEqual([{ number: 7, title: 'T', state: 'open', kind: 'comment', at: t(10), who: 'bob', url: 'u', through: t(10) }]);
    expect(byKey(shown, 'b')).toMatchObject({ issues: [], issuesError: 'boom' });
    expect(byKey(shown, 'c').issues).toBeNull();
    const ticked = buildOverview(input({ ...base, issues: { a: { activity: [a1] } }, ticks: [{ appId: 'a', number: 7, through: t(10) }] }));
    expect(byKey(ticked, 'a')).toMatchObject({ issues: [], count: 0 });
  });
  it('an app with a board but no result yet has an empty deck; an error is kept', () => {
    const o = buildOverview(input({ apps: [app('a', { deckBoardId: 1 }), app('b', { deckBoardId: 2 })], decks: { b: { error: 'x' } } }));
    expect(o.tiles.find((x) => x.key === 'a')?.deck).toEqual({ due: [], doing: 0, todo: 0, backlog: 0 });
    expect(o.tiles.find((x) => x.key === 'b')).toMatchObject({ deckError: 'x' });
  });
  it('counts due cards', () => {
    const o = buildOverview(input({
      apps: [app('a', { deckBoardId: 1 })],
      decks: { a: { view: view([{ id: 1, title: 'To Do', cards: [card(1, 1, day(-1))] }]) } },
    }));
    expect(o.tiles[0]).toMatchObject({ count: 1, faded: false });
  });
});
