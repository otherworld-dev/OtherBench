import { useEffect, useState, type JSX } from 'react';
import { autostart } from '../../desktop/bridge.js';

/**
 * Settings that only exist in the desktop app. `SettingsView` only offers
 * this tab when `isDesktop()`, so nothing here needs a browser fallback.
 */
export function DesktopPanel(): JSX.Element {
  const [startAtLogin, setStartAtLogin] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    autostart
      .isEnabled()
      .then((on) => {
        if (!cancelled) setStartAtLogin(on);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(`Couldn't read the start-at-login setting: ${String(err)}`);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function toggle(next: boolean): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await autostart.set(next);
      setStartAtLogin(next);
    } catch (err) {
      setError(`Couldn't change the start-at-login setting: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="max-w-xl space-y-4 text-sm">
      <h3 className="text-sm font-semibold">Desktop</h3>
      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={startAtLogin ?? false}
          disabled={startAtLogin === null || busy}
          onChange={(e) => void toggle(e.target.checked)}
        />
        Start Grunt when I sign in
      </label>
      <p className="text-[var(--text-muted)]">
        Closing the window keeps Grunt running in the tray, so replies in progress carry on. Use{' '}
        <strong>Quit</strong> in the tray menu to stop it completely.
      </p>
      {error && (
        <p role="alert" className="text-[var(--danger)]">
          {error}
        </p>
      )}
    </section>
  );
}
