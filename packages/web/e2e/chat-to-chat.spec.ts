import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { BASE_URL } from '../playwright.config.js';

/**
 * Chats that message each other (spec 2026-11-06-chat-to-chat-design): the
 * Mock model's `#send <chatId> <text>` sends work to another chat through the
 * real `message_chats` tool. The first send in a chat gets one card, and
 * "Allow for this chat" covers the rest. The other chat starts by itself, and
 * its reply comes back to the sender as a "Replies from" message that starts
 * the sender's next reply.
 */

async function twoChats(request: APIRequestContext): Promise<{ sender: string; target: string; targetTitle: string }> {
  const suffix = randomUUID().slice(0, 8);
  const conn = await request.post(`${BASE_URL}/api/connections`, { data: { name: `Mock ${suffix}`, kind: 'mock' } });
  const { id: connectionId } = await conn.json();
  const profile = await request.post(`${BASE_URL}/api/profiles`, {
    data: { name: `Chat2Chat ${suffix}`, connectionId, modelId: 'mock-standard', isDefault: true, toolPolicy: { fs: 'off', shell: false, mcpServerIds: [], approvalMode: 'always_ask' } },
  });
  const { id: profileId } = await profile.json();
  const ids: string[] = [];
  const targetTitle = `Chat2Chat target - ${suffix}`;
  for (const title of [`Chat2Chat sender - ${suffix}`, targetTitle]) {
    const res = await request.post(`${BASE_URL}/api/chats`, { data: { title, profileId, workspaceRoot: null } });
    expect(res.ok()).toBeTruthy();
    ids.push(((await res.json()) as { id: string }).id);
  }
  return { sender: ids[0]!, target: ids[1]!, targetTitle };
}

async function send(page: Page, chatId: string, text: string): Promise<void> {
  await page.getByTestId(`chat-row-${chatId}`).locator('[data-row-main]').click();
  const textbox = page.getByRole('textbox', { name: /message/i });
  await textbox.fill(text);
  await textbox.press('Enter');
}

test('a chat sends work to another chat, which starts by itself, and its reply comes back after one card', async ({ page, request }) => {
  const { sender, target, targetTitle } = await twoChats(request);
  await page.goto('/');

  await send(page, sender, `#send ${target} say hello`);
  const card = page.getByRole('alert').filter({ hasText: 'Let this chat send work to other chats' });
  await expect(card.getByRole('button', { name: /^Always/ })).toHaveCount(0);
  await card.getByRole('button', { name: 'Allow for this chat' }).click();

  // The target ran on its own and its reply came back: the sender has a "Replies from" message and a reply to it.
  await expect(page.getByTestId('chat-link').filter({ hasText: `Replies from ${targetTitle}` })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByLabel('streaming')).toHaveCount(0);
  await expect(page.getByTestId('chat-send-row').first()).toContainText('Replied');

  // The target shows who sent it.
  const sends = (await (await request.get(`${BASE_URL}/api/chats/${target}/sends`)).json()) as { sends: { status: string }[] };
  expect(sends.sends.map((s) => s.status)).toEqual(['replied']);

  // A second send in the same chat needs no card.
  await send(page, sender, `#send ${target} again`);
  await expect(page.getByTestId('chat-link').filter({ hasText: `Replies from ${targetTitle}` })).toHaveCount(2, { timeout: 20_000 });
  await expect(page.getByRole('button', { name: 'Allow for this chat' })).toHaveCount(0);
});
