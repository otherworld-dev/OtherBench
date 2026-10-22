import type { NextcloudErrorCode } from '@otherbench/core/types/nextcloud.js';

export interface NextcloudConfig { baseUrl: string; user: string; password: string }

export class NextcloudError extends Error {
  constructor(readonly code: NextcloudErrorCode, message: string) {
    super(message);
    this.name = 'NextcloudError';
  }
}

/** Raw Deck / Collectives / Bookmarks objects as Nextcloud returns them: the fields the code reads are typed, extras pass through. */
export interface RawLabel { id: number; title: string; color: string; [k: string]: unknown }
export interface RawCard {
  id: number;
  title: string;
  description?: string | null;
  stackId?: number;
  labels?: RawLabel[] | null;
  duedate?: string | null;
  done?: string | boolean | null;
  archived?: boolean;
  order?: number;
  type?: string;
  owner?: { uid?: string; [k: string]: unknown } | string | null;
  createdAt?: number;
  [k: string]: unknown;
}
export interface RawStack { id: number; title: string; order: number; cards?: RawCard[] | null; [k: string]: unknown }
export interface RawBoard {
  id: number;
  title: string;
  color?: string;
  archived?: boolean;
  labels?: RawLabel[] | null;
  [k: string]: unknown;
}
export interface RawCardPut {
  title: string;
  type: string;
  owner: string | null | undefined;
  description: string;
  order: number;
  duedate: string | null;
  done?: string | boolean | null;
  archived: boolean;
}
export interface RawCollective { id: number; name: string; [k: string]: unknown }
export interface RawPage {
  id: number;
  title: string;
  parentId: number;
  collectivePath?: string;
  filePath?: string;
  fileName?: string;
  [k: string]: unknown;
}
export interface RawBookmark {
  id: number;
  url: string;
  title: string;
  description?: string;
  tags?: string[];
  added?: number;
  [k: string]: unknown;
}
export interface BookmarkFields { url?: string; title?: string; description?: string; tags?: string[] }

export interface NextcloudClient {
  readonly baseUrl: string;
  readonly user: string;
  currentUser(): Promise<{ id: string; displayName: string }>;
  /** Whether each app answers (any non-404 on its base route). */
  appsAvailable(): Promise<{ deck: boolean; collectives: boolean; bookmarks: boolean }>;
  deckBoards(): Promise<RawBoard[]>;
  deckBoard(boardId: number): Promise<RawBoard>;
  deckStacks(boardId: number): Promise<RawStack[]>;
  deckArchivedStacks(boardId: number): Promise<RawStack[]>;
  deckCard(boardId: number, stackId: number, cardId: number): Promise<RawCard>;
  deckPutCard(boardId: number, stackId: number, cardId: number, body: RawCardPut): Promise<RawCard>;
  deckCreateCard(boardId: number, stackId: number, body: { title: string; type: 'plain'; order: number; description?: string }): Promise<RawCard>;
  deckDeleteCard(boardId: number, stackId: number, cardId: number): Promise<void>;
  deckReorder(boardId: number, stackId: number, cardId: number, toStackId: number, order: number): Promise<void>;
  deckReorderInternal(cardId: number, toStackId: number, order: number): Promise<void>;
  deckAssignLabel(boardId: number, stackId: number, cardId: number, labelId: number): Promise<void>;
  deckRemoveLabel(boardId: number, stackId: number, cardId: number, labelId: number): Promise<void>;
  collectives(): Promise<RawCollective[]>;
  collectivePages(collectiveId: number): Promise<RawPage[]>;
  pageText(page: RawPage): Promise<string>;
  bookmarks(tag: string): Promise<RawBookmark[]>;
  bookmarkCreate(fields: BookmarkFields): Promise<RawBookmark>;
  bookmarkUpdate(id: number, fields: BookmarkFields): Promise<RawBookmark>;
  bookmarkDelete(id: number): Promise<void>;
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);
const TIMEOUT_MS = 15_000;
const BOOKMARK_PAGE = 100;
const BOOKMARK_CAP = 1000;

/** The URL as stored: trimmed, no trailing slash. Throws NextcloudError('nextcloud-failed') if it isn't https, or http on a loopback host. */
export function normaliseBaseUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, '');
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new NextcloudError('nextcloud-failed', 'The Nextcloud URL is not a valid URL.');
  }
  const ok = url.protocol === 'https:' || (url.protocol === 'http:' && LOOPBACK.has(url.hostname));
  if (!ok) throw new NextcloudError('nextcloud-failed', 'The Nextcloud URL must start with https://.');
  return trimmed;
}

type Parse = 'json' | 'text' | 'none';
interface CallOpts { json?: unknown; body?: string; parse: Parse; headers?: Record<string, string> }

/** OCS envelope: {"ocs":{"data":...}} -> data, then a named collection out of it (nc.py ocs_pick). */
function ocsPick(payload: unknown, key: string): unknown {
  let data: unknown = payload;
  if (payload && typeof payload === 'object') {
    const p = payload as Record<string, unknown>;
    if (p.ocs && typeof p.ocs === 'object') {
      const o = p.ocs as Record<string, unknown>;
      data = 'data' in o ? o.data : o;
    } else if ('data' in p) data = p.data;
  }
  if (key && data && typeof data === 'object' && !Array.isArray(data) && key in (data as object)) {
    return (data as Record<string, unknown>)[key];
  }
  return data;
}

export function httpNextcloudClient(config: NextcloudConfig, fetchImpl: typeof fetch = fetch): NextcloudClient {
  const baseUrl = normaliseBaseUrl(config.baseUrl);
  const auth = 'Basic ' + Buffer.from(`${config.user}:${config.password}`, 'utf8').toString('base64');
  const deck = `${baseUrl}/index.php/apps/deck/api/v1.0`;
  const coll = `${baseUrl}/ocs/v2.php/apps/collectives/api/v1.0`;
  const bm = `${baseUrl}/index.php/apps/bookmarks/public/rest/v2`;

  async function call(method: string, url: string, opts: CallOpts): Promise<unknown> {
    const headers: Record<string, string> = {
      Authorization: auth,
      'OCS-APIRequest': 'true',
      Accept: 'application/json',
      ...opts.headers,
    };
    let body: string | undefined = opts.body;
    if (opts.json !== undefined) {
      body = JSON.stringify(opts.json);
      headers['Content-Type'] = 'application/json';
    }
    let res: Response;
    try {
      res = await fetchImpl(url, { method, headers, body, signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch {
      throw new NextcloudError('nextcloud-unreachable', `Couldn't reach Nextcloud at ${baseUrl}.`);
    }
    if (res.status === 401 || res.status === 403) {
      throw new NextcloudError('nextcloud-auth', 'Nextcloud rejected the username or app password.');
    }
    if (res.status === 404) throw new NextcloudError('nextcloud-not-found', 'Nextcloud answered HTTP 404.');
    if (res.status < 200 || res.status >= 300) {
      throw new NextcloudError('nextcloud-failed', `Nextcloud answered HTTP ${res.status}.`);
    }
    if (opts.parse === 'none') return undefined;
    let text: string;
    try {
      text = await res.text();
    } catch {
      throw new NextcloudError('nextcloud-unreachable', `Couldn't reach Nextcloud at ${baseUrl}.`);
    }
    if (opts.parse === 'text') return text;
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new NextcloudError('nextcloud-failed', 'Nextcloud answered with something that is not JSON.');
    }
  }

  /** The Bookmarks app answers 200 for logical failures, with status:"error" (nc.py bm_call). */
  async function bmCall(method: string, url: string, opts: CallOpts): Promise<Record<string, unknown>> {
    const payload = await call(method, url, opts);
    if (payload && typeof payload === 'object' && (payload as Record<string, unknown>).status === 'error') {
      throw new NextcloudError('nextcloud-failed', 'Nextcloud Bookmarks reported an error.');
    }
    return (payload && typeof payload === 'object' ? payload : {}) as Record<string, unknown>;
  }

  const asArray = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
  const cardUrl = (b: number, s: number, c: number) => `${deck}/boards/${b}/stacks/${s}/cards/${c}`;

  return {
    baseUrl,
    user: config.user,

    async currentUser() {
      const payload = await call('GET', `${baseUrl}/ocs/v2.php/cloud/user?format=json`, { parse: 'json' });
      const d = ocsPick(payload, '') as Record<string, unknown> | undefined;
      const id = typeof d?.id === 'string' ? d.id : config.user;
      const displayName = typeof d?.displayname === 'string' ? d.displayname : id;
      return { id, displayName };
    },

    async appsAvailable() {
      const probe = async (url: string): Promise<boolean> => {
        try {
          await call('GET', url, { parse: 'none' });
          return true;
        } catch (e) {
          if (e instanceof NextcloudError && e.code === 'nextcloud-not-found') return false;
          throw e;
        }
      };
      const [d, c, b] = await Promise.all([
        probe(`${deck}/boards`),
        probe(`${coll}/collectives`),
        probe(`${bm}/tag`),
      ]);
      return { deck: d, collectives: c, bookmarks: b };
    },

    async deckBoards() { return asArray<RawBoard>(await call('GET', `${deck}/boards`, { parse: 'json' })); },
    async deckBoard(id) { return (await call('GET', `${deck}/boards/${id}`, { parse: 'json' })) as RawBoard; },
    async deckStacks(id) { return asArray<RawStack>(await call('GET', `${deck}/boards/${id}/stacks`, { parse: 'json' })); },
    async deckArchivedStacks(id) {
      return asArray<RawStack>(await call('GET', `${deck}/boards/${id}/stacks/archived`, { parse: 'json' }));
    },
    async deckCard(b, s, c) { return (await call('GET', cardUrl(b, s, c), { parse: 'json' })) as RawCard; },
    async deckPutCard(b, s, c, body) { return (await call('PUT', cardUrl(b, s, c), { json: body, parse: 'json' })) as RawCard; },
    async deckCreateCard(b, s, body) {
      return (await call('POST', `${deck}/boards/${b}/stacks/${s}/cards`, { json: body, parse: 'json' })) as RawCard;
    },
    async deckDeleteCard(b, s, c) { await call('DELETE', cardUrl(b, s, c), { parse: 'none' }); },
    async deckReorder(b, s, c, toStackId, order) {
      await call('PUT', `${cardUrl(b, s, c)}/reorder`, { json: { order, stackId: toStackId }, parse: 'none' });
    },
    async deckReorderInternal(cardId, toStackId, order) {
      await call('PUT', `${baseUrl}/index.php/apps/deck/cards/${cardId}/reorder`, {
        json: { stackId: toStackId, order },
        parse: 'none',
      });
    },
    async deckAssignLabel(b, s, c, labelId) {
      await call('PUT', `${cardUrl(b, s, c)}/assignLabel`, { json: { labelId }, parse: 'none' });
    },
    async deckRemoveLabel(b, s, c, labelId) {
      await call('PUT', `${cardUrl(b, s, c)}/removeLabel`, { json: { labelId }, parse: 'none' });
    },

    async collectives() {
      return asArray<RawCollective>(ocsPick(await call('GET', `${coll}/collectives`, { parse: 'json' }), 'collectives'));
    },
    async collectivePages(id) {
      return asArray<RawPage>(ocsPick(await call('GET', `${coll}/collectives/${id}/pages`, { parse: 'json' }), 'pages'));
    },
    async pageText(page) {
      const rel = [page.collectivePath, page.filePath, page.fileName || 'Readme.md']
        .map((p) => (p ?? '').replace(/^\/+|\/+$/g, ''))
        .filter(Boolean)
        .join('/');
      const url = `${baseUrl}/remote.php/dav/files/${encodeURIComponent(config.user)}/${encodeURI(rel)}`;
      return (await call('GET', url, { parse: 'text', headers: { Accept: '*/*' } })) as string;
    },

    async bookmarks(tag) {
      const items: RawBookmark[] = [];
      for (let page = 0; ; page++) {
        const q = `tags%5B%5D=${encodeURIComponent(tag)}&limit=${BOOKMARK_PAGE}&page=${page}`;
        const payload = await bmCall('GET', `${bm}/bookmark?${q}`, { parse: 'json' });
        const batch = asArray<RawBookmark>(payload.data);
        items.push(...batch);
        if (batch.length < BOOKMARK_PAGE) return items;
        if (items.length > BOOKMARK_CAP) return items.slice(0, BOOKMARK_CAP);
      }
    },
    async bookmarkCreate(fields) {
      const p = await bmCall('POST', `${bm}/bookmark`, { json: fields, parse: 'json' });
      return (p.item ?? {}) as RawBookmark;
    },
    async bookmarkUpdate(id, fields) {
      const p = await bmCall('PUT', `${bm}/bookmark/${id}`, { json: fields, parse: 'json' });
      return (p.item ?? {}) as RawBookmark;
    },
    async bookmarkDelete(id) { await bmCall('DELETE', `${bm}/bookmark/${id}`, { parse: 'json' }); },
  };
}
