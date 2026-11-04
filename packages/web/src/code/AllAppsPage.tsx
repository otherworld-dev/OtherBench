import { useMemo, useState, type JSX } from 'react';
import { ConfirmDialog } from '../components/ConfirmDialog.js';
import { Menu } from '../components/Menu.js';
import { toast } from '../lib/toasts.js';
import { useNow } from '../lib/useNow.js';
import { appCardMenuItems, folderMenuItems } from '../panes/sidebar/menus.js';
import { folderKey } from '../panes/sidebar/model.js';
import { ApiError } from '../state/api.js';
import { useChatActivity } from '../state/chatStatus.js';
import { useOtherBenchStore } from '../state/store.js';
import { AllAppsCardView, type AllAppsLayout } from './AllAppsCard.js';
import { AllAppsSectionView } from './AllAppsSection.js';
import { allAppsSections, type AllAppsCard, type AllAppsSection } from './allAppsModel.js';
import { setAppOpen } from './appOpen.js';
import { cardSelector, focusLater, headingSelector, useAppOrganiser } from './useAppOrganiser.js';

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
 * shows its home. Folders are made, renamed, ordered and deleted here, and apps filed and ordered, by menu or by drag
 * (`useAppOrganiser`).
 */
export function AllAppsPage(): JSX.Element {
  const folders = useOtherBenchStore((s) => s.appFolders);
  const chats = useOtherBenchStore((s) => s.chats);
  const openAppHome = useOtherBenchStore((s) => s.openAppHome);
  const openAppPage = useOtherBenchStore((s) => s.openAppPage);
  const activity = useChatActivity();
  const now = useNow(60_000);
  const [query, setQuery] = useState('');
  const [layout, setLayoutState] = useState<AllAppsLayout>(loadLayout);
  const o = useAppOrganiser(() => setQuery(''));
  const { apps } = o;
  const sections = useMemo(() => allAppsSections(apps, folders, chats, query), [apps, folders, chats, query]);
  const openCount = apps.filter((a) => a.open).length;
  // Order only makes sense among every app; a search shows some of them.
  const searching = query.trim() !== '';

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

  // An app or folder deleted meanwhile (another window, a paired machine) closes its menu, rename or dialog.
  const menuApp = o.appMenu ? (apps.find((a) => a.id === o.appMenu!.appId) ?? null) : null;
  const menuFolder = o.folderMenu ? (o.sortedFolders.find((f) => f.id === o.folderMenu!.folderId) ?? null) : null;
  const deletingApp = o.deletingAppId ? (apps.find((a) => a.id === o.deletingAppId) ?? null) : null;
  const deletingFolder = o.deletingFolderId ? (o.sortedFolders.find((f) => f.id === o.deletingFolderId) ?? null) : null;
  const draggingApp = o.dragging?.kind === 'app' ? (apps.find((a) => a.id === o.dragging!.id) ?? null) : null;
  const draggingFolderId = o.dragging?.kind === 'folder' ? o.dragging.id : null;

  function renderSection(section: AllAppsSection): JSX.Element {
    const folder = section.folder;
    const folderId = folder?.id ?? null;
    // A card dragged from another section files there; its own section isn't a target (a near miss between its cards
    // would otherwise send it to the end).
    const fileTarget = draggingApp !== null && o.loadedFolderOf(draggingApp) !== folderId;
    const headingTarget = folder !== null && draggingFolderId !== null && draggingFolderId !== folder.id;
    return (
      <AllAppsSectionView
        key={section.key}
        section={section}
        layout={layout}
        searching={searching}
        menu={folder ? { open: menuFolder?.id === folder.id, onOpen: (position, source) => o.openFolderMenu(folder.id, position, source) } : undefined}
        rename={
          folder && o.renamingFolderId === folder.id
            ? {
                onCommit: (name) => void o.renameFolder(folder.id, name),
                onCancel: () => {
                  o.setRenamingFolderId(null);
                  focusLater(headingSelector(section.key));
                },
              }
            : null
        }
        reorder={
          folder
            ? {
                draggable: !searching,
                onDragStart: () => o.setDragging({ kind: 'folder', id: folder.id }),
                onDragEnd: o.endDrag,
                target: headingTarget,
                indicator: headingTarget && o.dropAt?.kind === 'heading' && o.dropAt.id === section.key ? o.dropAt.position : null,
                onOver: (position) => o.setDropAt({ kind: 'heading', id: section.key, position }),
                onLeave: () => o.setDropAt((d) => (d?.kind === 'heading' && d.id === section.key ? null : d)),
                onDrop: (position) => {
                  const moving = o.takeDragged('folder');
                  if (moving) void o.placeFolder(moving, folder.id, position);
                },
              }
            : undefined
        }
        fileDrop={{
          target: fileTarget,
          active: fileTarget && o.dropAt?.kind === 'section' && o.dropAt.id === section.key,
          onOver: () => o.setDropAt({ kind: 'section', id: section.key, position: null }),
          onLeave: () => o.setDropAt((d) => (d?.kind === 'section' && d.id === section.key ? null : d)),
          onDrop: () => {
            const moving = o.takeDragged('app');
            if (moving) void o.fileApp(moving, folderId, null);
          },
        }}
      >
        {section.cards.map(renderCard)}
      </AllAppsSectionView>
    );
  }

  function renderCard(card: AllAppsCard): JSX.Element {
    const { app } = card;
    const target = draggingApp !== null && draggingApp.id !== app.id;
    return (
      <AllAppsCardView
        key={app.id}
        card={card}
        layout={layout}
        activity={activity}
        now={now}
        onOpen={() => openApp(app.id, app.open)}
        menu={{ open: menuApp?.id === app.id, onOpen: (position, source) => o.openAppMenu(app.id, position, source) }}
        rename={
          o.renamingAppId === app.id
            ? {
                onCommit: (name) => void o.renameApp(app.id, name),
                onCancel: () => {
                  o.setRenamingAppId(null);
                  focusLater(cardSelector(app.id));
                },
              }
            : null
        }
        reorder={{
          draggable: !searching,
          onDragStart: () => o.setDragging({ kind: 'app', id: app.id }),
          onDragEnd: o.endDrag,
          target,
          indicator: target && o.dropAt?.kind === 'card' && o.dropAt.id === app.id ? o.dropAt.position : null,
          onOver: (position) => o.setDropAt({ kind: 'card', id: app.id, position }),
          onLeave: () => o.setDropAt((d) => (d?.kind === 'card' && d.id === app.id ? null : d)),
          onDrop: (position) => {
            const moving = o.takeDragged('app');
            if (moving) void o.placeApp(moving, app.id, position);
          },
        }}
      />
    );
  }

  const menuAppPlace = menuApp ? o.appPlace(menuApp.id) : null;

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
          <button type="button" onClick={() => void o.createFolder()} className="btn px-2.5 py-1">
            + New folder
          </button>
          <button type="button" onClick={() => openAppPage({ mode: 'create' })} className="btn btn-primary px-2.5 py-1">
            + New app
          </button>
        </div>
        {o.error && (
          <p role="alert" className="mt-3 text-xs text-[var(--danger)]">
            {o.error}
          </p>
        )}
        {sections.map(renderSection)}
        {apps.length === 0 && folders.length === 0 && <p className="mt-6 text-sm text-[var(--text-faint)]">No apps yet. Add one with + New app.</p>}
        {apps.length > 0 && sections.length === 0 && <p className="mt-6 text-sm text-[var(--text-faint)]">No apps match.</p>}
      </div>

      {o.appMenu && menuApp && menuAppPlace && (
        <Menu
          key={`app:${menuApp.id}`}
          label="App actions"
          position={o.appMenu.position}
          items={appCardMenuItems(
            menuAppPlace.index,
            menuAppPlace.count,
            {
              open: () => openApp(menuApp.id, menuApp.open),
              close: () => void o.closeApp(menuApp.id),
              rename: () => o.setRenamingAppId(menuApp.id),
              edit: () => openAppPage({ mode: 'edit', appId: menuApp.id, returnFocus: cardSelector(menuApp.id) }),
              move: (dir) => void o.moveApp(menuApp.id, dir),
              moveToFolder: (folderId) => void o.moveAppToFolder(menuApp.id, folderId),
              requestDelete: () => o.setDeletingAppId(menuApp.id),
            },
            o.sortedFolders,
            o.loadedFolderOf(menuApp),
            menuApp.open
          )}
          onClose={(reason) => {
            o.setAppMenu(null);
            if (reason === 'dismiss') focusLater(cardSelector(menuApp.id));
          }}
        />
      )}

      {o.folderMenu && menuFolder && (
        <Menu
          key={`folder:${menuFolder.id}`}
          label="Folder actions"
          position={o.folderMenu.position}
          items={folderMenuItems(
            o.sortedFolders.findIndex((f) => f.id === menuFolder.id),
            o.sortedFolders.length,
            {
              rename: () => o.setRenamingFolderId(menuFolder.id),
              move: (dir) => void o.moveFolder(menuFolder.id, dir),
              requestDelete: () => o.setDeletingFolderId(menuFolder.id),
            }
          )}
          onClose={(reason) => {
            o.setFolderMenu(null);
            if (reason === 'dismiss') focusLater(headingSelector(folderKey(menuFolder.id)));
          }}
        />
      )}

      {deletingApp && (
        <ConfirmDialog
          title={`Delete ${deletingApp.name}?`}
          message="Its chats move back to Chat mode; nothing is deleted."
          confirmLabel="Delete"
          onConfirm={() => o.deleteApp(deletingApp.id)}
          onCancel={() => {
            o.setDeletingAppId(null);
            focusLater(cardSelector(deletingApp.id));
          }}
        />
      )}

      {deletingFolder && (
        <ConfirmDialog
          title={`Delete ${deletingFolder.name}?`}
          message="Its apps move out of the folder; nothing is deleted."
          confirmLabel="Delete"
          onConfirm={() => o.deleteFolder(deletingFolder.id)}
          onCancel={() => {
            o.setDeletingFolderId(null);
            focusLater(headingSelector(folderKey(deletingFolder.id)));
          }}
        />
      )}
    </div>
  );
}
