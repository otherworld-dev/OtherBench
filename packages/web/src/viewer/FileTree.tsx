import { useEffect, useState, type JSX } from 'react';
import { ApiError, api, type ViewEntry, type ViewRoot } from '../state/api.js';

function failure(err: unknown): string {
  return err instanceof ApiError ? err.message : "Couldn't list this folder.";
}

function Folder({ chatId, path, label, onOpen, startOpen }: { chatId: string; path: string; label: string; onOpen: (path: string) => void; startOpen: boolean }): JSX.Element {
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
    <li role="treeitem" aria-expanded={open} aria-label={label}>
      <button type="button" onClick={() => setOpen((o) => !o)} className="flex w-full items-center gap-1 rounded px-1 text-left hover:bg-[var(--bg-sunken)]">
        <span aria-hidden="true">{open ? '▾' : '▸'}</span>
        <span className="truncate">{label.replace(/ \(read-only\)$/, '')}</span>
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

/** The chat's workspace and extra folders as a lazily loaded tree (Deck #826); a file click opens it. */
export function FileTree({ chatId, onOpen }: { chatId: string; onOpen: (path: string) => void }): JSX.Element {
  const [roots, setRoots] = useState<ViewRoot[] | null>(null);
  const [error, setError] = useState<string | null>(null);
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
  if (error) return <p role="alert" className="p-3 text-sm text-[var(--danger)]">{error}</p>;
  if (!roots) return <p className="p-3 text-sm text-[var(--text-faint)]">Loading…</p>;
  return (
    <ul role="tree" aria-label="Files" className="space-y-0.5 p-2 text-xs">
      {roots.map((r) => (
        <Folder key={r.path} chatId={chatId} path={r.path} label={r.access === 'read' ? `${r.label} (read-only)` : r.label} onOpen={onOpen} startOpen={r.workspace} />
      ))}
    </ul>
  );
}
