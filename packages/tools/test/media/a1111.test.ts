import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { MediaConnection, MediaProgress, MediaRequest } from '@otherbench/core/ports/media.js';
import { createA1111Backend } from '../../src/media/a1111.js';

type Seen = { method: string; url: string; auth: string | undefined; body: string };

let server: Server | undefined;
let seen: Seen[] = [];

async function start(handler: (req: IncomingMessage, res: ServerResponse, s: Seen) => void): Promise<MediaConnection> {
  seen = [];
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const s = { method: req.method ?? '', url: req.url ?? '', auth: req.headers.authorization, body: Buffer.concat(chunks).toString('utf8') };
      seen.push(s);
      handler(req, res, s);
    });
  });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  return { kind: 'a1111', baseUrl: `http://127.0.0.1:${port}`, apiKey: null, extraHeaders: {} };
}

afterEach(async () => {
  server?.closeAllConnections();
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  server = undefined;
});

const req: MediaRequest = {
  media: 'image', model: 'sd15.safetensors', prompt: 'a cat', negativePrompt: 'blurry',
  width: 512, height: 768, seed: 42,
};

const json = (res: ServerResponse, body: unknown, status = 200) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

describe('A1111 backend', () => {
  it('posts txt2img and decodes the first image', async () => {
    const png = Buffer.from('fake-png-bytes');
    const conn = await start((_r, res) => json(res, { images: [png.toString('base64')] }));
    const out = await createA1111Backend(conn).generate(req, () => {}, new AbortController().signal);
    expect(out).toHaveLength(1);
    expect(out[0]!.bytes.equals(png)).toBe(true);
    const post = seen.find((s) => s.url === '/sdapi/v1/txt2img')!;
    expect(post.method).toBe('POST');
    expect(JSON.parse(post.body)).toEqual({
      prompt: 'a cat', negative_prompt: 'blurry', width: 512, height: 768, seed: 42,
      override_settings: { sd_model_checkpoint: 'sd15.safetensors' },
      override_settings_restore_afterwards: false,
    });
  });

  it('reports progress from the progress endpoint while it runs', async () => {
    const conn = await start((r, res) => {
      if (r.url?.startsWith('/sdapi/v1/progress')) return json(res, { state: { sampling_step: 7, sampling_steps: 20 } });
      setTimeout(() => json(res, { images: [Buffer.from('x').toString('base64')] }), 1500);
    });
    const events: MediaProgress[] = [];
    await createA1111Backend(conn).generate(req, (p) => events.push(p), new AbortController().signal);
    expect(events).toContainEqual({ stage: 'generating', step: 7, steps: 20 });
  });

  it('interrupts and rejects with an AbortError when aborted', async () => {
    const conn = await start((r, res) => {
      if (r.url === '/sdapi/v1/interrupt') return json(res, {});
      if (r.url?.startsWith('/sdapi/v1/progress')) return json(res, { state: {} });
      // txt2img never answers
    });
    const ac = new AbortController();
    const p = createA1111Backend(conn).generate(req, () => {}, ac.signal);
    await new Promise((r) => setTimeout(r, 100));
    ac.abort();
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
    await new Promise((r) => setTimeout(r, 100));
    expect(seen.some((s) => s.method === 'POST' && s.url === '/sdapi/v1/interrupt')).toBe(true);
  });

  it('lists checkpoints by title and ignores video', async () => {
    const conn = await start((_r, res) => json(res, [{ title: 'a.safetensors [123]', model_name: 'a' }, { title: 'b.ckpt' }]));
    const b = createA1111Backend(conn);
    expect(await b.listModels('image', new AbortController().signal)).toEqual([
      { id: 'a.safetensors [123]', label: 'a.safetensors [123]' },
      { id: 'b.ckpt', label: 'b.ckpt' },
    ]);
    expect(await b.listModels('video', new AbortController().signal)).toEqual([]);
  });

  it('says to start it with --api when the endpoint 404s', async () => {
    const conn = await start((_r, res) => json(res, { detail: 'Not Found' }, 404));
    await expect(createA1111Backend(conn).test(new AbortController().signal)).rejects.toThrow(
      `${conn.baseUrl} isn't answering the A1111 API. Start it with --api.`,
    );
  });

  it('names the base URL when nothing is listening', async () => {
    const conn = await start((_r, res) => json(res, {}));
    await new Promise<void>((r) => server!.close(() => r()));
    await expect(createA1111Backend(conn).test(new AbortController().signal)).rejects.toThrow(
      `Couldn't reach ${conn.baseUrl}`,
    );
  });

  it('sends Basic for user:pass keys, Bearer otherwise, plus extra headers', async () => {
    const conn = await start((_r, res) => json(res, []));
    const ac = new AbortController();
    await createA1111Backend({ ...conn, apiKey: 'bob:secret', extraHeaders: { 'x-extra': '1' } }).test(ac.signal);
    expect(seen[0]!.auth).toBe(`Basic ${Buffer.from('bob:secret').toString('base64')}`);
    await createA1111Backend({ ...conn, apiKey: 'tok' }).test(ac.signal);
    expect(seen[1]!.auth).toBe('Bearer tok');
  });

  it('refuses a response past the cap without buffering it all', async () => {
    const conn = await start((_r, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      const chunk = Buffer.alloc(1024 * 1024, 97);
      let n = 0;
      const send = () => {
        while (n < 80) {
          n++;
          if (!res.write(chunk)) return void res.once('drain', send);
        }
        res.end();
      };
      send();
    });
    await expect(createA1111Backend(conn).generate(req, () => {}, new AbortController().signal)).rejects.toThrow(/larger than 64 MB/);
  });
});
