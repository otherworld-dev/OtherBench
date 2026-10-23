import { availableOn } from '@otherbench/core/domain/availability.js';
import { isGenerationKind } from '@otherbench/core/domain/media.js';
import type { MediaWorkflow } from '@otherbench/core/domain/media-workflows.js';
import type { MediaBackend, MediaConnection } from '@otherbench/core/ports/media.js';
import type { Store } from '@otherbench/core/ports/store.js';
import type { Connection } from '@otherbench/core/types/config.js';
import { createA1111Backend } from '@otherbench/tools/media/a1111.js';
import { BUILTIN_WORKFLOWS, createComfyBackend, type ComfyWorkflows } from '@otherbench/tools/media/comfyui.js';
import { createOpenAIImagesBackend } from '@otherbench/tools/media/openai-images.js';
import type { MediaHost } from '@otherbench/tools/media/tool.js';
import type { Container } from './container.js';

type Deps = Pick<Container, 'store' | 'secrets'>;

const KIND_LABELS: Record<MediaConnection['kind'], string> = { comfyui: 'ComfyUI', a1111: 'A1111', openai_images: 'OpenAI-style' };

/** The workflows a ComfyUI connection runs: the built-in ones, then the imported ones, read at use time. */
export function comfyWorkflows(store: Store): ComfyWorkflows {
  return {
    get: (id) => BUILTIN_WORKFLOWS.find((w) => w.id === id) ?? store.mediaWorkflows.get(id),
    list: (media) => [...BUILTIN_WORKFLOWS, ...store.mediaWorkflows.list()].filter((w) => w.media === media),
  };
}

/** A generation connection as the adapters take it, with its key from the `SecretStore` (never SQLite), as `resolveProfile` does. */
export async function mediaConnectionOf(deps: Deps, conn: Connection): Promise<MediaConnection> {
  if (!isGenerationKind(conn.kind)) throw new Error(`"${conn.name}" isn't a generation connection.`);
  if (!conn.baseUrl) throw new Error(`"${conn.name}" has no base URL. Set one in Settings → Connections.`);
  const apiKey = conn.secretRef ? await deps.secrets.get(conn.secretRef) : null;
  return { kind: conn.kind as MediaConnection['kind'], baseUrl: conn.baseUrl, apiKey, extraHeaders: conn.extraHeaders };
}

/** The adapter for a generation connection's kind. */
export function backendOf(store: Store, conn: MediaConnection): MediaBackend {
  switch (conn.kind) {
    case 'comfyui':
      return createComfyBackend(conn, comfyWorkflows(store));
    case 'a1111':
      return createA1111Backend(conn);
    case 'openai_images':
      return createOpenAIImagesBackend(conn);
  }
}

/**
 * The `MediaHost` the tool provider is given. Everything is read when a call
 * comes, not when the tools are listed: a connection can be deleted, moved to
 * another machine or PATCHed to a chat kind, and a workflow deleted, after a
 * profile chose them.
 */
export function createMediaHost(deps: Deps): MediaHost {
  return {
    async backendFor(connectionId, use) {
      const conn = deps.store.connections.get(connectionId);
      if (!conn) throw new Error('That generation connection no longer exists.');
      const making = use.media === 'image' ? 'images' : 'videos';
      if (!isGenerationKind(conn.kind)) {
        throw new Error(`"${conn.name}" isn't a generation connection any more, so it can't make ${making}. Choose another in the profile's Generation settings.`);
      }
      if (use.media === 'video' && conn.kind !== 'comfyui') {
        throw new Error(`Only a ComfyUI connection makes video, and "${conn.name}" isn't one. Choose another in the profile's Generation settings.`);
      }
      const self = deps.store.nodes.self().id;
      if (!availableOn(conn, self)) {
        const machine = deps.store.peers.get(conn.availability ?? '')?.name ?? 'another machine';
        throw new Error(`"${conn.name}" only works on ${machine}, so it can't make ${making} here.`);
      }
      const media = await mediaConnectionOf(deps, conn);
      let label: string;
      if (media.kind === 'comfyui') {
        const wf: MediaWorkflow | null = comfyWorkflows(deps.store).get(use.model);
        if (!wf) throw new Error('The workflow this profile uses was deleted.');
        if (wf.media !== use.media) throw new Error(`"${wf.name}" makes ${wf.media}s, not ${making}.`);
        label = `${wf.name} (${KIND_LABELS.comfyui})`;
      } else {
        label = `${use.model || conn.name} (${KIND_LABELS[media.kind]})`;
      }
      return { backend: backendOf(deps.store, media), label };
    },
  };
}
