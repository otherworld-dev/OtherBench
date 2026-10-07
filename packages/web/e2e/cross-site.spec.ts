import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { BASE_URL } from '../playwright.config.js';

/**
 * Cross-site writes (Deck #897): in browser mode there is no token, so a page
 * on another site could post a hidden form to the API, its text/plain body
 * read as JSON. The server must refuse it.
 */
test("a page on another site can't create anything through a hidden form", async ({ page, request }) => {
  const name = `Evil ${randomUUID().slice(0, 8)}`;
  // enctype text/plain sends `<input name>=<value>`: this pair makes the body
  // {"name":"Evil …","kind":"mock","x":"="}, valid JSON.
  const html = `<!doctype html><form id="f" method="POST" action="${BASE_URL}/api/connections" enctype="text/plain">
    <input type="hidden" name='{"name":"${name}","kind":"mock","x":"' value='"}'>
  </form><script>document.getElementById('f').submit();</script>`;
  await page.route('http://evil.example/**', (route) => route.fulfill({ contentType: 'text/html', body: html }));

  const answered = page.waitForResponse((r) => r.url() === `${BASE_URL}/api/connections` && r.request().method() === 'POST');
  await page.goto('http://evil.example/');
  expect((await answered).status()).toBe(403);

  const connections = (await (await request.get(`${BASE_URL}/api/connections`)).json()) as { name: string }[];
  expect(connections.map((c) => c.name)).not.toContain(name);
});
