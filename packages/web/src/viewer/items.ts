/** Something the viewer shows (Deck #826). Artifacts (part 2) add their own kind. */
export interface ViewItem {
  kind: 'file';
  /** As given: absolute, or relative to the chat's workspace. */
  path: string;
}

/** Tab ids for viewer items: a chat id never starts with this. */
export const VIEW_TAB_PREFIX = 'view:';

/** A pane-grid tab for `item` from `chatId`'s folders; the same item gives the same id. */
export function viewTabId(chatId: string, item: ViewItem): string {
  return VIEW_TAB_PREFIX + encodeURIComponent(JSON.stringify({ chatId, item }));
}

export function isViewTab(id: string | null | undefined): id is string {
  return typeof id === 'string' && id.startsWith(VIEW_TAB_PREFIX);
}

/** The chat and item a viewer tab id names, or null when it isn't a well-formed one. */
export function parseViewTab(id: string): { chatId: string; item: ViewItem } | null {
  if (!isViewTab(id)) return null;
  try {
    const value = JSON.parse(decodeURIComponent(id.slice(VIEW_TAB_PREFIX.length))) as { chatId?: unknown; item?: { kind?: unknown; path?: unknown } };
    if (typeof value.chatId !== 'string' || value.item?.kind !== 'file' || typeof value.item.path !== 'string') return null;
    return { chatId: value.chatId, item: { kind: 'file', path: value.item.path } };
  } catch {
    return null;
  }
}

/** The item's file name, for tabs and titles. */
export function itemName(item: ViewItem): string {
  return item.path.split(/[\\/]/).filter(Boolean).pop() ?? item.path;
}
