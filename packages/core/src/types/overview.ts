/** Shapes of the Overview: what needs the user across apps (chats, the GitHub inbox, Deck cards). */
import type { MessageStatus, Role } from './messages.js';

/** What a GitHub notification is about, from its subject type (domain/github-inbox.ts). */
export type NotificationKind = 'issue' | 'pr' | 'ci' | 'release' | 'discussion' | 'other';

/** One thread in the user's GitHub notifications inbox (spec 2026-10-29-github-inbox-design). */
export interface GithubNotification {
  /** The thread id, digits: Done and mark-read go by it. */
  id: string;
  /** owner/name, as GitHub spells it. */
  repo: string;
  kind: NotificationKind;
  title: string;
  /** The issue or PR number; null for anything else. */
  number: number | null;
  /** GitHub's reason: mention, review_requested, ci_activity, subscribed... */
  reason: string;
  unread: boolean;
  updatedAt: string;
  /** Where it opens in the browser. */
  url: string;
}

/** A chat's latest message, as far as the Overview cares. */
export interface ChatHead { chatId: string; role: Role; status: MessageStatus; createdAt: number }

export interface OverviewChat { chatId: string; title: string; waiting: boolean; at: number; projectId: string | null; projectName: string | null }
export interface OverviewDueCard { cardId: number; title: string; duedate: string; overdueDays: number }
export interface OverviewDeck { due: OverviewDueCard[]; doing: number; todo: number; backlog: number }

export interface OverviewTile {
  /** App id, 'chats' for chats outside apps, or 'github' for notifications in repos that aren't apps. */
  key: string;
  appId: string | null; name: string;
  count: number; faded: boolean;
  chats: OverviewChat[];
  /** The inbox's notifications for this tile, unread first; null = the app has no repo. */
  notifications: GithubNotification[] | null; notificationsError: string | null;
  /** The inbox had more than was fetched: "More on GitHub". */
  notificationsMore: boolean;
  /** null deck = the app has no board. */
  deck: OverviewDeck | null; deckError: string | null;
}

export interface Overview {
  checkedAt: number | null; checking: boolean;
  githubLogin: string | null;
  loginMismatches: { machine: string; login: string }[];
  unreachableMachines: string[];
  total: number;
  /** Already sorted. */
  tiles: OverviewTile[];
}
