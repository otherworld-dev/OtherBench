import { useState, type JSX } from 'react';
import type { AppSettings } from '@otherbench/core/ports/store.js';
import { api } from '../../state/api.js';
import { applyFeatures, useFeatures } from '../../state/features.js';

/**
 * The fresh chat card's switch and threshold (spec 2026-11-06-fresh-chat-handover-design): when a Claude Code
 * chat's calls read more than this, the card under its latest reply offers to carry on in a fresh chat. The
 * threshold is typed in thousands of tokens and stored in tokens; the server says what it won't take.
 */
export function FreshChatSection(): JSX.Element {
  const enabled = useFeatures((f) => f.handoverEnabled);
  const threshold = useFeatures((f) => f.handoverThresholdTokens);
  const [draft, setDraft] = useState(String(Math.round(threshold / 1000)));
  const [error, setError] = useState<string | null>(null);

  async function save(body: Partial<AppSettings>): Promise<void> {
    setError(null);
    try {
      applyFeatures(await api.settings.patch(body));
    } catch (err) {
      console.error('[otherbench-web] failed to save the fresh chat settings:', err);
      setError(err instanceof Error ? err.message : "Couldn't save that. Please try again.");
    }
  }

  return (
    <section className="space-y-2 text-sm">
      <h3 className="text-sm font-semibold">Fresh chats</h3>
      <p className="text-[var(--text-muted)]">
        A long chat re-reads everything on every call, which uses up your plan faster and slows replies. Past the threshold, OtherBench offers to carry on in a fresh chat
        that starts from a summary.
      </p>
      <label className="flex items-center gap-2">
        <input type="checkbox" checked={enabled} onChange={(e) => void save({ handoverEnabled: e.target.checked })} />
        Suggest a fresh chat when a Claude Code chat gets big
      </label>
      <div className="flex items-center gap-2">
        <label htmlFor="handover-threshold" className="text-[var(--text-muted)]">
          Threshold (thousand tokens)
        </label>
        <input
          id="handover-threshold"
          type="number"
          min={50}
          max={2000}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          className="w-24 rounded border border-[var(--border)] bg-[var(--bg-raised)] px-1 py-0.5"
        />
        <button type="button" className="btn px-2 py-1" onClick={() => void save({ handoverThresholdTokens: Math.round(Number(draft) * 1000) })}>
          Save threshold
        </button>
      </div>
      {error && (
        <p role="alert" className="text-[var(--danger)]">
          {error}
        </p>
      )}
    </section>
  );
}
