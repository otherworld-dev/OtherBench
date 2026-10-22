import type { MediaBackend, MediaConnection, MediaProgress, MediaRequest } from '@otherbench/core/ports/media.js';
import { httpError, mediaFetch, readJson } from './http.js';

const POLL_MS = 1000;

function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
}

export function createA1111Backend(conn: MediaConnection): MediaBackend {
  const notApi = () => new Error(`${conn.baseUrl} isn't answering the A1111 API. Start it with --api.`);

  /** Best effort; runs on its own signal because the caller's is already aborted. */
  async function interrupt(): Promise<void> {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 5000);
    try {
      await mediaFetch(conn, '/sdapi/v1/interrupt', { method: 'POST' }, ac.signal);
    } catch {
      // the job may already be gone
    } finally {
      clearTimeout(t);
    }
  }

  return {
    async generate(req: MediaRequest, onProgress: (p: MediaProgress) => void, signal: AbortSignal) {
      if (req.media !== 'image') throw new Error('A1111 makes images only.');
      if (signal.aborted) throw new DOMException('The operation was aborted.', 'AbortError');

      // The poll has its own controller so it is always cut off when the job ends.
      const pollAc = new AbortController();
      let polling = false;
      const timer = setInterval(() => {
        if (polling) return;
        polling = true;
        void (async () => {
          try {
            const res = await mediaFetch(conn, '/sdapi/v1/progress?skip_current_image=true', {}, pollAc.signal);
            if (!res.ok) return;
            const state = obj(obj(await readJson(res, conn))['state']);
            const step = Number(state['sampling_step']);
            const steps = Number(state['sampling_steps']);
            if (!pollAc.signal.aborted && Number.isFinite(step) && Number.isFinite(steps)) {
              onProgress({ stage: 'generating', step, steps });
            }
          } catch {
            // progress is cosmetic
          } finally {
            polling = false;
          }
        })();
      }, POLL_MS);

      const onAbort = () => {
        void interrupt();
      };
      signal.addEventListener('abort', onAbort, { once: true });
      try {
        const res = await mediaFetch(
          conn,
          '/sdapi/v1/txt2img',
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              prompt: req.prompt,
              negative_prompt: req.negativePrompt ?? '',
              width: req.width,
              height: req.height,
              seed: req.seed,
              override_settings: { sd_model_checkpoint: req.model },
            }),
          },
          signal,
        );
        if (!res.ok) throw httpError(conn, res, 'Image generation');
        const images = obj(await readJson(res, conn))['images'];
        const first = Array.isArray(images) ? images[0] : undefined;
        if (typeof first !== 'string' || first === '') {
          throw new Error(`${conn.baseUrl} answered but returned no image.`);
        }
        // Tolerate a data-URL prefix; Buffer's base64 decoder would misread it.
        return [{ bytes: Buffer.from(first.replace(/^data:[^,]*,/, ''), 'base64') }];
      } finally {
        clearInterval(timer);
        pollAc.abort();
        signal.removeEventListener('abort', onAbort);
      }
    },

    async test(signal: AbortSignal) {
      const res = await mediaFetch(conn, '/sdapi/v1/sd-models', {}, signal);
      if (res.status === 404) throw notApi();
      if (!res.ok) throw httpError(conn, res, 'The check');
      await res.body?.cancel().catch(() => {});
    },

    async listModels(media, signal) {
      if (media !== 'image') return [];
      const res = await mediaFetch(conn, '/sdapi/v1/sd-models', {}, signal);
      if (res.status === 404) throw notApi();
      if (!res.ok) throw httpError(conn, res, 'Listing models');
      const body = await readJson(res, conn);
      if (!Array.isArray(body)) return [];
      const out: { id: string; label: string }[] = [];
      for (const m of body) {
        const title = obj(m)['title'];
        if (typeof title === 'string' && title) out.push({ id: title, label: title });
      }
      return out;
    },
  };
}
