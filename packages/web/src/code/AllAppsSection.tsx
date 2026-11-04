import type { JSX, ReactNode } from 'react';
import { APP_FOLDER_NAME_MAX } from '@otherbench/core/domain/apps.js';
import { InlineNameInput } from '../components/InlineNameInput.js';
import { isContextMenuKey, positionIn } from '../panes/sidebar/ChatRow.js';
import { PROJECT_DRAG_MIME, type ProjectReorder } from '../panes/sidebar/ProjectGroup.js';
import { setGroupCollapsed, useCollapsedGroups } from '../state/sidebarGroups.js';
import type { AllAppsSection as Section } from './allAppsModel.js';
import { carriesPageDrag, MenuButton, type AllAppsLayout, type MenuControl, type RenameControl } from './AllAppsCard.js';

/** The whole section as a place to file a dragged app: it lights up, and a drop files the app last in it. */
export interface SectionFileDrop {
  /** An app from another section is being dragged. */
  target: boolean;
  active: boolean;
  onOver: () => void;
  onLeave: () => void;
  onDrop: () => void;
}

interface SectionProps {
  section: Section;
  layout: AllAppsLayout;
  /** Folders only: the heading's ⋯ menu. */
  menu?: MenuControl;
  /** Set while the folder's name is being edited. */
  rename?: RenameControl | null;
  /** Folders only: drag the heading to reorder folders; the heading takes another folder before or after it. */
  reorder?: ProjectReorder;
  fileDrop?: SectionFileDrop;
  children: ReactNode;
}

/**
 * One section of the All apps page: a heading that folds (the same per-machine collapsed-groups store the sidebar
 * uses, so it stays folded) over a grid or list of cards. Unfiled has no menu; an empty folder says so. A folder's
 * heading drags to reorder folders, and the whole section takes a card dragged from another section.
 */
export function AllAppsSectionView({ section, layout, menu, rename, reorder, fileDrop, children }: SectionProps): JSX.Element {
  const collapsed = useCollapsedGroups().has(section.key);
  const name = section.folder?.name ?? 'Unfiled';
  const listId = `all-apps-${section.key}`;
  const draggable = !rename && reorder?.draggable === true;
  return (
    <section
      data-testid={`all-apps-section-${section.key}`}
      aria-label={name}
      data-drop-active={fileDrop?.active ? 'true' : undefined}
      onDragOver={(e) => {
        if (!fileDrop?.target || !carriesPageDrag(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        if (!fileDrop.active) fileDrop.onOver();
      }}
      onDragLeave={(e) => {
        if (e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget)) return;
        fileDrop?.onLeave();
      }}
      onDrop={(e) => {
        if (!fileDrop?.target || !carriesPageDrag(e)) return;
        e.preventDefault();
        fileDrop.onDrop();
      }}
      // The sidebar heading's drop look, on the whole section.
      className={`mt-6 rounded-lg ${fileDrop?.active ? 'bg-[var(--bg-sunken)] ring-2 ring-[var(--accent)]' : ''}`}
    >
      <div
        data-testid={`all-apps-heading-${section.key}`}
        data-drop-position={reorder?.indicator ?? undefined}
        // A heading takes another folder (a line above or below it); an app goes on to the section.
        onDragOver={(e) => {
          if (!reorder?.target || !carriesPageDrag(e)) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
          const position = positionIn(e);
          if (position !== reorder.indicator) reorder.onOver(position);
        }}
        onDragLeave={(e) => {
          if (e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget)) return;
          reorder?.onLeave();
        }}
        onDrop={(e) => {
          if (!reorder?.target || !carriesPageDrag(e)) return;
          e.preventDefault();
          reorder.onDrop(positionIn(e));
        }}
        className={`mb-2.5 flex items-center gap-2 rounded ${
          reorder?.indicator === 'before' ? 'shadow-[inset_0_2px_0_var(--accent)]' : reorder?.indicator === 'after' ? 'shadow-[inset_0_-2px_0_var(--accent)]' : ''
        }`}
      >
        {rename ? (
          <InlineNameInput initial={name} label="Folder name" maxLength={APP_FOLDER_NAME_MAX} onCommit={rename.onCommit} onCancel={rename.onCancel} />
        ) : (
          <button
            type="button"
            data-heading-main=""
            aria-expanded={!collapsed}
            // Only while the list is there to point at.
            aria-controls={collapsed ? undefined : listId}
            onClick={() => setGroupCollapsed(section.key, !collapsed)}
            draggable={draggable}
            onDragStart={
              draggable
                ? (e) => {
                    e.dataTransfer.setData(PROJECT_DRAG_MIME, section.key);
                    e.dataTransfer.effectAllowed = 'move';
                    reorder?.onDragStart();
                  }
                : undefined
            }
            onDragEnd={reorder ? () => reorder.onDragEnd() : undefined}
            onContextMenu={
              menu
                ? (e) => {
                    e.preventDefault();
                    menu.onOpen({ x: e.clientX, y: e.clientY }, 'context');
                  }
                : undefined
            }
            onKeyDown={
              menu
                ? (e) => {
                    if (!isContextMenuKey(e)) return;
                    e.preventDefault();
                    const r = e.currentTarget.getBoundingClientRect();
                    menu.onOpen({ x: r.left + 16, y: r.bottom }, 'context');
                  }
                : undefined
            }
            className="label-caps flex min-w-0 items-center gap-2 text-[var(--text-muted)] hover:text-[var(--text)]"
          >
            <span aria-hidden="true" className={`inline-block text-[10px] transition-transform ${collapsed ? '' : 'rotate-90'}`}>
              ▶
            </span>
            <span className="truncate">{name}</span>
            <span className="font-sans text-xs font-normal normal-case tracking-normal text-[var(--text-faint)]">{section.total}</span>
          </button>
        )}
        {menu && <MenuButton label="Folder actions" menu={menu} />}
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
