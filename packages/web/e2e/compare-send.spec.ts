import { expect, test, type APIRequestContext } from '@playwright/test';
import type { CanonMessage } from '@grunt/core/types/messages.js';
import { BASE_URL } from '../playwright.config.js';

/**
 * Sending while a compare turn's tabs are still open (#821): the new message
 * continues from the tab on screen, instead of landing beside the replies as a
 * second user message in a row.
 */
// Unique per run: the e2e server keeps one database for the whole run, and
// other specs look profiles up by name.
const RUN = Math.random().toString(36).slice(2, 8);
const FIRST = `Sender first ${RUN}`;
const SECOND = `Sender second ${RUN}`;

async function seedProfiles(request: APIRequestContext): Promise<void> {
  const conn = await request.post(`${BASE_URL}/api/connections`, { data: { name: 'Mock', kind: 'mock' } });
  expect(conn.ok()).toBeTruthy();
  const { id: connectionId } = await conn.json();
  for (const [name, isDefault] of [[FIRST, true], [SECOND, false]] as const) {
    const profile = await request.post(`${BASE_URL}/api/profiles`, { data: { name, connectionId, modelId: 'mock-standard', isDefault } });
    expect(profile.ok()).toBeTruthy();
  }
}

test.beforeEach(async ({ request }) => {
  await seedProfiles(request);
});

test('sending with compare tabs open continues from the tab on screen', async ({ page, request }) => {
  await page.goto('/');
  const knownChatIds = new Set(((await (await request.get(`${BASE_URL}/api/chats`)).json()) as { id: string }[]).map((c) => c.id));
  await page.getByRole('button', { name: '+ New chat' }).click();
  const main = page.getByRole('main');
  const box = page.getByRole('textbox', { name: /message/i });

  await page.getByRole('button', { name: '+ Compare' }).click();
  await page.getByRole('checkbox', { name: SECOND, exact: true }).check();
  await page.getByRole('button', { name: '+ Compare' }).click();
  await box.fill('compare these');
  await box.press('Enter');

  const tabs = main.getByRole('tablist', { name: 'Compare variants' }).getByRole('tab');
  await expect(tabs).toHaveCount(2);
  await expect(page.getByLabel('streaming')).toHaveCount(0, { timeout: 15_000 });

  let chatId = '';
  await expect
    .poll(async () => {
      const all = (await (await request.get(`${BASE_URL}/api/chats`)).json()) as { id: string }[];
      chatId = all.find((c) => !knownChatIds.has(c.id))?.id ?? '';
      return chatId;
    })
    .not.toBe('');

  // #819: the tabs' token counts come back after a reload (from the server's recorded usage), not "…".
  await expect(tabs.first()).toContainText(/\d tok/);
  await page.reload();
  await page.getByTestId(`chat-row-${chatId}`).locator('[data-row-main]').click();
  await expect(tabs).toHaveCount(2);
  await expect(tabs.first()).toContainText(/\d tok/);
  await expect(tabs.nth(1)).toContainText(/\d tok/);

  await main.getByRole('tab', { name: new RegExp(`^${SECOND}`) }).click();
  await expect(page.getByText(`continues from ${SECOND}'s reply`, { exact: false })).toBeVisible();

  await box.fill('follow up');
  await box.press('Enter');
  await expect(page.getByLabel('streaming')).toHaveCount(0, { timeout: 15_000 });

  const { messages } = (await (await request.get(`${BASE_URL}/api/chats/${chatId}/messages`)).json()) as { messages: CanonMessage[] };
  const text = (m: CanonMessage) => m.parts.map((p) => (p.type === 'text' ? p.text : '')).join('');
  const followUp = messages.find((m) => m.role === 'user' && text(m) === 'follow up')!;
  const parent = messages.find((m) => m.id === followUp.parentId)!;
  expect(parent.role).toBe('assistant');
  expect(parent.producedBy?.profileName).toBe(SECOND);

  // On screen: the first turn now reads as the second profile's reply, with a chip for the first's.
  await expect(main.getByTestId('reopen-variants-chip').first()).toContainText('1 other variant');
});
