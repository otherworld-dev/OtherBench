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

test('Ctrl+F finds text inside folded pastes, drawn or not, and draws only the messages round one far back', async ({ page, request }) => {
  test.setTimeout(240_000);
  const suffix = randomUUID().slice(0, 8);
  const conn = await request.post(`${BASE_URL}/api/connections`, { data: { name: `Mock ${suffix}`, kind: 'mock' } });
  const { id: connectionId } = (await conn.json()) as { id: string };
  const profile = (await (await request.post(`${BASE_URL}/api/profiles`, { data: { name: `Paste ${suffix}`, connectionId, modelId: 'mock-standard' } })).json()) as { id: string };
  const chat = (await (await request.post(`${BASE_URL}/api/chats`, { data: { profileId: profile.id, title: `Paste ${suffix}` } })).json()) as { id: string };

  // A paste over 40 lines is drawn folded, its last line ("the hidden marmoset") past the fold.
  const paste = (n: number): string => `${Array.from({ length: 60 }, (_, i) => `pasted log ${n} line ${i}`).join('\n')}\nthe ${n === 0 ? 'hidden' : 'later'} marmoset`;
  // 45 turns, 90 messages: the first paste is 48 before the 40 drawn, far enough that only the messages round it are drawn.
  const early = await sendTurn(request, chat.id, null, profile.id, paste(0));
  let parent = early.assistantMessageIds[0]!;
  for (let i = 1; i < 44; i++) parent = (await sendTurn(request, chat.id, parent, profile.id, `turn ${i}`)).assistantMessageIds[0]!;
  const late = await sendTurn(request, chat.id, parent, profile.id, paste(1));

  await page.goto('/');
  await page.getByRole('navigation', { name: 'Chats' }).getByTestId(`chat-row-${chat.id}`).locator('[data-row-main]').click();
  const thread = page.getByTestId('thread-scroll');
  const lateMessage = page.locator(`[id="msg-${late.userMessageId}"]`);
  const earlyMessage = page.locator(`[id="msg-${early.userMessageId}"]`);
  await expect(lateMessage).toBeVisible();
  await expect(earlyMessage).toHaveCount(0);
  // The later paste is drawn, but folded: its marmoset isn't on the page.
  await expect(lateMessage).not.toContainText('marmoset');

  await lateMessage.getByText('pasted log 1 line 0').click();
  await page.keyboard.press('Control+f');
  const box = page.getByRole('textbox', { name: 'Find in this chat' });
  await box.fill('marmoset');
  const status = page.getByRole('status', { name: 'Matches' });
  const highlighted = () => page.evaluate(() => Array.from(CSS.highlights.get('chat-find') ?? [], (r) => r.toString()));

  // From the view, the drawn paste's match comes first: it opens, and the match is shown.
  await expect(status).toHaveText('2 of 2');
  await expect(lateMessage).toContainText('the later marmoset');
  await expect(lateMessage.getByRole('button', { name: 'Show less' })).toBeVisible();
  expect(await highlighted()).toEqual(['marmoset']);

  // On (wrapping round) to the paste far back: drawn, opened, scrolled to, highlighted.
  await box.press('Enter');
  await expect(status).toHaveText('1 of 2');
  await expect(earlyMessage).toContainText('the hidden marmoset');
  await expect(earlyMessage.getByText('the hidden marmoset')).toBeInViewport();
  expect(await highlighted()).toEqual(['marmoset']);
  // Not everything from it to the end: the latest messages aren't drawn until asked for.
  await expect(lateMessage).toHaveCount(0);
  expect(await thread.locator('[id^="msg-"]').count()).toBeLessThanOrEqual(40);
  await expect(page.getByRole('button', { name: /Show later messages/ })).toBeVisible();

  await box.press('Escape');
  await page.getByRole('button', { name: 'Jump to latest' }).click();
  await expect(lateMessage).toBeInViewport();
  await expect(page.getByRole('button', { name: /Show later messages/ })).toHaveCount(0);
});
