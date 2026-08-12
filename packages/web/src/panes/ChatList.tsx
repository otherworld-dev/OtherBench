import { useMemo, useState, type JSX } from 'react';
import type { Chat } from '@grunt/core/ports/store.js';
import { api } from '../state/api.js';
import { useGruntStore } from '../state/store.js';

function ChatRow({ chat, active, onSelect }: { chat: Chat; active: boolean; onSelect: () => void }): JSX.Element {
  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        aria-current={active ? 'true' : undefined}
        className={`w-full truncate rounded px-2 py-1.5 text-left text-sm ${
          active ? 'bg-[var(--accent)] text-[var(--accent-text)]' : 'text-[var(--text)] hover:bg-[var(--bg-sunken)]'
        }`}
      >
        {chat.pinned && <span className="mr-1" aria-hidden="true">📌</span>}
        {chat.title}
      </button>
    </li>
  );
}

/**
 * Left pane: pinned chats, search, and the rest of the chat list. Search
 * hits `GET /api/search` (FTS over message text + titles); a non-empty
 * query switches the list to a flat set of matching chats instead of
 * filtering the loaded list client-side, since search ranges over message
 * bodies the client never loads in full.
 */
export function ChatList(): JSX.Element {
  const chats = useGruntStore((s) => s.chats);
  const profiles = useGruntStore((s) => s.profiles);
  const activeChatId = useGruntStore((s) => s.activeChatId);
  const setActiveChatId = useGruntStore((s) => s.setActiveChatId);
  const upsertChat = useGruntStore((s) => s.upsertChat);

  const [query, setQuery] = useState('');
  const [searchChatIds, setSearchChatIds] = useState<string[] | null>(null);
  const [creating, setCreating] = useState(false);

  const pinned = useMemo(() => chats.filter((c) => c.pinned).sort((a, b) => b.updatedAt - a.updatedAt), [chats]);
  const rest = useMemo(() => chats.filter((c) => !c.pinned).sort((a, b) => b.updatedAt - a.updatedAt), [chats]);

  const visible = (list: Chat[]): Chat[] => (searchChatIds ? list.filter((c) => searchChatIds.includes(c.id)) : list);

  async function runSearch(q: string): Promise<void> {
    setQuery(q);
    if (q.trim().length === 0) {
      setSearchChatIds(null);
      return;
    }
    try {
      const results = await api.search(q);
      setSearchChatIds([...new Set(results.map((r) => r.chatId))]);
    } catch (err) {
      console.error('[grunt-web] search failed:', err);
    }
  }

  async function createChat(): Promise<void> {
    const defaultProfile = profiles.find((p) => p.isDefault) ?? profiles[0];
    if (!defaultProfile) return;
    setCreating(true);
    try {
      const chat = await api.chats.create({ profileId: defaultProfile.id });
      upsertChat(chat);
      setActiveChatId(chat.id);
    } catch (err) {
      console.error('[grunt-web] failed to create chat:', err);
    } finally {
      setCreating(false);
    }
  }

  return (
    <nav aria-label="Chats" className="flex h-full w-full flex-col border-r border-[var(--border)] bg-[var(--bg-raised)]">
      <div className="border-b border-[var(--border)] p-3">
        <input
          type="search"
          value={query}
          onChange={(e) => void runSearch(e.target.value)}
          placeholder="Search chats..."
          aria-label="Search chats"
          className="w-full rounded border border-[var(--border)] bg-[var(--bg)] px-2 py-1.5 text-sm outline-none focus:border-[var(--accent)] focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--bg-raised)]"
        />
      </div>

      <div className="flex-1 overflow-y-auto p-2">
        {pinned.length > 0 && (
          <div className="mb-3">
            <h2 className="px-2 pb-1 text-xs font-semibold tracking-wide text-[var(--text-muted)] uppercase">Pinned</h2>
            <ul className="space-y-0.5">
              {visible(pinned).map((c) => (
                <ChatRow key={c.id} chat={c} active={c.id === activeChatId} onSelect={() => setActiveChatId(c.id)} />
              ))}
            </ul>
          </div>
        )}

        <h2 className="px-2 pb-1 text-xs font-semibold tracking-wide text-[var(--text-muted)] uppercase">Chats</h2>
        {visible(rest).length === 0 ? (
          <p className="px-2 py-4 text-sm text-[var(--text-faint)]">
            {searchChatIds ? 'No chats match your search.' : 'No chats yet -- create one to get started.'}
          </p>
        ) : (
          <ul className="space-y-0.5">
            {visible(rest).map((c) => (
              <ChatRow key={c.id} chat={c} active={c.id === activeChatId} onSelect={() => setActiveChatId(c.id)} />
            ))}
          </ul>
        )}
      </div>

      <div className="border-t border-[var(--border)] p-2">
        <button
          type="button"
          onClick={() => void createChat()}
          disabled={creating || profiles.length === 0}
          title={profiles.length === 0 ? 'Create a profile before starting a chat.' : undefined}
          className="w-full rounded bg-[var(--accent)] px-2 py-1.5 text-sm font-medium text-[var(--accent-text)] disabled:opacity-50"
        >
          + New chat
        </button>
      </div>
    </nav>
  );
}
