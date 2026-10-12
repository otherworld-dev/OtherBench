import { useEffect, useState, type JSX } from 'react';
import { autostart, setHotkey } from '../../desktop/bridge.js';
import { DEFAULT_HOTKEY, loadHotkey, saveHotkey } from '../../desktop/hotkey.js';
import { loadNotifyPrefs, saveNotifyPrefs, type NotifyPrefs } from '../../desktop/notify.js';
import { useGruntStore } from '../../state/store.js';

/**
 * Settings that only exist in the desktop app. `SettingsView` only offers
 * this tab when `isDesktop()`, so nothing here needs a browser fallback.
 */
export function DesktopPanel(): JSX.Element {
  const [startAtLogin, setStartAtLogin] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notify, setNotify] = useState<NotifyPrefs>(loadNotifyPrefs);
  const hotkeyStatus = useGruntStore((s) => s.hotkeyStatus);
  const setHotkeyStatus = useGruntStore((s) => s.setHotkeyStatus);
  const [hotkeyDraft, setHotkeyDraft] = useState(loadHotkey);
  const [hotkeySaving, setHotkeySaving] = useState(false);

  /** Registers the new hotkey; if that fails, says why and puts the previous one back. */
  async function saveHotkeyDraft(): Promise<void> {
    const next = hotkeyDraft.trim() || DEFAULT_HOTKEY;
    const previous = loadHotkey();
    setHotkeySaving(true);
    try {
      await setHotkey(next);
      saveHotkey(next);
      setHotkeyDraft(next);
      setHotkeyStatus({ accelerator: next, error: null });
    } catch (err) {
      const reason = `Couldn't use ${next}: ${String(err)}. Another app may already use it.`;
      try {
        await setHotkey(previous);
        setHotkeyStatus({ accelerator: previous, error: reason });
      } catch {
        setHotkeyStatus({ accelerator: next, error: `${reason} No hotkey is set now.` });
      }
    } finally {
      setHotkeySaving(false);
    }
  }

  function setNotifyPref(key: keyof NotifyPrefs, on: boolean): void {
    const next = { ...notify, [key]: on };
    setNotify(next);
    saveNotifyPrefs(next);
  }

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
      <div className="space-y-2">
        <label className="block font-medium" htmlFor="quick-chat-hotkey">
          Quick chat hotkey
        </label>
        <div className="flex gap-2">
          <input
            id="quick-chat-hotkey"
            value={hotkeyDraft}
            onChange={(e) => setHotkeyDraft(e.target.value)}
            placeholder={DEFAULT_HOTKEY}
            className="w-48 rounded border border-[var(--border)] bg-[var(--bg)] px-2 py-1 font-mono text-sm"
          />
          <button
            type="button"
            onClick={() => void saveHotkeyDraft()}
            disabled={hotkeySaving}
            className="btn px-2.5 py-1"
          >
            Save
          </button>
        </div>
        <p className="text-[var(--text-muted)]">
          Opens a small chat window from anywhere, e.g. {DEFAULT_HOTKEY}. Keys: Ctrl, Alt, Shift, Super, then a letter, digit or F-key, joined with +.
        </p>
        {hotkeyStatus?.error && (
          <p role="alert" data-testid="hotkey-error" className="text-[var(--danger)]">
            {hotkeyStatus.error}
          </p>
        )}
      </div>
      <fieldset className="space-y-2">
        <legend className="mb-1 font-medium">Notifications while Grunt isn't focused</legend>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={notify.replies} onChange={(e) => setNotifyPref('replies', e.target.checked)} />
          When a reply finishes
        </label>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={notify.approvals} onChange={(e) => setNotifyPref('approvals', e.target.checked)} />
          Approvals, questions and plans
        </label>
        <p className="text-[var(--text-muted)]">Clicking the tray icon afterwards opens the chat you were last notified about.</p>
      </fieldset>
      {error && (
        <p role="alert" className="text-[var(--danger)]">
          {error}
        </p>
      )}
    </section>
  );
}
