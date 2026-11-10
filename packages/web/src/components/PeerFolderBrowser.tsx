import { useEffect, useState, type JSX } from 'react';
import type { PeerFolderListing } from '@otherbench/core/types/workspace.js';
import { ApiError, api } from '../state/api.js';
import { oneLine } from '../viewer/browser.js';

/**
 * Choosing a folder on the machine a chat runs on, when that isn't this one (`GET /api/peers/:id/dirs`). That
 * machine lists only folders inside its own locations, so browsing starts at its locations and can't go above one:
 * Up stops at the location's root. Folder names and paths are that machine's, shown as text only; the path picked is
 * sent back as typed, and that machine's location paths file it under the location.
 */
export function PeerFolderBrowser({
  nodeId,
  machine,
  onPick,
  onClose,
}: {
  nodeId: string;
  /** The machine's name, for the words. */
  machine: string;
  onPick: (path: string) => void;
  onClose: () => void;
}): JSX.Element {
  const name = oneLine(machine);
  const [listing, setListing] = useState<PeerFolderListing | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Each load is numbered so that an older answer arriving late never replaces a newer one.
  const [asked, setAsked] = useState<{ path: string | undefined; n: number }>({ path: undefined, n: 0 });

  useEffect(() => {
    let current = true;
    api.peers
      .dirs(nodeId, asked.path)
      .then((next) => {
        if (current) setListing(next);
      })
      .catch((err: unknown) => {
        if (current) setError(err instanceof ApiError ? err.message : `Couldn't list ${name}'s folders.`);
      })
      .finally(() => {
        if (current) setLoading(false);
      });
    return () => {
      current = false;
    };
  }, [nodeId, asked, name]);

  const open = (path: string | undefined): void => {
    setLoading(true);
    setError(null);
    setAsked((a) => ({ path, n: a.n + 1 }));
  };
  const at = listing?.path ?? null;

  return (
    <div data-testid="peer-folder-browser" className="space-y-2 rounded border border-[var(--border)] bg-[var(--bg-sunken)] p-2 text-xs">
      <p className="text-[var(--text-muted)]">
        Folders in <bdi>{name}</bdi>'s locations. Only they can be browsed from here.
      </p>
      {listing && at !== null && (
        <div className="space-y-1">
          <p data-testid="peer-folder-path" className="font-mono break-all">
            <bdi>{oneLine(at)}</bdi>
          </p>
          <div className="flex flex-wrap gap-2">
            <button type="button" disabled={loading} onClick={() => open(undefined)} className="btn px-2 py-0.5">
              Locations
            </button>
            {listing.parent !== null && (
              <button type="button" disabled={loading} onClick={() => open(listing.parent ?? undefined)} className="btn px-2 py-0.5">
                Up
              </button>
            )}
          </div>
        </div>
      )}
      {loading && !listing && <p className="text-[var(--text-faint)]">Asking <bdi>{name}</bdi>…</p>}
      {listing && at === null && (
        listing.locations.length === 0 ? (
          <p className="text-[var(--text-muted)]">
            <bdi>{name}</bdi> has no locations yet, so none of its folders can be browsed from here. Add one in Settings → Locations on <bdi>{name}</bdi>, or type the path.
          </p>
        ) : (
          <ul className="space-y-1">
            {listing.locations.map((l) => (
              <li key={l.id}>
                <button type="button" disabled={loading} onClick={() => open(l.root)} className="btn w-full px-2 py-0.5 text-left">
                  <bdi>{oneLine(l.name)}</bdi> <span className="font-mono text-[var(--text-muted)]">(<bdi>{oneLine(l.root)}</bdi>)</span>
                </button>
              </li>
            ))}
          </ul>
        )
      )}
      {listing && at !== null && (
        listing.dirs.length === 0 ? (
          <p className="text-[var(--text-faint)]">No folders in here.</p>
        ) : (
          <ul className="max-h-60 space-y-0.5 overflow-y-auto">
            {listing.dirs.map((d) => (
              <li key={d.path}>
                <button type="button" disabled={loading} onClick={() => open(d.path)} className="w-full rounded px-2 py-0.5 text-left font-mono hover:bg-[var(--bg-raised)]">
                  <bdi>{oneLine(d.name)}</bdi>
                </button>
              </li>
            ))}
          </ul>
        )
      )}
      {listing?.truncated === true && <p className="text-[var(--text-muted)]">Only the first {listing.dirs.length} folders are listed; type the path for another.</p>}
      {error && (
        <p role="alert" className="text-[var(--danger)]">
          {error}
        </p>
      )}
      <div className="flex gap-2">
        {at !== null && (
          <button type="button" disabled={loading} onClick={() => onPick(at)} className="btn btn-primary px-2 py-0.5">
            Use this folder
          </button>
        )}
        <button type="button" onClick={onClose} className="btn px-2 py-0.5">
          Cancel
        </button>
      </div>
    </div>
  );
}
