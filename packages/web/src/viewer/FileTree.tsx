import { useEffect, useState, type JSX } from 'react';
import { ApiError, api, type ArtifactSummary, type ViewEntry, type ViewRoot } from '../state/api.js';
import { useArtifactsStamp } from './stamp.js';

function failure(err: unknown): string {
  return err instanceof ApiError ? err.message : "Couldn't list this folder.";
}

function Folder({ chatId, path, label, readOnly = false, onOpen, startOpen }: { chatId: string; path: string; label: string; readOnly?: boolean; onOpen: (path: string) => void; startOpen: boolean }): JSX.Element {
  const [open, setOpen] = useState(startOpen);
  const [entries, setEntries] = useState<ViewEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!open || entries) return;
    let cancelled = false;
    api.view.dir(chatId, path).then(
      (r) => !cancelled && setEntries(r.entries),
      (err: unknown) => !cancelled && setError(failure(err))
    );
    return () => {
      cancelled = true;
    };
  }, [open, entries, chatId, path]);
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
              <Folder key={e.path} chatId={chatId} path={e.path} label={e.name} onOpen={onOpen} startOpen={false} />
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

/** The chat's artifacts on its branch (Deck #896), then its workspace and extra folders as a lazily loaded tree (Deck #826); a click opens one. */
export function FileTree({ chatId, onOpen, onOpenArtifact }: { chatId: string; onOpen: (path: string) => void; onOpenArtifact: (item: { artifactId: string; title: string }) => void }): JSX.Element {
  const [roots, setRoots] = useState<ViewRoot[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [artifacts, setArtifacts] = useState<ArtifactSummary[]>([]);
  const stamp = useArtifactsStamp(chatId);
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
            <Folder key={r.path} chatId={chatId} path={r.path} label={r.label} readOnly={r.access === 'read'} onOpen={onOpen} startOpen={r.workspace} />
          ))}
        </ul>
      )}
    </>
  );
}
