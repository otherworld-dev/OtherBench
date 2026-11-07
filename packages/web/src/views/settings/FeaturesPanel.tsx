import { useEffect, useState, type JSX } from 'react';
import type { AppSettings } from '@otherbench/core/ports/store.js';
import { ApiError, api } from '../../state/api.js';
import { applyFeatures, refreshFeatures, useFeatures } from '../../state/features.js';
import { StartCommandsSection } from './StartCommandsSection.js';

type FeatureKey = 'githubEnabled' | 'nextcloudEnabled';

const FEATURES: { key: FeatureKey; label: string; detail: string }[] = [
  {
    key: 'githubEnabled',
    label: 'GitHub',
    detail: "Issues in Code mode and on each app's page, the GitHub inbox in the Overview, and the app form's GitHub repo. Git itself (commit, pull, push) keeps working.",
  },
  {
    key: 'nextcloudEnabled',
    label: 'Nextcloud',
    detail: "The Deck, Wiki and Links tabs, Deck cards in the Overview, \"Deck #N\" links in messages, and the app form's Nextcloud fields.",
  },
];

/**
 * GitHub and Nextcloud on or off on this machine. Off hides everything that
 * uses it and the server stops reaching it, the Overview's background check
 * included; each app keeps its repo, board and wiki for when it's turned back on.
 */
export function FeaturesPanel(): JSX.Element {
  const features = useFeatures();
  const [saving, setSaving] = useState<FeatureKey | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The switches as the server has them now, not as this window last heard.
  useEffect(() => refreshFeatures(), []);
  const on: Record<FeatureKey, boolean> = { githubEnabled: features.github, nextcloudEnabled: features.nextcloud };

  async function toggle(key: FeatureKey, value: boolean): Promise<void> {
    setSaving(key);
    setError(null);
    try {
      const body: Partial<AppSettings> = { [key]: value };
      applyFeatures(await api.settings.patch(body));
    } catch (err) {
      console.error(`[otherbench-web] failed to change ${key}:`, err);
      setError(err instanceof ApiError ? err.message : "Couldn't save that. Please try again.");
    } finally {
      setSaving(null);
    }
  }

  return (
    <section className="max-w-xl space-y-4 text-sm">
      <h3 className="text-sm font-semibold">Features</h3>
      <p className="text-[var(--text-muted)]">
        Turn off what you don&apos;t use. Off hides it everywhere and OtherBench stops contacting it, in the background too. Your apps keep their settings for it, so turning it back on brings everything back. This
        applies to this machine only.
      </p>
      {FEATURES.map((f) => (
        <label key={f.key} className="flex items-start gap-2">
          <input
            type="checkbox"
            data-testid={`feature-${f.key}`}
            checked={on[f.key]}
            disabled={saving !== null}
            onChange={(e) => void toggle(f.key, e.target.checked)}
            className="mt-1"
          />
          <span>
            <span className="font-medium">{f.label}</span>
            <span className="block text-[var(--text-muted)]">{f.detail}</span>
          </span>
        </label>
      ))}
      {error && (
        <p role="alert" className="text-[var(--danger)]">
          {error}
        </p>
      )}
      <StartCommandsSection />
    </section>
  );
}
