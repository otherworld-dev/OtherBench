import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { BASE_URL } from '../playwright.config.js';

/**
 * A sidebar longer than the window scrolls inside itself. Each group
 * heading's screen-reader text is absolutely positioned, and before the
 * sidebar's scroll area was a positioned box it was placed against the page,
 * so a heading below the fold made the whole window scroll (seen after an
 * import brought in several projects).
 */
const ids: string[] = [];

test.afterEach(async ({ request }) => {
  for (const id of ids.splice(0)) await request.delete(`${BASE_URL}/api/projects/${id}`);
});

test('a sidebar longer than the window scrolls inside itself, never the whole window', async ({ page, request }) => {
  const run = randomUUID().slice(0, 8);
  for (let i = 0; i < 30; i++) {
    const created = await request.post(`${BASE_URL}/api/projects`, { data: { name: `Overflow ${run} ${String(i).padStart(2, '0')}` } });
    expect(created.ok()).toBeTruthy();
    ids.push(((await created.json()) as { id: string }).id);
  }
  await page.setViewportSize({ width: 1280, height: 700 });
  await page.goto('/');
  await expect(page.getByRole('navigation', { name: 'Chats' }).getByText(`Overflow ${run} 29`)).toBeAttached();
  const sizes = await page.evaluate(() => ({ page: document.documentElement.scrollHeight, window: innerHeight }));
  expect(sizes.page).toBeLessThanOrEqual(sizes.window);
});
