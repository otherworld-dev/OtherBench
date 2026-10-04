import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { BASE_URL } from '../playwright.config.js';

/**
 * The app-wide event stream (v2 plan, Task 34): a change made elsewhere (here
 * straight through the API, as another window or the tray would) reaches an
 * open page without a reload.
 */
test('a chat created, renamed and deleted elsewhere updates the open sidebar live', async ({ page, request }) => {
  const conn = await request.post(`${BASE_URL}/api/connections`, { data: { name: 'Mock', kind: 'mock' } });
  const { id: connectionId } = await conn.json();
  const profile = (await (await request.post(`${BASE_URL}/api/profiles`, { data: { name: 'Mock Profile', connectionId, modelId: 'mock-standard' } })).json()) as { id: string };

  await page.goto('/');
  const nav = page.getByRole('navigation', { name: 'Chats' });
  await expect(nav).toBeVisible();

  const title = `From elsewhere ${randomUUID().slice(0, 8)}`;
  const chat = (await (await request.post(`${BASE_URL}/api/chats`, { data: { profileId: profile.id, title } })).json()) as { id: string };
  await expect(nav.getByTestId(`chat-row-${chat.id}`)).toContainText(title);

  await request.patch(`${BASE_URL}/api/chats/${chat.id}`, { data: { title: `${title} renamed` } });
  await expect(nav.getByTestId(`chat-row-${chat.id}`)).toContainText(`${title} renamed`);

  await request.delete(`${BASE_URL}/api/chats/${chat.id}`);
  await expect(nav.getByTestId(`chat-row-${chat.id}`)).toHaveCount(0);
});
