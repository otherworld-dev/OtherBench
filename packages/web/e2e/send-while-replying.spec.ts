import { expect, test } from '@playwright/test';
import type { CanonMessage } from '@otherbench/core/types/messages.js';
import { BASE_URL } from '../playwright.config.js';

/**
 * Sending while a reply runs (spec 2026-10-18-send-while-replying-design), on
 * an API profile: Send stays beside Stop, the message waits at the end of the
 * thread, and when the reply ends it goes out as the next message and gets a
 * reply of its own. The mock's `#slow` reply streams for about eight seconds.
 */
// Unique per run: the e2e server keeps one database for the whole run.
const RUN = Math.random().toString(36).slice(2, 8);
const PROFILE = `Note sender ${RUN}`;

test.beforeEach(async ({ request }) => {
  const conn = await request.post(`${BASE_URL}/api/connections`, { data: { name: 'Mock', kind: 'mock' } });
  expect(conn.ok()).toBeTruthy();
  const { id: connectionId } = await conn.json();
  const profile = await request.post(`${BASE_URL}/api/profiles`, { data: { name: PROFILE, connectionId, modelId: 'mock-standard', isDefault: true } });
  expect(profile.ok()).toBeTruthy();
});

test('a message sent while the reply streams waits, then goes out as the next message', async ({ page, request }) => {
  await page.goto('/');
  const knownChatIds = new Set(((await (await request.get(`${BASE_URL}/api/chats`)).json()) as { id: string }[]).map((c) => c.id));
  await page.getByRole('button', { name: '+ New chat' }).click();
  const box = page.getByRole('textbox', { name: /message/i });

  await box.fill('#slow tell me something');
  await box.press('Enter');
  await expect(page.getByLabel('streaming')).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeVisible();

  await box.fill('and one more thing');
  await box.press('Enter');
  await expect(box).toHaveValue('');
  const waiting = page.getByTestId('waiting-note');
  await expect(waiting).toHaveCount(1);
  await expect(waiting).toContainText('and one more thing');
  await expect(waiting).toContainText('Sends when the reply finishes');
  await expect(waiting.getByRole('button', { name: 'Take back' })).toBeVisible();

  // The slow reply ends, the note goes out as its own message, and that gets a reply.
  await expect(waiting).toHaveCount(0, { timeout: 20_000 });
  await expect(page.locator('article[data-role="user"]', { hasText: 'and one more thing' })).toBeVisible();
  await expect(page.getByLabel('streaming')).toHaveCount(0, { timeout: 15_000 });

  let chatId = '';
  await expect
    .poll(async () => {
      const all = (await (await request.get(`${BASE_URL}/api/chats`)).json()) as { id: string }[];
      chatId = all.find((c) => !knownChatIds.has(c.id))?.id ?? '';
      return chatId;
    })
    .not.toBe('');
  const { messages } = (await (await request.get(`${BASE_URL}/api/chats/${chatId}/messages`)).json()) as { messages: CanonMessage[] };
  const text = (m: CanonMessage) => m.parts.map((p) => (p.type === 'text' ? p.text : '')).join('');
  const first = messages.find((m) => m.role === 'user' && text(m) === '#slow tell me something')!;
  const firstReply = messages.find((m) => m.parentId === first.id)!;
  expect(firstReply.status).toBe('complete');
  const note = messages.find((m) => m.role === 'user' && text(m) === 'and one more thing')!;
  expect(note.parentId).toBe(firstReply.id);
  const noteReply = messages.find((m) => m.parentId === note.id)!;
  expect(noteReply.role).toBe('assistant');
  expect(noteReply.status).toBe('complete');
});
