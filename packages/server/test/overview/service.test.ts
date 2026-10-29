import { beforeEach, describe, expect, it } from 'vitest';
import { InMemoryStore } from '@otherbench/core/testing/fakes.js';
import type { AppEvent } from '@otherbench/core/types/events.js';
import type { GithubNotification, OverviewTile } from '@otherbench/core/types/overview.js';
import { GhError } from '../../src/code/github.js';
import { OVERVIEW_INTERVAL_MS, OverviewService, type OverviewDeps, type OverviewMachine } from '../../src/overview/service.js';
import { ManualClock } from '../memory/manual-clock.js';
import { FakeNextcloudClient } from '../nextcloud/fake-client.js';

const NOW = Date.parse('2026-10-26T09:00:00Z');
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const GH_SIGNED_OUT = 'The GitHub CLI is not signed in. Run `gh auth login` in a terminal.';

/** A notification in `repo`, unread, updated at `at`. */
function note(id: string, repo: string, at: string, over: Partial<GithubNotification> = {}): GithubNotification {
  return { id, repo, kind: 'issue', title: `Note ${id}`, number: Number(id), reason: 'mention', unread: true, updatedAt: at, url: `https://github.com/${repo}/issues/${id}`, ...over };
}

/** A fake gh: `login`, the inbox, and Done/read, each settable to throw. */
class FakeGh {
  me: string | Error = 'adam';
  inbox: GithubNotification[] | Error = [];
  more = false;
  failDone: Error | null = null;
  calls: string[] = [];
  async login(): Promise<string> {
    this.calls.push('login');
    if (this.me instanceof Error) throw this.me;
    return this.me;
  }
  async notifications(): Promise<{ list: GithubNotification[]; more: boolean }> {
    this.calls.push('notifications');
    if (this.inbox instanceof Error) throw this.inbox;
    return { list: structuredClone(this.inbox), more: this.more };
  }
  async markDone(id: string): Promise<void> {
    this.calls.push(`done ${id}`);
    if (this.failDone) throw this.failDone;
  }
  async markRead(id: string): Promise<void> {
    this.calls.push(`read ${id}`);
  }
}

/** Board 1: Backlog/To Do/Doing/Done, a Doing card two days overdue, one To Do card, two Backlog cards. */
function fakeNextcloud(): FakeNextcloudClient {
  return new FakeNextcloudClient({
    boards: [{ id: 1, title: 'OtherBench' }],
    stacks: [
      { id: 10, boardId: 1, title: 'Backlog', order: 0 },
      { id: 11, boardId: 1, title: 'To Do', order: 1 },
      { id: 12, boardId: 1, title: 'Doing', order: 2 },
      { id: 13, boardId: 1, title: 'Done', order: 3 },
    ],
    cards: [
      { id: 900, stackId: 12, title: 'Ship it', duedate: '2026-10-24T12:00:00+00:00' },
      { id: 901, stackId: 11, title: 'Next' },
      { id: 902, stackId: 10, title: 'Later' },
      { id: 903, stackId: 10, title: 'Much later' },
      { id: 904, stackId: 13, title: 'Finished', duedate: '2026-10-20T12:00:00+00:00' },
    ],
  });
}

let clock: ManualClock;
let store: InMemoryStore;
let gh: FakeGh;
let nc: FakeNextcloudClient | null;
let waiting: string[];
let machines: OverviewMachine[];
let events: AppEvent[];
let loginChanges: number;

/** A chat whose latest message is `role`'s, finished at `at`. */
function chat(id: string, appId: string | null, role: 'user' | 'assistant', at: number, over: { runsOn?: string; archivedAt?: number | null } = {}): void {
  store.messages.create({ id: `${id}-m`, chatId: id, parentId: null, role, parts: [], status: 'complete', error: null, producedBy: null, createdAt: at });
  store.chats.create({
    id, title: id, profileId: 'p', headMessageId: `${id}-m`, workspaceRoot: null, pinned: false,
    archivedAt: over.archivedAt ?? null, appId, ...(over.runsOn ? { runsOn: over.runsOn } : {}),
  });
}

function service(over: Partial<OverviewDeps> = {}): OverviewService {
  return new OverviewService({
    store,
    github: () => gh,
    nextcloud: async () => nc,
    waitingChatIds: () => waiting,
    machines: () => machines,
    emit: (e) => events.push(e),
    onLoginChanged: () => loginChanges++,
    scheduler: clock,
    now: clock.now,
    ...over,
  });
}

const tileOf = (svc: OverviewService, key: string): OverviewTile => {
  const t = svc.view().tiles.find((x) => x.key === key);
  if (!t) throw new Error(`no tile ${key}`);
  return t;
};

beforeEach(() => {
  clock = new ManualClock(NOW);
  store = new InMemoryStore();
  gh = new FakeGh();
  nc = fakeNextcloud();
  waiting = [];
  machines = [];
  events = [];
  loginChanges = 0;
  // Repo and board; repo only; board only; neither.
  store.apps.create({ id: 'a1', name: 'OtherBench', githubRepo: 'o/ob', deckBoardId: 1 });
  store.apps.create({ id: 'a2', name: 'Site', githubRepo: 'o/site' });
  store.apps.create({ id: 'a3', name: 'Notes', deckBoardId: 1 });
  store.apps.create({ id: 'a4', name: 'Plain' });
  gh.inbox = [note('7', 'o/ob', '2026-10-25T10:00:00Z'), note('8', 'o/elsewhere', '2026-10-24T10:00:00Z', { unread: false })];
});

describe('OverviewService checks', () => {
  it('checks at start and again every OVERVIEW_INTERVAL_MS; dispose leaves no timer', async () => {
    const svc = service();
    expect(OVERVIEW_INTERVAL_MS).toBe(15 * 60_000);
    svc.start();
    await svc.refresh();
    expect(gh.calls.filter((c) => c === 'login')).toHaveLength(1);
    expect(clock.pending()).toEqual([OVERVIEW_INTERVAL_MS]);

    clock.advance(OVERVIEW_INTERVAL_MS - 1);
    expect(gh.calls.filter((c) => c === 'login')).toHaveLength(1);
    clock.advance(1);
    await svc.refresh();
    expect(gh.calls.filter((c) => c === 'login')).toHaveLength(2);
    expect(clock.pending()).toEqual([OVERVIEW_INTERVAL_MS]);

    svc.dispose();
    expect(clock.pending()).toEqual([]);
  });

  it('builds tiles from gh, Deck and the store', async () => {
    chat('c1', 'a1', 'assistant', NOW - HOUR);
    const svc = service();
    await svc.refresh();
    const ob = tileOf(svc, 'a1');
    expect(ob.notifications?.map((n) => n.id)).toEqual(['7']);
    expect(ob.notificationsError).toBeNull();
    expect(ob.deck).toMatchObject({ doing: 1, todo: 1, backlog: 2 });
    expect(ob.deck?.due.map((d) => [d.cardId, d.overdueDays])).toEqual([[900, 2]]);
    expect(ob.chats.map((c) => c.chatId)).toEqual(['c1']);
    expect(ob.count).toBe(3);
    expect(tileOf(svc, 'a2').notifications).toEqual([]);
    expect(tileOf(svc, 'a3').notifications).toBeNull();
    expect(tileOf(svc, 'a4')).toMatchObject({ notifications: null, deck: null, faded: true });
    expect(tileOf(svc, 'github').notifications?.map((n) => n.id)).toEqual(['8']);
    expect(svc.view()).toMatchObject({ checkedAt: NOW, checking: false, githubLogin: 'adam' });
    expect(svc.githubLogin()).toBe('adam');
  });

  it('shows a chat whose head is the user message with a completed reply below it', () => {
    // A normal send leaves the head on the user's message; the reply is its child.
    store.messages.create({ id: 'c9-u', chatId: 'c9', parentId: null, role: 'user', parts: [], status: 'complete', error: null, producedBy: null, createdAt: NOW - 2 * HOUR });
    store.chats.create({ id: 'c9', title: 'c9', profileId: 'p', headMessageId: 'c9-u', workspaceRoot: null, pinned: false, archivedAt: null, appId: 'a1' });
    store.messages.create({ id: 'c9-a', chatId: 'c9', parentId: 'c9-u', role: 'assistant', parts: [], status: 'complete', error: null, producedBy: null, createdAt: NOW - HOUR });
    expect(tileOf(service(), 'a1').chats.map((c) => c.chatId)).toEqual(['c9']);
  });

  it('leaves out chats whose last reply is older than a week', () => {
    chat('c-week', 'a1', 'assistant', NOW - 6 * DAY);
    chat('c-stale', 'a1', 'assistant', NOW - 8 * DAY);
    expect(tileOf(service(), 'a1').chats.map((c) => c.chatId)).toEqual(['c-week']);
  });

  it('shares one check between concurrent refreshes', async () => {
    const svc = service();
    const a = svc.refresh();
    const b = svc.refresh();
    await Promise.all([a, b]);
    expect(gh.calls.filter((c) => c === 'login')).toHaveLength(1);
    expect(gh.calls.filter((c) => c === 'notifications')).toHaveLength(1);
  });

  it('a signed-out gh puts a GitHub error on every repo app and the GitHub tile; chats and Deck still show', async () => {
    gh.me = new GhError('gh-signed-out', GH_SIGNED_OUT);
    chat('c1', 'a1', 'assistant', NOW - HOUR);
    const svc = service();
    await svc.refresh();
    for (const key of ['a1', 'a2', 'github']) {
      expect(tileOf(svc, key)).toMatchObject({ notifications: [], notificationsError: `couldn't check GitHub: ${GH_SIGNED_OUT}` });
    }
    expect(tileOf(svc, 'a3').notificationsError).toBeNull();
    const ob = tileOf(svc, 'a1');
    expect(ob.chats.map((c) => c.chatId)).toEqual(['c1']);
    expect(ob.deck?.due.map((d) => d.cardId)).toEqual([900]);
    expect(ob.deckError).toBeNull();
    expect(svc.githubLogin()).toBeNull();
    expect(svc.view().githubLogin).toBeNull();
  });

  it('a failed inbox read keeps the last good list and shows why', async () => {
    const svc = service();
    await svc.refresh();
    gh.inbox = new GhError('gh-failed', 'HTTP 502: Bad Gateway');
    await svc.refresh();
    expect(tileOf(svc, 'a1')).toMatchObject({ notificationsError: "couldn't check GitHub: HTTP 502: Bad Gateway" });
    expect(tileOf(svc, 'a1').notifications?.map((n) => n.id)).toEqual(['7']);
  });

  it('Nextcloud not set up puts a Deck error on every board app', async () => {
    nc = null;
    const svc = service();
    await svc.refresh();
    for (const key of ['a1', 'a3']) {
      expect(tileOf(svc, key)).toMatchObject({ deckError: "Nextcloud isn't set up", deck: { due: [], doing: 0, todo: 0, backlog: 0 } });
    }
    expect(tileOf(svc, 'a2').deckError).toBeNull();
    expect(tileOf(svc, 'a1').notifications?.map((n) => n.id)).toEqual(['7']);
  });

  it('calls onLoginChanged when the login changes, not on every check', async () => {
    const svc = service();
    await svc.refresh();
    expect(loginChanges).toBe(1);
    await svc.refresh();
    expect(loginChanges).toBe(1);
    gh.me = 'adam-work';
    await svc.refresh();
    expect(loginChanges).toBe(2);
    gh.me = new GhError('gh-signed-out', GH_SIGNED_OUT);
    await svc.refresh();
    expect(loginChanges).toBe(3);
    expect(svc.githubLogin()).toBeNull();
  });

  it('emits overview-changed when checking starts and after the check', async () => {
    const svc = service();
    const p = svc.refresh();
    expect(svc.view().checking).toBe(true);
    expect(events).toEqual([{ type: 'overview-changed' }]);
    await p;
    expect(svc.view().checking).toBe(false);
    expect(events).toEqual([{ type: 'overview-changed' }, { type: 'overview-changed' }]);
  });

  it('runs no gh at all while no app has a repo', async () => {
    for (const id of ['a1', 'a2']) store.apps.update(id, { githubRepo: null });
    const svc = service();
    await svc.refresh();
    expect(gh.calls).toEqual([]);
    expect(tileOf(svc, 'a1').deck?.due.map((d) => d.cardId)).toEqual([900]);
    expect(svc.view().checkedAt).toBe(NOW);
  });

  it('view() never runs gh or Nextcloud', () => {
    const svc = service();
    const v = svc.view();
    expect(gh.calls).toEqual([]);
    expect(nc?.calls).toEqual([]);
    expect(v).toMatchObject({ checkedAt: null, checking: false, githubLogin: null });
  });

  it('a disposed service checks nothing more', async () => {
    const svc = service();
    svc.start();
    svc.dispose();
    await svc.refresh();
    clock.advance(OVERVIEW_INTERVAL_MS * 2);
    expect(gh.calls.filter((c) => c === 'login')).toHaveLength(1);
    expect(clock.pending()).toEqual([]);
  });
});

describe('OverviewService machines', () => {
  it('lists unreachable machines running chats, login mismatches, and remote waiting chats', async () => {
    chat('c-away', 'a1', 'user', NOW - HOUR, { runsOn: 'n-laptop' });
    chat('c-remote', null, 'user', NOW - HOUR, { runsOn: 'n-desk' });
    chat('c-archived', null, 'user', NOW - HOUR, { runsOn: 'n-old', archivedAt: NOW - DAY });
    machines = [
      { nodeId: 'n-laptop', name: 'Laptop', reachable: false, waitingChatIds: [], githubLogin: null },
      { nodeId: 'n-desk', name: 'Desk', reachable: true, waitingChatIds: ['c-remote'], githubLogin: 'someone-else' },
      { nodeId: 'n-old', name: 'Old', reachable: false, waitingChatIds: [], githubLogin: null },
      { nodeId: 'n-idle', name: 'Idle', reachable: false, waitingChatIds: [], githubLogin: null },
      { nodeId: 'n-same', name: 'Same', reachable: true, waitingChatIds: [], githubLogin: 'adam' },
    ];
    const svc = service();
    await svc.refresh();
    const v = svc.view();
    expect(v.unreachableMachines).toEqual(['Laptop']);
    expect(v.loginMismatches).toEqual([{ machine: 'Desk', login: 'someone-else' }]);
    expect(tileOf(svc, 'chats').chats).toEqual([expect.objectContaining({ chatId: 'c-remote', waiting: true })]);
  });

  it('local waiting chats count as waiting', () => {
    chat('c-ask', null, 'user', NOW - HOUR);
    waiting = ['c-ask'];
    const svc = service();
    expect(tileOf(svc, 'chats').chats).toEqual([expect.objectContaining({ chatId: 'c-ask', waiting: true })]);
  });
});

describe('OverviewService inbox actions', () => {
  it('markDone clears it on GitHub, drops it straight away and says so', async () => {
    const svc = service();
    await svc.refresh();
    events.length = 0;
    await svc.markDone('7');
    expect(gh.calls).toContain('done 7');
    expect(tileOf(svc, 'a1').notifications).toEqual([]);
    expect(events).toEqual([{ type: 'overview-changed' }]);
  });

  it('a markDone GitHub refuses changes nothing and passes the error on', async () => {
    gh.failDone = new GhError('gh-failed', 'HTTP 500');
    const svc = service();
    await svc.refresh();
    events.length = 0;
    await expect(svc.markDone('7')).rejects.toThrow('HTTP 500');
    expect(tileOf(svc, 'a1').notifications?.map((n) => n.id)).toEqual(['7']);
    expect(events).toEqual([]);
  });

  it('markRead marks it read on GitHub and in the list', async () => {
    const svc = service();
    await svc.refresh();
    await svc.markRead('7');
    expect(gh.calls).toContain('read 7');
    expect(tileOf(svc, 'a1').notifications?.[0]).toMatchObject({ id: '7', unread: false });
  });

  it('tickOlder ticks off only older chats, and leaves waiting chats and the inbox alone', async () => {
    chat('c-old', 'a1', 'assistant', NOW - 3 * DAY);
    chat('c-new', 'a1', 'assistant', NOW - HOUR);
    chat('c-wait', 'a1', 'assistant', NOW - 3 * DAY);
    chat('c-mine', 'a1', 'user', NOW - 3 * DAY);
    waiting = ['c-wait'];
    const svc = service();
    await svc.refresh();
    events.length = 0;

    expect(svc.tickOlder(Date.parse('2026-10-26T00:00:00Z'))).toEqual({ chats: 1 });
    expect(store.chats.get('c-old')?.dealtWithAt).toBe(NOW);
    expect(store.chats.get('c-new')?.dealtWithAt ?? null).toBeNull();
    expect(store.chats.get('c-wait')?.dealtWithAt ?? null).toBeNull();
    expect(store.chats.get('c-mine')?.dealtWithAt ?? null).toBeNull();
    const ob = tileOf(svc, 'a1');
    expect(ob.chats.map((c) => c.chatId)).toEqual(['c-wait', 'c-new']);
    expect(ob.notifications?.map((n) => n.id)).toEqual(['7']);
    expect(gh.calls.filter((c) => c.startsWith('done'))).toEqual([]);
    expect(events).toEqual([{ type: 'overview-changed' }]);
  });
});
