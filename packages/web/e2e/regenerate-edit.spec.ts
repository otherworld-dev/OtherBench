import { expect, test, type APIRequestContext } from '@playwright/test';
import { BASE_URL } from '../playwright.config.js';

/**
 * Regenerate, edit and the branch switcher against the real server with the
 * keyless mock provider. The mock's reply text is the same every time, so
 * branches are told apart by the user text, the `‹ n / m ›` switcher and the
 * message tree the server holds.
 */
async function seedMockProfile(request: APIRequestContext): Promise<void> {
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

test('send, regenerate, switch back, edit an earlier message, switch back', async ({ page, request }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '+ New chat' }).click();
  const thread = page.getByTestId('thread-scroll');
  const box = page.getByRole('textbox', { name: /message/i });

  // Two turns, so the first user message is genuinely "earlier".
  await box.fill('first question');
  await box.press('Enter');
  await expect(thread.getByText(/Here is a mock reply from Grunt/)).toBeVisible();
  await expect(page.getByLabel('streaming')).toHaveCount(0);
  await box.fill('second question');
  await box.press('Enter');
  await expect(thread.locator('article[data-role="assistant"]')).toHaveCount(2);
  await expect(page.getByLabel('streaming')).toHaveCount(0);

  // --- Regenerate the last reply: a sibling appears, not a duplicate user message.
  await thread.locator('article[data-role="assistant"]').last().getByRole('button', { name: 'Regenerate' }).click();
  const lastReply = thread.locator('article[data-role="assistant"]').last();
  await expect(lastReply.getByTestId('branch-switcher')).toHaveText(/2 \/ 2/);
  await expect(page.getByLabel('streaming')).toHaveCount(0);
  await expect(thread.locator('article[data-role="assistant"]')).toHaveCount(2); // still two turns on screen
  await expect(thread.locator('article[data-role="user"]')).toHaveCount(2);
  await expect(page.getByTestId('variant-tabs')).toHaveCount(0); // not mistaken for a compare turn

  // --- Switch back to the original reply and forward again.
  await lastReply.getByRole('button', { name: 'Previous branch' }).click();
  await expect(lastReply.getByTestId('branch-switcher')).toHaveText(/1 \/ 2/);
  await lastReply.getByRole('button', { name: 'Next branch' }).click();
  await expect(lastReply.getByTestId('branch-switcher')).toHaveText(/2 \/ 2/);

  // --- Edit the FIRST user message: a new branch from the root, with its own reply.
  await thread.locator('article[data-role="user"]').first().getByRole('button', { name: 'Edit' }).click();
  const editor = page.getByRole('textbox', { name: 'Edit message' });
  await expect(editor).toHaveValue('first question');
  await editor.fill('first question, reworded');
  await page.getByRole('button', { name: 'Save and send' }).click();

  const firstUser = thread.locator('article[data-role="user"]').first();
  await expect(firstUser).toContainText('first question, reworded');
  await expect(firstUser.getByTestId('branch-switcher')).toHaveText(/2 \/ 2/);
  await expect(page.getByLabel('streaming')).toHaveCount(0);
  // The edited branch is a fresh conversation: one user message and its reply.
  await expect(thread.locator('article[data-role="user"]')).toHaveCount(1);
  await expect(thread.locator('article[data-role="assistant"]')).toHaveCount(1);
  await expect(thread.getByText('second question')).toHaveCount(0);

  // --- Switch back to the original: the whole old conversation, regenerated tip included.
  await firstUser.getByRole('button', { name: 'Previous branch' }).click();
  await expect(thread.getByText('second question')).toBeVisible();
  await expect(thread.getByText('first question', { exact: true })).toBeVisible();
  await expect(thread.locator('article[data-role="assistant"]')).toHaveCount(2);
  await expect(thread.locator('article[data-role="assistant"]').last().getByTestId('branch-switcher')).toHaveText(/2 \/ 2/);

  // --- The server's tree agrees, and the head survives a reload.
  await page.reload();
  await page.getByRole('navigation', { name: 'Chats' }).getByRole('button', { name: /mock reply/ }).click();
  await expect(thread.getByText('second question')).toBeVisible();
  const chats = (await (await request.get(`${BASE_URL}/api/chats`)).json()) as { id: string }[];
  const chatId = chats[0]!.id;
  const { messages } = (await (await request.get(`${BASE_URL}/api/chats/${chatId}/messages`)).json()) as {
    messages: { id: string; role: string; parentId: string | null }[];
  };
  expect(messages.filter((m) => m.role === 'user')).toHaveLength(3); // first, second, edited first
  expect(messages.filter((m) => m.role === 'assistant')).toHaveLength(4); // 2 + regenerated + reply to the edit
});
