import { describe, expect, it } from 'vitest';
import {
  asksUser, buildOverview, CHAT_NEED_WINDOW_MS, chatNeedsYou, deckSummary, isBotLogin, needsYouSince, type OverviewInput,
} from '../src/domain/overview.js';
import type { App, Chat } from '../src/ports/store.js';
import type { DeckBoardView, DeckCardSummary } from '../src/types/nextcloud.js';
import type { ChatHead, GithubNotification } from '../src/types/overview.js';

describe('isBotLogin', () => {
  it('spots bot accounts', () => {
    expect(isBotLogin('dependabot[bot]')).toBe(true);
    expect(isBotLogin('app/copilot')).toBe(true);
    expect(isBotLogin('bob')).toBe(false);
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

describe('asksUser', () => {
  it('sees a question at the end of a reply, in bold or brackets too', () => {
    expect(asksUser("I've put the mockups up.\n\nWhat's wrong or missing?")).toBe(true);
    expect(asksUser('Shall I go ahead with **option B?**')).toBe(true);
    expect(asksUser('Next is the sidebar (does that suit you?)')).toBe(true);
  });

  it('sees a question with a closing line or the options after it', () => {
    expect(asksUser("Which do you want?\n\nI'll leave the server running in the meantime.")).toBe(true);
    expect(asksUser('Which do you want?\n\n- The first\n- The second')).toBe(true);
  });

  it("isn't fooled by a link's query string", () => {
    expect(asksUser('The site is running at http://localhost:52495/?key=5f93d038')).toBe(false);
  });

  it('ignores a statement, and a question further back than the end', () => {
    expect(asksUser("I've started the build, I will carry on when it finishes.")).toBe(false);
    expect(asksUser('Why did it fail? A missing import.\n\nFixed that.\n\nThe tests are running.')).toBe(false);
    expect(asksUser('')).toBe(false);
  });
});

describe('chatNeedsYou', () => {
  const open = { archivedAt: null };
  it('a finished assistant reply needs me', () => {
    expect(chatNeedsYou(open, head('complete'), false, 0)).toBe(true);
    expect(chatNeedsYou(open, head('error'), false, 0)).toBe(true);
  });
  it('a streaming or cancelled head does not', () => {
    expect(chatNeedsYou(open, head('streaming'), false, 0)).toBe(false);
    expect(chatNeedsYou(open, head('cancelled'), false, 0)).toBe(false);
  });
  it('a chat still busy does not, unless it is waiting on them', () => {
    expect(chatNeedsYou(open, head('complete'), false, 0, true)).toBe(false);
    expect(chatNeedsYou(open, { ...head('complete'), asks: true }, false, 0, true)).toBe(true);
    expect(chatNeedsYou({ ...open, dealtWithAt: Date.now() + 1000 }, { ...head('complete'), asks: true }, false, 0, true)).toBe(false);
    expect(chatNeedsYou(open, head('complete'), true, 0, true)).toBe(true);
  });
  it('dealtWithAt after the head settles it, before does not', () => {
    expect(chatNeedsYou({ archivedAt: null, dealtWithAt: 150 }, head('complete'), false, 0)).toBe(false);
    expect(chatNeedsYou({ archivedAt: null, dealtWithAt: 50 }, head('complete'), false, 0)).toBe(true);
  });
  it('a reply from before `since` does not, but waiting does however old', () => {
    expect(chatNeedsYou(open, head('complete'), false, 100)).toBe(true);
    expect(chatNeedsYou(open, head('complete'), false, 101)).toBe(false);
    expect(chatNeedsYou(open, head('complete'), true, 101)).toBe(true);
  });
  it('archived is never, waiting is always otherwise', () => {
    expect(chatNeedsYou({ archivedAt: 1 }, head('complete'), true, 0)).toBe(false);
    expect(chatNeedsYou(open, head('streaming', 'user'), true, 0)).toBe(true);
    expect(chatNeedsYou(open, null, false, 0)).toBe(false);
  });
});

describe('needsYouSince', () => {
  const reply = (over: Partial<ChatHead> = {}): ChatHead => ({ chatId: 'c', role: 'assistant', status: 'complete', createdAt: 10, ...over });

  it('is when the reply stopped, not when it started', () => {
    expect(needsYouSince(reply({ finishedAt: 90 }), null)).toBe(90);
  });

  it("is when it started for a reply from before that was recorded, or one made finished", () => {
    expect(needsYouSince(reply(), null)).toBe(10);
  });

  it('is when the card started waiting, whatever the reply below it', () => {
    expect(needsYouSince(reply({ status: 'streaming' }), 50)).toBe(50);
    expect(needsYouSince(null, 50)).toBe(50);
  });

  it('is null with nothing to go on', () => {
    expect(needsYouSince(null, null)).toBeNull();
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
/** `ms` after an hour before `now`, inside the chat window. */
const recent = (ms: number): number => now.getTime() - 3_600_000 + ms;
const done = (chatId: string, createdAt: number): ChatHead => ({ chatId, role: 'assistant', status: 'complete', createdAt });
function note(id: string, repo: string, unread: boolean, day: number): GithubNotification {
  return { id, repo, kind: 'issue', title: `n${id}`, number: Number(id), reason: 'mention', unread, updatedAt: new Date(Date.UTC(2026, 9, 20 + day)).toISOString(), url: 'u' };
}
function input(over: Partial<OverviewInput>): OverviewInput {
  return {
    apps: [], chats: [], projects: [], heads: [], waitingChatIds: new Set(), backgroundChatIds: new Set(), me: 'me', notifications: null, decks: {}, github: true, nextcloud: true,
    checkedAt: null, checking: false, loginMismatches: [], unreachableMachines: [], now, ...over,
  };
}

describe('buildOverview', () => {
  it('orders tiles by count, then lit before faded, then input order; adds the Chats tile', () => {
    const o = buildOverview(input({
      apps: [app('a', { deckBoardId: 1 }), app('b', { deckBoardId: 2 }), app('c', { deckBoardId: 3 }), app('d')],
      chats: [chat('1', 'd'), chat('2', 'd'), chat('3', null)],
      heads: [done('1', recent(1)), done('2', recent(2)), done('3', recent(3))],
      decks: {
        a: { view: view([{ id: 1, title: 'Backlog', cards: [card(1, 1, null)] }]) },
        b: { view: view([{ id: 2, title: 'Doing', cards: [card(2, 2, null)] }]) },
        c: { view: view([{ id: 3, title: 'Backlog', cards: [] }]) },
      },
    }));
    expect(o.tiles.map((x) => [x.key, x.count, x.faded])).toEqual([
      ['d', 2, false], ['chats', 1, false], ['b', 0, false], ['a', 0, true], ['c', 0, true],
    ]);
    expect(o.tiles[1]).toMatchObject({ appId: null, name: 'Chats', notifications: null, deck: null });
    expect(o.total).toBe(3);
  });
  it('lists waiting chats first, then newest', () => {
    const o = buildOverview(input({
      apps: [app('a')],
      chats: [chat('1', 'a'), chat('2', 'a'), chat('3', 'a', { projectId: 'p' })],
      heads: [done('1', recent(10)), done('2', recent(20)), { chatId: '3', role: 'user', status: 'complete', createdAt: recent(5) }],
      waitingChatIds: new Set(['3']), projects: [{ id: 'p', name: 'Proj' }],
    }));
    expect(o.tiles[0]?.chats.map((x) => x.chatId)).toEqual(['3', '2', '1']);
    expect(o.tiles[0]?.chats[0]).toMatchObject({ waiting: true, projectName: 'Proj' });
  });
  it('leaves out a finished chat whose background tasks are still running, until it waits on the user', () => {
    const o = buildOverview(input({
      chats: [chat('1', null), chat('2', null), chat('3', null)],
      heads: [done('1', recent(10)), done('2', recent(20)), done('3', recent(30))],
      waitingChatIds: new Set(['3']), backgroundChatIds: new Set(['1', '3']),
    }));
    expect(o.tiles[0]?.chats.map((x) => x.chatId)).toEqual(['3', '2']);
  });
  it('leaves out replies older than the chat window, but not waiting chats', () => {
    const old = now.getTime() - CHAT_NEED_WINDOW_MS - 1;
    const o = buildOverview(input({
      chats: [chat('1', null), chat('2', null), chat('3', null)],
      heads: [done('1', old), done('2', now.getTime() - CHAT_NEED_WINDOW_MS), done('3', old)],
      waitingChatIds: new Set(['3']),
    }));
    expect(o.tiles[0]?.chats.map((x) => x.chatId)).toEqual(['3', '2']);
  });
  it("files each notification under its repo's app, shown once and counted; no repo means null", () => {
    const base = { apps: [app('a', { githubRepo: 'O/A' }), app('b', { githubRepo: 'o/a' }), app('c')] };
    const o = buildOverview(input({ ...base, notifications: { list: [note('1', 'o/a', false, 1), note('2', 'o/a', true, 0)], more: false, error: null } }));
    const byKey = (k: string) => o.tiles.find((x) => x.key === k);
    expect(byKey('a')).toMatchObject({ count: 2, notificationsError: null, notificationsMore: false });
    expect(byKey('a')?.notifications?.map((x) => x.id)).toEqual(['2', '1']);
    expect(byKey('b')?.notifications).toEqual([]);
    expect(byKey('c')?.notifications).toBeNull();
    expect(byKey('github')).toBeUndefined();
    expect(o.total).toBe(2);
  });
  it('puts notifications for repos that are not apps in a GitHub tile, which carries "more"', () => {
    const o = buildOverview(input({ apps: [app('a', { githubRepo: 'o/a' })], notifications: { list: [note('9', 'o/elsewhere', true, 0)], more: true, error: null } }));
    expect(o.tiles.find((x) => x.key === 'github')).toMatchObject({ appId: null, name: 'GitHub', count: 1, notificationsMore: true });
    expect(o.tiles.find((x) => x.key === 'a')).toMatchObject({ notifications: [], notificationsMore: true });
  });
  it('puts an error on every GitHub section, and a GitHub tile only for the error', () => {
    const o = buildOverview(input({ apps: [app('a', { githubRepo: 'o/a' }), app('c')], notifications: { list: [], more: false, error: 'boom' } }));
    expect(o.tiles.find((x) => x.key === 'a')).toMatchObject({ notifications: [], notificationsError: 'boom' });
    expect(o.tiles.find((x) => x.key === 'github')).toMatchObject({ notifications: [], notificationsError: 'boom', count: 0 });
    expect(o.tiles.find((x) => x.key === 'c')?.notificationsError).toBeNull();
  });
  it('before the first check, repo apps have an empty list and there is no GitHub tile', () => {
    const o = buildOverview(input({ apps: [app('a', { githubRepo: 'o/a' })] }));
    expect(o.tiles.find((x) => x.key === 'a')?.notifications).toEqual([]);
    expect(o.tiles.find((x) => x.key === 'github')).toBeUndefined();
  });
  it('an app with a board but no result yet has an empty deck; an error is kept', () => {
    const o = buildOverview(input({ apps: [app('a', { deckBoardId: 1 }), app('b', { deckBoardId: 2 })], decks: { b: { error: 'x' } } }));
    expect(o.tiles.find((x) => x.key === 'a')?.deck).toEqual({ due: [], doing: 0, todo: 0, backlog: 0 });
    expect(o.tiles.find((x) => x.key === 'b')).toMatchObject({ deckError: 'x' });
  });
  it('turned off, GitHub leaves no section, tile, login or mismatch, and Nextcloud no Deck section', () => {
    const o = buildOverview(input({
      apps: [app('a', { githubRepo: 'o/a', deckBoardId: 1 })],
      notifications: { list: [note('1', 'o/a', true, 0), note('9', 'o/elsewhere', true, 0)], more: true, error: 'boom' },
      decks: { a: { view: view([{ id: 1, title: 'To Do', cards: [card(1, 1, day(-1))] }]) } },
      loginMismatches: [{ machine: 'laptop', login: 'other' }],
      github: false, nextcloud: false,
    }));
    expect(o.tiles.find((x) => x.key === 'a')).toMatchObject({ notifications: null, notificationsError: null, deck: null, deckError: null, count: 0 });
    expect(o.tiles.find((x) => x.key === 'github')).toBeUndefined();
    expect(o).toMatchObject({ githubLogin: null, loginMismatches: [], total: 0 });
  });
  it('counts due cards', () => {
    const o = buildOverview(input({
      apps: [app('a', { deckBoardId: 1 })],
      decks: { a: { view: view([{ id: 1, title: 'To Do', cards: [card(1, 1, day(-1))] }]) } },
    }));
    expect(o.tiles[0]).toMatchObject({ count: 1, faded: false });
  });
});
