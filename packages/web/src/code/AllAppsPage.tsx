import type { JSX } from 'react';

/**
 * The All apps page (plan 2026-11-04-open-apps), open in a pane under `ALL_APPS_TAB_ID` the way an app's home is:
 * every app, grouped by folder, where apps are opened, filed and ordered. For now only its header.
 */
export function AllAppsPage(): JSX.Element {
  return (
    <div data-testid="all-apps-page" className="h-full min-h-0 overflow-y-auto bg-[var(--bg)]">
      <div className="mx-auto max-w-4xl p-6">
        <h2 className="text-lg font-medium">All apps</h2>
      </div>
    </div>
  );
}
