/** Shapes of the Overview: what needs the user across apps (chats, GitHub issues, Deck cards). */
import type { MessageStatus, Role } from './messages.js';

export interface IssueActivity {
  number: number; title: string; state: 'open' | 'closed'; url: string;
  author: string; authorIsBot: boolean; createdAt: string; closedAt: string | null;
  comments: { author: string; authorIsBot: boolean; createdAt: string }[];
}

/** A chat's latest message, as far as the Overview cares. */
export interface ChatHead { chatId: string; role: Role; status: MessageStatus; createdAt: number }

export interface OverviewChat { chatId: string; title: string; waiting: boolean; at: number; projectId: string | null; projectName: string | null }
export interface OverviewIssue { number: number; title: string; state: 'open' | 'closed'; kind: 'new' | 'comment'; at: string; who: string; url: string; through: string }
export interface OverviewDueCard { cardId: number; title: string; duedate: string; overdueDays: number }
export interface OverviewDeck { due: OverviewDueCard[]; doing: number; todo: number; backlog: number }

export interface OverviewTile {
  /** App id, or 'chats' for chats outside apps. */
  key: string;
  appId: string | null; name: string;
  count: number; faded: boolean;
  chats: OverviewChat[];
  /** null issues = the app has no repo. */
  issues: OverviewIssue[] | null; issuesError: string | null;
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
