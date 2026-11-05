import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { BASE_URL } from '../playwright.config.js';

/**
 * The phone layout (App.tsx's data-phone, below 640px) at an iPhone's
 * 390x844: the sidebar as a drawer, a chat full width, an approval card
 * answered with a tap, the Needs you list, and Settings. At each step nothing
 * may stick out sideways: the page can't scroll sideways and no element runs
 * past the screen's edge unless it sits in a box that scrolls sideways by
 * itself (a code block, the Settings tabs). A full-page screenshot backs that
 * up: it is exactly as wide as the screen.
 */

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

let workspaceRoot: string;

test.beforeEach(() => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'otherbench-e2e-phone-'));
  writeFileSync(join(workspaceRoot, 'notes.txt'), 'PHONE LAYOUT CHECK PASSED');
});

test.afterEach(() => {
  rmSync(workspaceRoot, { recursive: true, force: true });
});

async function seed(request: import('@playwright/test').APIRequestContext, chatTitle: string): Promise<void> {
  const suffix = randomUUID().slice(0, 8);
  const conn = await request.post(`${BASE_URL}/api/connections`, { data: { name: `Phone mock ${suffix}`, kind: 'mock' } });
  expect(conn.ok()).toBeTruthy();
  const profile = await request.post(`${BASE_URL}/api/profiles`, {
    data: {
      name: `Phone ${suffix}`,
      connectionId: (await conn.json()).id,
      modelId: 'mock-standard',
      isDefault: true,
      toolPolicy: { fs: 'readwrite', shell: false, mcpServerIds: [], approvalMode: 'always_ask' },
    },
  });
  expect(profile.ok()).toBeTruthy();
  const chat = await request.post(`${BASE_URL}/api/chats`, { data: { title: chatTitle, profileId: (await profile.json()).id, workspaceRoot } });
  expect(chat.ok()).toBeTruthy();
}

/** What sticks out past the screen's right or left edge, outside any box that scrolls sideways. */
async function expectNoSidewaysOverflow(page: Page, step: string): Promise<void> {
  const found = await page.evaluate(() => {
    const vw = document.documentElement.clientWidth;
    const bad: string[] = [];
    for (const el of document.querySelectorAll('body *')) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      if (r.right <= vw + 1 && r.left >= -1) continue;
      let p = el.parentElement;
      let scrolls = false;
      while (p) {
        const o = getComputedStyle(p).overflowX;
        if (o === 'auto' || o === 'scroll') {
          scrolls = true;
          break;
        }
        p = p.parentElement;
      }
      if (!scrolls) bad.push(`${el.tagName.toLowerCase()}[${el.getAttribute('data-testid') ?? ''}] ${Math.round(r.left)}..${Math.round(r.right)}`);
    }
    return { vw, scrollWidth: document.documentElement.scrollWidth, bodyScrollWidth: document.body.scrollWidth, bad: bad.slice(0, 10) };
  });
  expect(found.vw, step).toBe(390);
  expect(found.scrollWidth, step).toBe(390);
  expect(found.bodyScrollWidth, step).toBeLessThanOrEqual(390);
  expect(found.bad, step).toEqual([]);
  // A full-page screenshot is as wide as everything that can be scrolled to: exactly the screen.
  const png = await page.screenshot({ fullPage: true });
  expect(png.readUInt32BE(16), `${step}: screenshot width`).toBe(390);
}

test('a phone: open a chat from the drawer, answer its approval card, find it in Needs you, reach Settings', async ({ page, request }) => {
  const chatTitle = `Phone layout ${randomUUID().slice(0, 8)}`;
  await seed(request, chatTitle);

  await page.goto('/');
  await expect(page.getByTestId('phone-bar')).toBeVisible();
  const drawer = page.getByTestId('sidebar-drawer');
  await expect(drawer).toBeHidden();
  await expectNoSidewaysOverflow(page, 'start');

  // The sidebar is a drawer: open it, pick the chat, and it gets out of the way.
  await page.getByRole('button', { name: 'Open the sidebar' }).tap();
  await expect(drawer).toBeVisible();
  await expectNoSidewaysOverflow(page, 'drawer');
  await drawer.getByRole('button', { name: chatTitle }).first().tap();
  await expect(drawer).toBeHidden();

  // The thread and the composer take the whole width.
  const composer = page.getByRole('textbox', { name: /message/i });
  await expect(composer).toBeVisible();
  const box = await composer.boundingBox();
  expect(box!.width).toBeGreaterThan(300);

  await composer.fill('#tool notes.txt');
  await composer.press('Enter');
  const card = page.locator('[data-testid^="approval-prompt-"]');
  await expect(card).toBeVisible();
  await expectNoSidewaysOverflow(page, 'approval card');
  // Thumb-sized: at least 44px tall.
  const allow = card.getByRole('button', { name: 'Allow once' });
  expect((await allow.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  // Waiting on the user: the bar's count says so.
  await expect(page.getByTestId('phone-needs-you')).toBeVisible();
  await allow.tap();
  await expect(card).toHaveCount(0);
  await expect(page.locator('article[data-role="assistant"] .markdown-body').getByText(/PHONE LAYOUT CHECK PASSED/)).toBeVisible();
  await expect(page.getByLabel('streaming')).toHaveCount(0);
  await expectNoSidewaysOverflow(page, 'reply');

  // The finished reply waits on the user in the Needs you list, at the top of the drawer.
  await page.getByRole('button', { name: 'Open the sidebar' }).tap();
  const needsYou = drawer.getByTestId('group-needs-you');
  await expect(needsYou.getByRole('button', { name: chatTitle })).toBeVisible();
  expect((await needsYou.getByRole('button', { name: chatTitle }).boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await expectNoSidewaysOverflow(page, 'needs you');
  await needsYou.getByRole('button', { name: chatTitle }).tap();
  await expect(drawer).toBeHidden();

  // Settings, from the drawer's footer; its tabs scroll sideways inside their own strip.
  await page.getByRole('button', { name: 'Open the sidebar' }).tap();
  await drawer.getByRole('button', { name: 'Settings' }).tap();
  const settings = page.getByTestId('settings-view');
  await expect(settings).toBeVisible();
  await expect(drawer).toBeHidden();
  await expectNoSidewaysOverflow(page, 'settings');
  await settings.getByRole('tab', { name: 'Notifications' }).tap();
  await expect(settings.getByRole('checkbox', { name: 'Scheduled runs' })).toBeVisible();
  await expectNoSidewaysOverflow(page, 'settings: notifications');
  await settings.getByRole('tab', { name: 'Profiles' }).tap();
  await expectNoSidewaysOverflow(page, 'settings: profiles');
  await settings.getByRole('button', { name: 'Close settings' }).tap();
  await expect(settings).toHaveCount(0);
});
