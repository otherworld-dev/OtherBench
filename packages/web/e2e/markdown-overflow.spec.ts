import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { BASE_URL } from '../playwright.config.js';

/**
 * A long unbroken run in a reply stays inside the reply. A Windows path has no
 * place to wrap, so a code chip holding one ran past the edge of the message and
 * was cut off by the thread. Checked for plain inline code, a path (the chip then
 * holds a button that opens the viewer), a link and bare text.
 */
const FOLDERS = Array.from({ length: 12 }, (_, i) => `Nimbo_hthxzjrt90bbe_${i}`).join('\\');

test('a long path, link or word in a reply wraps instead of running out of the message', async ({ page, request }) => {
  const suffix = randomUUID().slice(0, 8);
  const conn = await request.post(`${BASE_URL}/api/connections`, { data: { name: `Mock ${suffix}`, kind: 'mock' } });
  const { id: connectionId } = await conn.json();
  const profile = await request.post(`${BASE_URL}/api/profiles`, { data: { name: `Overflow ${suffix}`, connectionId, modelId: 'mock-standard', isDefault: true } });
  const { id: profileId } = await profile.json();
  const title = `Overflow E2E - ${suffix}`;
  expect((await request.post(`${BASE_URL}/api/chats`, { data: { title, profileId } })).ok()).toBeTruthy();

  await page.setViewportSize({ width: 900, height: 700 });
  await page.goto('/');
  await page.getByRole('button', { name: title }).click();
  const textbox = page.getByRole('textbox', { name: /message/i });
  await textbox.fill(
    `#echo-user\n\n\`${'d'.repeat(300)}\`\n\n\`C:\\Users\\${FOLDERS}\\nimbo.log\`\n\n[link](https://example.com/${'a'.repeat(300)})\n\nhttps://example.com/${'b'.repeat(300)}\n\n${'c'.repeat(300)}`
  );
  await textbox.press('Enter');
  await expect(page.getByLabel('streaming')).toHaveCount(0);

  const reply = page.locator('article[data-role="assistant"] .markdown-body').first();
  await expect(reply.getByRole('button', { name: /nimbo\.log$/ })).toBeVisible();
  await expect(reply.locator('code:not(:has(button))')).toHaveCount(1);
  const overflowing = await reply.evaluate((body) => {
    const right = body.getBoundingClientRect().right;
    return [...body.querySelectorAll('p, code, a, button')].filter((el) => el.getBoundingClientRect().right > right + 1).map((el) => el.tagName);
  });
  expect(overflowing).toEqual([]);
  const scroller = page.getByTestId('thread-scroll');
  expect(await scroller.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(0);
});
