import { useEffect, useState, type JSX } from 'react';
import { checkForUpdates, installUpdateNow, onUpdateStatus, setBetaUpdates, updateStatus, type UpdateStatus } from '../../desktop/bridge.js';

/** One line saying where the updater is. */
export function updateStatusText(s: UpdateStatus): string {
  switch (s.state) {
    case 'dev-build':
      return "This is a development build, so it doesn't update itself";
    case 'idle':
      return `Version ${s.current}. Not checked yet`;
    case 'checking':
      return 'Checking for updates…';
    case 'up-to-date':
      return `Up to date (${s.current})`;
    case 'ahead':
      return `You're on a newer build than the current release (${s.newestFull ?? 'none yet'})`;
    case 'no-releases':
      return 'No releases yet';
    case 'downloading':
      return `Downloading ${s.available ?? 'the update'}…`;
    case 'ready': {
      const waiting = s.waitingFor.length > 0 ? ` (waiting for: ${s.waitingFor.join(', ')})` : '';
      return `${s.available ?? 'An update'} is ready. It installs when nothing is running and you're away${waiting}`;
    }
    case 'ask':
      return `${s.available ?? 'An update'} has been waiting a day.`;
    case 'installing':
      return `Installing ${s.available ?? 'the update'}…`;
    case 'error':
      return `Couldn't check for updates: ${s.error ?? 'unknown error'}`;
  }
}

function clock(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/**
 * Settings → Desktop → Updates: this build's version, the betas switch, and
 * what the shell's updater is doing (desktop/src-tauri/src/update.rs), kept
 * current by its `update-status` events.
 */
export function UpdatesSection(): JSX.Element {
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let off: (() => void) | null = null;
    updateStatus()
      .then((s) => {
        if (!cancelled) setStatus(s);
      })
      .catch((err: unknown) => setError(String(err)));
    void onUpdateStatus((s) => setStatus(s)).then((unlisten) => {
      if (cancelled) unlisten();
      else off = unlisten;
    });
    return () => {
      cancelled = true;
      off?.();
    };
  }, []);

  async function act(run: () => Promise<void>): Promise<void> {
    setError(null);
    try {
      await run();
    } catch (err) {
      setError(String(err));
    }
  }

  const installed = status?.installed ?? false;
  return (
    <fieldset className="space-y-2">
      <legend className="mb-1 font-medium">Updates</legend>
      {status && (
        <p data-testid="update-status" className={status.state === 'error' ? 'text-[var(--danger)]' : undefined}>
          {updateStatusText(status)}
        </p>
      )}
      {status?.lastCheckedAt != null && (
        <p data-testid="update-last-checked" className="text-[var(--text-muted)]">
          Last checked at {clock(status.lastCheckedAt)}
        </p>
      )}
      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={status?.beta ?? false}
          disabled={!installed}
          onChange={(e) => {
            const beta = e.target.checked;
            setStatus((s) => (s ? { ...s, beta } : s));
            void act(() => setBetaUpdates(beta));
          }}
        />
        Get beta releases early
      </label>
      <div className="flex gap-2">
        <button type="button" className="btn px-3 py-1.5" disabled={!installed || status?.state === 'checking'} onClick={() => void act(checkForUpdates)}>
          Check now
        </button>
        {(status?.state === 'ready' || status?.state === 'ask') && (
          <button type="button" className="btn btn-primary px-3 py-1.5" onClick={() => void act(installUpdateNow)}>
            Restart and update now
          </button>
        )}
      </div>
      <p className="text-[var(--text-muted)]">
        Betas come from every change to the development branch. Turning this off never goes back to an older build: this machine stays where it is until a full release passes it.
      </p>
      {error && (
        <p role="alert" className="text-[var(--danger)]">
          {error}
        </p>
      )}
    </fieldset>
  );
}
