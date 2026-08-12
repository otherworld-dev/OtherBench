import { expect, test } from '@playwright/test';
import { BASE_URL } from '../playwright.config.js';

/**
 * End-to-end verification (task 19/20 brief, decision #5): builds nothing
 * itself -- `playwright.config.ts`'s `webServer` starts the already-built
 * `grunt serve` against a scratch database -- and drives the real browser
 * app against it, using the keyless mock provider (`ConnectionKind:
 * 'mock'`, packages/engine-aisdk/src/mock-provider.ts) so no API key or
 * network access is required. Seeds one connection + one default profile
 * via the real HTTP API before each test, mirroring exactly what a user
 * would do via Settings (not built yet) rather than reaching into the
 * database directly.
 */
async function seedMockProfile(request: import('@playwright/test').APIRequestContext): Promise<void> {
  const conn = await request.post(`${BASE_URL}/api/connections`, { data: { name: 'Mock', kind: 'mock' } });
  expect(conn.ok()).toBeTruthy();
  const { id: connectionId } = await conn.json();

  const profile = await request.post(`${BASE_URL}/api/profiles`, {
    data: { name: 'Mock Profile', connectionId, modelId: 'mock-standard', isDefault: true },
  });
  expect(profile.ok()).toBeTruthy();
}

test.beforeEach(async ({ request }) => {
  await seedMockProfile(request);
});

test('creating a chat, sending a message, and watching it stream in', async ({ page }) => {
  await page.goto('/');

  await page.getByRole('button', { name: '+ New chat' }).click();

  const textbox = page.getByRole('textbox', { name: /message/i });
  await expect(textbox).toBeVisible();
  await textbox.fill('Hello from Playwright');
  await textbox.press('Enter');

  // The user's own message renders immediately (optimistic local stub).
  await expect(page.getByText('Hello from Playwright')).toBeVisible();

  // The mock provider's canned reply streams in over several chunks;
  // asserting on it proves text actually arrived over the live SSE
  // connection, not just that the turn was created.
  await expect(page.getByText(/Here is a mock reply from Grunt/)).toBeVisible();

  // And the turn reaches a terminal state -- the streaming caret goes away.
  await expect(page.getByLabel('streaming')).toHaveCount(0);
});

test('#slow renders progressively, chunk by chunk, before completing', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '+ New chat' }).click();

  const textbox = page.getByRole('textbox', { name: /message/i });
  await textbox.fill('#slow');
  await textbox.press('Enter');

  // Still streaming, and only part of the 20-word reply has arrived yet
  // (chunks land one per 400ms; the full reply takes ~8s). Waiting for the
  // body to become non-empty (rather than a fixed sleep) lands this
  // assertion right after the first chunk or two.
  await expect(page.getByLabel('streaming')).toBeVisible();
  const partial = page.locator('article[data-role="assistant"] .markdown-body');
  await expect(partial).not.toHaveText('');
  const partialText = (await partial.innerText()).trim();
  expect(partialText.length).toBeGreaterThan(0);
  expect(partialText).not.toContain('smoothly across chat pane now'); // the reply's last words

  // Eventually the full reply lands and the turn completes.
  await expect(page.getByText(/smoothly across chat pane now/)).toBeVisible();
  await expect(page.getByLabel('streaming')).toHaveCount(0);
});

test('#fail surfaces an error state instead of hanging', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '+ New chat' }).click();

  const textbox = page.getByRole('textbox', { name: /message/i });
  await textbox.fill('#fail');
  await textbox.press('Enter');

  await expect(page.locator('article[data-role="assistant"][data-status="error"]')).toBeVisible();
  await expect(page.getByText(/simulated rate limit/)).toBeVisible();
});
