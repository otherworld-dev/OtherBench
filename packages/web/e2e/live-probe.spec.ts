import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, test } from '@playwright/test';

/**
 * Live artifacts, Task 1 (spec 2026-10-12-live-artifacts §9): what Chromium
 * does with a page served under the live CSP in a sandboxed frame. It runs
 * against its own tiny server, not Grunt's, and pins the browser behaviour
 * the viewer's bridge relies on.
 *
 * Result (2026-10-12, Chromium): SOURCE_CHECK=pass
 * (`fail` would mean the viewer uses the nonce-in-fragment fallback, plan
 * Tasks 9, 11 and 12).
 */

function livePolicy(folderUrl: string): string {
  return `sandbox allow-scripts allow-forms; default-src 'none'; script-src 'unsafe-inline' ${folderUrl}; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; form-action 'none'; base-uri 'none'`;
}

const APP = `<!doctype html><meta charset="utf-8"><title>probe app</title>
<script>
window.requests = [];
window.loads = 0;
window.addEventListener('message', (e) => {
  const d = e.data;
  if (!d || d.grunt !== 'live-call') return;
  const frame = document.getElementById('f');
  window.requests.push({ sourceIsFrame: e.source === frame.contentWindow, origin: e.origin, call: d.call });
  frame.contentWindow.postMessage({ grunt: 'live-result', v: 1, requestId: d.requestId, ok: true, text: 'pong', cached: false, at: 1 }, '*');
});
</script>
<iframe id="f" sandbox="allow-scripts allow-forms" src="/frame/page.html" onload="window.loads += 1"></iframe>`;

const HELPER = `(function () {
  var pending = {};
  var n = 0;
  window.addEventListener('message', function (e) {
    if (e.source !== parent) return;
    var d = e.data;
    if (!d || d.grunt !== 'live-result' || d.v !== 1) return;
    var p = pending[d.requestId];
    if (!p) return;
    delete pending[d.requestId];
    p(d);
  });
  window.probeCall = function (call) {
    return new Promise(function (resolve) {
      var id = 'r' + (++n);
      pending[id] = resolve;
      parent.postMessage({ grunt: 'live-call', v: 1, requestId: id, call: call, params: {} }, '*');
    });
  };
})();`;

const FRAME = `<!doctype html><meta charset="utf-8">
<script src="helper.js"></script>
<pre id="csp"></pre><pre id="out">waiting</pre><pre id="submitted"></pre>
<form id="form" action="https://example.invalid/collect"><input name="q" value="secret"><button id="go">Send</button></form>
<button id="leave" type="button">Leave</button>
<script>
document.addEventListener('securitypolicyviolation', function (e) { document.getElementById('csp').textContent += e.effectiveDirective + '\\n'; });
document.getElementById('form').addEventListener('submit', function () { document.getElementById('submitted').textContent = 'submit fired'; });
document.getElementById('leave').addEventListener('click', function () { location.href = 'about:blank'; });
fetch('https://example.invalid/').catch(function () {});
probeCall('ping').then(function (r) { document.getElementById('out').textContent = r.text; });
</script>`;

let server: Server;
let origin = '';

test.beforeAll(async () => {
  server = createServer((req, res) => {
    const live = { 'Content-Security-Policy': livePolicy(`${origin}/frame/`), 'X-DNS-Prefetch-Control': 'off', 'Cache-Control': 'no-store' };
    if (req.url === '/app.html') return void res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(APP);
    if (req.url === '/frame/page.html') return void res.writeHead(200, { ...live, 'Content-Type': 'text/html; charset=utf-8' }).end(FRAME);
    if (req.url === '/frame/helper.js') return void res.writeHead(200, { ...live, 'Content-Type': 'text/javascript; charset=utf-8' }).end(HELPER);
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

test.afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

type ProbeWindow = { requests: { sourceIsFrame: boolean; origin: string; call: string }[]; loads: number };
const loads = (page: import('@playwright/test').Page) => page.evaluate(() => (window as unknown as ProbeWindow).loads);

test('a page under the live policy loads its helper from the link folder, asks the app frame and is answered (SOURCE_CHECK)', async ({ page }) => {
  await page.goto(`${origin}/app.html`);
  await expect(page.frameLocator('#f').locator('#out')).toHaveText('pong');
  const requests = await page.evaluate(() => (window as unknown as ProbeWindow).requests);
  // SOURCE_CHECK: the app frame can tell the message came from this frame.
  expect(requests).toEqual([{ sourceIsFrame: true, origin: 'null', call: 'ping' }]);
  expect(await loads(page)).toBe(1);
});

test('fetch is blocked and reported as connect-src', async ({ page }) => {
  await page.goto(`${origin}/app.html`);
  await expect(page.frameLocator('#f').locator('#csp')).toContainText('connect-src');
});

test("a form's submit event still fires under form-action 'none', and the frame doesn't navigate", async ({ page }) => {
  await page.goto(`${origin}/app.html`);
  const frame = page.frameLocator('#f');
  await expect(frame.locator('#out')).toHaveText('pong');
  await frame.locator('#go').click();
  await expect(frame.locator('#submitted')).toHaveText('submit fired');
  // A negative check needs a moment for a navigation that should not happen.
  await page.waitForTimeout(500);
  expect(await loads(page)).toBe(1);
  test.info().annotations.push({ type: 'reported violations', description: (await frame.locator('#csp').textContent()) ?? '' });
});

test('load fires again when the page navigates its own frame', async ({ page }) => {
  await page.goto(`${origin}/app.html`);
  const frame = page.frameLocator('#f');
  await expect(frame.locator('#out')).toHaveText('pong');
  await frame.locator('#leave').click();
  await expect.poll(() => loads(page)).toBe(2);
});
