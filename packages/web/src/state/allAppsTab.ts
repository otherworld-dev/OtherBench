/**
 * The All apps page open in a pane (plan 2026-11-04-open-apps), the way an
 * app's home is (`appTab.ts`). One page, so one fixed id; it belongs to Code
 * mode. A chat id never is this, the same as the `app:` and `project:` prefixes.
 */
export const ALL_APPS_TAB_ID = 'apps:all';

export function isAllAppsTab(id: string | null | undefined): boolean {
  return id === ALL_APPS_TAB_ID;
}
