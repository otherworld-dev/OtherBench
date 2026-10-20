import { useCallback, useEffect, useState, type JSX } from 'react';
import { ApiError, api, type ArtifactSummary, type ViewEntry, type ViewRoot } from '../state/api.js';
import { useArtifactsStamp } from './stamp.js';

function failure(err: unknown): string {
  return err instanceof ApiError ? err.message : "Couldn't list this folder.";
}

/**
 * Lists one folder: a chat's through `/api/view/dirs`, or an app's through
 * `/api/apps/:id/files` (the Code panel's Files tab, spec
 * 2026-10-20-code-tab-design Goal 4), where `undefined` is the app's root.
 */
export type LoadDir = (path: string | undefined) => Promise<{ entries: ViewEntry[] }>;

interface FolderProps {
  loadDir: LoadDir;
  path: string | undefined;
  label: string;
  readOnly?: boolean;
  onOpen: (path: string) => void;
  startOpen: boolean;
  /** What a failed listing says; the server's message by default. */
  describeError?: (err: unknown) => string;
}

function Folder({ loadDir, path, label, readOnly = false, onOpen, startOpen, describeError = failure }: FolderProps): JSX.Element {
  const [open, setOpen] = useState(startOpen);
  const [entries, setEntries] = useState<ViewEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!open || entries) return;
    let cancelled = false;
    loadDir(path).then(
      (r) => !cancelled && setEntries(r.entries),
      (err: unknown) => !cancelled && setError(describeError(err))
    );
    return () => {
      cancelled = true;
    };
  }, [open, entries, loadDir, path, describeError]);
  return (
    <li role="treeitem" aria-expanded={open} aria-label={readOnly ? `${label} (read-only)` : label}>
      <button type="button" onClick={() => setOpen((o) => !o)} className="flex w-full items-center gap-1 rounded px-1 text-left hover:bg-[var(--bg-sunken)]">
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
              <Folder key={e.path} loadDir={loadDir} path={e.path} label={e.name} onOpen={onOpen} startOpen={false} describeError={describeError} />
            ) : (
              <li key={e.path} role="treeitem" aria-label={e.name}>
                <button type="button" onClick={() => onOpen(e.path)} className="w-full truncate rounded px-1 pl-4 text-left hover:bg-[var(--bg-sunken)]">
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
  return (
    <ul role="tree" aria-label="Files" className="space-y-0.5 p-2 text-xs">
      <Folder loadDir={loadDir} path={undefined} label={label} onOpen={onOpen} startOpen {...(describeError ? { describeError } : {})} />
    </ul>
  );
}

/** The chat's artifacts on its branch (Deck #896), then its workspace and extra folders as a lazily loaded tree (Deck #826); a click opens one. */
export function FileTree({ chatId, onOpen, onOpenArtifact }: { chatId: string; onOpen: (path: string) => void; onOpenArtifact: (item: { artifactId: string; title: string }) => void }): JSX.Element {
  const [roots, setRoots] = useState<ViewRoot[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [artifacts, setArtifacts] = useState<ArtifactSummary[]>([]);
  const stamp = useArtifactsStamp(chatId);
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
            <Folder key={r.path} loadDir={loadDir} path={r.path} label={r.label} readOnly={r.access === 'read'} onOpen={onOpen} startOpen={r.workspace} />
          ))}
        </ul>
      )}
    </>
  );
}
