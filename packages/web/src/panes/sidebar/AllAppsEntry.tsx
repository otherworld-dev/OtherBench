import type { JSX } from 'react';
import { AppsIcon } from '../../components/icons.js';

/** Code mode's All apps entry, above the open apps: opens the page holding every app (plan 2026-11-04-open-apps). */
export function AllAppsEntry({ active, count, onOpen }: { active: boolean; count: number; onOpen: () => void }): JSX.Element {
  return (
    <button
      type="button"
      data-testid="all-apps-entry"
      aria-current={active ? 'page' : undefined}
      onClick={onOpen}
      className={`mb-1.5 flex w-full items-center gap-1.5 rounded px-2 py-1 text-left text-sm ${
        active
          ? 'bg-[var(--bg)] text-[var(--text)] shadow-[inset_2px_0_0_var(--accent)]'
          : 'text-[var(--text-muted)] hover:bg-[var(--bg-sunken)] hover:text-[var(--text)]'
      }`}
    >
      <AppsIcon className="shrink-0" />
      <span className="min-w-0 flex-1 truncate">All apps</span>
      {/* Read as "All apps 3 apps", not a bare number, as a group heading's count is. The spaces sit between the
          spans (a flex row draws none) so the name keeps them. */}
      {' '}
      <span data-testid="all-apps-count" className="shrink-0 text-xs tabular-nums text-[var(--text-faint)]" title={`${count} ${count === 1 ? 'app' : 'apps'}`}>
        {count}
      </span>
      {' '}
      <span className="sr-only">{count === 1 ? 'app' : 'apps'}</span>
    </button>
  );
}
