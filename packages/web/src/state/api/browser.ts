/** The model's browser calls and shapes for `api.browser`. */
import { request, post, del } from './http.js';

/** The id of a chat's own page; each of its sub-agents' pages has its own (the server's `MAIN_PAGE` and `isPageId`). */
export const MAIN_BROWSER_PAGE = 'main';

/** One of a chat's open pages. `subagent` is the sub-agent's label (the model's words: clean before showing), null for the chat's own page. */
export interface BrowserPageSummary {
  id: string;
  subagent: string | null;
  host: string | null;
}

/** A chat's browser as the server reports it (spec 2026-10-12-model-browser-design §5); `elsewhere` names the machine running it. */
export interface BrowserLiveState {
  /** A real window on the machine running the chat. */
  visible?: boolean;
  open: boolean;
  url?: string | null;
  title?: string | null;
  host?: string | null;
  holder?: string | null;
  elsewhere?: string;
  /** Which page this is about: the chat's own, or a sub-agent's. */
  page?: string;
  /** Every page the chat has open, its own first. */
  pages?: BrowserPageSummary[];
}
/** Something done in the Browser panel. `x` and `y` are fractions of the picture's width and height. */
export type BrowserPanelInput = { type: 'click'; x: number; y: number } | { type: 'wheel'; x: number; y: number; dy: number } | { type: 'key'; key: string } | { type: 'text'; text: string };

export type BrowserLiveEvent = { type: 'state'; state: BrowserLiveState } | { type: 'frame'; seq: number; jpeg: string };

/** The query naming a page: none for the chat's own, which every route takes when none is named. */
export function browserPageQuery(page: string = MAIN_BROWSER_PAGE): string {
  return page === MAIN_BROWSER_PAGE ? '' : `?page=${encodeURIComponent(page)}`;
}

export const browserApi = {
  state: (chatId: string, page?: string) => request<BrowserLiveState>(`/chats/${chatId}/browser${browserPageQuery(page)}`),
  /** Closes one page; the chat's own when none is named. */
  close: (chatId: string, page?: string) => del(`/chats/${chatId}/browser${browserPageQuery(page)}`),
  input: (chatId: string, event: BrowserPanelInput, page?: string) => post<void>(`/chats/${chatId}/browser/input${browserPageQuery(page)}`, event),
  show: (chatId: string, page?: string) => post<void>(`/chats/${chatId}/browser/show${browserPageQuery(page)}`),
  forgetSignIns: () => del('/browser/profile'),
};
