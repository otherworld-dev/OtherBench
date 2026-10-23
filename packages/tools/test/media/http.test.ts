import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { MediaConnection } from '@otherbench/core/ports/media.js';
import { httpError, mediaFetch, readJson } from '../../src/media/http.js';

const servers: Server[] = [];
type Hit = { url: string; headers: IncomingMessage['headers'] };

async function start(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<{ origin: string; hits: Hit[] }> {
  const hits: Hit[] = [];
  const s = createServer((req, res) => {
    hits.push({ url: req.url ?? '', headers: req.headers });
    handler(req, res);
  });
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  return { origin: `http://127.0.0.1:${(s.address() as AddressInfo).port}`, hits };
}

afterEach(async () => {
  for (const s of servers.splice(0)) {
    s.closeAllConnections();
    await new Promise<void>((r) => s.close(() => r()));
  }
});

const conn = (baseUrl: string, over: Partial<MediaConnection> = {}): MediaConnection => ({
  kind: 'openai_images', baseUrl, apiKey: 'sk-secret', extraHeaders: { 'x-extra': 'private' }, ...over,
});
const sig = () => new AbortController().signal;

describe('mediaFetch', () => {
  it('refuses an absolute URL on another origin and sends nothing', async () => {
    const home = await start((_r, res) => res.end('ok'));
    const other = await start((_r, res) => res.end('ok'));
    await expect(mediaFetch(conn(home.origin), `${other.origin}/x.png`, {}, sig())).rejects.toThrow(
      'The server answered with a link to another site.',
    );
    expect(other.hits).toHaveLength(0);
    expect(home.hits).toHaveLength(0);
  });

  it('allows an absolute URL on the same origin', async () => {
    const home = await start((_r, res) => res.end('ok'));
    const res = await mediaFetch(conn(home.origin), `${home.origin}/x.png`, {}, sig());
    expect(res.status).toBe(200);
  });

  it('does not follow a redirect to another origin', async () => {
    const other = await start((_r, res) => res.end('ok'));
    const home = await start((_r, res) => {
      res.writeHead(302, { location: `${other.origin}/stolen` });
      res.end();
    });
    const err = await mediaFetch(conn(home.origin), '/v1/x', {}, sig()).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain(home.origin);
    expect((err as Error).message).not.toContain('sk-secret');
    expect(other.hits).toHaveLength(0);
  });

  it('does not let a caller switch redirects back on', async () => {
    const other = await start((_r, res) => res.end('ok'));
    const home = await start((_r, res) => {
      res.writeHead(302, { location: `${other.origin}/stolen` });
      res.end();
    });
    await expect(mediaFetch(conn(home.origin), '/x', { redirect: 'follow' }, sig())).rejects.toThrow();
    expect(other.hits).toHaveLength(0);
  });

  it('rejects a key with unsendable characters without quoting it', async () => {
    const home = await start((_r, res) => res.end('ok'));
    const err = await mediaFetch(conn(home.origin, { apiKey: 'sk-abc\ndef' }), '/x', {}, sig()).catch((e: Error) => e);
    expect((err as Error).message).toBe("The API key or a header value has characters that can't be sent.");
    expect((err as Error).message).not.toContain('sk-abc');
    const err2 = await mediaFetch(conn(home.origin, { extraHeaders: { 'x-a': 'v\nbad' } }), '/x', {}, sig()).catch((e: Error) => e);
    expect((err2 as Error).message).toBe("The API key or a header value has characters that can't be sent.");
    expect(home.hits).toHaveLength(0);
  });
});

describe('a base URL with a user and password in it', () => {
  it('never names them in an error', async () => {
    const home = await start((_r, res) => res.end('not json'));
    const withUser = home.origin.replace('http://', 'http://admin:hunter2@');
    const c = conn(withUser);
    const reach = await mediaFetch(c, '/models', {}, sig()).then(() => null, (e: Error) => e.message);
    expect(reach).toMatch(/127\.0\.0\.1/);
    expect(httpError(c, new Response(null, { status: 401 }), 'x').message).toBe(`${home.origin} refused the credentials (HTTP 401). Check the API key.`);
    expect(httpError(c, new Response(null, { status: 500 }), 'Listing models').message).toBe(`Listing models failed at ${home.origin} (HTTP 500).`);
    const json = await readJson(new Response('nope'), c).then(() => null, (e: Error) => e.message);
    for (const m of [reach, json]) {
      expect(m).not.toContain('hunter2');
      expect(m).not.toContain('admin');
    }
  });
});
