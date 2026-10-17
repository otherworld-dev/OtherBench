import { useEffect, useRef, useState } from 'react';
import { OWN_COMMANDS, type CommandRow } from '@otherbench/core/domain/context-lines.js';
import { api } from './api.js';

const REFETCH_AFTER_MS = 60_000;

/** Shown (as the menu's muted last row) when the chat's own commands couldn't be loaded. Same wording as the server's fallback. */
export const COMMANDS_LOAD_WARNING = "Couldn't load this chat's own commands.";

type Entry = { commands: CommandRow[]; warning: string | null; at: number; failed: boolean };

/**
 * The commands the `/` menu offers. Starts as OtherBench's own, fetches the chat's full list once per
 * (chat, profile) the first time `enabled`, and again when enabled 60 s or more after the last fetch
 * (or at once after a failed one). Lists are kept per (chat, profile), and a response always lands in its
 * own slot, so closing the menu or switching chats mid-fetch loses nothing.
 */
export function useChatCommands(chatId: string, profileId: string | null, enabled: boolean): { commands: CommandRow[]; warning: string | null; loading: boolean } {
  const [cache, setCache] = useState<Record<string, Entry>>({});
  const [loadingKeys, setLoadingKeys] = useState<Record<string, true>>({});
  const inFlight = useRef(new Set<string>());
  const key = `${chatId}\n${profileId ?? ''}`;
  const entry = cache[key];
  // Read inside the effect without re-running it when an answer lands (a failed fetch must not retry in a loop).
  const entryRef = useRef(entry);
  entryRef.current = entry;

  useEffect(() => {
    if (!enabled || !profileId || inFlight.current.has(key)) return;
    const have = entryRef.current;
    if (have && !have.failed && Date.now() - have.at < REFETCH_AFTER_MS) return;
    inFlight.current.add(key);
    setLoadingKeys((l) => ({ ...l, [key]: true }));
    const settle = (next: Entry): void => {
      inFlight.current.delete(key);
      setCache((c) => ({ ...c, [key]: next }));
      setLoadingKeys((l) => {
        const { [key]: _gone, ...rest } = l;
        return rest;
      });
    };
    Promise.resolve(api.chats.commands(chatId, profileId))
      .then((res) => {
        if (!Array.isArray(res?.commands)) throw new Error('unexpected commands response');
        settle({ commands: res.commands, warning: res.warning ?? null, at: Date.now(), failed: false });
      })
      .catch((err: unknown) => {
        console.error(`[otherbench-web] failed to load commands for chat ${chatId}:`, err);
        settle({ commands: [...OWN_COMMANDS], warning: COMMANDS_LOAD_WARNING, at: Date.now(), failed: true });
      });
  }, [enabled, chatId, profileId, key]);

  return { commands: entry?.commands ?? [...OWN_COMMANDS], warning: entry?.warning ?? null, loading: !!loadingKeys[key] };
}
