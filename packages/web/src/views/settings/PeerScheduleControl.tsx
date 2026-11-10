import { useEffect, useState, type JSX } from 'react';
import { ApiError, api } from '../../state/api.js';

/**
 * "Let paired machines manage this machine's schedules" (`peerScheduleControl`, off by default; this machine only,
 * never synced, and the peer listener has no settings route, so a paired machine can't turn it on). On: a paired
 * machine can run, pause, resume, edit, delete and make this machine's schedules, reading their prompts to edit
 * them, and this machine records which machine made each change. Off: it sees the rows and their run history only.
 * A plain switch, unlike computer use's: it hands over no mouse or keyboard, and a scheduled run still refuses
 * anything that would need an approval.
 */
export function PeerScheduleControl(): JSX.Element {
  const [on, setOn] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    api.settings
      .get()
      .then((s) => live && setOn(s.peerScheduleControl === true))
      .catch((err: unknown) => console.error('[otherbench-web] failed to load the settings:', err));
    return () => {
      live = false;
    };
  }, []);

  async function change(value: boolean): Promise<void> {
    setSaving(true);
    setError(null);
    try {
      setOn((await api.settings.patch({ peerScheduleControl: value })).peerScheduleControl === true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't save that. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-1">
      <label className="flex items-start gap-2">
        <input
          type="checkbox"
          data-testid="peer-schedule-control"
          checked={on === true}
          disabled={on === null || saving}
          onChange={(e) => void change(e.target.checked)}
          className="mt-1"
        />
        <span>
          <span className="font-medium">Let paired machines manage this machine&rsquo;s schedules</span>
          <span className="block text-xs text-[var(--text-muted)]">
            A paired machine can then run, pause, edit, delete and make schedules here, and see their prompts. A schedule starts runs on this
            computer with nobody watching; they still can&rsquo;t do anything that needs an approval, and this computer notes which machine made
            each change. Off (the default), a paired machine can only see the schedules here and their history.
          </span>
        </span>
      </label>
      {error && (
        <p role="alert" className="text-xs text-[var(--danger)]">
          {error}
        </p>
      )}
    </div>
  );
}
