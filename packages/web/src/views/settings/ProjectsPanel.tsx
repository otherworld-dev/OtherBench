import { useEffect, useState, type JSX } from 'react';
import type { AppSettings } from '@grunt/core/ports/store.js';
import { ApiError, api } from '../../state/api.js';
import { useGruntStore } from '../../state/store.js';

export const MEMORY_MODEL_HINT =
  "Keeps each project's memory note up to date a few minutes after a chat goes quiet. A cheap or local model is plenty. Project default uses the project's default profile, then the app default.";

/** Settings for every project (spec 2026-10-03-project-memory-design §5): the model the memory summariser runs on. */
export function ProjectsPanel(): JSX.Element {
  const profiles = useGruntStore((s) => s.profiles);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.settings
      .get()
      .then((s) => {
        if (!cancelled) setSettings(s);
      })
      .catch((err: unknown) => {
        console.error('[grunt-web] failed to load settings:', err);
        if (!cancelled) setError("Couldn't load the settings.");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const live = profiles.filter((p) => p.archivedAt === null);
  const stored = settings?.memoryProfileId ?? null;
  // A stored profile that has since been archived or deleted works like Project default, so it reads as one.
  const value = stored !== null && live.some((p) => p.id === stored) ? stored : '';

  async function choose(next: string): Promise<void> {
    setSaving(true);
    setSaved(false);
    setError(null);
    try {
      setSettings(await api.settings.patch({ memoryProfileId: next === '' ? null : next }));
      setSaved(true);
    } catch (err) {
      console.error('[grunt-web] failed to save the memory model:', err);
      setError(err instanceof ApiError ? err.message : 'Save failed -- please try again.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="max-w-xl space-y-4 text-sm">
      <h3 className="text-sm font-semibold">Projects</h3>
      <label className="flex items-center gap-2">
        Memory model
        <select
          aria-label="Memory model"
          value={value}
          disabled={settings === null || saving}
          onChange={(e) => void choose(e.target.value)}
          className="rounded border border-[var(--border)] bg-[var(--bg-raised)] px-2 py-1"
        >
          <option value="">Project default</option>
          {live.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </label>
      <p className="text-[var(--text-muted)]">{MEMORY_MODEL_HINT}</p>
      {saved && (
        <p role="status" className="text-xs text-[var(--text-muted)]">
          Saved.
        </p>
      )}
      {error && (
        <p role="alert" className="text-xs text-[var(--danger)]">
          {error}
        </p>
      )}
    </section>
  );
}
