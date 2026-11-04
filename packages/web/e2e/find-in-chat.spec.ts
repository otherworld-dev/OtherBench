import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext } from '@playwright/test';
import { BASE_URL } from '../playwright.config.js';

/**
 * Find in a chat: the thread draws only its last 40 messages, so the browser's own find can't reach the start of a
 * long chat. Ctrl+F in the chat opens its own find bar, which finds a message that isn't drawn, draws back to it,
 * scrolls to it and highlights the match. Ctrl+F outside a chat is left to the browser.
 */

interface Turn {
  userMessageId: string;
  assistantMessageIds: string[];
}

/** Sends one turn and waits for its reply to finish, so the next can follow it. */
async function sendTurn(request: APIRequestContext, chatId: string, parentId: string | null, profileId: string, text: string): Promise<Turn> {
  const res = await request.post(`${BASE_URL}/api/chats/${chatId}/turns`, { data: { parentId, parts: [{ type: 'text', text }], profileIds: [profileId] } });
  expect(res.status()).toBe(202);
  const turn = (await res.json()) as Turn;
  const replyId = turn.assistantMessageIds[0]!;
  await expect
    .poll(async () => {
      const { messages } = (await (await request.get(`${BASE_URL}/api/chats/${chatId}/messages`)).json()) as { messages: { id: string; status: string }[] };
      return messages.find((m) => m.id === replyId)?.status;
    })
    .toBe('complete');
  return turn;
}

test('Ctrl+F in a chat finds a message that is not drawn, and leaves the browser its own find elsewhere', async ({ page, request }) => {
  test.setTimeout(120_000);
  const suffix = randomUUID().slice(0, 8);
  const conn = await request.post(`${BASE_URL}/api/connections`, { data: { name: `Mock ${suffix}`, kind: 'mock' } });
  const { id: connectionId } = (await conn.json()) as { id: string };
  const profile = (await (await request.post(`${BASE_URL}/api/profiles`, { data: { name: `Find ${suffix}`, connectionId, modelId: 'mock-standard' } })).json()) as { id: string };
  const chat = (await (await request.post(`${BASE_URL}/api/chats`, { data: { profileId: profile.id, title: `Find ${suffix}` } })).json()) as { id: string };

  // 22 turns, 44 messages: the first turn, the only one with the word, is past the 40 the thread draws.
  const first = await sendTurn(request, chat.id, null, profile.id, 'where did the zebracorn go?');
  let parent = first.assistantMessageIds[0]!;
  for (let i = 1; i < 22; i++) parent = (await sendTurn(request, chat.id, parent, profile.id, `turn ${i}`)).assistantMessageIds[0]!;

  await page.goto('/');
  const nav = page.getByRole('navigation', { name: 'Chats' });
  // By the row, not its title: auto-title renames the chat after its first reply.
  await nav.getByTestId(`chat-row-${chat.id}`).locator('[data-row-main]').click();
  const thread = page.getByTestId('thread-scroll');
  await expect(thread.getByText('turn 21')).toBeVisible();
  const target = page.locator(`[id="msg-${first.userMessageId}"]`);
  await expect(target).toHaveCount(0);

  // Ctrl+F outside a chat stays the browser's: nothing takes it, and no find bar opens.
  await page.evaluate(() => {
    const w = window as unknown as { findPrevented?: boolean };
    window.addEventListener('keydown', (e) => {
      if (e.key === 'f') w.findPrevented = e.defaultPrevented;
    });
  });
  await nav.focus();
  await page.keyboard.press('Control+f');
  expect(await page.evaluate(() => (window as unknown as { findPrevented?: boolean }).findPrevented)).toBe(false);
  await expect(page.getByRole('textbox', { name: 'Find in this chat' })).toHaveCount(0);

  // In the chat: a click on its text, then Ctrl+F.
  await thread.getByText('turn 21').click();
  await page.keyboard.press('Control+f');
  expect(await page.evaluate(() => (window as unknown as { findPrevented?: boolean }).findPrevented)).toBe(true);
  const box = page.getByRole('textbox', { name: 'Find in this chat' });
  await expect(box).toBeFocused();
  await box.fill('zebracorn');
  await expect(page.getByRole('status', { name: 'Matches' })).toHaveText('1 of 1');
  await expect(target).toBeInViewport();
  const highlighted = () => page.evaluate(() => Array.from(CSS.highlights.get('chat-find') ?? [], (r) => r.toString()));
  expect(await highlighted()).toEqual(['zebracorn']);

  // Every message is searched, drawn or not: each user message has "turn", 21 of them.
  await box.fill('turn ');
  await expect(page.getByRole('status', { name: 'Matches' })).toHaveText(/ of 21$/);
  await box.press('Escape');
  await expect(box).toHaveCount(0);
  expect(await highlighted()).toEqual([]);
});
