import type { JSX, ReactNode } from 'react';
import { setGroupCollapsed, useCollapsedGroups } from '../state/sidebarGroups.js';
import type { AllAppsSection as Section } from './allAppsModel.js';
import type { AllAppsLayout } from './AllAppsCard.js';

interface SectionProps {
  section: Section;
  layout: AllAppsLayout;
  /** Extra controls after the heading (the folder menu). */
  actions?: ReactNode;
  children: ReactNode;
}

/**
 * One section of the All apps page: a heading that folds (the same per-machine collapsed-groups store the sidebar
 * uses, so it stays folded) over a grid or list of cards. Unfiled has no menu; an empty folder says so.
 */
export function AllAppsSectionView({ section, layout, actions, children }: SectionProps): JSX.Element {
  const collapsed = useCollapsedGroups().has(section.key);
  const name = section.folder?.name ?? 'Unfiled';
  const listId = `all-apps-${section.key}`;
  return (
    <section data-testid={`all-apps-section-${section.key}`} aria-label={name} className="mt-6">
      <div className="mb-2.5 flex items-center gap-2">
        <button
          type="button"
          aria-expanded={!collapsed}
          aria-controls={listId}
          onClick={() => setGroupCollapsed(section.key, !collapsed)}
          className="label-caps flex min-w-0 items-center gap-2 text-[var(--text-muted)] hover:text-[var(--text)]"
        >
          <span aria-hidden="true" className={`inline-block text-[10px] transition-transform ${collapsed ? '' : 'rotate-90'}`}>
            ▶
          </span>
          <span className="truncate">{name}</span>
          <span className="font-sans text-xs font-normal normal-case tracking-normal text-[var(--text-faint)]">{section.total}</span>
        </button>
        {actions}
      </div>
      {!collapsed && (
        <div id={listId}>
          {section.cards.length === 0 ? (
            <p className="text-sm text-[var(--text-faint)]">No apps yet</p>
          ) : layout === 'grid' ? (
            <div data-testid="all-apps-grid" className="grid grid-cols-[repeat(auto-fill,minmax(14rem,1fr))] gap-2.5">
              {children}
            </div>
          ) : (
            <div data-testid="all-apps-list" className="overflow-hidden rounded-lg border border-[var(--border)]">
              {children}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
