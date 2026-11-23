import { expect, test } from '@playwright/test';
import { BASE_URL } from '../playwright.config.js';

/** A click on a chat, in the sidebar or on its tab, leaves the cursor in that chat's message box. */
test('clicking a chat puts the cursor in its message box', async ({ page, request }) => {
  const conn = await request.post(`${BASE_URL}/api/connections`, { data: { name: 'Click focus', kind: 'claude_code' } });
  expect(conn.ok()).toBeTruthy();
  const profile = await request.post(`${BASE_URL}/api/profiles`, { data: { name: 'Click focus', connectionId: (await conn.json()).id, modelId: 'claude-opus-5-5' } });
  expect(profile.ok()).toBeTruthy();
  const profileId = (await profile.json()).id;
  const ids: string[] = [];
  for (const title of ['Click focus one', 'Click focus two']) {
    const chat = await request.post(`${BASE_URL}/api/chats`, { data: { profileId, title } });
    ids.push((await chat.json()).id);
  }
  const [one, two] = ids as [string, string];
  const row = (id: string) => page.getByTestId(`chat-row-${id}`).getByRole('button').first();
  const box = page.locator('[data-composer-box] textarea');

  await page.goto('/');
  await row(one).click();
  await expect(box).toBeFocused();
  await page.keyboard.type('for one');
  await expect(box).toHaveValue('for one');

  // Another chat: its own box, not the row just clicked.
  await row(two).click();
  await expect(box).toBeFocused();
  await expect(box).toHaveValue('');

  // The chat already on show, clicked again from somewhere else.
  await page.getByRole('searchbox', { name: 'Search chats' }).focus();
  await row(two).click();
  await expect(box).toBeFocused();

  // Enter on a row opens the chat and stays in the list.
  await row(one).focus();
  await page.keyboard.press('Enter');
  await expect(row(one)).toHaveAttribute('aria-current', 'true');
  await expect(row(one)).toBeFocused();
});
