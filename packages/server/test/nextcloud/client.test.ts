import { describe, expect, it } from 'vitest';
import { httpNextcloudClient, normaliseBaseUrl, NextcloudError } from '../../src/nextcloud/client.js';

interface Call { url: string; init: RequestInit & { headers: Record<string, string> } }

function fake(replies: Array<Response | Error>) {
  const calls: Call[] = [];
  let i = 0;
  const f = (async (url: string, init: Call['init']) => {
    calls.push({ url: String(url), init });
    const r = replies[Math.min(i++, replies.length - 1)]!;
    if (r instanceof Error) throw r;
    return r.clone();
  }) as unknown as typeof fetch;
  return { f, calls };
}
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const mk = (f: typeof fetch, password = 'pw') =>
  httpNextcloudClient({ baseUrl: 'https://nc', user: 'adam', password }, f);

describe('nextcloud client', () => {
  it('sends basic auth and the OCS header', async () => {
    const { f, calls } = fake([json([])]);
    await mk(f).deckBoards();
    expect(calls[0]!.init.headers.Authorization).toBe('Basic ' + btoa('adam:pw'));
    expect(calls[0]!.init.headers['OCS-APIRequest']).toBe('true');
  });

  it('normaliseBaseUrl', () => {
    expect(normaliseBaseUrl('https://cloud.example.com/')).toBe('https://cloud.example.com');
    expect(normaliseBaseUrl('http://127.0.0.1:4798')).toBe('http://127.0.0.1:4798');
    expect(() => normaliseBaseUrl('http://cloud.example.com')).toThrow(NextcloudError);
    try {
      normaliseBaseUrl('http://cloud.example.com');
    } catch (e) {
      expect((e as NextcloudError).code).toBe('nextcloud-failed');
    }
  });

  it('refuses a URL with embedded credentials, a query or a fragment', () => {
    for (const raw of ['https://adam:app-pw@cloud.example.com', 'https://adam@cloud.example.com', 'https://cloud.example.com/?a=1', 'https://cloud.example.com/#x']) {
      const err = (() => { try { normaliseBaseUrl(raw); } catch (e) { return e; } })();
      expect(err).toBeInstanceOf(NextcloudError);
      expect((err as NextcloudError).code).toBe('nextcloud-failed');
      expect((err as NextcloudError).message).not.toContain('app-pw');
    }
    expect(() => httpNextcloudClient({ baseUrl: 'https://adam:app-pw@nc', user: 'adam', password: 'x' })).toThrow(NextcloudError);
  });

  it('escapes # and ? in WebDAV page names', async () => {
    const { f, calls } = fake([new Response('x')]);
    await mk(f).pageText({ id: 1, title: 'C#', parentId: 0, collectivePath: '.Collectives/A', filePath: 'What?/C#', fileName: 'Readme.md' });
    expect(calls[0]!.url).toBe('https://nc/remote.php/dav/files/adam/.Collectives/A/What%3F/C%23/Readme.md');
  });

  it('builds the deck, collectives, bookmarks and WebDAV URLs', async () => {
    const { f, calls } = fake([json([]), json({ ocs: { data: { pages: [] } } }), json({ data: [] }), new Response('# hi')]);
    const c = mk(f);
    await c.deckStacks(7);
    await c.collectivePages(3);
    await c.bookmarks('ob');
    const text = await c.pageText({
      id: 1, title: 'x', parentId: 0,
      collectivePath: '.Collectives/Otherworld Dev', filePath: 'Products/OtherBench', fileName: 'Readme.md',
    });
    expect(text).toBe('# hi');
    expect(calls.map((x) => x.url)).toEqual([
      'https://nc/index.php/apps/deck/api/v1.0/boards/7/stacks',
      'https://nc/ocs/v2.php/apps/collectives/api/v1.0/collectives/3/pages',
      'https://nc/index.php/apps/bookmarks/public/rest/v2/bookmark?tags%5B%5D=ob&limit=100&page=0',
      'https://nc/remote.php/dav/files/adam/.Collectives/Otherworld%20Dev/Products/OtherBench/Readme.md',
    ]);
  });

  it('unwraps OCS collections', async () => {
    const { f } = fake([json({ ocs: { data: { collectives: [{ id: 1, name: 'A' }] } } })]);
    expect(await mk(f).collectives()).toEqual([{ id: 1, name: 'A' }]);
  });

  it('pages through bookmarks until a short page', async () => {
    const item = (id: number) => ({ id, url: 'u', title: 't' });
    const { f, calls } = fake([
      json({ data: Array.from({ length: 100 }, (_, i) => item(i)) }),
      json({ data: [item(100), item(101), item(102)] }),
    ]);
    expect(await mk(f).bookmarks('ob')).toHaveLength(103);
    expect(calls).toHaveLength(2);
  });

  describe('failures', () => {
    const cases: Array<[string, () => Response | Error, string]> = [
      ['401 is nextcloud-auth', () => new Response('s3cr3t-pw', { status: 401 }), 'nextcloud-auth'],
      ['404 on an app base route is nextcloud-not-found', () => new Response('s3cr3t-pw', { status: 404 }), 'nextcloud-not-found'],
      ['500 is nextcloud-failed', () => new Response('s3cr3t-pw', { status: 500 }), 'nextcloud-failed'],
      ['fetch rejecting is nextcloud-unreachable', () => new Error('boom s3cr3t-pw'), 'nextcloud-unreachable'],
      ['a non-JSON 200 is nextcloud-failed', () => new Response('<html>s3cr3t-pw', { status: 200 }), 'nextcloud-failed'],
    ];
    for (const [name, reply, code] of cases) {
      it(`${name}, without the password in the message`, async () => {
        const { f } = fake([reply()]);
        const err = await mk(f, 's3cr3t-pw').deckBoards().catch((e: unknown) => e);
        expect(err).toBeInstanceOf(NextcloudError);
        expect((err as NextcloudError).code).toBe(code);
        expect(String((err as NextcloudError).message)).not.toContain('s3cr3t-pw');
      });
    }

    it('a bookmarks status:error is nextcloud-failed', async () => {
      const { f } = fake([json({ status: 'error', data: ['s3cr3t-pw nope'] })]);
      const err = await mk(f, 's3cr3t-pw').bookmarks('ob').catch((e: unknown) => e);
      expect((err as NextcloudError).code).toBe('nextcloud-failed');
      expect(String((err as NextcloudError).message)).not.toContain('s3cr3t-pw');
    });
  });

  it('appsAvailable treats only a 404 as missing', async () => {
    const { f } = fake([json([]), json({ ocs: { data: [] } }), new Response('', { status: 404 })]);
    expect(await mk(f).appsAvailable()).toEqual({ deck: true, collectives: true, bookmarks: false });
  });

  it('sends the internal reorder route and body', async () => {
    const { f, calls } = fake([new Response('', { status: 200 })]);
    await mk(f).deckReorderInternal(5, 9, 0);
    expect(calls[0]!.url).toBe('https://nc/index.php/apps/deck/cards/5/reorder');
    expect(calls[0]!.init.body).toBe(JSON.stringify({ stackId: 9, order: 0 }));
  });
});
