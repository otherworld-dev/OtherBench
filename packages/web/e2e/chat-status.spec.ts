import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { BASE_URL } from '../playwright.config.js';

/**
 * The chat's status (spec 2026-11-15-chat-done-status-design) in a real
 * browser, on the keyless mock connection: `#status left a|b` and
 * `#status done` call the real set_chat_status tool, and the chat's row says
 * "2 left" (nothing for the user), "1 for you" with its ask shown in full, then "Done", then "Your turn" again
 * after a reply that doesn't set it. A "you" item with no ask is refused, so that reply sets no status.
 * Names are unique per test: the e2e server keeps one database.
 */

const suffix = (): string => randomUUID().slice(0, 8);

async function seed(request: APIRequestContext, title: string): Promise<{ chatId: string }> {
  const conn = await request.post(`${BASE_URL}/api/connections`, { data: { name: `Mock ${suffix()}`, kind: 'mock' } });
  expect(conn.ok()).toBeTruthy();
  const { id: connectionId } = (await conn.json()) as { id: string };
  const profile = await request.post(`${BASE_URL}/api/profiles`, {
    data: { name: `Status ${suffix()}`, connectionId, modelId: 'mock-standard', isDefault: true, toolPolicy: { fs: 'off', shell: false, mcpServerIds: [], approvalMode: 'always_ask' } },
  });
  expect(profile.ok()).toBeTruthy();
  const { id: profileId } = (await profile.json()) as { id: string };
  const chat = await request.post(`${BASE_URL}/api/chats`, { data: { title, profileId } });
  expect(chat.ok()).toBeTruthy();
  return { chatId: ((await chat.json()) as { id: string }).id };
}

async function send(page: Page, text: string): Promise<void> {
  const textbox = page.getByRole('textbox', { name: /message/i });
  await textbox.fill(text);
  await textbox.press('Enter');
  await expect(page.getByLabel('streaming')).toHaveCount(0, { timeout: 15_000 });
}

test('the agent marks the chat: N left, then Done, then Your turn after a reply that says nothing', async ({ page, request }) => {
  const title = `Status ${suffix()}`;
  const { chatId } = await seed(request, title);
  await page.goto('/');
  await page.getByRole('button', { name: title }).click();
  const word = page.getByRole('navigation', { name: 'Chats' }).getByTestId(`chat-status-${chatId}`);

  await send(page, '#status left me:push to github|parked:update the docs');
  await expect(word).toHaveText('2 left');
  await expect(word).toHaveAttribute('title', 'Next from me:\n  push to github\nParked:\n  update the docs');
  const card = page.locator('article[data-role="assistant"]').last().getByTestId('chat-status-card');
  await expect(card).toContainText('push to github');
  await expect(page.locator('article[data-role="assistant"]').last()).not.toContainText('set_chat_status');

  await send(page, '#status left you:try it live=Open the app and tell me if the sidebar loads|me:push to github|parked:dark mode');
  await expect(word).toHaveText('1 for you');
  await expect(word).toHaveAttribute('title', 'Waiting on you:\n  try it live\nNext from me:\n  push to github\nParked:\n  dark mode');
  const grouped = page.locator('article[data-role="assistant"]').last().getByTestId('chat-status-card');
  await expect(grouped.getByRole('list', { name: 'Waiting on you' })).toContainText('try it live');
  await expect(grouped.getByTestId('chat-status-ask')).toHaveText('Open the app and tell me if the sidebar loads');
  await expect(grouped.getByRole('list', { name: 'Parked' })).toContainText('dark mode');

  // Waiting on the user with nothing asked: refused, so this reply sets no status and the thread shows the failed call.
  await send(page, '#status left you:approve it');
  await expect(word).toHaveText('Your turn');
  await expect(page.locator('article[data-role="assistant"]').last()).toContainText('set_chat_status');

  await send(page, '#status left me:push to github');
  await expect(word).toHaveText('1 left');
  await expect(word).toHaveAttribute('data-for-you', '0');

  await send(page, '#status done');
  await expect(word).toHaveText('Done');
  await expect(word).toHaveAttribute('data-status', 'done');

  await send(page, 'anything else?');
  await expect(word).toHaveText('Your turn');
});
