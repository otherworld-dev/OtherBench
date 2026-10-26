import { expect, test, type Page } from '@playwright/test';
import { BASE_URL } from '../playwright.config.js';

/**
 * A long chat stays at its bottom while you type and send. Two cases broke it:
 * - the message box growing in the same frame as a streamed reply was pinned, which
 *   read as the user scrolling up and stopped the thread following;
 * - a message sent while a reply runs goes out on the server when the reply ends, and
 *   the chat's new head arrived before its messages, so the thread drew nothing for a
 *   frame, its scroll position fell to the top, and it could stay there.
 */
const RUN = Math.random().toString(36).slice(2, 8);
const PROFILE = `Scroll keeper ${RUN}`;

test.beforeEach(async ({ request }) => {
  const conn = await request.post(`${BASE_URL}/api/connections`, { data: { name: 'Mock', kind: 'mock' } });
  expect(conn.ok()).toBeTruthy();
  const { id: connectionId } = await conn.json();
  const profile = await request.post(`${BASE_URL}/api/profiles`, { data: { name: PROFILE, connectionId, modelId: 'mock-standard', isDefault: true } });
  expect(profile.ok()).toBeTruthy();
});

/** How far the thread is from its bottom, in pixels. */
async function gapToBottom(page: Page): Promise<number> {
  return page.getByTestId('thread-scroll').evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight);
}

async function longChat(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByRole('button', { name: '+ New chat' }).click();
  const box = page.getByRole('textbox', { name: /message/i });
  for (let i = 0; i < 3; i++) {
    await box.fill(`#long part ${i}`);
    await box.press('Enter');
    await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0, { timeout: 30_000 });
  }
  await expect.poll(() => page.getByTestId('thread-scroll').evaluate((el) => el.scrollHeight > el.clientHeight * 2)).toBe(true);
  await expect.poll(() => gapToBottom(page)).toBeLessThanOrEqual(2);
}

test('the message box growing while a reply streams keeps a long chat at the bottom', async ({ page }) => {
  await longChat(page);
  const box = page.getByRole('textbox', { name: /message/i });
  await box.fill('#long one more');
  await box.press('Enter');
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeVisible();
  // Grow and shrink the box while the reply streams, so some of the resizes land in the same frame as a delta.
  for (let i = 0; i < 8; i++) {
    await box.fill(Array.from({ length: 10 }, (_, n) => `line ${n + 1}`).join('\n'));
    await page.waitForTimeout(60);
    await box.fill('');
    await page.waitForTimeout(60);
  }
  await box.fill(Array.from({ length: 10 }, (_, n) => `line ${n + 1}`).join('\n'));
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0, { timeout: 30_000 });
  await expect.poll(() => gapToBottom(page)).toBeLessThanOrEqual(2);
  await expect(page.getByRole('button', { name: /Jump to latest/ })).toHaveCount(0);
});

test('a message sent while a reply runs goes out without the thread collapsing or leaving the bottom', async ({ page }) => {
  await longChat(page);
  const box = page.getByRole('textbox', { name: /message/i });
  // Every animation frame, the thread's lowest content height and scroll position.
  await page.evaluate(() => {
    const w = window as unknown as { __lowest: { height: number; top: number } };
    const el = document.querySelector('[data-testid="thread-scroll"]') as HTMLElement;
    w.__lowest = { height: el.scrollHeight, top: el.scrollTop };
    const tick = (): void => {
      const now = document.querySelector('[data-testid="thread-scroll"]') as HTMLElement | null;
      if (now) w.__lowest = { height: Math.min(w.__lowest.height, now.scrollHeight), top: Math.min(w.__lowest.top, now.scrollTop) };
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  const before = await page.getByTestId('thread-scroll').evaluate((el) => ({ height: el.scrollHeight, top: el.scrollTop }));

  await box.fill('#slow a slow one');
  await box.press('Enter');
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeVisible();
  await box.fill('sent while the reply runs');
  await box.press('Enter');
  await expect(page.getByTestId('waiting-note')).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0, { timeout: 60_000 });
  await expect(page.getByTestId('waiting-note')).toHaveCount(0);

  const lowest = await page.evaluate(() => (window as unknown as { __lowest: { height: number; top: number } }).__lowest);
  // The thread never shrank to nothing, so it was never thrown to the top.
  expect(lowest.height).toBeGreaterThanOrEqual(before.height * 0.9);
  expect(lowest.top).toBeGreaterThan(before.top * 0.5);
  await expect.poll(() => gapToBottom(page)).toBeLessThanOrEqual(2);
  await expect(page.getByRole('button', { name: /Jump to latest/ })).toHaveCount(0);
});
