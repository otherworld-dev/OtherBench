import { expect, test } from '@playwright/test';
import { BASE_URL } from '../playwright.config.js';

/**
 * The composer's toolbar never pushes Send out of its box, at any width a
 * pane can be. A Claude Code chat has the most on the row (Plan, Auto,
 * Effort, the plan usage meter), so it's the one measured. The plan usage
 * call is stubbed: the meter only needs numbers to show.
 */
test('Send stays inside the composer box at every width, with the most a toolbar can hold', async ({ page, request }) => {
  const conn = await request.post(`${BASE_URL}/api/connections`, { data: { name: 'Claude Code', kind: 'claude_code' } });
  expect(conn.ok()).toBeTruthy();
  const profile = await request.post(`${BASE_URL}/api/profiles`, {
    data: { name: 'Claude Code Opus', connectionId: (await conn.json()).id, modelId: 'claude-opus-5-5' },
  });
  expect(profile.ok()).toBeTruthy();
  const chat = await request.post(`${BASE_URL}/api/chats`, { data: { profileId: (await profile.json()).id, title: 'Toolbar widths' } });
  const { id: chatId } = await chat.json();

  await page.route('**/api/claude/plan-usage*', (route) =>
    route.fulfill({
      json: { usage: { fetchedAt: Date.now(), windows: [{ id: 'five_hour', label: '5-hour', percent: 1, resetsAt: null }, { id: 'seven_day', label: 'Weekly', percent: 13, resetsAt: null }] } },
    })
  );
  await page.goto('/');
  await page.getByTestId(`chat-row-${chatId}`).getByRole('button').first().click();
  await expect(page.getByTestId('plan-usage')).toBeVisible();

  const overflowing = await page.evaluate(() => {
    const box = document.querySelector<HTMLElement>('[data-composer-box]')!;
    const bad: string[] = [];
    for (let w = 240; w <= 720; w += 10) {
      box.style.width = `${w}px`;
      const edge = box.getBoundingClientRect().right;
      const shown = [...box.querySelectorAll<HTMLElement>('button, select, [data-testid="plan-usage"]')].filter((el) => getComputedStyle(el).display !== 'none');
      const name = (el: HTMLElement): string => el.getAttribute('aria-label') ?? el.textContent?.trim() ?? '?';
      for (const el of shown) {
        const right = el.getBoundingClientRect().right;
        if (right > edge + 0.5) bad.push(`${w}px: ${name(el)} ends ${Math.round(right - edge)}px past the box`);
      }
      // Nor on top of each other.
      for (let i = 0; i < shown.length; i++) {
        for (let j = i + 1; j < shown.length; j++) {
          const a = shown[i]!.getBoundingClientRect();
          const b = shown[j]!.getBoundingClientRect();
          const overlap = Math.min(a.right, b.right) - Math.max(a.left, b.left) > 0.5 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 0.5;
          if (overlap) bad.push(`${w}px: ${name(shown[i]!)} and ${name(shown[j]!)} overlap`);
        }
      }
    }
    return bad;
  });
  expect(overflowing).toEqual([]);
});
