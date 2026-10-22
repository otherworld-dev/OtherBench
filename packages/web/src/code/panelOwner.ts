import type { App, Chat } from '@otherbench/core/ports/store.js';
import { appTabId, parseAppTab } from '../state/appTab.js';
import { isChatTab } from '../state/projectTab.js';
import { isViewTab, parseViewTab } from '../viewer/items.js';

/**
 * The chat the focused pane is about: the chat itself, or the chat a popped-out
 * viewer tab belongs to (its file is that chat's), else none (an app home, an
 * empty pane).
 */
export function focusedChat(activeId: string | null, chats: Chat[]): Chat | null {
  const id = isViewTab(activeId) ? (parseViewTab(activeId)?.chatId ?? null) : isChatTab(activeId) ? activeId : null;
  return id === null ? null : (chats.find((c) => c.id === id) ?? null);
}

/**
 * What the Code panel follows: the focused chat, and its app (the app chat's
 * `appId`, or the app tab's id). `appId` is set while `app` is null when the
 * app isn't loaded.
 */
export function panelApp(activeId: string | null, chats: Chat[], apps: App[]): { chat: Chat | null; appId: string | null; app: App | null } {
  const chat = focusedChat(activeId, chats);
  const appId = chat?.appId ?? parseAppTab(activeId);
  const app = appId === null ? null : (apps.find((a) => a.id === appId) ?? null);
  return { chat, appId, app };
}

/** Who owns the Issues, Deck and Wiki views shown for `app`: the focused chat when it's that app's, else the app home. */
export function viewOwner(app: App, chat: Chat | null): string {
  return chat?.appId === app.id ? chat.id : appTabId(app.id);
}

/** The focused pane's app and the owner of its panel views, or null when the pane has no (loaded) app. */
export function panelOwner(state: { activeChatId: string | null; chats: Chat[]; apps: App[] }): { app: App; owner: string } | null {
  const { chat, app } = panelApp(state.activeChatId, state.chats, state.apps);
  return app === null ? null : { app, owner: viewOwner(app, chat) };
}
