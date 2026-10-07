import { useState, type JSX } from 'react';
import type { FolderAccess } from '@grunt/core/types/workspace.js';
import { pickFolder } from '../../desktop/bridge.js';
import { useServerPlatform, validateWorkspaceRoot } from '../../lib/workspaceRoot.js';
import type { DraftFolder } from './draft.js';

const ACCESS_LABEL: Record<FolderAccess, string> = { read: 'Read-only', readwrite: 'Read & write' };
const SELECT = 'rounded-sm border border-[var(--border-strong)] bg-[var(--bg-raised)] px-1 py-0.5 text-xs';

/**
 * The project page's "Other folders" (spec 2026-10-08-project-page-design §3):
 * FolderList's checks and picker, but every change stays in the page's draft
 * until Create/Save instead of saving at once.
 */
export function FolderDraftList({ folders, onChange, canPick }: { folders: DraftFolder[]; onChange: (next: DraftFolder[]) => void; canPick: boolean }): JSX.Element {
  const serverPlatform = useServerPlatform();
  const [path, setPath] = useState('');
  const [access, setAccess] = useState<FolderAccess>('read');
  const [error, setError] = useState<string | null>(null);

  function add(raw: string): void {
    const problem = validateWorkspaceRoot(raw, serverPlatform);
    if (problem) {
      setError(problem);
      return;
    }
    const value = raw.trim();
    if (folders.some((f) => f.display === value)) {
      setError('That folder is already in the list.');
      return;
    }
    onChange([...folders, { entry: { path: value, access }, display: value }]);
    setPath('');
    setError(null);
  }

  return (
    <div className="space-y-2">
      {folders.length === 0 ? (
        <p className="text-xs text-[var(--text-faint)]">None.</p>
      ) : (
        <ul className="space-y-1">
          {folders.map((f, i) => (
            <li key={`${f.display}:${i}`} data-testid="draft-folder" className="flex items-center gap-2 text-xs">
              <span className="min-w-0 flex-1 break-all font-mono">{f.display}</span>
              <select
                aria-label={`Access to ${f.display}`}
                value={f.entry.access}
                onChange={(e) => onChange(folders.map((g, j) => (j === i ? { ...g, entry: { ...g.entry, access: e.target.value as FolderAccess } } : g)))}
                className={SELECT}
              >
                <option value="read">{ACCESS_LABEL.read}</option>
                <option value="readwrite">{ACCESS_LABEL.readwrite}</option>
              </select>
              <button
                type="button"
                aria-label={`Remove ${f.display}`}
                onClick={() => onChange(folders.filter((_, j) => j !== i))}
                className="rounded-sm px-1.5 py-0.5 text-[var(--text-faint)] hover:bg-[var(--bg-sunken)] hover:text-[var(--text)]"
              >
                ✕
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <input
          aria-label="Folder path to add"
          placeholder="Folder path"
          value={path}
          onChange={(e) => {
            setPath(e.target.value);
            setError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && path.trim() !== '') {
              e.preventDefault();
              add(path);
            }
          }}
          className="min-w-0 flex-1 rounded-sm border border-[var(--border-strong)] bg-[var(--bg)] px-2 py-1 font-mono text-xs"
        />
        <select aria-label="Access to the new folder" value={access} onChange={(e) => setAccess(e.target.value as FolderAccess)} className={SELECT}>
          <option value="read">{ACCESS_LABEL.read}</option>
          <option value="readwrite">{ACCESS_LABEL.readwrite}</option>
        </select>
        <button type="button" disabled={path.trim() === ''} onClick={() => add(path)} className="btn px-2 py-1">
          Add
        </button>
        {canPick && (
          <button
            type="button"
            onClick={() => {
              void pickFolder('Choose a folder').then((picked) => {
                if (picked) add(picked);
              });
            }}
            className="btn px-2 py-1"
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
