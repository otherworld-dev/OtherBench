import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { BASE_URL, SITE_URL } from '../playwright.config.js';

/**
 * The model's browser (spec 2026-10-12-model-browser-design): the Mock
 * model's `#browser <url>` opens a page through the real tool on a loopback
 * fixture site. One card names the site; "Allow for this chat" covers it for
 * the rest of the chat; the viewer shows the page live and takes clicks; Close empties it.
 * Needs a Chromium Playwright can start (the same one this suite uses).
 */

async function browserChat(request: APIRequestContext): Promise<string> {
  const suffix = randomUUID().slice(0, 8);
  const conn = await request.post(`${BASE_URL}/api/connections`, { data: { name: `Mock ${suffix}`, kind: 'mock' } });
  const { id: connectionId } = await conn.json();
  const profile = await request.post(`${BASE_URL}/api/profiles`, {
    data: { name: `Browser ${suffix}`, connectionId, modelId: 'mock-standard', isDefault: true, toolPolicy: { fs: 'off', shell: false, mcpServerIds: [], approvalMode: 'always_ask', browser: true } },
  });
  const { id: profileId } = await profile.json();
  const chat = await request.post(`${BASE_URL}/api/chats`, { data: { title: `Browser E2E ${suffix}`, profileId, workspaceRoot: null } });
  expect(chat.ok()).toBeTruthy();
  return ((await chat.json()) as { id: string }).id;
}

test('when the model hands over, a click in the panel reaches the page and the model carries on from there', async ({ page, request }) => {
  test.setTimeout(90_000);
  const chatId = await browserChat(request);
  await page.goto('/');

  await send(page, chatId, `#browser ${SITE_URL}/check handover`);
  const allow = page.getByRole('alert').filter({ hasText: 'Let the model use 127.0.0.1?' });
  await expect(allow).toBeVisible();
  await allow.getByRole('button', { name: 'Allow for this chat' }).click();

  const card = page.getByRole('group', { name: /needs you in the browser/ });
  await expect(card).toBeVisible({ timeout: 30_000 });
  await expect(card).toContainText('Please click the page to prove you are human.');
  // Headless here, so the card points at the panel and there's no window to show.
  await expect(card).toContainText('Use the Browser panel here.');
  await expect(page.getByRole('button', { name: 'Show window' })).toHaveCount(0);

  const live = page.getByRole('img', { name: "Live view of the model's browser" });
  await expect(live).toHaveAttribute('src', /^data:image\/jpeg;base64,/, { timeout: 30_000 });
  await live.click();
  await card.getByRole('button', { name: "I'm done" }).click();

  await expect(page.getByText('The page says: Cleared by hand.')).toBeVisible({ timeout: 30_000 });
  await expect(card).toHaveCount(0);
});

async function send(page: Page, chatId: string, text: string): Promise<void> {
  await page.getByTestId(`chat-row-${chatId}`).locator('[data-row-main]').click();
  const textbox = page.getByRole('textbox', { name: /message/i });
  await textbox.fill(text);
  await textbox.press('Enter');
}

test('the model opens a page after one card for its site, the viewer shows it live, and the site is remembered for the chat', async ({ page, request }) => {
  test.setTimeout(90_000);
  const chatId = await browserChat(request);
  await page.goto('/');

  await send(page, chatId, `#browser ${SITE_URL}/`);
  const card = page.getByRole('alert').filter({ hasText: 'Let the model use 127.0.0.1?' });
  await expect(card).toBeVisible();
  await card.getByRole('button', { name: 'Allow for this chat' }).click();

  const live = page.getByRole('img', { name: "Live view of the model's browser" });
  await expect(live).toHaveAttribute('src', /^data:image\/jpeg;base64,/, { timeout: 30_000 });
  await expect(page.getByLabel('streaming')).toHaveCount(0, { timeout: 30_000 });
  await expect(page.getByText('The page says: Fixture heading.')).toBeVisible();

  await send(page, chatId, `#browser ${SITE_URL}/`);
  await expect(page.getByLabel('streaming')).toHaveCount(0, { timeout: 30_000 });
  await expect(page.getByText('The page says: Fixture heading.')).toHaveCount(2);
  await expect(page.getByRole('button', { name: 'Allow once' })).toHaveCount(0);

  await page.getByRole('button', { name: 'Close browser' }).click();
  await expect(page.getByText("The model hasn't opened a page in this chat.")).toBeVisible();
});
