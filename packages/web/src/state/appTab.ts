/**
 * An app's home page open as a tab (spec 2026-10-20-code-tab-design, "Code is
 * a whole-window mode": an app with no chats opens on its home, like a
 * project's). Mirrors `projectTab.ts`. A chat id never starts with this, the
 * same as the viewer's `view:` prefix and `project:`.
 */
export const APP_TAB_PREFIX = 'app:';

export function appTabId(appId: string): string {
  return APP_TAB_PREFIX + appId;
}

/** The app id an app tab names, or null when the id isn't one. */
export function parseAppTab(id: string | null | undefined): string | null {
  if (typeof id !== 'string' || !id.startsWith(APP_TAB_PREFIX)) return null;
  const appId = id.slice(APP_TAB_PREFIX.length);
  return appId.length > 0 ? appId : null;
}
