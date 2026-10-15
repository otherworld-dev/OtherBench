import { useEffect, useState, type JSX } from 'react';
import { hasMemoryContent, validateMemoryBody, type MemoryUpdateOutcome } from '@grunt/core/domain/memory.js';
import type { Chat, Project } from '@grunt/core/ports/store.js';
import { MemoryNote } from '../components/MemoryNote.js';
import { memoryUpdatedLine } from '../lib/memoryUpdated.js';
import { formatRelativeTime } from '../lib/relativeTime.js';
import { ApiError, api } from '../state/api.js';
import { useGruntStore } from '../state/store.js';
import { useProjectMemory } from '../state/useProjectMemory.js';

export { MEMORY_POLL_MS } from '../state/useProjectMemory.js';

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
  // Loaded on a project switch, then polled. A poll never touches the edit draft.
  const { view, loadFailed, setView } = useProjectMemory(project.id);
  const [updating, setUpdating] = useState(false);
  const [notice, setNotice] = useState<{ text: string; failed: boolean } | null>(null);
  const [refresh, setRefresh] = useState(0);

  useEffect(() => setNotice(null), [chat.id]);

  function chatTitle(id: string | null): string {
    if (id === null) return 'a chat';
    return chats.find((c) => c.id === id)?.title ?? 'a deleted chat';
  }

  async function runUpdate(chatId: string): Promise<void> {
    setUpdating(true);
    setNotice(null);
    try {
      const outcome = await api.memory.updateNow(chatId);
      setNotice({ text: outcomeText(outcome), failed: outcome.status === 'failed' });
      setView(await api.memory.get(project.id));
      setRefresh((n) => n + 1);
    } catch (err) {
      setNotice({ text: errorText(err, 'Update failed -- please try again.'), failed: true });
    } finally {
      setUpdating(false);
    }
  }

  if (!view) {
    return <p className="text-sm text-[var(--text-faint)]">{loadFailed ? "Couldn't load project memory." : 'Loading…'}</p>;
  }

  const { memory, lastError } = view;
  const updatedLine = memoryUpdatedLine(memory, chats);

  return (
    <MemoryNote
      key={project.id}
      testIdPrefix="memory"
      label="Project memory"
      emptyText="Nothing in this project's memory yet."
      body={memory.body}
      updatedLine={updatedLine}
      validate={(draft) => validateMemoryBody(draft)}
      hasContent={(body) => hasMemoryContent(body)}
      save={async (draft) => setView(await api.memory.save(project.id, draft))}
      loadVersions={() => api.memory.versions(project.id)}
      loadVersion={(id) => api.memory.version(project.id, id)}
      restore={async (id) => {
        setView(await api.memory.restore(project.id, id));
        setNotice({ text: 'Version restored.', failed: false });
      }}
      versionAuthor={(v) => (v.createdBy === 'user' ? 'You' : chatTitle(v.sourceChatId))}
      refreshKey={refresh}
      actions={
        <button
          type="button"
          onClick={() => void runUpdate(chat.id)}
          disabled={updating || chat.memoryExcluded}
          aria-busy={updating}
          title={chat.memoryExcluded ? 'This chat is set to not add to memory.' : 'Fold this chat into the project memory now'}
          className={BUTTON}
        >
          {updating ? 'Updating…' : 'Update now'}
        </button>
      }
    >
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
    </MemoryNote>
  );
}
