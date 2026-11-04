import { useMemo, useState, type JSX } from 'react';
import { toast } from '../lib/toasts.js';
import { useNow } from '../lib/useNow.js';
import { ApiError } from '../state/api.js';
import { useChatActivity } from '../state/chatStatus.js';
import { useOtherBenchStore } from '../state/store.js';
import { AllAppsCardView, type AllAppsLayout } from './AllAppsCard.js';
import { AllAppsSectionView } from './AllAppsSection.js';
import { allAppsSections } from './allAppsModel.js';
import { setAppOpen } from './appOpen.js';

/** localStorage key of the grid/list switch. Per machine, by design (spec 2026-11-04-open-apps-design, Goal 15). */
export const ALL_APPS_LAYOUT_KEY = 'otherbench.allApps.layout';

function loadLayout(): AllAppsLayout {
  try {
    return window.localStorage.getItem(ALL_APPS_LAYOUT_KEY) === 'list' ? 'list' : 'grid';
  } catch {
    return 'grid';
  }
}

function saveLayout(layout: AllAppsLayout): void {
  try {
    window.localStorage.setItem(ALL_APPS_LAYOUT_KEY, layout);
  } catch {
    // storage blocked or full -- the switch still applies for this session.
  }
}

const SEG = 'px-2.5 py-1 text-xs';

/**
 * The All apps page (plan 2026-11-04-open-apps), open in a pane under `ALL_APPS_TAB_ID` the way an app's home is:
 * every app, in a section per folder, as cards or rows. Clicking one opens the app (it joins the Code sidebar) and
 * shows its home. Filing and ordering come to this page next.
 */
export function AllAppsPage(): JSX.Element {
  const apps = useOtherBenchStore((s) => s.apps);
  const folders = useOtherBenchStore((s) => s.appFolders);
  const chats = useOtherBenchStore((s) => s.chats);
  const openAppHome = useOtherBenchStore((s) => s.openAppHome);
  const openAppPage = useOtherBenchStore((s) => s.openAppPage);
  const activity = useChatActivity();
  const now = useNow(60_000);
  const [query, setQuery] = useState('');
  const [layout, setLayoutState] = useState<AllAppsLayout>(loadLayout);
  const sections = useMemo(() => allAppsSections(apps, folders, chats, query), [apps, folders, chats, query]);
  const openCount = apps.filter((a) => a.open).length;

  const setLayout = (next: AllAppsLayout): void => {
    setLayoutState(next);
    saveLayout(next);
  };
  // The home opens either way: a failed PATCH only means the app isn't kept in the sidebar, and the toast says so.
  const openApp = (appId: string, wasOpen: boolean): void => {
    openAppHome(appId);
    if (wasOpen) return;
    setAppOpen(appId, true).catch((err: unknown) => {
      toast({ text: err instanceof ApiError ? err.message : "Couldn't add the app to the sidebar. Please try again.", tone: 'error' });
    });
  };

  return (
    <div data-testid="all-apps-page" className="h-full min-h-0 overflow-y-auto bg-[var(--bg)]">
      <div className="mx-auto max-w-5xl p-6">
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="text-lg font-medium">All apps</h2>
          <span className="text-sm text-[var(--text-muted)]">{`${apps.length} ${apps.length === 1 ? 'app' : 'apps'} · ${openCount} open`}</span>
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search apps"
            aria-label="Search apps"
            className="ml-auto w-64 max-w-full rounded-md border border-[var(--border)] bg-[var(--bg-raised)] px-2.5 py-1 text-sm text-[var(--text)] placeholder:text-[var(--text-faint)] focus:border-[var(--accent)] focus:outline-none"
          />
          <div role="group" aria-label="Layout" className="flex overflow-hidden rounded-md border border-[var(--border)]">
            {(['grid', 'list'] as const).map((l) => (
              <button
                key={l}
                type="button"
                aria-pressed={layout === l}
                onClick={() => setLayout(l)}
                className={`${SEG} ${layout === l ? 'bg-[var(--bg-raised)] text-[var(--text)]' : 'text-[var(--text-muted)] hover:text-[var(--text)]'}`}
              >
                {l === 'grid' ? 'Grid' : 'List'}
              </button>
            ))}
          </div>
          <button type="button" onClick={() => openAppPage({ mode: 'create' })} className="btn btn-primary px-2.5 py-1">
            + New app
          </button>
        </div>
        {sections.map((section) => (
          <AllAppsSectionView key={section.key} section={section} layout={layout}>
            {section.cards.map((card) => (
              <AllAppsCardView key={card.app.id} card={card} layout={layout} activity={activity} now={now} onOpen={() => openApp(card.app.id, card.app.open)} />
            ))}
          </AllAppsSectionView>
        ))}
        {apps.length === 0 && folders.length === 0 && <p className="mt-6 text-sm text-[var(--text-faint)]">No apps yet. Add one with + New app.</p>}
        {apps.length > 0 && sections.length === 0 && <p className="mt-6 text-sm text-[var(--text-faint)]">No apps match.</p>}
      </div>
    </div>
  );
}
