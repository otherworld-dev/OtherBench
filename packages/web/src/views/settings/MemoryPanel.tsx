import { useEffect, useState, type JSX } from 'react';
import { ABOUT_MAX_CHARS, GLOBAL_MEMORY_HEADINGS, validateGlobalMemoryBody } from '@grunt/core/domain/global-memory.js';
import { hasMemoryContent } from '@grunt/core/domain/memory.js';
import type { AppSettings } from '@grunt/core/ports/store.js';
import { MemoryNote } from '../../components/MemoryNote.js';
import { formatRelativeTime } from '../../lib/relativeTime.js';
import { ApiError, api, type GlobalMemoryView } from '../../state/api.js';
import { useGruntStore } from '../../state/store.js';

export const MEMORY_MODEL_HINT =
  "Keeps project memory and your global note up to date a few minutes after a chat goes quiet. The memory model reads your chats, so choose a model you're happy to send that content to; a local model keeps it on this machine. Default uses each project's default profile for its note, else the app default.";

const HEADING = 'text-sm font-semibold';
const HINT = 'text-xs text-[var(--text-muted)]';

function errorText(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}

/**
 * Settings > Memory (spec 2026-10-08-global-memory-design): About you, the
 * learned global note, and the model both memory summarisers run on.
 */
export function MemoryPanel(): JSX.Element {
  const [view, setView] = useState<GlobalMemoryView | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api.memory.global
      .get()
      .then((next) => {
        if (!cancelled) setView(next);
      })
      .catch((err: unknown) => {
        console.error('[grunt-web] failed to load global memory:', err);
        if (!cancelled) setLoadFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <section className="max-w-2xl space-y-8 text-sm">
      {view ? (
        <>
          <AboutYou about={view.memory.about} onSaved={setView} />
          <LearnedNote view={view} onChange={setView} />
        </>
      ) : (
        <p className="text-[var(--text-faint)]">{loadFailed ? "Couldn't load your memory." : 'Loading…'}</p>
      )}
      <MemoryModel />
    </section>
  );
}

function AboutYou({ about, onSaved }: { about: string; onSaved: (view: GlobalMemoryView) => void }): JSX.Element {
  const [draft, setDraft] = useState(about);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const over = draft.length > ABOUT_MAX_CHARS;

  async function save(): Promise<void> {
    setSaving(true);
    setSaved(false);
    setError(null);
    try {
      onSaved(await api.memory.global.saveAbout(draft));
      setSaved(true);
    } catch (err) {
      setError(errorText(err, 'Save failed -- please try again.'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-2">
      <h3 className={HEADING}>About you</h3>
      <p className={HINT}>
        Added to every chat whose profile uses global memory, and the model follows it: who you are, how you like answers, what you work on.
      </p>
      <textarea
        aria-label="About you"
        rows={8}
        value={draft}
        onChange={(e) => {
          setDraft(e.target.value);
          setSaved(false);
        }}
        className="w-full rounded-sm border border-[var(--border-strong)] bg-[var(--bg)] px-2 py-1.5 text-sm"
      />
      <div className="flex items-center gap-3">
        <button type="button" onClick={() => void save()} disabled={saving || over || draft === about} aria-label="Save About you" className="btn btn-primary px-2.5 py-1">
          {saving ? 'Saving…' : 'Save'}
        </button>
        <span data-testid="about-count" className={`font-mono text-xs ${over ? 'text-[var(--danger)]' : 'text-[var(--text-faint)]'}`}>
          {draft.length.toLocaleString('en-US')} / {ABOUT_MAX_CHARS.toLocaleString('en-US')}
        </span>
        {saved && (
          <span data-testid="about-saved" role="status" className={HINT}>
            Saved.
          </span>
        )}
      </div>
      {error && (
        <p data-testid="about-error" role="alert" className="text-xs text-[var(--danger)]">
          {error}
        </p>
      )}
    </div>
  );
}

function LearnedNote({ view, onChange }: { view: GlobalMemoryView; onChange: (view: GlobalMemoryView) => void }): JSX.Element {
  const chats = useGruntStore((s) => s.chats);
  const { memory, lastError } = view;

  function chatTitle(id: string | null): string {
    if (id === null) return 'a chat';
    return chats.find((c) => c.id === id)?.title ?? 'a deleted chat';
  }

  const updatedLine =
    memory.noteUpdatedAt === 0
      ? 'Not saved yet'
      : memory.noteUpdatedBy === 'user'
        ? `Updated ${formatRelativeTime(memory.noteUpdatedAt)} by you`
        : `Updated ${formatRelativeTime(memory.noteUpdatedAt)} from ${chatTitle(memory.noteSourceChatId)}`;

  return (
    <div className="space-y-2">
      <h3 className={HEADING}>What Grunt has learned about you</h3>
      <p className={HINT}>
        Lasting facts about you that the memory model picks up from your chats, added to every chat as background. Pinned is yours: it&rsquo;s never changed
        automatically. A chat marked &ldquo;Don&rsquo;t add to memory&rdquo; is never read.
      </p>
      <MemoryNote
        testIdPrefix="global-memory"
        label="Learned note"
        emptyText="Nothing learned about you yet. It fills in as you chat."
        body={memory.note}
        updatedLine={updatedLine}
        validate={(draft) => validateGlobalMemoryBody(draft)}
        hasContent={(body) => hasMemoryContent(body, GLOBAL_MEMORY_HEADINGS)}
        save={async (draft) => onChange(await api.memory.global.saveNote(draft))}
        loadVersions={() => api.memory.global.versions()}
        loadVersion={(id) => api.memory.global.version(id)}
        restore={async (id) => onChange(await api.memory.global.restore(id))}
        versionAuthor={(v) => (v.createdBy === 'user' ? 'You' : chatTitle(v.sourceChatId))}
      >
        {lastError && (
          <p role="alert" data-testid="global-memory-error" className="rounded border border-[var(--danger)] px-2 py-1.5 text-xs">
            The last automatic update failed {formatRelativeTime(lastError.at)}: {lastError.message}
          </p>
        )}
      </MemoryNote>
    </div>
  );
}

/** The model both memory summarisers run on (spec 2026-10-03-project-memory-design §5). */
function MemoryModel(): JSX.Element {
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
  // A stored profile that has since been archived or deleted works like Default, so it reads as one.
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
      setError(errorText(err, 'Save failed -- please try again.'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-2">
      <h3 className={HEADING}>Memory model</h3>
      <label className="flex items-center gap-2">
        Memory model
        <select
          aria-label="Memory model"
          value={value}
          disabled={settings === null || saving}
          onChange={(e) => void choose(e.target.value)}
          className="rounded border border-[var(--border)] bg-[var(--bg-raised)] px-2 py-1"
        >
          <option value="">Default</option>
          {live.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </label>
      <p className="text-[var(--text-muted)]">{MEMORY_MODEL_HINT}</p>
      {saved && (
        <p data-testid="memory-model-saved" role="status" className="text-xs text-[var(--text-muted)]">
          Saved.
        </p>
      )}
      {error && (
        <p data-testid="memory-model-error" role="alert" className="text-xs text-[var(--danger)]">
          {error}
        </p>
      )}
    </div>
  );
}
