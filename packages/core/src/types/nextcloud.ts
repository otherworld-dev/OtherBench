/** Shapes shared by the server's Nextcloud client, its routes and the web tabs (Deck, Wiki, Links). */

/** Why a Nextcloud call failed; surfaced to the UI as a `CodeRouteError` code. */
export type NextcloudErrorCode =
  | 'nextcloud-not-configured' | 'nextcloud-auth' | 'nextcloud-unreachable'
  | 'nextcloud-app-missing' | 'nextcloud-not-found' | 'nextcloud-failed'
  | 'no-deck-board' | 'no-wiki-page' | 'no-bookmark-tag' | 'deck-move-ignored';

/** A Deck label. */
export interface DeckLabel { id: number; title: string; color: string }

/** A Deck card as listed on a board. */
export interface DeckCardSummary {
  id: number;
  /** Without its "#<id> " prefix. */
  title: string;
  stackId: number;
  labels: DeckLabel[];
  /** ISO, or null. */
  duedate: string | null;
  done: boolean;
  archived: boolean;
}

/** A Deck column and its open cards. */
export interface DeckStack { id: number; title: string; order: number; cards: DeckCardSummary[] }

/** A whole board as the Deck tab shows it. */
export interface DeckBoardView {
  board: { id: number; title: string };
  /** In board order. */
  stacks: DeckStack[];
  archived: DeckCardSummary[];
  labels: DeckLabel[];
  doingStackId: number | null;
  url: string;
}

/** One card with its description and where it lives. */
export interface DeckCardDetail extends DeckCardSummary {
  description: string;
  boardId: number;
  boardTitle: string;
  stackTitle: string;
  /** Unix seconds, as Deck gives them. */
  createdAt: number | null;
  url: string;
}

/** A page in a collective's tree. */
export interface WikiPageNode {
  id: number;
  title: string;
  /** null only for the app's own page (the root). */
  parentId: number | null;
}

/** The page tree under an app's wiki page. */
export interface WikiTree { collective: string; pagePath: string; rootId: number; pages: WikiPageNode[]; url: string }

/** One wiki page with its markdown body. */
export interface WikiPage {
  id: number;
  title: string;
  /** Titles from the app's page down, e.g. ['OtherBench', 'Design', 'Specs']. */
  breadcrumbs: string[];
  markdown: string;
  url: string;
}

/** A Nextcloud Bookmarks entry. */
export interface Bookmark {
  id: number;
  url: string;
  title: string;
  description: string;
  tags: string[];
  /** Unix seconds. */
  added: number;
}

/** Machine-local connection settings; never carries the password. */
export interface NextcloudSettingsView { baseUrl: string | null; user: string | null; passwordSet: boolean }

/** Outcome of a connection test, with which Nextcloud apps are installed. */
export interface NextcloudTestResult { ok: boolean; message: string; apps: { deck: boolean; collectives: boolean; bookmarks: boolean } }

/** The "Project links" section of a CLAUDE.md. */
export interface ProjectLinks { deckBoard: string | null; collective: string | null; pagePath: string | null; bookmarkTag: string | null }

/** Project links plus the resolved board id. */
export interface ProjectLinksSuggestion extends ProjectLinks {
  /** The board's id when `deckBoard` names a board this account sees; null otherwise, or when Nextcloud isn't set up. */
  deckBoardId: number | null;
}

/** The collective used when a project's links name a page but no collective. */
export const DEFAULT_COLLECTIVE = 'Otherworld Dev';
