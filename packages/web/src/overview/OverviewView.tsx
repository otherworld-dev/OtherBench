import { useState, type JSX } from 'react';
import { api } from '../state/api.js';
import { useOtherBenchStore } from '../state/store.js';
import { OverviewTile } from './OverviewTile.js';

const pad = (n: number): string => String(n).padStart(2, '0');

const DAY = 86_400_000;
/** The "older than" choices; `Everything` ticks off up to now. */
const SPANS = [
  { label: '1 day', ms: DAY },
  { label: '1 week', ms: 7 * DAY },
  { label: '1 month', ms: 30 * DAY },
  { label: 'Everything', ms: 0 },
] as const;

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

/** Header action: tick off every chat and issue not touched for a chosen span, after a confirm step. */
function TickOlder(): JSX.Element {
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState<(typeof SPANS)[number] | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  const close = (): void => {
    setOpen(false);
    setPicked(null);
  };
  const confirm = (): void => {
    if (!picked || busy) return;
    setBusy(true);
    api.overview
      .tickOlder(Date.now() - picked.ms)
      .then((r) => {
        setResult(`Ticked off ${plural(r.chats, 'chat')} and ${plural(r.issues, 'issue')}`);
        // The overview refreshes itself from the server events that follow.
        close();
      })
      .catch((err: unknown) => {
        console.error('[otherbench-web] failed to tick off older items:', err);
        setResult("Couldn't tick them off.");
      })
      .finally(() => setBusy(false));
  };

  return (
    <span className="text-xs text-[var(--text-muted)]">
      {result !== null && <span className="mr-2">{result}</span>}
      {!open ? (
        <button type="button" onClick={() => setOpen(true)} className="underline hover:text-[var(--text)]">
          Tick off older than…
        </button>
      ) : picked === null ? (
        <span className="inline-flex items-center gap-1">
          {SPANS.map((s) => (
            <button key={s.label} type="button" onClick={() => setPicked(s)} className="btn px-1.5 py-0 text-xs">
              {s.label}
            </button>
          ))}
          <button type="button" onClick={close} className="underline hover:text-[var(--text)]">
            Cancel
          </button>
        </span>
      ) : (
        <span className="inline-flex items-center gap-1">
          <span>Tick off everything older than {picked.label === 'Everything' ? 'now' : picked.label}? The counts are unknown until it's done.</span>
          <button type="button" disabled={busy} onClick={confirm} className="btn px-1.5 py-0 text-xs">
            Confirm
          </button>
          <button type="button" onClick={close} className="underline hover:text-[var(--text)]">
            Cancel
          </button>
        </span>
      )}
    </span>
  );
}

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
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-label text-lg font-bold uppercase tracking-[0.08em]">Overview</h2>
        <TickOlder />
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
