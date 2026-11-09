import { useState, type Dispatch, type SetStateAction } from 'react';
import { projectParentOf, type ProjectLookup } from '@otherbench/core/domain/projects.js';
import type { Profile } from '@otherbench/core/types/config.js';
import { api, type CreateChatBody } from '../../state/api.js';
import { NO_PROJECT_KEY, setGroupCollapsed } from '../../state/sidebarGroups.js';
import { useOtherBenchStore } from '../../state/store.js';
import { errorText } from './errorText.js';

/**
 * The sidebar's "+ New chat": the bottom button, a project heading's +, an app's "+ New chat" row and the tray menu
 * all start a chat through `createChat`. `creating` is true while one is on its way, so a second click waits.
 */
export function useCreateChat({
  profiles,
  lookup,
  setError,
}: {
  profiles: Profile[];
  lookup: ProjectLookup;
  setError: Dispatch<SetStateAction<string | null>>;
}): { creating: boolean; createChat: (into?: { projectId: string } | { appId: string }) => Promise<void> } {
  const setActiveChatId = useOtherBenchStore((s) => s.setActiveChatId);
  const upsertChat = useOtherBenchStore((s) => s.upsertChat);
  const [creating, setCreating] = useState(false);

  /**
   * A new chat in a project, an app (Code mode), or neither. `into` names the
   * group the "+" belongs to; nothing means No project.
   */
  async function createChat(into?: { projectId: string } | { appId: string }): Promise<void> {
    if (creating) return;
    const projectId = into && 'projectId' in into ? into.projectId : undefined;
    let body: CreateChatBody;
    if (into && 'appId' in into) {
      // As for a project: the server gives the chat the app's folder and its
      // default profile, else the app-wide default (spec 2026-10-20-code-tab-design).
      body = { appId: into.appId };
    } else if (projectId !== undefined) {
      // The server copies the project's folder and default profile onto the
      // new chat, falling back to the app default profile (spec §2).
      body = { projectId };
    } else {
      const defaultProfile = profiles.find((p) => p.isDefault && p.archivedAt === null) ?? profiles.find((p) => p.archivedAt === null);
      if (!defaultProfile) return;
      body = { profileId: defaultProfile.id };
    }
    // A chat created into a collapsed group (or one inside a collapsed parent) would be invisible.
    setGroupCollapsed(into && 'appId' in into ? into.appId : (projectId ?? NO_PROJECT_KEY), false);
    const parent = projectId === undefined ? undefined : lookup(projectId);
    const parentId = parent ? projectParentOf(parent, lookup)?.id : undefined;
    if (parentId) setGroupCollapsed(parentId, false);
    setCreating(true);
    setError(null);
    try {
      const chat = await api.chats.create(body);
      upsertChat(chat);
      // Shown in the pane, not made a tab: only what the user asks to be a tab becomes one.
      setActiveChatId(chat.id);
      useOtherBenchStore.getState().focusComposer(chat.id);
    } catch (err) {
      console.error('[otherbench-web] failed to create chat:', err);
      setError(errorText(err, "Couldn't create the chat"));
    } finally {
      setCreating(false);
    }
  }

  return { creating, createChat };
}
