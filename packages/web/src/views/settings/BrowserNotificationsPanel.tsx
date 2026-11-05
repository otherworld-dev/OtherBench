import { useState, type JSX } from 'react';
import { browserNotifyPermission, loadBrowserScheduledNotify, requestBrowserNotify, saveBrowserScheduledNotify } from '../../lib/browserNotify.js';
import { useAuthStore } from '../../state/auth.js';
import { PushSection } from './PushSection.js';

const BLOCKED = 'Your browser blocks notifications from OtherBench. Allow them in its site settings, then turn this on again.';

/**
 * Notifications in a plain browser (`SettingsView` offers this tab only
 * outside the desktop app, whose Desktop tab has its own). Signed in through
 * remote access, "Notify this device" sends Web Push (`PushSection`); the
 * browser notifications below cover only scheduled runs, while a tab is
 * open, once the user turns them on and the browser allows it.
 */
export function BrowserNotificationsPanel(): JSX.Element {
  const [on, setOn] = useState(() => loadBrowserScheduledNotify() && browserNotifyPermission() === 'granted');
  const [problem, setProblem] = useState<string | null>(() => (browserNotifyPermission() === 'denied' && loadBrowserScheduledNotify() ? BLOCKED : null));
  const [busy, setBusy] = useState(false);
  const supported = browserNotifyPermission() !== 'unsupported';
  const signInMode = useAuthStore((st) => st.mode === 'login');

  async function toggle(next: boolean): Promise<void> {
    setProblem(null);
    if (!next) {
      setOn(false);
      saveBrowserScheduledNotify(false);
      return;
    }
    setBusy(true);
    try {
      const permission = await requestBrowserNotify();
      if (permission === 'granted') {
        setOn(true);
        saveBrowserScheduledNotify(true);
      } else {
        setProblem(permission === 'denied' ? BLOCKED : "Your browser didn't allow notifications, so this stays off.");
      }
    } catch (err) {
      setProblem(`Couldn't ask the browser: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="max-w-xl space-y-4 text-sm">
      <h3 className="text-sm font-semibold">Notifications</h3>
      {signInMode && <PushSection />}
      <fieldset className="space-y-2">
        <legend className="mb-1 font-medium">Browser notifications</legend>
        <label className="flex min-h-11 items-center gap-2">
          <input type="checkbox" checked={on} disabled={!supported || busy} onChange={(e) => void toggle(e.target.checked)} className="size-5" />
          Scheduled runs
        </label>
        <p className="text-[var(--text-muted)]">
          {supported
            ? "Says when a scheduled run finishes, fails or doesn't run, while OtherBench is open in a tab of this browser. Your browser asks first."
            : "This browser can't show notifications for this address. They work at http://127.0.0.1 or http://localhost, and over https."}
        </p>
        {problem && (
          <p role="alert" className="text-[var(--danger)]">
            {problem}
          </p>
        )}
      </fieldset>
    </section>
  );
}
