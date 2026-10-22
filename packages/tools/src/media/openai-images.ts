import type { MediaBackend, MediaConnection, MediaRequest } from '@otherbench/core/ports/media.js';
import { httpError, mediaFetch, readCapped, readJson } from './http.js';

function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
}

function sameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}

/** An OpenAI-compatible images server; `baseUrl` already ends in `/v1`. */
export function createOpenAIImagesBackend(conn: MediaConnection): MediaBackend {
  return {
    async generate(req: MediaRequest, onProgress, signal) {
      if (req.media !== 'image') throw new Error('This server makes images only.');
      onProgress({ stage: 'generating' });
      const res = await mediaFetch(
        conn,
        '/images/generations',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            model: req.model,
            prompt: req.prompt,
            size: `${req.width}x${req.height}`,
            response_format: 'b64_json',
            n: 1,
          }),
        },
        signal,
      );
      if (!res.ok) throw httpError(conn, res, 'Image generation');
      const data = obj(await readJson(res, conn))['data'];
      const first = obj(Array.isArray(data) ? data[0] : undefined);
      const b64 = first['b64_json'];
      if (typeof b64 === 'string' && b64 !== '') {
        return [{ bytes: Buffer.from(b64, 'base64') }];
      }
      const link = first['url'];
      if (typeof link === 'string' && link !== '') {
        // Only the server we were pointed at; a link elsewhere could reach the user's network.
        if (!sameOrigin(link, conn.baseUrl)) throw new Error('The server answered with a link to another site.');
        const img = await mediaFetch(conn, link, {}, signal);
        if (!img.ok) throw httpError(conn, img, 'Fetching the image');
        return [{ bytes: await readCapped(img) }];
      }
      throw new Error(`${conn.baseUrl} answered but returned no image.`);
    },

    async test(signal) {
      const res = await mediaFetch(conn, '/models', {}, signal);
      if (!res.ok) throw httpError(conn, res, 'The check');
      await res.body?.cancel().catch(() => {});
    },

    async listModels(media, signal) {
      if (media !== 'image') return [];
      const res = await mediaFetch(conn, '/models', {}, signal);
      if (!res.ok) throw httpError(conn, res, 'Listing models');
      const data = obj(await readJson(res, conn))['data'];
      const out: { id: string; label: string }[] = [];
      for (const m of Array.isArray(data) ? data : []) {
        const id = obj(m)['id'];
        if (typeof id === 'string' && id) out.push({ id, label: id });
      }
      return out;
    },
  };
}
