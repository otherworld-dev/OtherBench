import type { JSX } from 'react';
import { useOtherBenchStore } from '../state/store.js';
import { overviewTileDomId } from './OverviewTile.js';

/** The sidebar's list while the Overview is open: tile names with their counts; a click scrolls that tile into view. */
export function OverviewJumpList(): JSX.Element {
  const overview = useOtherBenchStore((s) => s.overview);
  return (
    <ul data-testid="overview-jump-list" className="py-1">
      {overview === null && <li className="px-2 py-1 text-xs text-[var(--text-muted)]">Loading…</li>}
      {overview?.tiles.map((tile) => (
        <li key={tile.key}>
          <button
            type="button"
            data-testid={`overview-jump-${tile.key}`}
            onClick={() => document.getElementById(overviewTileDomId(tile.key))?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
            className={`flex w-full items-center justify-between gap-2 rounded-sm px-2 py-1 text-left text-sm hover:bg-[var(--bg-sunken)] ${tile.faded ? 'text-[var(--text-muted)]' : ''}`}
          >
            <span className="truncate">{tile.name}</span>
            {tile.count > 0 && <span className="rounded-full bg-[var(--accent)] px-1.5 text-[0.65rem] tabular-nums text-[var(--bg)]">{tile.count}</span>}
          </button>
        </li>
      ))}
    </ul>
  );
}
