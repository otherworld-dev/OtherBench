import { createContext, useContext } from 'react';
import { openInBrowser, openSite } from '../desktop/bridge.js';
import { useViewerStore } from './state.js';

/** What a chat's messages can open (Deck #826): a path or an artifact (Deck #896) in that chat's viewer panel, or a website. */
export interface ViewerActions {
  openPath(path: string): void;
  /** An artifact: its current version on the chat's branch, or the pinned `versionId`. */
  openArtifact(item: { artifactId: string; title: string; versionId?: string }): void;
  /** A website: its own isolated window, or the default browser when `external` (Ctrl-click). */
  openLink(url: string, opts?: { external?: boolean }): void;
}

/** Provided by each Thread for its own chat, so a click opens in the right chat's panel; null outside a chat. */
export const ViewerContext = createContext<ViewerActions | null>(null);

export function useViewer(): ViewerActions | null {
  return useContext(ViewerContext);
}

export function viewerActionsFor(chatId: string): ViewerActions {
  return {
    openPath: (path) => useViewerStore.getState().openItem(chatId, { kind: 'file', path }),
    openArtifact: (item) => useViewerStore.getState().openItem(chatId, { kind: 'artifact', ...item }),
    openLink: (url, opts) => void (opts?.external ? openInBrowser(url) : openSite(url)),
  };
}
