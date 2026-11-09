/** Profile calls and shapes for `api.profiles`. */
import type { ModelParams, Profile, ToolPolicy } from '@otherbench/core/types/config.js';
import { request, post, patch, del } from './http.js';

/** A tool policy as the profiles API takes it: `sandboxHosts: null` puts the default allowlist back. */
export type ToolPolicyBody = Omit<ToolPolicy, 'sandboxHosts'> & { sandboxHosts?: string[] | null };

export interface CreateProfileBody {
  name: string;
  description?: string | null;
  colour?: string | null;
  connectionId: string;
  modelId: string;
  systemPrompt?: string | null;
  params?: ModelParams;
  toolPolicy?: ToolPolicyBody;
  isDefault?: boolean;
  /** Absent means on. */
  useGlobalMemory?: boolean;
  /** Websites the browser may use without asking (`example.com`, `*.example.com`). Absent on create = none; on PATCH = unchanged. */
  browserAllowedSites?: string[];
}

/** `PATCH /api/profiles/:id`: any `CreateProfileBody` field, and only the `toolPolicy` fields to change (the server keeps the rest). */
export type ProfilePatchBody = Partial<Omit<CreateProfileBody, 'toolPolicy'>> & { toolPolicy?: Partial<ToolPolicyBody> };

export const profilesApi = {
  list: () => request<Profile[]>('/profiles'),
  create: (body: CreateProfileBody) => post<Profile>('/profiles', body),
  get: (id: string) => request<Profile>(`/profiles/${id}`),
  patch: (id: string, body: ProfilePatchBody) => patch<Profile>(`/profiles/${id}`, body),
  delete: (id: string) => del(`/profiles/${id}`),
};
