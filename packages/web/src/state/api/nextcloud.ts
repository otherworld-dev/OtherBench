/** Nextcloud settings and Deck card calls for `api.nextcloud`. */
import type { DeckCardDetail, NextcloudSettingsView, NextcloudTestResult, ProjectLinksSuggestion } from '@otherbench/core/types/nextcloud.js';
import { request, post, put, patch, del } from './http.js';

function boardQuery(board: number | null | undefined): string {
  return board === undefined || board === null ? '' : `?board=${board}`;
}

/**
 * Nextcloud settings and cards (spec 2026-10-22-nextcloud-tabs; server `routes/nextcloud.ts`). The password is only
 * ever sent, never returned. `board` is optional on the card calls: without it the card is found on whichever board holds it.
 */
export const nextcloudApi = {
  get: () => request<NextcloudSettingsView>('/nextcloud'),
  put: (body: { baseUrl: string; user: string; password?: string | null }) => put<NextcloudSettingsView>('/nextcloud', body),
  test: () => post<NextcloudTestResult>('/nextcloud/test'),
  boards: () => request<{ id: number; title: string }[]>('/nextcloud/boards'),
  collectives: () => request<string[]>('/nextcloud/collectives'),
  /** The collective's page paths (`Products/MyApp`), parents first, for picking an app's Collectives page. */
  collectivePages: (collective: string) => request<string[]>(`/nextcloud/collectives/${encodeURIComponent(collective)}/pages`),
  detectLinks: (path: string) => request<ProjectLinksSuggestion>(`/nextcloud/detect-links?path=${encodeURIComponent(path)}`),
  card: (cardId: number, board?: number | null) => request<DeckCardDetail>(`/nextcloud/cards/${cardId}${boardQuery(board)}`),
  updateCard: (cardId: number, change: { title?: string; description?: string; duedate?: string | null }, board?: number | null) =>
    patch<DeckCardDetail>(`/nextcloud/cards/${cardId}${boardQuery(board)}`, change),
  /** 204; refetch the card after. */
  cardAction: (cardId: number, action: 'done' | 'reopen' | 'archive', board?: number | null) =>
    post<void>(`/nextcloud/cards/${cardId}/${action}${boardQuery(board)}`),
  /** Moves in place; a move Deck ignores is a 409 `deck-move-ignored`, never a delete and recreate. */
  moveCard: (cardId: number, stackId: number, board?: number | null) => post<void>(`/nextcloud/cards/${cardId}/move${boardQuery(board)}`, { stackId }),
  labels: (cardId: number, change: { add?: number[]; remove?: number[] }, board?: number | null) =>
    post<void>(`/nextcloud/cards/${cardId}/labels${boardQuery(board)}`, change),
  deleteCard: (cardId: number, board?: number | null) => del(`/nextcloud/cards/${cardId}${boardQuery(board)}`),
};
