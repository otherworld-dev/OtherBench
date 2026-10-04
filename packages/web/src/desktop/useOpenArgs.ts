import { useEffect } from 'react';
import { api } from '../state/api.js';
import { useGruntStore } from '../state/store.js';
import { isDesktop, launchArgs, onDesktopEvent } from './bridge.js';
import { parseOpenArgs } from './openArgs.js';

/**
 * Acts on `--open-folder <path>` (a new chat working in that folder) and
 * `--send <file>...` (a new chat with those images attached), whether they
 * came with this launch (`launch_args`, handed over once) or with a second
 * launch the single-instance plugin forwarded (`open-args`). The new chat
 * uses the default profile, like **+ New chat**, and opens.
 */
export async function handleOpenArgs(argv: string[]): Promise<void> {
  const { openFolder, send } = parseOpenArgs(argv);
  if (openFolder === null && send.length === 0) return;
  const { profiles, upsertChat, setActiveChatId } = useGruntStore.getState();
  const profile = profiles.find((p) => p.isDefault && p.archivedAt === null) ?? profiles.find((p) => p.archivedAt === null);
  if (!profile) {
    console.error('[grunt-web] no profile to open a chat with; set one up in Settings first.');
    return;
  }
  if (openFolder !== null) {
    const chat = await api.chats.create({ profileId: profile.id, workspaceRoot: openFolder });
    upsertChat(chat);
    setActiveChatId(chat.id);
  }
  if (send.length > 0) {
    const chat = await api.chats.create({ profileId: profile.id });
    upsertChat(chat);
    for (const path of send) {
      try {
        await api.attachments.fromPath(chat.id, path);
      } catch (err) {
        console.error(`[grunt-web] couldn't attach "${path}":`, err);
      }
    }
    // Opened after the files are attached, so the composer loads them with the chat.
    setActiveChatId(chat.id);
  }
}

/** Runs `handleOpenArgs` for this launch's arguments and every later launch's. Desktop only. */
export function useOpenArgs(ready: boolean): void {
  useEffect(() => {
    if (!ready || !isDesktop()) return;
    let off: (() => void) | null = null;
    let disposed = false;
    const run = (argv: string[]): void => {
      handleOpenArgs(argv).catch((err: unknown) => console.error('[grunt-web] failed to act on launch arguments:', err));
    };
    void launchArgs().then(run);
    void onDesktopEvent<string[]>('open-args', run).then((unlisten) => {
      if (disposed) unlisten();
      else off = unlisten;
    });
    return () => {
      disposed = true;
      off?.();
    };
  }, [ready]);
}
