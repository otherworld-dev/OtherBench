import { useState, type JSX } from 'react';
import { START_COMMAND_MAX } from '@otherbench/core/domain/settings.js';
import type { AppSettings } from '@otherbench/core/ports/store.js';
import { ApiError, api } from '../../state/api.js';
import { applyFeatures, useFeatures } from '../../state/features.js';

type CommandKey = 'deckStartCommand' | 'issueStartCommand';

/**
 * What a Deck card's or GitHub issue's "Start a chat on this" sends at once (`fillStartCommand`), e.g. `/start
 * {card}`. Empty, the default, keeps the button as it was: the card or issue goes in the new chat's box, unsent.
 * Each box shows only while its feature is on.
 */
export function StartCommandsSection(): JSX.Element | null {
  const features = useFeatures();
  if (!features.nextcloud && !features.github) return null;
  return (
    <section className="space-y-2 text-sm">
      <h3 className="text-sm font-semibold">Start commands</h3>
      <p className="text-[var(--text-muted)]">
        What the Chat button on a card or issue sends as the new chat&apos;s first message, such as a slash command of your own. Leave it empty to put the card or issue in the
        message box instead, without sending anything.
      </p>
      {features.nextcloud && (
        <CommandField
          key={`deck:${features.deckStartCommand}`}
          field="deckStartCommand"
          label="Deck card"
          noun="card"
          placeholderName="{card}"
          example="d123"
          saved={features.deckStartCommand}
        />
      )}
      {features.github && (
        <CommandField
          key={`issue:${features.issueStartCommand}`}
          field="issueStartCommand"
          label="GitHub issue"
          noun="issue"
          placeholderName="{issue}"
          example="#45"
          saved={features.issueStartCommand}
        />
      )}
    </section>
  );
}

function CommandField(props: { field: CommandKey; label: string; noun: string; placeholderName: string; example: string; saved: string }): JSX.Element {
  const { field, label, noun, placeholderName, example, saved } = props;
  const [draft, setDraft] = useState(saved);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const id = `start-command-${field}`;

  async function save(): Promise<void> {
    setSaving(true);
    setError(null);
    try {
      const body: Partial<AppSettings> = { [field]: draft };
      applyFeatures(await api.settings.patch(body));
    } catch (err) {
      console.error(`[otherbench-web] failed to save ${field}:`, err);
      setError(err instanceof ApiError ? err.message : "Couldn't save that. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-1">
      <label htmlFor={id} className="block font-medium">
        {label}
      </label>
      <div className="flex items-center gap-2">
        <input
          id={id}
          type="text"
          value={draft}
          maxLength={START_COMMAND_MAX}
          placeholder={`/start ${placeholderName}`}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void save();
          }}
          className="min-w-0 flex-1 rounded border border-[var(--border)] bg-[var(--bg-raised)] px-1 py-0.5 font-mono"
        />
        <button type="button" className="btn px-2 py-1" disabled={saving || draft.trim() === saved} onClick={() => void save()}>
          Save
        </button>
      </div>
      <p className="text-xs text-[var(--text-muted)]">{`${placeholderName} becomes the ${noun}'s ref, like ${example}; without it, the ref goes on the end.`}</p>
      {error && (
        <p role="alert" className="text-[var(--danger)]">
          {error}
        </p>
      )}
    </div>
  );
}
