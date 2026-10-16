import { useEffect, useRef, useState, type JSX } from 'react';
import type { SandboxStatus } from '@otherbench/core/ports/sandbox.js';
import { ApiError, api } from '../../state/api.js';

/** How often the panel asks for progress while the sandbox is being set up. */
export const SANDBOX_POLL_MS = 1000;

const STATE_LABEL: Record<SandboxStatus['state'], string> = {
  unsupported: 'Not available',
  not_set_up: 'Not set up',
  setting_up: 'Setting up…',
  ready: 'Ready',
  failed: 'Setup failed',
};

function errorText(err: unknown): string {
  return err instanceof ApiError ? err.message : "That didn't work -- please try again.";
}

/** "ffmpeg, pandoc\nimagemagick" -> ['ffmpeg', 'pandoc', 'imagemagick']. */
export function splitPackages(text: string): string[] {
  return text
    .split(/[\s,]+/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}

/**
 * Settings > Sandbox (spec 2026-10-12-sandbox-design, "Setup"): where profiles
 * set to run their shell "in the sandbox" run it. Set up, Repair and Remove,
 * the versions inside, progress while it sets up, and extra apt packages.
 * Nothing is set up until the user presses Set up.
 */
export function SandboxPanel(): JSX.Element {
  const [status, setStatus] = useState<SandboxStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [packagesText, setPackagesText] = useState<string | null>(null);
  const stateRef = useRef<HTMLParagraphElement>(null);
  const logRef = useRef<HTMLPreElement>(null);
  const previousState = useRef<SandboxStatus['state'] | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.sandbox
      .status()
      .then((s) => {
        if (!cancelled) setStatus(s);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(errorText(err));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Setup, Repair and a package install all report as 'setting_up' until they finish.
  const settingUp = status?.state === 'setting_up';
  useEffect(() => {
    if (!settingUp) return;
    const timer = setInterval(() => {
      api.sandbox
        .status()
        .then((s) => {
          setStatus(s);
          setError(null);
        })
        .catch((err: unknown) => setError(errorText(err)));
    }, SANDBOX_POLL_MS);
    return () => clearInterval(timer);
  }, [settingUp]);

  // The newest progress line stays in view.
  const logLength = status?.log?.length ?? 0;
  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [logLength, status?.log?.[logLength - 1]]);

  // Set up, Repair and Remove take their own button away when the state changes; keep keyboard focus on the panel.
  const state = status?.state ?? null;
  useEffect(() => {
    const before = previousState.current;
    previousState.current = state;
    if (before !== null && state !== before && (document.activeElement === null || document.activeElement === document.body)) {
      (logRef.current ?? stateRef.current)?.focus();
    }
  }, [state]);

  /** Runs a button's call; true when it went through. */
  async function act(fn: () => Promise<SandboxStatus>): Promise<boolean> {
    setBusy(true);
    setError(null);
    try {
      setStatus(await fn());
      return true;
    } catch (err) {
      setError(errorText(err));
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function applyPackages(list: string[]): Promise<void> {
    // Back to showing the server's list, which is what it now holds.
    if (await act(() => api.sandbox.setPackages(list))) setPackagesText(null);
  }

  function remove(): void {
    const where = status?.machine ?? 'this machine';
    const ok = window.confirm(
      `Remove the sandbox from ${where}? This deletes the otherbench-sandbox WSL distro and everything installed in it, including each chat's home folder there. Your own folders aren't touched.`
    );
    if (ok) void act(() => api.sandbox.remove());
  }

  if (!status) {
    return error ? (
      <p role="alert" className="text-sm text-[var(--danger)]">
        {error}
      </p>
    ) : (
      <p className="text-sm text-[var(--text-faint)]">Loading…</p>
    );
  }

  if (status.state === 'unsupported') {
    return (
      <p data-testid="sandbox-unsupported" className="max-w-2xl text-sm text-[var(--text-muted)]">
        {status.detail ?? "The sandbox isn't available on this platform yet."}
      </p>
    );
  }

  const packages = packagesText ?? status.packages.join(' ');
  const canRepair = status.state === 'ready' || status.state === 'failed';
  return (
    <div data-testid="sandbox-panel" className="max-w-2xl space-y-4">
      <p className="text-sm text-[var(--text-muted)]">
        Profiles whose shell runs &ldquo;in the sandbox&rdquo; run their commands in a Linux VM on {status.machine} (a WSL distro called otherbench-sandbox).
        Each command sees only its chat&rsquo;s folders and reaches only the hosts its profile allows; any other host asks you first. Under
        &ldquo;ask on mutate&rdquo; those commands need no approval.
      </p>
      <p ref={stateRef} role="status" tabIndex={-1} data-testid="sandbox-state" className="text-sm outline-none">
        <strong>{STATE_LABEL[status.state]}</strong>
        {status.state === 'not_set_up' ? ` on ${status.machine}.` : ''}
      </p>
      {/* On a failed setup this is "<step>: <message>"; on a ready sandbox it is why the last package install failed. */}
      {(status.state === 'failed' || status.state === 'ready') && status.detail && (
        <p role="alert" className="text-sm text-[var(--danger)]">
          {status.state === 'ready' ? `The last package install failed. ${status.detail}` : status.detail}
        </p>
      )}
      {status.versions && (
        <dl data-testid="sandbox-versions" className="grid grid-cols-[auto_1fr] gap-x-4 text-xs text-[var(--text-muted)]">
          <dt>Linux</dt>
          <dd>{status.versions.distro}</dd>
          <dt>Sandbox runtime</dt>
          <dd>{status.versions.runtime}</dd>
          <dt>Node</dt>
          <dd>{status.versions.node}</dd>
        </dl>
      )}
      {(status.warnings ?? []).map((w) => (
        <p key={w} data-testid="sandbox-warning" className="text-xs text-[var(--warn)]">
          <span className="font-medium">Warning:</span> {w}
        </p>
      ))}
      <div className="flex flex-wrap gap-2">
        {status.state === 'not_set_up' && (
          <button type="button" disabled={busy} onClick={() => void act(() => api.sandbox.setup())} className="btn btn-primary px-3 py-1.5">
            Set up
          </button>
        )}
        {canRepair && (
          <button type="button" disabled={busy} onClick={() => void act(() => api.sandbox.setup())} className="btn px-3 py-1.5">
            Repair
          </button>
        )}
        {canRepair && (
          <button type="button" disabled={busy} onClick={remove} className="btn btn-danger px-3 py-1.5">
            Remove
          </button>
        )}
      </div>
      {status.log && status.log.length > 0 && (
        <pre
          ref={logRef}
          role="log"
          aria-label="Setup progress"
          tabIndex={0}
          data-testid="sandbox-log"
          className="max-h-64 overflow-y-auto rounded-sm bg-[var(--bg-sunken)] p-2 text-xs whitespace-pre-wrap"
        >
          {status.log.join('\n')}
        </pre>
      )}
      <div className="space-y-1">
        <label className="block text-xs font-medium text-[var(--text-muted)]" htmlFor="sandbox-packages">
          Extra packages
        </label>
        <input
          id="sandbox-packages"
          aria-describedby="sandbox-packages-help"
          value={packages}
          onChange={(e) => setPackagesText(e.target.value)}
          placeholder="ffmpeg pandoc"
          className="w-full rounded border border-[var(--border)] bg-[var(--bg)] px-2 py-1.5 text-sm"
        />
        <p id="sandbox-packages-help" className="text-xs text-[var(--text-muted)]">
          Ubuntu (apt) package names. OtherBench installs them as root when you press Apply; commands in the sandbox can&rsquo;t install system packages
          themselves. Taking one off the list doesn&rsquo;t uninstall it.
        </p>
        <button type="button" disabled={busy || settingUp} onClick={() => void applyPackages(splitPackages(packages))} className="btn px-3 py-1.5">
          Apply
        </button>
      </div>
      {error && (
        <p role="alert" className="text-xs text-[var(--danger)]">
          {error}
        </p>
      )}
    </div>
  );
}
