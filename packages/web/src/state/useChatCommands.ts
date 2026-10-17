import { useEffect, useRef, useState } from 'react';
import { OWN_COMMANDS, type CommandRow } from '@otherbench/core/domain/context-lines.js';
import { api } from './api.js';

const REFETCH_AFTER_MS = 60_000;

/**
 * The commands the `/` menu offers. Starts as OtherBench's own, fetches the chat's full list once per
 * (chat, profile) the first time `enabled`, and again when enabled 60 s or more after the last fetch.
 */
export function useChatCommands(chatId: string, profileId: string | null, enabled: boolean): { commands: CommandRow[]; warning: string | null; loading: boolean } {
  const [state, setState] = useState<{ key: string; commands: CommandRow[]; warning: string | null }>({ key: '', commands: [...OWN_COMMANDS], warning: null });
  const [loading, setLoading] = useState(false);
  const lastFetch = useRef(new Map<string, number>());
  const key = `${chatId}\n${profileId ?? ''}`;

  useEffect(() => {
    if (!enabled || !profileId) return;
    const last = lastFetch.current.get(key);
    if (last !== undefined && Date.now() - last < REFETCH_AFTER_MS) return;
    lastFetch.current.set(key, Date.now());
    let cancelled = false;
    setLoading(true);
    Promise.resolve(api.chats.commands(chatId, profileId))
      .then((res) => {
        if (cancelled || !Array.isArray(res?.commands)) return;
        setState({ key, commands: res.commands, warning: res.warning ?? null });
      })
      .catch((err: unknown) => {
        console.error(`[otherbench-web] failed to load commands for chat ${chatId}:`, err);
        lastFetch.current.delete(key); // try again next time it opens
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [enabled, chatId, profileId, key]);

  // Another chat or profile starts from the built-ins until its own list arrives.
  if (state.key !== key && state.key !== '') return { commands: [...OWN_COMMANDS], warning: null, loading };
  return { commands: state.commands, warning: state.warning, loading };
}
