import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { BASE_URL } from '../playwright.config.js';
import { startOAuthEchoServer } from '../../tools/test/fixtures/oauth-echo-server.js';

/**
 * MCP sign-in (spec 2026-10-12-mcp-oauth-design §8) against the fake OAuth
 * provider fixture, started here on a free port. No model is involved. The
 * e2e server's redirect address is http://127.0.0.1:<its port>/oauth/callback,
 * so the fixture's /authorize sends the new tab straight back to OtherBench.
 */
let fixture: Awaited<ReturnType<typeof startOAuthEchoServer>>;
test.beforeAll(async () => {
  fixture = await startOAuthEchoServer({ idTokenEmail: 'e2e@example.com' });
});
test.afterAll(async () => {
  await fixture.close();
});

async function createServer(request: APIRequestContext, name: string): Promise<string> {
  const res = await request.post(`${BASE_URL}/api/mcp-servers`, { data: { name, transport: 'http', url: fixture.url } });
  return ((await res.json()) as { id: string }).id;
}

async function openServer(page: Page, id: string): Promise<void> {
  await page.goto('/');
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('tab', { name: 'MCP Servers' }).click();
  await expect(page.getByTestId(`mcp-row-${id}`)).toContainText('needs sign-in');
  await page.getByTestId(`mcp-row-${id}`).click();
}

test('signs in to a hosted MCP server through the browser, never shows a token, and signs out', async ({ page, request }) => {
  const name = `OAuth e2e ${randomUUID().slice(0, 8)}`;
  const id = await createServer(request, name);
  await openServer(page, id);
  const signIn = page.getByTestId('mcp-sign-in');
  const status = signIn.getByTestId('mcp-sign-in-status');
  await expect(status).toHaveText('This server needs you to sign in.');

  const [tab] = await Promise.all([page.context().waitForEvent('page'), signIn.getByRole('button', { name: 'Sign in…' }).click()]);
  await expect(tab.locator('body')).toContainText(`Signed in to ${name}. You can close this tab and go back to OtherBench.`);
  await tab.close();

  await expect(status).toContainText('Signed in as e2e@example.com since', { timeout: 15_000 });
  await expect(page.getByTestId(`mcp-row-${id}`)).toContainText('2 tools');

  const config = await (await request.get(`${BASE_URL}/api/mcp-servers/${id}`)).text();
  const health = await (await request.get(`${BASE_URL}/api/mcp-servers`)).text();
  const pageText = (await page.locator('body').textContent()) ?? '';
  for (const token of [...fixture.issued.accessTokens, ...fixture.issued.refreshTokens, ...fixture.issued.idTokens]) {
    expect(config).not.toContain(token);
    expect(health).not.toContain(token);
    expect(pageText).not.toContain(token);
  }

  page.once('dialog', (dialog) => void dialog.accept());
  await signIn.getByRole('button', { name: 'Sign out' }).click();
  await expect(status).toHaveText('This server needs you to sign in.', { timeout: 15_000 });

  await request.delete(`${BASE_URL}/api/mcp-servers/${id}`);
});

test('finishes a sign-in from the address another device ended on', async ({ page, request }) => {
  const id = await createServer(request, `OAuth paste ${randomUUID().slice(0, 8)}`);
  await openServer(page, id);
  const signIn = page.getByTestId('mcp-sign-in');

  // As a phone would see it: the redirect to 127.0.0.1 ends on a page that won't load. A
  // new tab opened with noopener doesn't pass its redirects through Playwright's routing, so
  // answer the provider's /authorize here: read where it redirects, and show the dead page
  // instead of following it (OtherBench's callback is never reached; the code stays unused).
  const ended = { url: '' };
  const isAuthorize = (url: URL): boolean => url.pathname === '/authorize' && url.origin === new URL(fixture.url).origin;
  await page.context().route(isAuthorize, async (route) => {
    const res = await route.fetch({ maxRedirects: 0 });
    ended.url = res.headers()['location'] ?? '';
    await route.fulfill({ status: 502, contentType: 'text/html', body: '<p>This site can’t be reached</p>' });
  });
  const [tab] = await Promise.all([page.context().waitForEvent('page'), signIn.getByRole('button', { name: 'Sign in…' }).click()]);
  await expect.poll(() => ended.url).not.toBe('');
  await tab.close();
  await page.context().unroute(isAuthorize);

  await signIn.getByLabel('Address the sign-in ended on').fill(ended.url);
  await signIn.getByRole('button', { name: 'Finish sign-in' }).click();
  await expect(signIn.getByTestId('mcp-sign-in-status')).toContainText('Signed in as e2e@example.com', { timeout: 15_000 });

  await request.delete(`${BASE_URL}/api/mcp-servers/${id}`);
});

test('shows a refusal at the provider on the callback page and in Settings', async ({ page, request }) => {
  const id = await createServer(request, `OAuth deny ${randomUUID().slice(0, 8)}`);
  fixture.setDeny(true);
  try {
    await openServer(page, id);
    const signIn = page.getByTestId('mcp-sign-in');
    const [tab] = await Promise.all([page.context().waitForEvent('page'), signIn.getByRole('button', { name: 'Sign in…' }).click()]);
    await expect(tab.locator('body')).toContainText('The sign-in provider said: access_denied');
    await tab.close();
    await expect(signIn).toContainText('The sign-in provider said: access_denied', { timeout: 15_000 });
  } finally {
    fixture.setDeny(false);
    await request.delete(`${BASE_URL}/api/mcp-servers/${id}`);
  }
});
