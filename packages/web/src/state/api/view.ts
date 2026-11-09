/** The file viewer calls and shapes for `api.view`. */
import type { FolderAccess } from '@otherbench/core/types/workspace.js';
import { request, post } from './http.js';

/** How the viewer shows a file (Deck #826); the server decides. */
export type ViewKind = 'image' | 'video' | 'pdf' | 'html' | 'markdown' | 'text' | 'other';
/** A file opened for the viewer: `url` is a short-lived `/view/` link for what the browser loads itself, else null. */
export interface ViewOpened { path: string; name: string; kind: ViewKind; url: string | null; size: number; /** This link lets the page save files. */ downloads?: boolean }

export interface ViewText { path: string; content: string; truncated: boolean; size: number }
export interface ViewRoot { path: string; label: string; access: FolderAccess; workspace: boolean }
export interface ViewEntry { name: string; path: string; type: 'dir' | 'file' }

export const viewApi = {
  open: (chatId: string, path: string, downloads?: boolean) => post<ViewOpened>('/view/links', { chatId, path, ...(downloads ? { downloads } : {}) }),
  openArtifact: (chatId: string, artifactVersionId: string, downloads?: boolean) => post<ViewOpened>('/view/links', { chatId, artifactVersionId, ...(downloads ? { downloads } : {}) }),
  text: (chatId: string, path: string) => request<ViewText>(`/view/text?chatId=${encodeURIComponent(chatId)}&path=${encodeURIComponent(path)}`),
  roots: (chatId: string) => request<{ roots: ViewRoot[] }>(`/view/dirs?chatId=${encodeURIComponent(chatId)}`),
  dir: (chatId: string, path: string) => request<{ path: string; entries: ViewEntry[] }>(`/view/dirs?chatId=${encodeURIComponent(chatId)}&path=${encodeURIComponent(path)}`),
};
