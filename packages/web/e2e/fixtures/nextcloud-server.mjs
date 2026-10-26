// A fake Nextcloud on 127.0.0.1 for nextcloud-tabs.spec.ts. It answers the
// routes packages/server/src/nextcloud/client.ts calls, in the shapes the real
// apps use: Deck's api/v1.0 JSON, Collectives' OCS envelope with page text
// over WebDAV, and Bookmarks' REST v2 `{ status, data }`. Everything but
// /status.php needs Basic auth as adam:e2e-app-password and the
// OCS-APIRequest header. State is kept in memory, so a move or a done sticks
// for the run. The web UI's internal reorder route isn't here: the documented
// one moves the card, so the server never needs the fallback.
import { createServer } from 'node:http';

const port = Number(process.argv[2] ?? 4798);
const USER = 'adam';
const PASSWORD = 'e2e-app-password';
const AUTH = 'Basic ' + Buffer.from(`${USER}:${PASSWORD}`, 'utf8').toString('base64');

// ---- Deck ----
const label = { id: 1, title: 'Bug', color: 'e9322d' };
const board = { id: 1, title: 'E2E Board', color: '0082c9', archived: false, labels: [label], deletedAt: 0 };
const stacks = [
  { id: 1, title: 'To Do', order: 0 },
  { id: 2, title: 'Doing', order: 1 },
  { id: 3, title: 'Done', order: 2 },
];
const card = (id, title, stackId, extra = {}) => ({
  id,
  title,
  description: '',
  stackId,
  type: 'plain',
  owner: { uid: USER, displayname: 'Adam' },
  order: 0,
  duedate: null,
  done: null,
  archived: false,
  labels: [],
  createdAt: 1_760_000_000,
  ...extra,
});
const cards = [
  card(101, '#101 First card', 1, { description: 'The first card.' }),
  card(102, '#102 Second card', 2, { labels: [label] }),
  // Due now, for overview.spec.ts. It sits in Doing so To Do stays as nextcloud-tabs.spec.ts expects.
  card(104, '#104 Due today', 2, { duedate: new Date().toISOString() }),
];
let nextCardId = 105;

const stackOut = (s, archived) => ({ ...s, boardId: board.id, cards: cards.filter((c) => c.stackId === s.id && c.archived === archived) });

// ---- Collectives ----
const collective = { id: 1, name: 'Otherworld Dev' };
const collectivePath = 'Collectives/Otherworld Dev';
const pages = [
  { id: 10, title: 'Otherworld Dev', parentId: 0, filePath: '', fileName: 'Readme.md', text: '# Otherworld Dev\n' },
  { id: 11, title: 'Products', parentId: 10, filePath: 'Products', fileName: 'Readme.md', text: '# Products\n' },
  { id: 12, title: 'E2E', parentId: 11, filePath: 'Products/E2E', fileName: 'Readme.md', text: '# E2E\n\nThe app page.\n' },
  { id: 13, title: 'Notes', parentId: 12, filePath: 'Products/E2E', fileName: 'Notes.md', text: '# Notes\n\nThe notes page, read over WebDAV.\n' },
];
const pageOut = ({ text: _text, ...p }) => ({ ...p, collectivePath, emoji: null, isLandingPage: p.parentId === 0 });
/** WebDAV path under files/adam/ -> page text. */
const davFiles = new Map(pages.map((p) => [[collectivePath, p.filePath, p.fileName].filter(Boolean).join('/'), p.text]));

// ---- Bookmarks ----
const bookmarks = [
  { id: 1, url: 'https://example.com/e2e-docs', title: 'E2E bookmark', description: 'Tagged for the app.', tags: ['e2e'], added: 1_760_000_100 },
  { id: 2, url: 'https://example.com/other', title: 'Other bookmark', description: '', tags: ['other'], added: 1_760_000_200 },
];

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}
const ocs = (data) => ({ ocs: { meta: { status: 'ok', statuscode: 200, message: 'OK' }, data } });

function readJson(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        resolve({});
      }
    });
  });
}

const DECK = '/index.php/apps/deck/api/v1.0';
const COLL = '/ocs/v2.php/apps/collectives/api/v1.0';
const BM = '/index.php/apps/bookmarks/public/rest/v2';

async function handle(req, res) {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
  const path = url.pathname;
  const method = req.method ?? 'GET';

  // Playwright's readiness check, as public as the real one.
  if (path === '/status.php') return send(res, 200, { installed: true, maintenance: false, productname: 'Nextcloud' });
  if (req.headers.authorization !== AUTH) return send(res, 401, { message: 'Unauthorized' });
  if (req.headers['ocs-apirequest'] !== 'true') return send(res, 400, { message: 'OCS-APIRequest header missing' });

  if (method === 'GET' && path === '/ocs/v2.php/cloud/user') return send(res, 200, ocs({ id: USER, displayname: 'Adam E2E' }));

  // Deck
  let m;
  if (method === 'GET' && path === `${DECK}/boards`) return send(res, 200, [board]);
  if ((m = /^\/index\.php\/apps\/deck\/api\/v1\.0\/boards\/(\d+)(\/.*)?$/.exec(path))) {
    if (Number(m[1]) !== board.id) return send(res, 404, { message: 'Board not found' });
    const rest = m[2] ?? '';
    if (method === 'GET' && rest === '') return send(res, 200, { ...board, stacks: stacks.map((s) => stackOut(s, false)) });
    if (method === 'GET' && rest === '/stacks') return send(res, 200, stacks.map((s) => stackOut(s, false)));
    if (method === 'GET' && rest === '/stacks/archived') return send(res, 200, stacks.map((s) => stackOut(s, true)));
    const sc = /^\/stacks\/(\d+)\/cards(?:\/(\d+)(\/\w+)?)?$/.exec(rest);
    if (!sc || !stacks.some((s) => s.id === Number(sc[1]))) return send(res, 404, { message: 'Not found' });
    const stackId = Number(sc[1]);
    if (sc[2] === undefined) {
      if (method !== 'POST') return send(res, 405, { message: 'Method not allowed' });
      const body = await readJson(req);
      const created = card(nextCardId++, String(body.title ?? ''), stackId, { description: String(body.description ?? ''), order: Number(body.order ?? 0) });
      cards.push(created);
      return send(res, 200, created);
    }
    const target = cards.find((c) => c.id === Number(sc[2]));
    if (!target) return send(res, 404, { message: 'Card not found' });
    const action = sc[3] ?? '';
    if (action === '' && method === 'GET') return send(res, 200, target);
    if (action === '' && method === 'PUT') {
      const body = await readJson(req);
      for (const key of ['title', 'description', 'type', 'order', 'duedate', 'done', 'archived']) {
        if (key in body) target[key] = body[key];
      }
      return send(res, 200, target);
    }
    if (action === '' && method === 'DELETE') {
      cards.splice(cards.indexOf(target), 1);
      return send(res, 200, target);
    }
    if (action === '/reorder' && method === 'PUT') {
      const body = await readJson(req);
      if (!stacks.some((s) => s.id === Number(body.stackId))) return send(res, 400, { message: 'Bad stack' });
      target.stackId = Number(body.stackId);
      target.order = Number(body.order ?? 0);
      return send(res, 200, cards.filter((c) => c.stackId === target.stackId));
    }
    if ((action === '/assignLabel' || action === '/removeLabel') && method === 'PUT') {
      const body = await readJson(req);
      if (Number(body.labelId) !== label.id) return send(res, 400, { message: 'Bad label' });
      target.labels = action === '/assignLabel' ? [label] : [];
      return send(res, 200, {});
    }
    return send(res, 404, { message: 'Not found' });
  }

  // Collectives
  if (method === 'GET' && path === `${COLL}/collectives`) return send(res, 200, ocs({ collectives: [collective] }));
  if (method === 'GET' && path === `${COLL}/collectives/${collective.id}/pages`) return send(res, 200, ocs({ pages: pages.map(pageOut) }));
  const davPrefix = `/remote.php/dav/files/${USER}/`;
  if (method === 'GET' && path.startsWith(davPrefix)) {
    const text = davFiles.get(decodeURIComponent(path.slice(davPrefix.length)));
    return text === undefined ? send(res, 404, 'Not found', 'text/plain') : send(res, 200, text, 'text/markdown; charset=utf-8');
  }

  // Bookmarks
  if (method === 'GET' && path === `${BM}/tag`) return send(res, 200, [...new Set(bookmarks.flatMap((b) => b.tags))]);
  if (method === 'GET' && path === `${BM}/bookmark`) {
    const tags = url.searchParams.getAll('tags[]');
    const limit = Number(url.searchParams.get('limit') ?? 10);
    const page = Number(url.searchParams.get('page') ?? 0);
    const matching = bookmarks.filter((b) => tags.every((t) => b.tags.includes(t)));
    return send(res, 200, { status: 'success', data: matching.slice(page * limit, (page + 1) * limit) });
  }

  return send(res, 404, { message: 'Not found' });
}

createServer((req, res) => {
  handle(req, res).catch(() => send(res, 500, { message: 'Fixture error' }));
}).listen(port, '127.0.0.1');
