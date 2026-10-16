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
  const knownChatIds = new Set(((await (await request.get(`${BASE_URL}/api/chats`)).json()) as { id: string }[]).map((c) => c.id));
  await page.getByRole('button', { name: '+ New chat' }).click();
  const thread = page.getByTestId('thread-scroll');
  const box = page.getByRole('textbox', { name: /message/i });
  await box.fill('first question');
  await box.press('Enter');
  let chatId = '';
  await expect
    .poll(async () => {
      const all = (await (await request.get(`${BASE_URL}/api/chats`)).json()) as { id: string }[];
      chatId = all.find((c) => !knownChatIds.has(c.id))?.id ?? '';
      return chatId;
    })
    .not.toBe('');

  // Two turns, so the first user message is genuinely "earlier".
  await expect(thread.getByText(/Here is a mock reply from OtherBench/)).toBeVisible();
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

  // --- The server's tree agrees, and it persisted the head on the regenerated tip.
  const messages = (await (await request.get(`${BASE_URL}/api/chats/${chatId}/messages`)).json()).messages as {
    id: string;
    role: string;
    parentId: string | null;
    parts: { type: string; text?: string }[];
    producedBy: { regenerated?: boolean } | null;
  }[];
  expect(messages.filter((m) => m.role === 'user')).toHaveLength(3); // first, second, edited first
  expect(messages.filter((m) => m.role === 'assistant')).toHaveLength(4); // 2 + regenerated + reply to the edit
  const second = messages.find((m) => m.parts.some((p) => p.text === 'second question'))!;
  const replies = messages.filter((m) => m.parentId === second.id);
  expect(replies).toHaveLength(2);
  expect(replies.filter((m) => m.producedBy?.regenerated)).toHaveLength(1);
  const chat = (await (await request.get(`${BASE_URL}/api/chats/${chatId}`)).json()) as { headMessageId: string };
  expect(chat.headMessageId).toBe(replies.find((m) => m.producedBy?.regenerated)!.id);
});

test('switching branches keeps a resolved compare choice, and the next message is parented on the branch tip', async ({ page, request }) => {
  const connections = (await (await request.get(`${BASE_URL}/api/connections`)).json()) as { id: string }[];
  const mockB = await request.post(`${BASE_URL}/api/profiles`, {
    data: { name: 'Mock B', connectionId: connections[0]!.id, modelId: 'mock-standard' },
  });
  expect(mockB.ok()).toBeTruthy();

  await page.goto('/');
  const knownChatIds = new Set(((await (await request.get(`${BASE_URL}/api/chats`)).json()) as { id: string }[]).map((c) => c.id));
  await page.getByRole('button', { name: '+ New chat' }).click();
  const thread = page.getByTestId('thread-scroll');
  const box = page.getByRole('textbox', { name: /message/i });
  const idle = async (): Promise<void> => expect(page.getByLabel('streaming')).toHaveCount(0);

  await box.fill('k1');
  await box.press('Enter');
  await expect(thread.getByText(/Here is a mock reply from OtherBench/)).toBeVisible();
  await idle();

  // k2 as a compare turn, keep B.
  await page.getByRole('button', { name: 'Compare', exact: true }).click();
  await page.getByRole('listbox', { name: 'Compare profiles' }).getByLabel('Mock B', { exact: true }).check();
  // Close the picker: left open it can cover the tab strip once other specs have added profiles.
  await page.getByRole('button', { name: 'Compare', exact: true }).click();
  await box.fill('k2');
  await box.press('Enter');
  await expect(page.getByTestId('variant-tabs')).toBeVisible();
  await idle();
  await page.locator('[data-testid^="variant-tab-"]').filter({ hasText: /^Mock B(?!\w)/ }).click();
  await page.getByRole('button', { name: /keep this one/i }).click();

  // k3 continues under the kept variant (single profile again: drop the compare partner).
  await page.getByRole('button', { name: 'Compare', exact: true }).click();
  await page.getByRole('listbox', { name: 'Compare profiles' }).getByLabel('Mock B', { exact: true }).uncheck();
  await page.getByRole('button', { name: 'Compare', exact: true }).click();
  await box.fill('k3');
  await box.press('Enter');
  await expect(thread.getByText('k3', { exact: true })).toBeVisible();
  await idle();

  // Regenerate the FIRST reply, switch back to the original branch, then send k4.
  await thread.locator('article[data-role="assistant"]').first().getByRole('button', { name: 'Regenerate' }).click();
  await idle();
  const firstReply = thread.locator('article[data-role="assistant"]').first();
  await expect(firstReply.getByTestId('branch-switcher')).toHaveText(/2 \/ 2/);
  await firstReply.getByRole('button', { name: 'Previous branch' }).click();

  // The old branch comes back whole: k2, the kept compare choice and k3.
  await expect(thread.getByText('k3', { exact: true })).toBeVisible();
  await expect(thread.getByText('k2', { exact: true })).toBeVisible();
  await expect(page.getByTestId('variant-tabs')).toHaveCount(0);

  await box.fill('k4');
  await box.press('Enter');
  await expect(thread.getByText('k4', { exact: true })).toBeVisible();
  await idle();

  const chatId = ((await (await request.get(`${BASE_URL}/api/chats`)).json()) as { id: string }[]).find((c) => !knownChatIds.has(c.id))!.id;
  const { messages } = (await (await request.get(`${BASE_URL}/api/chats/${chatId}/messages`)).json()) as {
    messages: { id: string; role: string; parentId: string | null; parts: { text?: string }[] }[];
  };
  const textOf = (m: { parts: { text?: string }[] }): string | undefined => m.parts[0]?.text;
  const k3 = messages.find((m) => textOf(m) === 'k3')!;
  const k3Reply = messages.find((m) => m.parentId === k3.id)!;
  const k4 = messages.find((m) => textOf(m) === 'k4')!;
  expect(k4.parentId).toBe(k3Reply.id); // not the compare turn's user message
  const k2 = messages.find((m) => textOf(m) === 'k2')!;
  expect(messages.filter((m) => m.parentId === k2.id)).toHaveLength(2); // still just the two compare variants
});
