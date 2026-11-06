import { createContext, useContext } from 'react';
import { isDesktop, revealPath } from '../desktop/bridge.js';
import { toast } from '../lib/toasts.js';
import { api } from '../state/api.js';
import { joinPath } from './paths.js';
import { useViewerStore } from './state.js';

/** What a chat's messages can open (Deck #826): a path or an artifact (Deck #896) in that chat's viewer panel. Websites go to the default browser (MarkdownBody). */
export interface ViewerActions {
  openPath(path: string): void;
  /** A path mentioned in a message: its file selected in Explorer in the desktop app (`revealMentioned`), or in the viewer in a browser, which can't. */
  showPath(path: string): void;
  /** An artifact: its current version on the chat's branch, or the pinned `versionId`. */
  openArtifact(item: { artifactId: string; title: string; versionId?: string }): void;
}

/** Provided by each Thread for its own chat, so a click opens in the right chat's panel; null outside a chat. */
export const ViewerContext = createContext<ViewerActions | null>(null);

export function useViewer(): ViewerActions | null {
  return useContext(ViewerContext);
}

export function viewerActionsFor(chatId: string): ViewerActions {
  const openPath = (path: string): void => useViewerStore.getState().openItem(chatId, { kind: 'file', path });
  return {
    openPath,
    showPath: (path) => (isDesktop() ? void revealMentioned(chatId, path) : openPath(path)),
    openArtifact: (item) => useViewerStore.getState().openItem(chatId, { kind: 'artifact', ...item }),
  };
}

/** A line reference after a file name (`app.ts:42`, `app.ts:42-51`, `app.ts:42:7`): not part of the name. */
const LINE_REF = /:\d+(?:[-:]\d+)?$/;

/** A drive (`C:\`) or a root (`/`). */
const ABSOLUTE = /^(?:[A-Za-z]:[\\/]|[\\/])/;

/**
 * Not a plain path on this machine: a share (`\\host\share`, `//host/share`), or a device path (`\\?\`, `\\.\`,
 * `\??\`), which Windows passes on as written and so can reach a share too. No Windows file name holds a `?`.
 */
const NOT_LOCAL = /^[\\/]{2}|\?/;

/**
 * Selects a path mentioned in `chatId`'s messages in Explorer, never opening
 * it, so an installer named in a reply is shown rather than run. It may be
 * anywhere on this machine, not only in the chat's folders: nothing is read.
 * A relative path is from the chat's workspace, as the model meant it.
 * A network path is refused: just looking one up makes Windows connect to
 * that server and offer it the user's sign-in, and a message's text can come
 * from anywhere. One that isn't here (another machine's, or gone) gets a toast.
 */
export async function revealMentioned(chatId: string, mentioned: string): Promise<void> {
  const path = mentioned.replace(LINE_REF, '');
  if (NOT_LOCAL.test(path)) {
    toast({ text: `${mentioned} isn't a file on this computer, so it isn't shown from a chat.`, tone: 'error' });
    return;
  }
  try {
    let full = path;
    if (!ABSOLUTE.test(path)) {
      const workspace = (await api.view.roots(chatId)).roots.find((r) => r.workspace);
      if (!workspace) throw new Error('This chat has no workspace.');
      full = joinPath(workspace.path, path);
    }
    await revealPath(full);
  } catch {
    toast({ text: `Couldn't find ${mentioned} on this machine.`, tone: 'error' });
  }
}
