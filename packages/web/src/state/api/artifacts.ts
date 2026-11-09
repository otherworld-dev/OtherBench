/** Artifact and live page calls and shapes for `api.artifacts`. */
import type { Artifact, ArtifactKind, ArtifactVersion, LiveParam } from '@otherbench/core/ports/store.js';
import type { LiveCallOutcome, LiveCallStatus } from '@otherbench/core/ports/tool-provider.js';
import { apiFetch } from '../transport.js';
import { ApiError, extractErrorMessage, request, post, put, del } from './http.js';

/** One artifact in a chat's list (Deck #896): its current version on the branch the chat shows. */
export interface ArtifactSummary { id: string; slug: string; kind: ArtifactKind; language: string | null; title: string; versionId: string; number: number; madeBy: 'model' | 'user';
  /** How many live calls it declares (spec 2026-10-12-live-artifacts); 0 for a plain one. */
  live: number }

/** One artifact with every version, each marked on or off the chat's branch. */
export interface ArtifactDetail {
  artifact: Artifact;
  fileName: string;
  currentVersionId: string | null;
  /** Each version is its own kind (a note made into a page), with its own file name. */
  versions: { id: string; number: number; title: string; madeBy: 'model' | 'user'; createdAt: number; onBranch: boolean; kind: ArtifactKind; language: string | null; fileName: string;
    /** How many live calls it declares (spec 2026-10-12-live-artifacts); 0 for a plain one. */
    live: number }[];
}

/** A live page's calls as the viewer shows them (spec 2026-10-12-live-artifacts). */
export interface LiveStatus {
  /** The machine the calls run on: the one serving this UI. */
  machine: { id: string; name: string };
  /** Set when the chat runs on another machine. */
  runsOn: { id: string; name: string } | null;
  profile: { id: string; name: string };
  calls: (LiveCallStatus & { args: Record<string, unknown>; params: Record<string, LiveParam> })[];
}

/** What one live call came back as: the server's outcome, or one the viewer gave itself. */
export type LiveOutcome = LiveCallOutcome | { ok: false; code: 'bad_params' | 'busy'; message: string };

export const artifactsApi = {
  list: (chatId: string) => request<{ artifacts: ArtifactSummary[] }>(`/chats/${chatId}/artifacts`),
  get: (chatId: string, artifactId: string) => request<ArtifactDetail>(`/chats/${chatId}/artifacts/${artifactId}`),
  version: (chatId: string, artifactId: string, versionId: string) => request<ArtifactVersion>(`/chats/${chatId}/artifacts/${artifactId}/versions/${versionId}`),
  edit: (chatId: string, artifactId: string, body: { content: string; title?: string; fromVersionId?: string }) => put<ArtifactVersion>(`/chats/${chatId}/artifacts/${artifactId}`, body),
  save: (chatId: string, artifactId: string, body: { versionId: string; path: string; replace?: boolean }) => post<{ path: string }>(`/chats/${chatId}/artifacts/${artifactId}/save`, body),
  /** The version as the file it downloads as (spec 2026-10-12-office-files §4): the made .docx/.xlsx/.pptx, or the text. */
  file: async (chatId: string, artifactId: string, versionId: string): Promise<Blob> => {
    const res = await apiFetch(`/chats/${chatId}/artifacts/${artifactId}/versions/${versionId}/file`);
    if (!res.ok) throw new ApiError(res.status, await extractErrorMessage(res));
    return res.blob();
  },
  live: {
    status: (chatId: string, artifactId: string, versionId: string) => request<LiveStatus>(`/chats/${chatId}/artifacts/${artifactId}/versions/${versionId}/live`),
    allow: (chatId: string, artifactId: string, versionId: string) => post<LiveStatus>(`/chats/${chatId}/artifacts/${artifactId}/versions/${versionId}/live/allow`, {}),
    revoke: (chatId: string, artifactId: string) => del(`/chats/${chatId}/artifacts/${artifactId}/live`),
    call: (chatId: string, artifactId: string, versionId: string, callId: string, body: { params?: Record<string, unknown>; fresh?: boolean }) =>
      post<LiveOutcome>(`/chats/${chatId}/artifacts/${artifactId}/versions/${versionId}/live/calls/${encodeURIComponent(callId)}`, body),
  },
};
