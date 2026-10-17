import { expect, test, type Page } from '@playwright/test';
import type { CanonMessage } from '@otherbench/core/types/messages.js';
import { BASE_URL } from '../playwright.config.js';

/**
 * /clear in a chat: typed through the composer's / menu, it draws a "Context
 * cleared" line with the earlier messages still above it, and the next reply is
 * sent none of them. Sending /clear never starts Claude Code (the server writes
 * the line itself), so the Claude Code profile here is only ever selected for
 * that one message; the replies come from the keyless mock.
 *
 * The mock records no requests, so "carries none of the earlier text" is read
 * from the reply's recorded input tokens, which the mock counts as the words of
 * every text part in the request it was sent.
 */
const RUN = Math.random().toString(36).slice(2, 8);
const MOCK = `Clear mock ${RUN}`;
const CODE = `Clear code ${RUN}`;
const FIRST = `alpha${RUN} one two three four five six seven eight nine`;
const SECOND = `bravo${RUN} one two three four five six seven eight nine`;

async function chooseProfile(page: Page, name: string): Promise<void> {
  await page.getByRole('button', { name: /choose a profile|·/ }).click();
  await page.getByRole('option', { name: new RegExp(`^${name}`) }).click();
}

test('/clear from the menu cuts what the next reply is sent, and leaves the thread above it', async ({ page, request }) => {
  const mock = await request.post(`${BASE_URL}/api/connections`, { data: { name: `Mock ${RUN}`, kind: 'mock' } });
  const code = await request.post(`${BASE_URL}/api/connections`, { data: { name: `Claude Code ${RUN}`, kind: 'claude_code' } });
  expect(mock.ok() && code.ok()).toBeTruthy();
  const p1 = await request.post(`${BASE_URL}/api/profiles`, { data: { name: MOCK, connectionId: (await mock.json()).id, modelId: 'mock-standard' } });
  const p2 = await request.post(`${BASE_URL}/api/profiles`, { data: { name: CODE, connectionId: (await code.json()).id, modelId: 'claude-opus-5-5' } });
  expect(p1.ok() && p2.ok()).toBeTruthy();

  await page.goto('/');
  const known = new Set(((await (await request.get(`${BASE_URL}/api/chats`)).json()) as { id: string }[]).map((c) => c.id));
  await page.getByRole('button', { name: '+ New chat' }).click();
  const main = page.getByRole('main');
  const box = page.getByRole('textbox', { name: /message/i });
  // The outline in the strip names the line too, so the line is looked for in the thread itself.
  const thread = main.getByTestId('thread-scroll');

  await chooseProfile(page, MOCK);
  const replies = main.getByRole('article').filter({ hasText: /Here is a mock reply from OtherBench/ });
  for (const [i, text] of [FIRST, SECOND].entries()) {
    await box.fill(text);
    await box.press('Enter');
    await expect(replies).toHaveCount(i + 1, { timeout: 15_000 });
    await expect(page.getByLabel('streaming')).toHaveCount(0, { timeout: 15_000 });
  }

  // The menu is for Claude Code profiles only: not offered while the mock is selected.
  await box.fill('/');
  await expect(page.getByRole('listbox', { name: 'Commands' })).toHaveCount(0);

  await chooseProfile(page, CODE);
  await box.fill('/');
  const menu = page.getByRole('listbox', { name: 'Commands' });
  await expect(menu.getByRole('option', { name: /\/clear/ })).toBeVisible();
  await expect(menu.getByRole('option', { name: /\/compact/ })).toBeVisible();
  await box.press('Enter');
  // Filling the box does not send it.
  await expect(box).toHaveValue(/^\/clear/);
  await expect(main.getByText('Context cleared')).toHaveCount(0);
  await box.press('Enter');

  await expect(thread.getByText('Context cleared')).toBeVisible();
  await expect(main.getByText(FIRST)).toBeVisible();
  await expect(main.getByText(SECOND)).toBeVisible();

  await chooseProfile(page, MOCK);
  await box.fill('third');
  await box.press('Enter');
  await expect(replies).toHaveCount(3, { timeout: 15_000 });
  await expect(page.getByLabel('streaming')).toHaveCount(0, { timeout: 15_000 });

  let chatId = '';
  await expect
    .poll(async () => {
      const all = (await (await request.get(`${BASE_URL}/api/chats`)).json()) as { id: string }[];
      chatId = all.find((c) => !known.has(c.id))?.id ?? '';
      return chatId;
    })
    .not.toBe('');
  const body = (await (await request.get(`${BASE_URL}/api/chats/${chatId}/messages`)).json()) as {
    messages: CanonMessage[];
    headMessageId: string;
    usage: Record<string, { tokensIn: number }>;
  };
  const sent = body.messages.filter((m) => m.role === 'assistant');
  const last = sent[sent.length - 1]!;
  const first = sent[0]!;
  // Whatever the system prompt weighs, the first reply was sent that plus the ten words of FIRST, and the last that plus only "third".
  // Uncut it would carry both earlier messages and their replies as well.
  expect(body.usage[last.id]!.tokensIn).toBeLessThanOrEqual(body.usage[first.id]!.tokensIn - 5);
});
