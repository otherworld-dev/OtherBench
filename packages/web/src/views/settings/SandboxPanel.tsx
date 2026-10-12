import { useEffect, useState, type JSX } from 'react';
import type { SandboxStatus } from '@grunt/core/ports/sandbox.js';
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
        .then(setStatus)
        .catch((err: unknown) => console.error('[grunt-web] failed to load the sandbox status:', err));
    }, SANDBOX_POLL_MS);
    return () => clearInterval(timer);
  }, [settingUp]);

  async function act(fn: () => Promise<SandboxStatus>): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      setStatus(await fn());
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  function remove(): void {
    const where = status?.machine ?? 'this machine';
    const ok = window.confirm(
      `Remove the sandbox from ${where}? This deletes the grunt-sandbox WSL distro and everything installed in it, including each chat's home folder there. Your own folders aren't touched.`
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
        Profiles whose shell runs &ldquo;in the sandbox&rdquo; run their commands in a Linux VM on {status.machine} (a WSL distro called grunt-sandbox).
        Each command sees only its chat&rsquo;s folders and reaches only the hosts its profile allows; any other host asks you first. Under
        &ldquo;ask on mutate&rdquo; those commands need no approval.
      </p>
      <p data-testid="sandbox-state" className="text-sm">
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
          {w}
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
        <pre data-testid="sandbox-log" className="max-h-64 overflow-y-auto rounded-sm bg-[var(--bg-sunken)] p-2 text-xs whitespace-pre-wrap">
          {status.log.join('\n')}
        </pre>
      )}
      <div className="space-y-1">
        <label className="block text-xs font-medium text-[var(--text-muted)]" htmlFor="sandbox-packages">
          Extra packages
        </label>
        <input
          id="sandbox-packages"
          value={packages}
          onChange={(e) => setPackagesText(e.target.value)}
          placeholder="ffmpeg pandoc"
          className="w-full rounded border border-[var(--border)] bg-[var(--bg)] px-2 py-1.5 text-sm"
        />
        <p className="text-xs text-[var(--text-muted)]">
          Ubuntu (apt) package names. Grunt installs them as root when you press Apply; commands in the sandbox can&rsquo;t install system packages
          themselves. Taking one off the list doesn&rsquo;t uninstall it.
        </p>
        <button type="button" disabled={busy || settingUp} onClick={() => void act(() => api.sandbox.setPackages(splitPackages(packages)))} className="btn px-3 py-1.5">
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
