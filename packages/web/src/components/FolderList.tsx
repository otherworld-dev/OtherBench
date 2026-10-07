import { useState, type JSX } from 'react';
import type { FolderAccess, FolderView } from '@grunt/core/types/workspace.js';
import { pickFolder } from '../desktop/bridge.js';
import { useServerPlatform, validateWorkspaceRoot } from '../lib/workspaceRoot.js';
import { ApiError, type FolderEntry } from '../state/api.js';

const ACCESS_LABEL: Record<FolderAccess, string> = { read: 'Read-only', readwrite: 'Read & write' };

/** Where an extra folder is, as shown: its path on the machine that runs the chat, or where it's known to be. */
export function folderPath(view: FolderView): string {
  if (view.root) return view.root;
  if (view.status.status === 'unresolved' && view.status.hint) return view.status.hint.path;
  return view.workspace.kind === 'machine' ? view.workspace.root : view.workspace.subpath || 'a location';
}

/** Each folder as the API keeps it, to send back unchanged (spec 2026-10-07-extra-folders). */
function kept(views: FolderView[]): FolderEntry[] {
  return views.map((v) => ({ workspace: v.workspace, access: v.access }));
}

/**
 * An editable list of extra folders (a chat's or a project's): each with its
 * access and Remove, plus a path to add (or Choose…, the native picker, when
 * the folder would be on this machine). Every change saves the whole list.
 */
export function FolderList({
  label,
  views,
  canPick,
  onSave,
}: {
  /** Whose folders these are, for labels: "this chat", "the project". */
  label: string;
  views: FolderView[];
  canPick: boolean;
  onSave: (folders: FolderEntry[]) => Promise<void>;
}): JSX.Element {
  const serverPlatform = useServerPlatform();
  const [draft, setDraft] = useState('');
  const [access, setAccess] = useState<FolderAccess>('read');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(folders: FolderEntry[]): Promise<boolean> {
    setSaving(true);
    setError(null);
    try {
      await onSave(folders);
      return true;
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't save the folders. Please try again.");
      return false;
    } finally {
      setSaving(false);
    }
  }

  async function add(path: string): Promise<void> {
    const invalid = validateWorkspaceRoot(path, serverPlatform);
    if (invalid) {
      setError(invalid);
      return;
    }
    if (await save([...kept(views), { path: path.trim(), access }])) setDraft('');
  }

  return (
    <div className="space-y-2">
      {views.length === 0 ? (
        <p className="text-xs text-[var(--text-faint)]">None.</p>
      ) : (
        <ul className="space-y-1">
          {views.map((view, i) => (
            <li key={`${folderPath(view)}:${i}`} data-testid="extra-folder" className="space-y-1 text-xs">
              <div className="break-all font-mono">{folderPath(view)}</div>
              <div className="flex flex-wrap items-center gap-2">
                {view.status.status !== 'ok' && <span className="text-[var(--warn)]">not on this machine</span>}
                <select
                  aria-label={`Access to ${folderPath(view)}`}
                  value={view.access}
                  disabled={saving}
                  onChange={(e) => void save(views.map((v, j) => ({ workspace: v.workspace, access: j === i ? (e.target.value as FolderAccess) : v.access })))}
                  className="rounded border border-[var(--border)] bg-[var(--bg-raised)] px-1 py-0.5"
                >
                  <option value="read">{ACCESS_LABEL.read}</option>
                  <option value="readwrite">{ACCESS_LABEL.readwrite}</option>
                </select>
                <button
                  type="button"
                  aria-label={`Remove ${folderPath(view)}`}
                  disabled={saving}
                  onClick={() => void save(kept(views.filter((_, j) => j !== i)))}
                  className="rounded border border-[var(--border)] px-1.5 py-0.5 hover:bg-[var(--bg-sunken)] disabled:opacity-50"
                >
                  Remove
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
      <input
        aria-label={`Add a folder for ${label}`}
        placeholder="Folder path"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && draft.trim() !== '') void add(draft);
        }}
        className="w-full rounded border border-[var(--border)] bg-[var(--bg)] px-2 py-1 font-mono text-xs"
      />
      <div className="flex flex-wrap items-center gap-2">
        <select
          aria-label={`Access to the new folder for ${label}`}
          value={access}
          onChange={(e) => setAccess(e.target.value as FolderAccess)}
          className="rounded border border-[var(--border)] bg-[var(--bg-raised)] px-1 py-1 text-xs"
        >
          <option value="read">{ACCESS_LABEL.read}</option>
          <option value="readwrite">{ACCESS_LABEL.readwrite}</option>
        </select>
        <button
          type="button"
          disabled={saving || draft.trim() === ''}
          onClick={() => void add(draft)}
          className="rounded border border-[var(--border)] px-2 py-1 text-xs hover:bg-[var(--bg-sunken)] disabled:opacity-50"
        >
          Add
        </button>
        {canPick && (
          <button
            type="button"
            disabled={saving}
            onClick={() => {
              void pickFolder('Choose a folder').then((picked) => (picked ? add(picked) : undefined));
            }}
            className="rounded border border-[var(--border)] px-2 py-1 text-xs hover:bg-[var(--bg-sunken)] disabled:opacity-50"
          >
            Choose…
          </button>
        )}
      </div>
      {error && (
        <p role="alert" className="text-xs text-[var(--danger)]">
          {error}
        </p>
      )}
    </div>
  );
}
