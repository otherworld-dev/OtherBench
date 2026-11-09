/** The model's browser calls and shapes for `api.browser`. */
import { request, post, del } from './http.js';

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
}
/** Something done in the Browser panel. `x` and `y` are fractions of the picture's width and height. */
export type BrowserPanelInput = { type: 'click'; x: number; y: number } | { type: 'wheel'; x: number; y: number; dy: number } | { type: 'key'; key: string } | { type: 'text'; text: string };

export type BrowserLiveEvent = { type: 'state'; state: BrowserLiveState } | { type: 'frame'; seq: number; jpeg: string };

export const browserApi = {
  state: (chatId: string) => request<BrowserLiveState>(`/chats/${chatId}/browser`),
  close: (chatId: string) => del(`/chats/${chatId}/browser`),
  input: (chatId: string, event: BrowserPanelInput) => post<void>(`/chats/${chatId}/browser/input`, event),
  show: (chatId: string) => post<void>(`/chats/${chatId}/browser/show`),
  forgetSignIns: () => del('/browser/profile'),
};
