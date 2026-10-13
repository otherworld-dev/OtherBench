import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { BASE_URL } from '../playwright.config.js';

/**
 * A reply that finishes in a chat the user isn't looking at marks its row in
 * the sidebar, and opening the chat clears the mark, here and on the server.
 */
test('a reply finished in another chat marks its row until the chat is opened', async ({ page, request }) => {
  const conn = await request.post(`${BASE_URL}/api/connections`, { data: { name: 'Mock', kind: 'mock' } });
  const { id: connectionId } = await conn.json();
  const profile = (await (await request.post(`${BASE_URL}/api/profiles`, { data: { name: 'Mock Profile', connectionId, modelId: 'mock-standard' } })).json()) as { id: string };
  const suffix = randomUUID().slice(0, 8);
  const open = (await (await request.post(`${BASE_URL}/api/chats`, { data: { profileId: profile.id, title: `Open ${suffix}` } })).json()) as { id: string };
  const other = (await (await request.post(`${BASE_URL}/api/chats`, { data: { profileId: profile.id, title: `Other ${suffix}` } })).json()) as { id: string };

  await page.goto('/');
  const nav = page.getByRole('navigation', { name: 'Chats' });
  await nav.getByTestId(`chat-row-${open.id}`).click();

  // Another window sends a turn in the chat that isn't open here.
  const sent = await request.post(`${BASE_URL}/api/chats/${other.id}/turns`, {
    data: { parentId: null, parts: [{ type: 'text', text: 'while you were away' }], profileIds: [profile.id] },
  });
  expect(sent.status()).toBe(202);

  const dot = nav.getByTestId(`chat-status-${other.id}`);
  await expect(dot).toHaveAttribute('data-status', 'ready');
  await expect(dot).toHaveAccessibleName('reply ready');
  await expect(nav.getByTestId(`chat-status-${open.id}`)).toHaveCount(0);

  // By the row, not its title: auto-title renames the chat after its first reply.
  await nav.getByTestId(`chat-row-${other.id}`).locator('[data-row-main]').click();
  await expect(dot).toHaveCount(0);
  await expect.poll(async () => ((await (await request.get(`${BASE_URL}/api/chats/${other.id}`)).json()) as { unread: boolean }).unread).toBe(false);
});
