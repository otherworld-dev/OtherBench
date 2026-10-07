import { useEffect, useState, type JSX } from 'react';
import { hasMemoryContent, validateMemoryBody, type MemoryUpdateOutcome, type MemoryVersionSummary, type ProjectMemoryView } from '@grunt/core/domain/memory.js';
import type { Chat, Project, ProjectMemoryVersion } from '@grunt/core/ports/store.js';
import { MarkdownBody } from '../components/MarkdownBody.js';
import { formatRelativeTime } from '../lib/relativeTime.js';
import { ApiError, api } from '../state/api.js';
import { useGruntStore } from '../state/store.js';

/** How often the panel re-reads the note: the summariser changes it in the background. */
export const MEMORY_POLL_MS = 15_000;

const BUTTON = 'btn px-2 py-1';

function errorText(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}

function outcomeText(outcome: MemoryUpdateOutcome): string {
  switch (outcome.status) {
    case 'updated':
      return 'Memory updated.';
    case 'unchanged':
      return 'Memory checked: nothing needed changing.';
    case 'nothing-new':
      return 'Nothing new in this chat to add.';
    case 'discarded':
      return outcome.reason;
    case 'failed':
      return outcome.error;
  }
}

/**
 * The Inspector's "Project memory" section (spec 2026-10-03-project-memory-design
 * §5): the project's shared note, who last changed it, Edit, Update now,
 * History with View and Restore, and the last automatic failure with Retry.
 */
export function InspectorMemory({ chat, project }: { chat: Chat; project: Project }): JSX.Element {
  const chats = useGruntStore((s) => s.chats);
  const [view, setView] = useState<ProjectMemoryView | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [editError, setEditError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [notice, setNotice] = useState<{ text: string; failed: boolean } | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [versions, setVersions] = useState<MemoryVersionSummary[] | null>(null);
  const [viewing, setViewing] = useState<ProjectMemoryVersion | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);

  // Load on a project switch, then poll. A poll never touches the edit draft.
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setView(null);
    setLoadFailed(false);
    setEditing(false);
    setHistoryOpen(false);
    setVersions(null);
    setViewing(null);
    async function tick(): Promise<void> {
      try {
        const next = await api.memory.get(project.id);
        if (!cancelled) {
          setView(next);
          setLoadFailed(false);
        }
      } catch (err) {
        console.error(`[grunt-web] failed to load memory for project ${project.id}:`, err);
        if (!cancelled) setLoadFailed(true);
      }
      if (!cancelled) timer = setTimeout(() => void tick(), MEMORY_POLL_MS);
    }
    void tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [project.id]);

  useEffect(() => setNotice(null), [chat.id]);

  function chatTitle(id: string | null): string {
    if (id === null) return 'a chat';
    return chats.find((c) => c.id === id)?.title ?? 'a deleted chat';
  }

  async function loadVersions(): Promise<void> {
    try {
      setVersions(await api.memory.versions(project.id));
      setHistoryError(null);
    } catch (err) {
      setHistoryError(errorText(err, "Couldn't load the history."));
    }
  }

  async function save(): Promise<void> {
    const problem = validateMemoryBody(draft);
    if (problem) {
      setEditError(problem);
      return;
    }
    setSaving(true);
    setEditError(null);
    try {
      setView(await api.memory.save(project.id, draft));
      setEditing(false);
      if (historyOpen) void loadVersions();
    } catch (err) {
      setEditError(errorText(err, 'Save failed -- please try again.'));
    } finally {
      setSaving(false);
    }
  }

  async function runUpdate(chatId: string): Promise<void> {
    setUpdating(true);
    setNotice(null);
    try {
      const outcome = await api.memory.updateNow(chatId);
      setNotice({ text: outcomeText(outcome), failed: outcome.status === 'failed' });
      setView(await api.memory.get(project.id));
      if (historyOpen) void loadVersions();
    } catch (err) {
      setNotice({ text: errorText(err, 'Update failed -- please try again.'), failed: true });
    } finally {
      setUpdating(false);
    }
  }

  function toggleHistory(): void {
    const next = !historyOpen;
    setHistoryOpen(next);
    setViewing(null);
    if (next) void loadVersions();
  }

  async function viewVersion(id: string): Promise<void> {
    try {
      setViewing(await api.memory.version(project.id, id));
    } catch (err) {
      setHistoryError(errorText(err, "Couldn't load that version."));
    }
  }

  async function restore(id: string): Promise<void> {
    try {
      setView(await api.memory.restore(project.id, id));
      setViewing(null);
      setNotice({ text: 'Version restored.', failed: false });
      void loadVersions();
    } catch (err) {
      setHistoryError(errorText(err, "Couldn't restore that version."));
    }
  }

  if (!view) {
    return <p className="text-sm text-[var(--text-faint)]">{loadFailed ? "Couldn't load project memory." : 'Loading…'}</p>;
  }

  const { memory, lastError } = view;
  const updatedLine =
    memory.updatedAt === 0
      ? 'Not saved yet'
      : memory.updatedBy === 'user'
        ? `Updated ${formatRelativeTime(memory.updatedAt)} by you`
        : `Updated ${formatRelativeTime(memory.updatedAt)} from ${chatTitle(memory.sourceChatId)}`;

  return (
    <div className="space-y-2" data-testid="memory-section">
      {editing ? (
        <div className="space-y-2">
          <textarea
            aria-label="Project memory"
            value={draft}
            rows={14}
            onChange={(e) => {
              setDraft(e.target.value);
              setEditError(null);
            }}
            className="w-full rounded border border-[var(--border)] bg-[var(--bg)] px-2 py-1.5 font-mono text-xs"
          />
          {editError && (
            <p data-testid="memory-edit-error" className="text-xs text-[var(--danger)]">
              {editError}
            </p>
          )}
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => void save()}
              disabled={saving}
              className="btn btn-primary px-2.5 py-1"
            >
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
      ) : hasMemoryContent(memory.body) ? (
        <div data-testid="memory-note">
          <MarkdownBody text={memory.body} />
        </div>
      ) : (
        <p className="text-sm text-[var(--text-faint)]">Nothing in this project's memory yet.</p>
      )}

      <p data-testid="memory-updated" className="text-xs text-[var(--text-muted)]">
        {updatedLine}
      </p>

      {lastError && (
        <div role="alert" data-testid="memory-error" className="space-y-1 rounded border border-[var(--danger)] px-2 py-1.5 text-xs">
          <p>
            The last automatic update failed {formatRelativeTime(lastError.at)}: {lastError.message}
          </p>
          <button type="button" onClick={() => void runUpdate(lastError.chatId ?? chat.id)} disabled={updating} className={BUTTON}>
            Retry
          </button>
        </div>
      )}

      {notice && (
        <p role="status" data-testid="memory-notice" className={`text-xs ${notice.failed ? 'text-[var(--danger)]' : 'text-[var(--text-muted)]'}`}>
          {notice.text}
        </p>
      )}

      {!editing && (
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => {
              setDraft(memory.body);
              setEditError(null);
              setEditing(true);
            }}
            className={BUTTON}
          >
            Edit
          </button>
          <button
            type="button"
            onClick={() => void runUpdate(chat.id)}
            disabled={updating || chat.memoryExcluded}
            aria-busy={updating}
            title={chat.memoryExcluded ? 'This chat is set to not add to project memory.' : 'Fold this chat into the project memory now'}
            className={BUTTON}
          >
            {updating ? 'Updating…' : 'Update now'}
          </button>
          <button type="button" aria-expanded={historyOpen} onClick={toggleHistory} className={BUTTON}>
            History
          </button>
        </div>
      )}

      {historyOpen && (
        <div data-testid="memory-history" className="space-y-1">
          {historyError && <p className="text-xs text-[var(--danger)]">{historyError}</p>}
          {versions === null ? (
            <p className="text-xs text-[var(--text-faint)]">Loading…</p>
          ) : versions.length === 0 ? (
            <p className="text-xs text-[var(--text-faint)]">No versions yet.</p>
          ) : (
            <ul className="space-y-1">
              {versions.map((v) => (
                <li key={v.id} data-testid={`memory-version-${v.id}`} className="flex items-center gap-2 text-xs">
                  <span className="min-w-0 flex-1 truncate">
                    {formatRelativeTime(v.createdAt)} · {v.createdBy === 'user' ? 'You' : chatTitle(v.sourceChatId)}
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
            <div data-testid="memory-version-body" className="rounded bg-[var(--bg-sunken)] px-2 py-1">
              <MarkdownBody text={viewing.body} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
