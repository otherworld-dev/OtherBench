import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { BASE_URL } from '../playwright.config.js';

/**
 * Recall (spec 2026-10-09-recall-design): the Mock model's `#recall <query>`
 * searches past chats through the real tool and names what it found. The
 * first call in a chat gets a card, and "Allow for this chat" covers the
 * rest; a profile with Search past chats off isn't offered the tool.
 *
 * A chat is retitled from its first reply (auto-title) shortly after that
 * reply finishes, so chats are found by id, never by title, and recall's
 * answer is checked against the old chat's title once that has settled.
 */

/** A Mock profile and two chats under it; returns their ids. */
async function mockChats(request: APIRequestContext, recall: boolean): Promise<{ old: string; asking: string }> {
  const suffix = randomUUID().slice(0, 8);
  const conn = await request.post(`${BASE_URL}/api/connections`, { data: { name: `Mock ${suffix}`, kind: 'mock' } });
  const { id: connectionId } = await conn.json();
  const profile = await request.post(`${BASE_URL}/api/profiles`, {
    data: { name: `Recall ${suffix}`, connectionId, modelId: 'mock-standard', isDefault: true, toolPolicy: { fs: 'off', shell: false, mcpServerIds: [], approvalMode: 'always_ask', recall } },
  });
  const { id: profileId } = await profile.json();
  const old = `Recall E2E old - ${suffix}`;
  const asking = `Recall E2E asking - ${suffix}`;
  const ids: string[] = [];
  for (const title of [old, asking]) {
    const res = await request.post(`${BASE_URL}/api/chats`, { data: { title, profileId, workspaceRoot: null } });
    expect(res.ok()).toBeTruthy();
    ids.push(((await res.json()) as { id: string }).id);
  }
  return { old: ids[0]!, asking: ids[1]! };
}

/** The chat's title once its auto-title (from the first reply) has replaced the one it was created with. */
async function settledTitle(request: APIRequestContext, chatId: string, created: string): Promise<string> {
  let title = created;
  await expect
    .poll(async () => {
      const chats = (await (await request.get(`${BASE_URL}/api/chats`)).json()) as { id: string; title: string }[];
      title = chats.find((c) => c.id === chatId)?.title ?? created;
      return title;
    })
    .not.toBe(created);
  return title;
}

async function send(page: Page, chatId: string, text: string, waitForReply = true): Promise<void> {
  await page.getByTestId(`chat-row-${chatId}`).locator('[data-row-main]').click();
  const textbox = page.getByRole('textbox', { name: /message/i });
  await textbox.fill(text);
  await textbox.press('Enter');
  if (waitForReply) await expect(page.getByLabel('streaming')).toHaveCount(0);
}

test('the model finds an earlier chat by what was said in it, after one card for the chat', async ({ page, request }) => {
  const word = `zebrafish${randomUUID().slice(0, 6)}`;
  const { old, asking } = await mockChats(request, true);
  await page.goto('/');
  const created = (await (await request.get(`${BASE_URL}/api/chats/${old}`)).json()) as { title: string };
  await send(page, old, `The staging host is called ${word}.`);
  const oldTitle = await settledTitle(request, old, created.title);

  await send(page, asking, `#recall ${word}`, false);
  const card = page.getByRole('alert').filter({ hasText: `Search past chats for "${word}"` });
  await card.getByRole('button', { name: 'Allow for this chat' }).click();
  await expect(page.getByLabel('streaming')).toHaveCount(0);
  await expect(page.getByText(`I found: ${oldTitle}.`)).toBeVisible();

  await send(page, asking, `#recall ${word} host`);
  await expect(page.getByText(`I found: ${oldTitle}.`)).toHaveCount(2);
  await expect(page.getByRole('button', { name: 'Allow once' })).toHaveCount(0);
});

test('a profile with Search past chats off is not offered the tool', async ({ page, request }) => {
  const { asking } = await mockChats(request, false);
  await page.goto('/');
  await send(page, asking, '#recall anything');

  // In the reply itself: the chat (and earlier ones like it) may already be titled after it.
  await expect(page.locator('article[data-role="assistant"]').getByText(/Recall didn't work/).last()).toBeVisible();
});
