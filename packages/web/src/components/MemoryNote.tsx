import { useEffect, useState, type JSX, type ReactNode } from 'react';
import type { MemoryVersionSummary } from '@otherbench/core/domain/memory.js';
import { formatRelativeTime } from '../lib/relativeTime.js';
import { ApiError } from '../state/api.js';
import { MarkdownBody } from './MarkdownBody.js';

const BUTTON = 'btn px-2 py-1';

function errorText(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}

export interface MemoryNoteProps {
  /** Test ids start with this ('memory' in the Inspector, 'global-memory' in Settings), so both can be on screen. */
  testIdPrefix: string;
  /** The edit box's accessible name. */
  label: string;
  emptyText: string;
  body: string;
  /** "Updated 2 min ago by you", say. */
  updatedLine: string;
  validate: (draft: string) => string | null;
  hasContent: (body: string) => boolean;
  /** Rejects with the server's error to keep the editor open. */
  save: (draft: string) => Promise<void>;
  loadVersions: () => Promise<MemoryVersionSummary[]>;
  loadVersion: (id: string) => Promise<{ body: string }>;
  restore: (id: string) => Promise<void>;
  /** Who made a version: "You", or the chat it came from. */
  versionAuthor: (version: MemoryVersionSummary) => string;
  /** Bumped by the owner after it changes the note itself (Update now), so an open history reloads. */
  refreshKey?: number;
  /** Buttons between Edit and History. */
  actions?: ReactNode;
  /** Shown under the updated line: failures and notices. */
  children?: ReactNode;
}

/**
 * A memory note (project or global): the note, who last changed it, Edit,
 * and History with View and Restore. The owner loads the note and supplies
 * the calls; this keeps the editing and history state.
 */
export function MemoryNote(props: MemoryNoteProps): JSX.Element {
  const { testIdPrefix: id, label, emptyText, body, updatedLine, validate, hasContent, refreshKey, actions, children } = props;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [editError, setEditError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [versions, setVersions] = useState<MemoryVersionSummary[] | null>(null);
  const [viewing, setViewing] = useState<{ body: string } | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);

  async function loadVersions(): Promise<void> {
    try {
      setVersions(await props.loadVersions());
      setHistoryError(null);
    } catch (err) {
      setHistoryError(errorText(err, "Couldn't load the history."));
    }
  }

  // The owner changed the note: an open history shows the new version.
  useEffect(() => {
    if (refreshKey !== undefined && historyOpen) void loadVersions();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only a new refreshKey reloads
  }, [refreshKey]);

  async function save(): Promise<void> {
    const problem = validate(draft);
    if (problem) {
      setEditError(problem);
      return;
    }
    setSaving(true);
    setEditError(null);
    try {
      await props.save(draft);
      setEditing(false);
      if (historyOpen) void loadVersions();
    } catch (err) {
      setEditError(errorText(err, 'Save failed -- please try again.'));
    } finally {
      setSaving(false);
    }
  }

  function toggleHistory(): void {
    const next = !historyOpen;
    setHistoryOpen(next);
    setViewing(null);
    if (next) void loadVersions();
  }

  async function viewVersion(versionId: string): Promise<void> {
    try {
      setViewing(await props.loadVersion(versionId));
    } catch (err) {
      setHistoryError(errorText(err, "Couldn't load that version."));
    }
  }

  async function restore(versionId: string): Promise<void> {
    try {
      await props.restore(versionId);
      setViewing(null);
      void loadVersions();
    } catch (err) {
      setHistoryError(errorText(err, "Couldn't restore that version."));
    }
  }

  return (
    <div className="space-y-2" data-testid={`${id}-section`}>
      {editing ? (
        <div className="space-y-2">
          <textarea
            aria-label={label}
            value={draft}
            rows={14}
            onChange={(e) => {
              setDraft(e.target.value);
              setEditError(null);
            }}
            className="w-full rounded border border-[var(--border)] bg-[var(--bg)] px-2 py-1.5 font-mono text-xs"
          />
          {editError && (
            <p data-testid={`${id}-edit-error`} className="text-xs text-[var(--danger)]">
              {editError}
            </p>
          )}
          <div className="flex gap-2">
            <button type="button" onClick={() => void save()} disabled={saving} className="btn btn-primary px-2.5 py-1">
              {saving ? 'Saving…' : 'Save'}
            </button>
            <button
              type="button"
              onClick={() => {
                setEditing(false);
                setEditError(null);
              }}
              className="btn px-2.5 py-1"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : hasContent(body) ? (
        <div data-testid={`${id}-note`}>
          <MarkdownBody text={body} />
        </div>
      ) : (
        <p className="text-sm text-[var(--text-faint)]">{emptyText}</p>
      )}

      <p data-testid={`${id}-updated`} className="text-xs text-[var(--text-muted)]">
        {updatedLine}
      </p>

      {children}

      {!editing && (
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => {
              setDraft(body);
              setEditError(null);
              setEditing(true);
            }}
            className={BUTTON}
          >
            Edit
          </button>
          {actions}
          <button type="button" aria-expanded={historyOpen} onClick={toggleHistory} className={BUTTON}>
            History
          </button>
        </div>
      )}

      {historyOpen && (
        <div data-testid={`${id}-history`} className="space-y-1">
          {historyError && <p className="text-xs text-[var(--danger)]">{historyError}</p>}
          {versions === null ? (
            <p className="text-xs text-[var(--text-faint)]">Loading…</p>
          ) : versions.length === 0 ? (
            <p className="text-xs text-[var(--text-faint)]">No versions yet.</p>
          ) : (
            <ul className="space-y-1">
              {versions.map((v) => (
                <li key={v.id} data-testid={`${id}-version-${v.id}`} className="flex items-center gap-2 text-xs">
                  <span className="min-w-0 flex-1 truncate">
                    {formatRelativeTime(v.createdAt)} · {props.versionAuthor(v)}
                  </span>
                  <button type="button" onClick={() => void viewVersion(v.id)} className={BUTTON}>
                    View
                  </button>
                  <button type="button" onClick={() => void restore(v.id)} className={BUTTON}>
                    Restore
                  </button>
                </li>
              ))}
            </ul>
          )}
          {viewing && (
            <div data-testid={`${id}-version-body`} className="rounded bg-[var(--bg-sunken)] px-2 py-1">
              <MarkdownBody text={viewing.body} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
