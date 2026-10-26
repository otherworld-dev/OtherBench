/** Pure rules for the Overview: what needs the user, and how the tiles are ordered. */
import type { App, Chat } from '../ports/store.js';
import type { DeckBoardView } from '../types/nextcloud.js';
import type {
  ChatHead, IssueActivity, Overview, OverviewChat, OverviewDeck, OverviewIssue, OverviewTile,
} from '../types/overview.js';
import { columnKind } from './deck-columns.js';

export function isBotLogin(login: string): boolean {
  return login.endsWith('[bot]') || login.startsWith('app/');
}

interface Other { kind: 'new' | 'comment'; at: string; who: string; ms: number }

/**
 * Whether an issue needs `me`: someone else (not a bot) opened it or commented
 * after the latest of my own comment, a close, and the user's tick-off.
 */
export function issueNeed(
  a: IssueActivity, me: string, tickedThrough: string | null,
): { kind: 'new' | 'comment'; at: string; who: string } | null {
  const others: Other[] = [];
  if (a.author !== me && !a.authorIsBot) others.push({ kind: 'new', at: a.createdAt, who: a.author, ms: Date.parse(a.createdAt) });
  for (const c of a.comments) {
    if (c.author !== me && !c.authorIsBot) others.push({ kind: 'comment', at: c.createdAt, who: c.author, ms: Date.parse(c.createdAt) });
  }
  const last = others.reduce<Other | null>((best, o) => (best === null || o.ms > best.ms ? o : best), null);
  if (!last) return null;
  let settled = -Infinity;
  for (const c of a.comments) if (c.author === me) settled = Math.max(settled, Date.parse(c.createdAt));
  if (a.closedAt) settled = Math.max(settled, Date.parse(a.closedAt));
  if (tickedThrough) settled = Math.max(settled, Date.parse(tickedThrough));
  if (!(last.ms > settled)) return null;
  return { kind: last.kind, at: last.at, who: last.who };
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

/** Whether a chat wants the user: waiting on them, or a finished reply they haven't dealt with. */
export function chatNeedsYou(
  chat: { archivedAt: number | null; dealtWithAt?: number | null },
  head: ChatHead | null,
  waiting: boolean,
): boolean {
  if (chat.archivedAt !== null) return false;
  if (waiting) return true;
  if (!head || head.role !== 'assistant') return false;
  if (head.status !== 'complete' && head.status !== 'error') return false;
  return chat.dealtWithAt == null || chat.dealtWithAt < head.createdAt;
}

export interface OverviewInput {
  apps: App[]; chats: Chat[]; projects: { id: string; name: string }[];
  heads: ChatHead[]; waitingChatIds: ReadonlySet<string>;
  me: string | null;
  /** By app id; absent = not checked yet. */
  issues: Record<string, { activity: IssueActivity[] } | { error: string }>;
  ticks: { appId: string; number: number; through: string }[];
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

  const chatsFor = (appId: string | null): OverviewChat[] => {
    const out: OverviewChat[] = [];
    for (const chat of input.chats) {
      if ((chat.appId ?? null) !== appId) continue;
      const head = heads.get(chat.id) ?? null;
      const waiting = input.waitingChatIds.has(chat.id);
      if (!chatNeedsYou(chat, head, waiting)) continue;
      const projectId = chat.projectId ?? null;
      out.push({
        chatId: chat.id, title: chat.title, waiting, at: head?.createdAt ?? chat.updatedAt,
        projectId, projectName: projectId === null ? null : projectNames.get(projectId) ?? null,
      });
    }
    return out.sort((a, b) => Number(b.waiting) - Number(a.waiting) || b.at - a.at);
  };

  const issuesFor = (app: App): { issues: OverviewIssue[] | null; error: string | null } => {
    if (app.githubRepo === null) return { issues: null, error: null };
    const result = input.issues[app.id];
    if (!result) return { issues: [], error: null };
    if ('error' in result) return { issues: [], error: result.error };
    const me = input.me;
    if (me === null) return { issues: [], error: null };
    const issues: OverviewIssue[] = [];
    for (const a of result.activity) {
      const tick = input.ticks.find((t) => t.appId === app.id && t.number === a.number)?.through ?? null;
      const need = issueNeed(a, me, tick);
      if (need) issues.push({ number: a.number, title: a.title, state: a.state, kind: need.kind, at: need.at, who: need.who, url: a.url, through: need.at });
    }
    return { issues: issues.sort((a, b) => Date.parse(b.at) - Date.parse(a.at)), error: null };
  };

  const deckFor = (app: App): { deck: OverviewDeck | null; error: string | null } => {
    if (app.deckBoardId === null) return { deck: null, error: null };
    const result = input.decks[app.id];
    if (!result) return { deck: emptyDeck(), error: null };
    if ('error' in result) return { deck: emptyDeck(), error: result.error };
    return { deck: deckSummary(result.view, input.now), error: null };
  };

  const tile = (
    key: string, appId: string | null, name: string, chats: OverviewChat[],
    iss: { issues: OverviewIssue[] | null; error: string | null },
    dk: { deck: OverviewDeck | null; error: string | null },
  ): OverviewTile => {
    const count = chats.length + (iss.issues?.length ?? 0) + (dk.deck?.due.length ?? 0);
    const faded = count === 0 && (dk.deck?.doing ?? 0) + (dk.deck?.todo ?? 0) === 0;
    return { key, appId, name, count, faded, chats, issues: iss.issues, issuesError: iss.error, deck: dk.deck, deckError: dk.error };
  };

  const tiles = input.apps.map((app) => tile(app.id, app.id, app.name, chatsFor(app.id), issuesFor(app), deckFor(app)));
  tiles.push(tile('chats', null, 'Chats', chatsFor(null), { issues: null, error: null }, { deck: null, error: null }));

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
