import { useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import type { Chat } from '@otherbench/core/ports/store.js';
import { api, type PeersOverview } from '../../state/api.js';
import { chatStatus, type ChatActivity } from '../../state/chatStatus.js';
import { titleMatches } from './model.js';

export interface SidebarSearch {
  query: string;
  runSearch: (q: string) => Promise<void>;
  trimmedQuery: string;
  statusOnly: boolean;
  setStatusOnly: Dispatch<SetStateAction<boolean>>;
  /** The Machine chip's node id while it applies; null = any. */
  machineFilter: string | null;
  setMachine: Dispatch<SetStateAction<string | null>>;
  /** A query or a chip is on. */
  searching: boolean;
  /** The ids of the chats the search and chips keep; null while not searching. */
  matches: Set<string> | null;
}

/**
 * The sidebar's search box and filter chips: title matches here, message-text matches through
 * `GET /api/search?scope=chats`, and the chats the status and machine chips allow.
 */
export function useSidebarSearch(
  chats: Chat[],
  machines: PeersOverview | null,
  activeChatId: string | null,
  activity: ChatActivity,
  now: number
): SidebarSearch {
  const [query, setQuery] = useState('');
  /** The server's message-text hits for the query; a previous query's stay until the new answer, so rows don't blink while typing. */
  const [searchChatIds, setSearchChatIds] = useState<ReadonlySet<string> | null>(null);
  const searchSeq = useRef(0);
  const [statusOnly, setStatusOnly] = useState(false);
  /** The Machine chip: only chats that run on this node id; null = any. */
  const [machine, setMachine] = useState<string | null>(null);

  const trimmedQuery = query.trim();
  // A chip left on for a machine since unpaired would hide everything, with no chip shown to turn it off.
  const machineFilter = machines?.peers.length ? machine : null;
  const searching = trimmedQuery !== '' || statusOnly || machineFilter !== null;
  // The chats the status and machine chips allow (null with neither on); the open chat is never hidden by them:
  // a new chat runs here.
  const chipMatches = useMemo(() => {
    if (!statusOnly && machineFilter === null) return null;
    return new Set(
      chats
        .filter((c) => c.id === activeChatId || !statusOnly || chatStatus(c, activity, now) !== null)
        .filter((c) => c.id === activeChatId || machineFilter === null || c.runsOn === machineFilter)
        .map((c) => c.id)
    );
  }, [chats, statusOnly, machineFilter, activeChatId, activity, now]);
  const matches = useMemo(() => {
    if (!searching) return null;
    return new Set(
      chats
        .filter((c) => trimmedQuery === '' || titleMatches(c.title, trimmedQuery) || searchChatIds?.has(c.id) === true)
        .filter((c) => chipMatches === null || chipMatches.has(c.id))
        .map((c) => c.id)
    );
  }, [searching, chats, trimmedQuery, searchChatIds, chipMatches]);

  async function runSearch(q: string): Promise<void> {
    setQuery(q);
    const seq = ++searchSeq.current;
    if (q.trim().length === 0) {
      setSearchChatIds(null);
      return;
    }
    try {
      const results = await api.searchChats(q);
      // A newer keystroke, or clearing the box, supersedes this response.
      if (seq !== searchSeq.current) return;
      setSearchChatIds(new Set(results.map((r) => r.chatId)));
    } catch (err) {
      console.error('[otherbench-web] search failed:', err);
    }
  }

  return { query, runSearch, trimmedQuery, statusOnly, setStatusOnly, machineFilter, setMachine, searching, matches };
}
