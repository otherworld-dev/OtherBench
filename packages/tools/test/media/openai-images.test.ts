import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { MediaConnection, MediaRequest } from '@otherbench/core/ports/media.js';
import { createOpenAIImagesBackend } from '../../src/media/openai-images.js';

type Seen = { method: string; url: string; auth: string | undefined; body: string };

let server: Server | undefined;
let seen: Seen[] = [];

async function start(handler: (req: IncomingMessage, res: ServerResponse, port: number) => void): Promise<MediaConnection> {
  seen = [];
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      seen.push({ method: req.method ?? '', url: req.url ?? '', auth: req.headers.authorization, body: Buffer.concat(chunks).toString('utf8') });
      handler(req, res, (server!.address() as AddressInfo).port);
    });
  });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  return { kind: 'openai_images', baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'sk-test', extraHeaders: {} };
}

afterEach(async () => {
  server?.closeAllConnections();
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  server = undefined;
});

const req: MediaRequest = {
  media: 'image', model: 'flux', prompt: 'a dog', negativePrompt: null, width: 1024, height: 1024, seed: 1,
};

const json = (res: ServerResponse, body: unknown, status = 200) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

describe('OpenAI-style images backend', () => {
  it('posts /images/generations and decodes b64_json', async () => {
    const png = Buffer.from('png-bytes');
    const conn = await start((_r, res) => json(res, { data: [{ b64_json: png.toString('base64') }] }));
    const out = await createOpenAIImagesBackend(conn).generate(req, () => {}, new AbortController().signal);
    expect(out[0]!.bytes.equals(png)).toBe(true);
    expect(seen[0]!.url).toBe('/v1/images/generations');
    expect(seen[0]!.auth).toBe('Bearer sk-test');
    expect(JSON.parse(seen[0]!.body)).toEqual({
      model: 'flux', prompt: 'a dog', size: '1024x1024', response_format: 'b64_json', n: 1,
    });
  });

  it('fetches a same-origin url once when there is no b64_json', async () => {
    const png = Buffer.from('linked-bytes');
    const conn = await start((r, res, port) => {
      if (r.url === '/files/1.png') {
        res.writeHead(200, { 'content-type': 'image/png' });
        return void res.end(png);
      }
      json(res, { data: [{ url: `http://127.0.0.1:${port}/files/1.png` }] });
    });
    const out = await createOpenAIImagesBackend(conn).generate(req, () => {}, new AbortController().signal);
    expect(out[0]!.bytes.equals(png)).toBe(true);
    expect(seen.filter((s) => s.url === '/files/1.png')).toHaveLength(1);
  });

  it('refuses a url on another origin and never fetches it', async () => {
    const conn = await start((_r, res) => json(res, { data: [{ url: 'http://example.invalid/x.png' }] }));
    await expect(createOpenAIImagesBackend(conn).generate(req, () => {}, new AbortController().signal)).rejects.toThrow(
      'The server answered with a link to another site.',
    );
    expect(seen).toHaveLength(1);
  });

  it('lists models from /models', async () => {
    const conn = await start((_r, res) => json(res, { data: [{ id: 'flux' }, { id: 'sdxl' }] }));
    const b = createOpenAIImagesBackend(conn);
    expect(await b.listModels('image', new AbortController().signal)).toEqual([
      { id: 'flux', label: 'flux' },
      { id: 'sdxl', label: 'sdxl' },
    ]);
    expect(seen[0]!.url).toBe('/v1/models');
    expect(await b.listModels('video', new AbortController().signal)).toEqual([]);
  });

  it('rejects with an AbortError and never leaks the key in errors', async () => {
    const conn = await start(() => {});
    const ac = new AbortController();
    const p = createOpenAIImagesBackend(conn).generate(req, () => {}, ac.signal);
    await new Promise((r) => setTimeout(r, 50));
    ac.abort();
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });

    server?.closeAllConnections();
    await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
    const bad = await start((_r, res) => json(res, {}, 401));
    const err = await createOpenAIImagesBackend(bad).test(new AbortController().signal).catch((e: Error) => e);
    expect((err as Error).message).toMatch(/refused the credentials/);
    expect((err as Error).message).not.toContain('sk-test');
  });
});
