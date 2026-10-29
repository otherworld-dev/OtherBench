import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { BASE_URL, NEXTCLOUD_URL } from '../playwright.config.js';

/**
 * The Overview (spec docs/superpowers/specs/2026-10-26-overview-design.md): a
 * chat with a reply is listed under the Chats tile and counted on the mode
 * switch, and ticking it off drops it and the count; an app linked to the fake
 * Nextcloud's board shows the card due today, and clicking it opens that app's
 * Deck tab. No GitHub inbox here: gh isn't available in CI, so that is unit-tested.
 *
 * Apps and chats are created through the API, as the native folder picker can't
 * be driven. The fixture's board is shared with nextcloud-tabs.spec.ts, which
 * never touches the card that is due.
 */
test('a replied chat is listed and ticked off, and a due Deck card opens the Deck tab', async ({ page, request }) => {
  const suffix = randomUUID().slice(0, 8);
  const conn = await request.post(`${BASE_URL}/api/connections`, { data: { name: 'Mock', kind: 'mock' } });
  const { id: connectionId } = await conn.json();
  const profile = await request.post(`${BASE_URL}/api/profiles`, { data: { name: `Mock ${suffix}`, connectionId, modelId: 'mock-standard', isDefault: true } });
  expect(profile.ok()).toBeTruthy();

  // Nextcloud set up through the API, then an app on its board.
  const saved = await request.put(`${BASE_URL}/api/nextcloud`, { data: { baseUrl: NEXTCLOUD_URL, user: 'adam', password: 'e2e-app-password' } });
  expect(saved.ok()).toBeTruthy();
  const appName = `Overview App ${suffix}`;
  const created = await request.post(`${BASE_URL}/api/apps`, {
    data: { name: appName, workspacePath: process.cwd(), githubRepo: null, deckBoardId: 1 },
  });
  expect(created.ok()).toBeTruthy();
  const { id: appId } = (await created.json()) as { id: string };
  // The check runs at start-up and every 15 minutes; this one reads the board just linked.
  expect((await request.post(`${BASE_URL}/api/overview/refresh`)).ok()).toBeTruthy();

  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto('/');

  // A chat with a finished reply: sent through the UI.
  const knownChatIds = new Set(((await (await request.get(`${BASE_URL}/api/chats`)).json()) as { id: string }[]).map((c) => c.id));
  await page.getByRole('button', { name: '+ New chat' }).click();
  const box = page.getByRole('textbox', { name: /message/i });
  await box.fill('hello overview');
  await box.press('Enter');
  await expect(page.locator('article[data-role="assistant"]')).toBeVisible();
  await expect(page.getByLabel('streaming')).toHaveCount(0, { timeout: 15_000 });
  let chatId = '';
  await expect
    .poll(async () => {
      const all = (await (await request.get(`${BASE_URL}/api/chats`)).json()) as { id: string }[];
      chatId = all.find((c) => !knownChatIds.has(c.id))?.id ?? '';
      return chatId;
    })
    .not.toBe('');
  expect((await request.post(`${BASE_URL}/api/overview/refresh`)).ok()).toBeTruthy();

  const nav = page.getByRole('navigation', { name: 'Chats' });
  const modes = nav.getByTestId('mode-switch');
  await modes.getByRole('button', { name: 'Overview' }).click();

  // The chat is under the Chats tile, and the switch counts it.
  const chatsTile = page.getByTestId('overview-tile-chats');
  const row = chatsTile.getByTestId(`overview-chat-${chatId}`);
  await expect(row).toBeVisible();
  const count = modes.getByTestId('overview-count');
  await expect(count).toBeVisible();
  const before = Number(await count.textContent());
  expect(before).toBeGreaterThanOrEqual(1);

  // The row's actions take no room until the row has focus or hover; a Tab from the row reaches them.
  await expect(chatsTile.getByRole('button', { name: /^Tick off / })).toHaveCount(0);
  await row.focus();
  await page.keyboard.press('Tab');
  await expect(chatsTile.getByRole('button', { name: /^Tick off / })).toBeFocused();

  // Ticking it off removes the row and lowers the count.
  await row.hover();
  await chatsTile.getByRole('button', { name: /^Tick off / }).click();
  await expect(chatsTile.getByTestId(`overview-chat-${chatId}`)).toHaveCount(0);
  await expect(async () => {
    const now = (await count.count()) === 0 ? 0 : Number(await count.textContent());
    expect(now).toBe(before - 1);
  }).toPass();

  // The app's tile shows the card due today; clicking it opens the app's Deck tab.
  const appTile = page.getByTestId(`overview-tile-${appId}`);
  const card = appTile.getByTestId('overview-card-104');
  // The title drops the "#104" prefix, so it reads "Due today" and the badge says "due today".
  await expect(card).toHaveText('Due todaydue today');
  await card.click();
  await expect(modes.getByRole('button', { name: 'Code' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('code-panel-tab-deck')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('deck-tab')).toBeVisible();

  expect((await request.delete(`${BASE_URL}/api/apps/${appId}`)).ok()).toBeTruthy();
  await request.delete(`${BASE_URL}/api/chats/${chatId}`);
});
