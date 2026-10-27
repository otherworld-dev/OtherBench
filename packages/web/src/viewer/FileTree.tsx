import { useCallback, useEffect, useState, type JSX, type KeyboardEvent, type MouseEvent } from 'react';
import { Menu, type MenuItem } from '../components/Menu.js';
import { isDesktop, openFolder, revealPath } from '../desktop/bridge.js';
import { isContextMenuKey } from '../panes/sidebar/ChatRow.js';
import { ApiError, api, type ArtifactSummary, type ViewEntry, type ViewRoot } from '../state/api.js';
import { useArtifactsStamp } from './stamp.js';

function failure(err: unknown): string {
  return err instanceof ApiError ? err.message : "Couldn't list this folder.";
}

/**
 * Lists one folder: a chat's through `/api/view/dirs`, or an app's through
 * `/api/apps/:id/files` (the Code panel's Files tab, spec
 * 2026-10-20-code-tab-design Goal 4), where `undefined` is the app's root.
 * `path` is the folder's full path, which the right-click menu needs for a root listed as `undefined`.
 */
export type LoadDir = (path: string | undefined) => Promise<{ path?: string; entries: ViewEntry[] }>;

/** What the desktop shell calls the system file manager. */
function fileManager(): string {
  const ua = typeof navigator === 'undefined' ? '' : navigator.userAgent;
  return ua.includes('Windows') ? 'Explorer' : ua.includes('Mac') ? 'Finder' : 'the file manager';
}

/** Right-click (or Shift+F10 / the ContextMenu key) on a row: `entry` is the folder or file under it. */
type OpenEntryMenu = (entry: { path: string; type: 'dir' | 'file' }, e: MouseEvent<HTMLElement> | KeyboardEvent<HTMLElement>) => void;

/**
 * The tree's one right-click menu: Open in Explorer for a folder, Show in
 * Explorer for a file (selected in its folder, never opened), both only in
 * the desktop app; Copy path everywhere. A failure shows under the tree.
 */
function useEntryMenu(): { openMenu: OpenEntryMenu; menu: JSX.Element | null } {
  const [state, setState] = useState<{ path: string; type: 'dir' | 'file'; position: { x: number; y: number }; from: HTMLElement } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const openMenu = useCallback<OpenEntryMenu>((entry, e) => {
    e.preventDefault();
    const from = e.currentTarget;
    let position: { x: number; y: number };
    if ('clientX' in e) position = { x: e.clientX, y: e.clientY };
    else {
      const r = from.getBoundingClientRect();
      position = { x: r.left + 16, y: r.bottom };
    }
    setError(null);
    setState({ ...entry, position, from });
  }, []);
  if (!state && !error) return { openMenu, menu: null };

  const items: MenuItem[] = [];
  if (state && isDesktop()) {
    const { path, type } = state;
    items.push(
      type === 'dir'
        ? { id: 'open-folder', label: `Open in ${fileManager()}`, onSelect: () => void openFolder(path).catch(() => setError(`Couldn't open this folder in ${fileManager()}.`)) }
        : { id: 'reveal', label: `Show in ${fileManager()}`, onSelect: () => void revealPath(path).catch(() => setError(`Couldn't show this file in ${fileManager()}.`)) }
    );
  }
  if (state) {
    const { path } = state;
    items.push({ id: 'copy-path', label: 'Copy path', onSelect: () => void navigator.clipboard.writeText(path).catch(() => setError("Couldn't copy to the clipboard.")) });
  }
  return {
    openMenu,
    menu: (
      <>
        {error && (
          <p role="alert" className="px-3 pb-2 text-xs text-[var(--danger)]">
            {error}
          </p>
        )}
        {state && (
          <Menu
            label={state.type === 'dir' ? 'Folder actions' : 'File actions'}
            items={items}
            position={state.position}
            onClose={(reason) => {
              if (reason === 'dismiss' && state.from.isConnected) state.from.focus();
              setState(null);
            }}
          />
        )}
      </>
    ),
  };
}

/** A row's handlers for its menu: right-click, and the keyboard's context-menu gestures. */
function menuHandlers(entry: { path: string; type: 'dir' | 'file' } | null, onMenu: OpenEntryMenu | undefined) {
  if (!entry || !onMenu) return {};
  return {
    onContextMenu: (e: MouseEvent<HTMLElement>) => onMenu(entry, e),
    onKeyDown: (e: KeyboardEvent<HTMLElement>) => {
      if (isContextMenuKey(e)) onMenu(entry, e);
    },
  };
}

interface FolderProps {
  loadDir: LoadDir;
  path: string | undefined;
  label: string;
  readOnly?: boolean;
  onOpen: (path: string) => void;
  startOpen: boolean;
  /** What a failed listing says; the server's message by default. */
  describeError?: (err: unknown) => string;
  onMenu?: OpenEntryMenu;
}

function Folder({ loadDir, path, label, readOnly = false, onOpen, startOpen, describeError = failure, onMenu }: FolderProps): JSX.Element {
  const [open, setOpen] = useState(startOpen);
  const [entries, setEntries] = useState<ViewEntry[] | null>(null);
  // The full path the listing gave: a root listed as `undefined` only has one once it's been listed.
  const [listedPath, setListedPath] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!open || entries) return;
    let cancelled = false;
    loadDir(path).then(
      (r) => {
        if (cancelled) return;
        setEntries(r.entries);
        setListedPath(r.path);
      },
      (err: unknown) => !cancelled && setError(describeError(err))
    );
    return () => {
      cancelled = true;
    };
  }, [open, entries, loadDir, path, describeError]);
  const fullPath = path ?? listedPath;
  return (
    <li role="treeitem" aria-expanded={open} aria-label={readOnly ? `${label} (read-only)` : label}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        {...menuHandlers(fullPath !== undefined ? { path: fullPath, type: 'dir' } : null, onMenu)}
        className="flex w-full items-center gap-1 rounded px-1 text-left hover:bg-[var(--bg-sunken)]"
      >
        <span aria-hidden="true">{open ? '▾' : '▸'}</span>
        <span className="truncate">{label}</span>
      </button>
      {open && (
        <ul role="group" className="ml-3">
          {error && <li role="alert" className="text-[var(--danger)]">{error}</li>}
          {!error && !entries && <li className="text-[var(--text-faint)]">Loading…</li>}
          {entries?.length === 0 && <li className="text-[var(--text-faint)]">Empty.</li>}
          {entries?.map((e) =>
            e.type === 'dir' ? (
              <Folder
                key={e.path}
                loadDir={loadDir}
                path={e.path}
                label={e.name}
                onOpen={onOpen}
                startOpen={false}
                describeError={describeError}
                {...(onMenu ? { onMenu } : {})}
              />
            ) : (
              <li key={e.path} role="treeitem" aria-label={e.name}>
                <button
                  type="button"
                  onClick={() => onOpen(e.path)}
                  {...menuHandlers({ path: e.path, type: 'file' }, onMenu)}
                  className="w-full truncate rounded px-1 pl-4 text-left hover:bg-[var(--bg-sunken)]"
                >
                  {e.name}
                </button>
              </li>
            )
          )}
        </ul>
      )}
    </li>
  );
}

/**
 * One folder as the same lazy tree, with its own loader: the Code panel's
 * Files tab roots it at the app's folder (`loadDir(undefined)` lists it).
 * `loadDir` and `describeError` should be stable (a memo), or an open folder
 * asks again each time they change.
 */
export function DirTree({ label, loadDir, onOpen, describeError }: { label: string; loadDir: LoadDir; onOpen: (path: string) => void; describeError?: (err: unknown) => string }): JSX.Element {
  const { openMenu, menu } = useEntryMenu();
  return (
    <>
      <ul role="tree" aria-label="Files" className="space-y-0.5 p-2 text-xs">
        <Folder loadDir={loadDir} path={undefined} label={label} onOpen={onOpen} startOpen onMenu={openMenu} {...(describeError ? { describeError } : {})} />
      </ul>
      {menu}
    </>
  );
}

/** The chat's artifacts on its branch (Deck #896), then its workspace and extra folders as a lazily loaded tree (Deck #826); a click opens one. */
export function FileTree({ chatId, onOpen, onOpenArtifact }: { chatId: string; onOpen: (path: string) => void; onOpenArtifact: (item: { artifactId: string; title: string }) => void }): JSX.Element {
  const [roots, setRoots] = useState<ViewRoot[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [artifacts, setArtifacts] = useState<ArtifactSummary[]>([]);
  const stamp = useArtifactsStamp(chatId);
  const { openMenu, menu } = useEntryMenu();
  // A chat's folders list through the viewer's own route, contained to the chat's folders there.
  const loadDir = useCallback<LoadDir>((path) => api.view.dir(chatId, path ?? ''), [chatId]);
  // Loaded on its own: a failure here leaves the list out, never the folders.
  useEffect(() => {
    let cancelled = false;
    api.artifacts.list(chatId).then(
      (r) => !cancelled && setArtifacts(r.artifacts),
      () => !cancelled && setArtifacts([])
    );
    return () => {
      cancelled = true;
    };
  }, [chatId, stamp]);
  useEffect(() => {
    let cancelled = false;
    setRoots(null);
    setError(null);
    api.view.roots(chatId).then(
      (r) => !cancelled && setRoots(r.roots),
      (err: unknown) => !cancelled && setError(failure(err))
    );
    return () => {
      cancelled = true;
    };
  }, [chatId]);
  return (
    <>
      {artifacts.length > 0 && (
        <ul aria-label="Artifacts" className="space-y-0.5 border-b border-[var(--border)] p-2 text-xs">
          {artifacts.map((a) => (
            <li key={a.id}>
              <button type="button" onClick={() => onOpenArtifact({ artifactId: a.id, title: a.title })} className="flex w-full items-center gap-2 rounded px-1 text-left hover:bg-[var(--bg-sunken)]">
                <span aria-hidden="true">◧</span>
                <span className="min-w-0 flex-1 truncate">{a.title}</span>
                <span className="text-[var(--text-faint)]">{`${a.kind} v${a.number}`}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {error ? (
        <p role="alert" className="p-3 text-sm text-[var(--danger)]">{error}</p>
      ) : !roots ? (
        <p className="p-3 text-sm text-[var(--text-faint)]">Loading…</p>
      ) : (
        <ul role="tree" aria-label="Files" className="space-y-0.5 p-2 text-xs">
          {roots.map((r) => (
            <Folder key={r.path} loadDir={loadDir} path={r.path} label={r.label} readOnly={r.access === 'read'} onOpen={onOpen} startOpen={r.workspace} onMenu={openMenu} />
          ))}
        </ul>
      )}
      {menu}
    </>
  );
}
