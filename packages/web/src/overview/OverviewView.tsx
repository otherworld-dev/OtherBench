import type { JSX } from 'react';
import { api } from '../state/api.js';
import { useOtherBenchStore } from '../state/store.js';
import { OverviewTile } from './OverviewTile.js';

const pad = (n: number): string => String(n).padStart(2, '0');

/** The main column while the Overview is open: what needs you across apps (spec 2026-10-26-overview). */
export function OverviewView(): JSX.Element {
  const overview = useOtherBenchStore((s) => s.overview);
  const setOverview = useOtherBenchStore((s) => s.setOverview);

  if (overview === null) {
    return (
      <div data-testid="overview-view" className="p-4 text-sm text-[var(--text-muted)]">
        Loading…
      </div>
    );
  }

  const checkedAt = overview.checkedAt === null ? null : new Date(overview.checkedAt);
  const status = overview.checking || checkedAt === null ? 'checking…' : `checked ${pad(checkedAt.getHours())}:${pad(checkedAt.getMinutes())}`;
  const refresh = (): void => {
    api.overview
      .refresh()
      .then(setOverview)
      .catch((err: unknown) => console.error('[otherbench-web] failed to refresh the overview:', err));
  };

  return (
    <div data-testid="overview-view" className="h-full min-h-0 overflow-y-auto bg-[var(--bg)] p-4">
      <div className="mb-3 flex items-baseline justify-between">
        <h2 className="font-label text-lg font-bold uppercase tracking-[0.08em]">Overview</h2>
        <span className="text-xs text-[var(--text-muted)]">
          {status} ·{' '}
          <button type="button" data-testid="overview-refresh" onClick={refresh} className="underline hover:text-[var(--text)]">
            refresh
          </button>
        </span>
      </div>
      {overview.unreachableMachines.map((name) => (
        <p key={`u-${name}`} className="mb-1 text-xs text-[var(--text-muted)]">
          Couldn't reach {name}: chats running there may be waiting on you
        </p>
      ))}
      {overview.loginMismatches.map((m) => (
        <p key={`l-${m.machine}`} className="mb-1 text-xs text-[var(--text-muted)]">
          {m.machine}'s gh is signed in as {m.login}, this machine's as {overview.githubLogin ?? 'unknown'}
        </p>
      ))}
      <div className="mt-3 grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(16rem, 1fr))' }}>
        {overview.tiles.map((tile) => (
          <OverviewTile key={tile.key} tile={tile} />
        ))}
      </div>
    </div>
  );
}
