import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { BASE_URL } from '../playwright.config.js';

/**
 * Recall (spec 2026-10-09-recall-design): the Mock model's `#recall <query>`
 * searches past chats through the real tool and names what it found. The
 * first call in a chat gets a card, and "Allow for this chat" covers the
 * rest; a profile with Search past chats off isn't offered the tool.
 */

/** A Mock profile and two chats under it; returns their titles. */
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
  for (const title of [old, asking]) {
    expect((await request.post(`${BASE_URL}/api/chats`, { data: { title, profileId, workspaceRoot: null } })).ok()).toBeTruthy();
  }
  return { old, asking };
}

async function send(page: Page, chat: string, text: string, waitForReply = true): Promise<void> {
  await page.getByRole('button', { name: chat }).click();
  const textbox = page.getByRole('textbox', { name: /message/i });
  await textbox.fill(text);
  await textbox.press('Enter');
  if (waitForReply) await expect(page.getByLabel('streaming')).toHaveCount(0);
}

test('the model finds an earlier chat by what was said in it, after one card for the chat', async ({ page, request }) => {
  const word = `zebrafish${randomUUID().slice(0, 6)}`;
  const { old, asking } = await mockChats(request, true);
  await page.goto('/');
  await send(page, old, `The staging host is called ${word}.`);

  await send(page, asking, `#recall ${word}`, false);
  const card = page.getByRole('alert').filter({ hasText: `Search past chats for "${word}"` });
  await card.getByRole('button', { name: 'Allow for this chat' }).click();
  await expect(page.getByLabel('streaming')).toHaveCount(0);
  await expect(page.getByText(`I found: ${old}.`)).toBeVisible();

  await send(page, asking, `#recall ${word} host`);
  await expect(page.getByText(`I found: ${old}.`)).toHaveCount(2);
  await expect(page.getByRole('button', { name: 'Allow once' })).toHaveCount(0);
});

test('a profile with Search past chats off is not offered the tool', async ({ page, request }) => {
  const { asking } = await mockChats(request, false);
  await page.goto('/');
  await send(page, asking, '#recall anything');

  await expect(page.getByText(/Recall didn't work/)).toBeVisible();
});
