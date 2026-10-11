import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext } from '@playwright/test';
import { BASE_URL } from '../playwright.config.js';

/** A chat (outside any project) on a fresh mock profile; returns its id. */
async function createChat(request: APIRequestContext, title: string): Promise<string> {
  const run = randomUUID().slice(0, 8);
  const conn = await request.post(`${BASE_URL}/api/connections`, { data: { name: `Mock ${run}`, kind: 'mock' } });
  expect(conn.ok()).toBeTruthy();
  const { id: connectionId } = (await conn.json()) as { id: string };
  const prof = await request.post(`${BASE_URL}/api/profiles`, { data: { name: `Pin ${run}`, connectionId, modelId: 'mock-standard' } });
  expect(prof.ok()).toBeTruthy();
  const { id: profileId } = (await prof.json()) as { id: string };
  const created = await request.post(`${BASE_URL}/api/chats`, { data: { profileId, title } });
  expect(created.ok()).toBeTruthy();
  return ((await created.json()) as { id: string }).id;
}

/**
 * Pinning from a sidebar row's hover button puts the chat under Pinned, and
 * the open chat's pane header can unpin it again (spec
 * 2026-10-11-sidebar-layout-design §3).
 */
test('pins a chat from its row and unpins it from the pane header', async ({ page, request }) => {
  const title = `Pin me ${randomUUID().slice(0, 8)}`;
  const id = await createChat(request, title);

  try {
    await page.goto('/');
    const nav = page.getByRole('navigation', { name: 'Chats' });
    const row = nav.getByTestId(`chat-row-${id}`);
    await row.hover();
    await row.getByRole('button', { name: 'Pin chat' }).click();
    await expect(nav.getByTestId('group-pinned').getByTestId(`chat-row-${id}`)).toBeVisible();

    await nav.getByRole('button', { name: title }).click();
    await page.getByRole('region', { name: 'Conversation' }).getByRole('button', { name: 'Unpin chat' }).click();
    await expect(nav.getByTestId('group-pinned').getByTestId(`chat-row-${id}`)).toHaveCount(0);
    await expect(nav.getByTestId(`chat-row-${id}`)).toBeVisible();
  } finally {
    await request.delete(`${BASE_URL}/api/chats/${id}`);
  }
});

/**
 * With nothing pinned, dragging a chat swaps the search box for a "Drop here
 * to pin" target; the list itself doesn't move, and dropping there pins it.
 */
test('dragging a chat onto the drop target in the search box pins it', async ({ page, request }) => {
  const id = await createChat(request, `Drag pin ${randomUUID().slice(0, 8)}`);

  try {
    await page.goto('/');
    const nav = page.getByRole('navigation', { name: 'Chats' });
    await expect(nav.getByTestId('group-pinned')).toHaveCount(0);
    const source = nav.getByTestId(`chat-row-${id}`).locator('[data-row-main]');
    await source.scrollIntoViewIfNeeded();
    const before = (await source.boundingBox())!;

    // The target only exists once the drag has started, so drive the mouse by hand.
    await source.hover();
    await page.mouse.down();
    await page.mouse.move(before.x + 30, before.y + 4, { steps: 3 });
    const zone = nav.getByTestId('pinned-drop-zone');
    await expect(zone).toBeVisible();
    expect((await source.boundingBox())!.y).toBe(before.y);
    await zone.hover();
    await page.mouse.up();

    await expect(nav.getByTestId('group-pinned').getByTestId(`chat-row-${id}`)).toBeVisible();
    await expect(nav.getByRole('searchbox', { name: 'Search chats' })).toBeVisible();
  } finally {
    await request.delete(`${BASE_URL}/api/chats/${id}`);
  }
});
