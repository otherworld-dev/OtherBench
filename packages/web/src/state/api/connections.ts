/** Connection, model and ComfyUI workflow calls: `api.connections`, `api.mediaWorkflows` and `api.models`. */
import type { CheckpointLoader, MediaWorkflow } from '@otherbench/core/domain/media-workflows.js';
import type { ComfyTemplate, RecentWorkflow } from '@otherbench/core/types/media-library.js';
import type { Connection, ConnectionKind, ModelInfo } from '@otherbench/core/types/config.js';
import { request, post, patch, del } from './http.js';

export interface MediaModelsResult {
  models: { id: string; label: string }[];
  checkpoints: string[];
  checkpointsError?: string;
}

export interface CreateConnectionBody {
  name: string;
  kind: ConnectionKind;
  baseUrl?: string | null;
  apiKey?: string | null;
  extraHeaders?: Record<string, string>;
  /** 'anywhere', or the node id of the one machine it works on. Omitted on create: the server decides from the address. */
  availability?: string;
  /** False keeps the API key on this machine when chats sync. */
  syncSecret?: boolean;
}

export const connectionsApi = {
  list: () => request<Connection[]>('/connections'),
  create: (body: CreateConnectionBody) => post<Connection>('/connections', body),
  get: (id: string) => request<Connection>(`/connections/${id}`),
  patch: (id: string, body: Partial<CreateConnectionBody>) => patch<Connection>(`/connections/${id}`, body),
  delete: (id: string) => del(`/connections/${id}`),
  test: (id: string) => post<{ ok: boolean; message: string; latencyMs: number }>(`/connections/${id}/test`),
  discoverModels: (id: string) => post<ModelInfo[]>(`/connections/${id}/discover-models`),
  /** Looks for ComfyUI on this PC's two usual addresses; only when asked. */
  findComfyui: () => post<{ baseUrl: string; version: string; gpu: string | null; vramGb: number | null } | { found: false }>('/connections/find-comfyui'),
  comfyRecent: (id: string) => request<RecentWorkflow[]>(`/connections/${encodeURIComponent(id)}/comfy/recent`),
  comfyTemplates: (id: string) => request<{ templates: ComfyTemplate[] } | { unsupported: true }>(`/connections/${encodeURIComponent(id)}/comfy/templates`),
  /**
   * A generation connection's models or workflows for the pickers; ComfyUI also lists the model files it has
   * (`checkpointsError` when it couldn't say), from `loader` (the one a workflow's model file is on), else the media's usual one.
   */
  mediaModels: (id: string, media: 'image' | 'video', loader?: CheckpointLoader) =>
    request<MediaModelsResult>(`/connections/${encodeURIComponent(id)}/media-models?media=${media}${loader ? `&loader=${encodeURIComponent(loader)}` : ''}`),
};

/** ComfyUI workflows, built-in (`builtin:` ids, read-only) and imported. */
export const mediaWorkflowsApi = {
  list: () => request<MediaWorkflow[]>('/media/workflows'),
  detect: (graph: unknown) => post<{ bindings: MediaWorkflow['bindings']; problem: string | null }>('/media/workflows/detect', { graph }),
  create: (body: { name: string; media: 'image' | 'video'; graph: unknown; bindings: MediaWorkflow['bindings']; checkpoint?: string }) =>
    post<MediaWorkflow>('/media/workflows', body),
  /** An imported workflow's name, media, bindings or model file (`checkpoint: null` goes back to the graph's own). */
  update: (id: string, body: { name?: string; media?: 'image' | 'video'; graph?: unknown; bindings?: MediaWorkflow['bindings']; checkpoint?: string | null }) =>
    patch<MediaWorkflow>(`/media/workflows/${encodeURIComponent(id)}`, body),
  delete: (id: string) => del(`/media/workflows/${encodeURIComponent(id)}`),
};

export const modelsApi = {
  list: (connectionId?: string) => request<ModelInfo[]>(`/models${connectionId ? `?connectionId=${encodeURIComponent(connectionId)}` : ''}`),
  get: (id: string) => request<ModelInfo>(`/models/${id}`),
  patch: (
    id: string,
    body: Partial<Pick<ModelInfo, 'displayName' | 'priceInPer1m' | 'priceOutPer1m' | 'priceCachedPer1m' | 'currency' | 'supportsVision' | 'supportsTools' | 'supportsReasoning' | 'contextWindow' | 'maxOutput'>>
  ) => patch<ModelInfo>(`/models/${id}`, body),
};
