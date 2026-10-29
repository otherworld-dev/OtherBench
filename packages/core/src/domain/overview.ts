/** Pure rules for the Overview: what needs the user, and how the tiles are ordered. */
import type { App, Chat } from '../ports/store.js';
import type { DeckBoardView } from '../types/nextcloud.js';
import type {
  ChatHead, GithubNotification, Overview, OverviewChat, OverviewDeck, OverviewTile,
} from '../types/overview.js';
import { columnKind } from './deck-columns.js';
import { appForRepo, sortNotifications } from './github-inbox.js';

export function isBotLogin(login: string): boolean {
  return login.endsWith('[bot]') || login.startsWith('app/');
}

const dayNumber = (d: Date): number => Math.round(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86_400_000);

/** Open cards due today or earlier (local calendar days) plus per-column counts. */
export function deckSummary(view: DeckBoardView, now: Date): OverviewDeck {
  const out: OverviewDeck = { due: [], doing: 0, todo: 0, backlog: 0 };
  const today = dayNumber(now);
  for (const stack of view.stacks) {
    const kind = columnKind(stack.title);
    if (kind === 'done') continue;
    for (const card of stack.cards) {
      if (card.done || card.archived) continue;
      if (kind === 'doing') out.doing++;
      else if (kind === 'todo') out.todo++;
      else if (kind === 'backlog') out.backlog++;
      if (card.duedate === null) continue;
      const due = new Date(card.duedate);
      if (Number.isNaN(due.getTime())) continue;
      const overdueDays = today - dayNumber(due);
      if (overdueDays >= 0) out.due.push({ cardId: card.id, title: card.title, duedate: card.duedate, overdueDays });
    }
  }
  out.due.sort((a, b) => b.overdueDays - a.overdueDays);
  return out;
}

/**
 * How far back a finished reply can still need the user. Without it every old
 * chat that ended on Claude's answer counted, hundreds on a first run. Chats
 * waiting on a card or question count however old they are.
 */
export const CHAT_NEED_WINDOW_MS = 7 * 86_400_000;

/**
 * Whether a chat wants the user: waiting on them, or a finished reply from
 * `since` (ms) on that they haven't dealt with.
 */
export function chatNeedsYou(
  chat: { archivedAt: number | null; dealtWithAt?: number | null },
  head: ChatHead | null,
  waiting: boolean,
  since: number,
): boolean {
  if (chat.archivedAt !== null) return false;
  if (waiting) return true;
  if (!head || head.role !== 'assistant') return false;
  if (head.status !== 'complete' && head.status !== 'error') return false;
  if (head.createdAt < since) return false;
  return chat.dealtWithAt == null || chat.dealtWithAt < head.createdAt;
}

export interface OverviewInput {
  apps: App[]; chats: Chat[]; projects: { id: string; name: string }[];
  heads: ChatHead[]; waitingChatIds: ReadonlySet<string>;
  me: string | null;
  /** The GitHub inbox from the last check; null = not checked yet. */
  notifications: { list: GithubNotification[]; more: boolean } | { error: string } | null;
  /** By app id. */
  decks: Record<string, { view: DeckBoardView } | { error: string }>;
  checkedAt: number | null; checking: boolean;
  loginMismatches: Overview['loginMismatches']; unreachableMachines: string[];
  now: Date;
}

const emptyDeck = (): OverviewDeck => ({ due: [], doing: 0, todo: 0, backlog: 0 });

export function buildOverview(input: OverviewInput): Overview {
  const heads = new Map(input.heads.map((h) => [h.chatId, h]));
  const projectNames = new Map(input.projects.map((p) => [p.id, p.name]));
  const since = input.now.getTime() - CHAT_NEED_WINDOW_MS;

  const chatsFor = (appId: string | null): OverviewChat[] => {
    const out: OverviewChat[] = [];
    for (const chat of input.chats) {
      if ((chat.appId ?? null) !== appId) continue;
      const head = heads.get(chat.id) ?? null;
      const waiting = input.waitingChatIds.has(chat.id);
      if (!chatNeedsYou(chat, head, waiting, since)) continue;
      const projectId = chat.projectId ?? null;
      out.push({
        chatId: chat.id, title: chat.title, waiting, at: head?.createdAt ?? chat.updatedAt,
        projectId, projectName: projectId === null ? null : projectNames.get(projectId) ?? null,
      });
    }
    return out.sort((a, b) => Number(b.waiting) - Number(a.waiting) || b.at - a.at);
  };

  // Each notification goes to the first app whose repo it is, else to the GitHub tile.
  const inbox = input.notifications;
  const inboxError = inbox !== null && 'error' in inbox ? inbox.error : null;
  const inboxMore = inbox !== null && 'list' in inbox ? inbox.more : false;
  const byApp = new Map<string, GithubNotification[]>();
  const elsewhere: GithubNotification[] = [];
  for (const n of inbox !== null && 'list' in inbox ? sortNotifications(inbox.list) : []) {
    const owner = appForRepo(input.apps, n.repo);
    if (owner === null) elsewhere.push(n);
    else byApp.set(owner.id, [...(byApp.get(owner.id) ?? []), n]);
  }
  type Inbox = { notifications: GithubNotification[] | null; error: string | null; more: boolean };
  const noInbox: Inbox = { notifications: null, error: null, more: false };
  const inboxFor = (app: App): Inbox =>
    app.githubRepo === null ? noInbox : { notifications: byApp.get(app.id) ?? [], error: inboxError, more: inboxMore };

  const deckFor = (app: App): { deck: OverviewDeck | null; error: string | null } => {
    if (app.deckBoardId === null) return { deck: null, error: null };
    const result = input.decks[app.id];
    if (!result) return { deck: emptyDeck(), error: null };
    if ('error' in result) return { deck: emptyDeck(), error: result.error };
    return { deck: deckSummary(result.view, input.now), error: null };
  };

  const tile = (
    key: string, appId: string | null, name: string, chats: OverviewChat[],
    gh: Inbox,
    dk: { deck: OverviewDeck | null; error: string | null },
  ): OverviewTile => {
    const count = chats.length + (gh.notifications?.length ?? 0) + (dk.deck?.due.length ?? 0);
    const faded = count === 0 && (dk.deck?.doing ?? 0) + (dk.deck?.todo ?? 0) === 0;
    return {
      key, appId, name, count, faded, chats,
      notifications: gh.notifications, notificationsError: gh.error, notificationsMore: gh.more,
      deck: dk.deck, deckError: dk.error,
    };
  };

  const noDeck = { deck: null, error: null };
  const tiles = input.apps.map((app) => tile(app.id, app.id, app.name, chatsFor(app.id), inboxFor(app), deckFor(app)));
  tiles.push(tile('chats', null, 'Chats', chatsFor(null), noInbox, noDeck));
  // Repos that aren't apps: a tile only when there is something to show there.
  if (elsewhere.length > 0 || inboxError !== null) {
    tiles.push(tile('github', null, 'GitHub', [], { notifications: elsewhere, error: inboxError, more: inboxMore }, noDeck));
  }

  const sorted = tiles
    .map((t, i) => ({ t, i }))
    .sort((a, b) => b.t.count - a.t.count || Number(a.t.faded) - Number(b.t.faded) || a.i - b.i)
    .map((x) => x.t);

  return {
    checkedAt: input.checkedAt, checking: input.checking,
    githubLogin: input.me,
    loginMismatches: input.loginMismatches, unreachableMachines: input.unreachableMachines,
    total: sorted.reduce((n, t) => n + t.count, 0),
    tiles: sorted,
  };
}
