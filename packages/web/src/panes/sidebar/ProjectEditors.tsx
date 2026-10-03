import { useState, type JSX } from 'react';
import type { Project } from '@grunt/core/ports/store.js';
import type { Profile } from '@grunt/core/types/config.js';
import { WORKSPACE_ROOT_HELP, useServerPlatform, validateWorkspaceRoot } from '../../lib/workspaceRoot.js';
import { ApiError } from '../../state/api.js';

function saveError(err: unknown): string {
  return err instanceof ApiError ? err.message : 'Save failed -- please try again.';
}

const BUTTON = 'rounded border border-[var(--border)] px-2 py-1 text-xs hover:bg-[var(--bg-sunken)] disabled:opacity-50';
const PRIMARY = 'rounded bg-[var(--accent)] px-2.5 py-1 text-xs font-medium text-[var(--accent-text)] disabled:opacity-50';

/** "Set folder…" (spec §3): the same validation and help text as the Inspector's workspace field. */
export function ProjectFolderEditor({
  project,
  onSave,
  onCancel,
}: {
  project: Project;
  /** Rejects with the server's error to keep the form open. */
  onSave: (workspaceRoot: string | null) => Promise<void>;
  onCancel: () => void;
}): JSX.Element {
  const serverPlatform = useServerPlatform();
  const [draft, setDraft] = useState(project.workspaceRoot ?? '');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const inputId = `project-folder-${project.id}`;

  async function save(next: string | null): Promise<void> {
    if (saving) return;
    let value = next;
    if (value !== null) {
      const problem = validateWorkspaceRoot(value, serverPlatform);
      if (problem) {
        setError(problem);
        return;
      }
      value = value.trim();
    }
    setSaving(true);
    setError(null);
    try {
      await onSave(value);
    } catch (err) {
      setError(saveError(err));
    }
    // On success the caller normally closes the form; if it stays open, Save must work again.
    setSaving(false);
  }

  return (
    <div
      className="space-y-2 px-2 py-2"
      data-testid={`project-folder-editor-${project.id}`}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          onCancel();
        }
      }}
    >
      <label className="block text-xs font-medium text-[var(--text-muted)]" htmlFor={inputId}>
        Project folder (native absolute path)
      </label>
      <input
        id={inputId}
        aria-label="Project folder"
        autoFocus
        value={draft}
        onChange={(e) => {
          setDraft(e.target.value);
          setError(null);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            void save(draft);
          }
        }}
        placeholder={serverPlatform === 'win32' ? 'E:\\Git\\Grunt' : '/home/user/project'}
        className="w-full rounded border border-[var(--border)] bg-[var(--bg)] px-2 py-1 font-mono text-xs"
      />
      <p className="text-xs text-[var(--text-muted)]">{WORKSPACE_ROOT_HELP}</p>
      <p className="text-xs text-[var(--text-muted)]">New chats in this project start in this folder. Existing chats keep theirs.</p>
      {error && (
        <p role="alert" data-testid="project-folder-error" className="text-xs text-[var(--danger)]">
          {error}
        </p>
      )}
      <div className="flex gap-2">
        <button type="button" onClick={() => void save(draft)} disabled={saving} className={PRIMARY}>
          {saving ? 'Saving…' : 'Save'}
        </button>
        {project.workspaceRoot !== null && (
          <button type="button" onClick={() => void save(null)} disabled={saving} className={BUTTON}>
            Clear
          </button>
        )}
        <button type="button" onClick={onCancel} className={BUTTON}>
          Cancel
        </button>
      </div>
    </div>
  );
}

/** "Default profile…" (spec §3): unarchived profiles, or App default (null). */
export function ProjectProfileEditor({
  project,
  profiles,
  onSave,
  onCancel,
}: {
  project: Project;
  profiles: Profile[];
  /** Rejects with the server's error to keep the form open. */
  onSave: (defaultProfileId: string | null) => Promise<void>;
  onCancel: () => void;
}): JSX.Element {
  const choices = profiles.filter((p) => p.archivedAt === null);
  const [value, setValue] = useState(choices.some((p) => p.id === project.defaultProfileId) ? (project.defaultProfileId ?? '') : '');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const selectId = `project-profile-${project.id}`;

  async function save(): Promise<void> {
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      await onSave(value === '' ? null : value);
    } catch (err) {
      setError(saveError(err));
    }
    // On success the caller normally closes the form; if it stays open, Save must work again.
    setSaving(false);
  }

  return (
    <div
      className="space-y-2 px-2 py-2"
      data-testid={`project-profile-editor-${project.id}`}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          onCancel();
        }
      }}
    >
      <label className="block text-xs font-medium text-[var(--text-muted)]" htmlFor={selectId}>
        Default profile for new chats
      </label>
      <select
        id={selectId}
        aria-label="Default profile"
        autoFocus
        value={value}
        onChange={(e) => setValue(e.target.value)}
        className="w-full rounded border border-[var(--border)] bg-[var(--bg)] px-2 py-1 text-xs"
      >
        <option value="">App default</option>
        {choices.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>
      {error && (
        <p role="alert" className="text-xs text-[var(--danger)]">
          {error}
        </p>
      )}
      <div className="flex gap-2">
        <button type="button" onClick={() => void save()} disabled={saving} className={PRIMARY}>
          {saving ? 'Saving…' : 'Save'}
        </button>
        <button type="button" onClick={onCancel} className={BUTTON}>
          Cancel
        </button>
      </div>
    </div>
  );
}
