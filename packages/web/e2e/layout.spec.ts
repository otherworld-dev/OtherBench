import { expect, test, type Page } from '@playwright/test';
import { BASE_URL } from '../playwright.config.js';

/**
 * Layout regression: each pane scrolls on its own and the document never
 * does. When the thread (or Inspector) grew past the window the whole page
 * used to scroll, leaving the sidebar at its old height with a blank band
 * underneath it.
 */
async function seedMockProfile(request: import('@playwright/test').APIRequestContext): Promise<void> {
  const conn = await request.post(`${BASE_URL}/api/connections`, { data: { name: 'Mock', kind: 'mock' } });
  expect(conn.ok()).toBeTruthy();
  const { id: connectionId } = await conn.json();
  const profile = await request.post(`${BASE_URL}/api/profiles`, {
    data: { name: 'Mock Profile', connectionId, modelId: 'mock-standard', isDefault: true },
  });
  expect(profile.ok()).toBeTruthy();
}

async function fillThread(page: Page): Promise<void> {
  await page.getByRole('button', { name: '+ New chat' }).click();
  const textbox = page.getByRole('textbox', { name: /message/i });
  await expect(textbox).toBeVisible();
  // Several tall messages so the thread is well past the window height.
  const tall = Array.from({ length: 40 }, (_, i) => `line ${i + 1} of a deliberately long message`).join('\n\n');
  for (let i = 0; i < 3; i++) {
    await textbox.fill(tall);
    await textbox.press('Enter');
    await expect(page.getByLabel('streaming')).toHaveCount(0);
  }
}

async function expectPanesBounded(page: Page): Promise<void> {
  const m = await page.evaluate(() => {
    const bottom = (sel: string): number => document.querySelector(sel)!.getBoundingClientRect().bottom;
    const scroller = document.querySelector('[data-testid="thread-scroll"]') as HTMLElement;
    return {
      docScrollHeight: document.scrollingElement!.scrollHeight,
      innerHeight: window.innerHeight,
      nav: bottom('nav[aria-label="Chats"]'),
      main: bottom('main'),
      aside: bottom('aside'),
      threadOverflows: scroller.scrollHeight > scroller.clientHeight,
    };
  });
  expect(m.threadOverflows).toBe(true); // the content really is taller than its pane
  expect(m.docScrollHeight).toBeLessThanOrEqual(m.innerHeight);
  for (const key of ['nav', 'main', 'aside'] as const) {
    expect(Math.abs(m[key] - m.innerHeight)).toBeLessThanOrEqual(1);
  }
}

test.beforeEach(async ({ request }) => {
  await seedMockProfile(request);
});

test('overflowing content scrolls inside the panes, never the document', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 700 });
  await page.goto('/');
  await fillThread(page);
  await expectPanesBounded(page);
});

test('panes stay bounded at 150% text size (set from Settings)', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 700 });
  await page.goto('/');
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('tab', { name: 'Appearance' }).click();
  await page.getByRole('combobox', { name: 'Text size' }).selectOption('150');
  await expect.poll(() => page.evaluate(() => document.documentElement.style.fontSize)).toBe('150%');
  await page.getByRole('button', { name: 'Close settings' }).click();
  await fillThread(page);
  await expectPanesBounded(page);
});

test('Ctrl+= / Ctrl+0 change and reset the text size, and it survives a reload', async ({ page }) => {
  await page.goto('/');
  await page.keyboard.press('Control+=');
  await expect.poll(() => page.evaluate(() => document.documentElement.style.fontSize)).toBe('115%');
  await page.reload();
  await expect.poll(() => page.evaluate(() => document.documentElement.style.fontSize)).toBe('115%');
  await page.keyboard.press('Control+0');
  await expect.poll(() => page.evaluate(() => document.documentElement.style.fontSize)).toBe('100%');
});
