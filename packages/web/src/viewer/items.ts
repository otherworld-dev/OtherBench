/** Something the viewer shows (Deck #826): a file from the chat's folders, or an artifact (Deck #896). */
export type ViewItem =
  | {
      kind: 'file';
      /** As given: absolute, or relative to the chat's workspace. */
      path: string;
    }
  | {
      kind: 'artifact';
      artifactId: string;
      /** For tabs and titles; the artifact's own title shows once it's loaded. */
      title: string;
      /** A pinned version; absent = the current version on the chat's branch. */
      versionId?: string;
    };

/** A stable key for an item (history, React keys). */
export function itemKey(item: ViewItem): string {
  return item.kind === 'file' ? `file:${item.path}` : `artifact:${item.artifactId}:${item.versionId ?? ''}`;
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
    const value = JSON.parse(decodeURIComponent(id.slice(VIEW_TAB_PREFIX.length))) as { chatId?: unknown; item?: Record<string, unknown> | null };
    const item = value.item;
    if (typeof value.chatId !== 'string' || typeof item !== 'object' || item === null) return null;
    if (item['kind'] === 'file' && typeof item['path'] === 'string') return { chatId: value.chatId, item: { kind: 'file', path: item['path'] } };
    if (item['kind'] === 'artifact' && typeof item['artifactId'] === 'string' && typeof item['title'] === 'string' && (item['versionId'] === undefined || typeof item['versionId'] === 'string')) {
      const versionId = item['versionId'];
      return { chatId: value.chatId, item: { kind: 'artifact', artifactId: item['artifactId'], title: item['title'], ...(typeof versionId === 'string' ? { versionId } : {}) } };
    }
    return null;
  } catch {
    return null;
  }
}

/** The item's file name (an artifact's title), for tabs and titles. */
export function itemName(item: ViewItem): string {
  if (item.kind === 'artifact') return item.title;
  return item.path.split(/[\\/]/).filter(Boolean).pop() ?? item.path;
}
