import { randomUUID } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { BASE_URL } from '../playwright.config.js';

/**
 * Settings > Features: turning GitHub and Nextcloud off takes their tabs and
 * the app home's Issues away, and the server refuses their routes; turning
 * them back on brings it all back. The server is shared with the other specs,
 * so both are always turned back on afterwards.
 */
let folder: string;

test.beforeEach(() => {
  folder = realpathSync.native(mkdtempSync(join(tmpdir(), 'otherbench-e2e-features-')));
});

test.afterEach(async ({ request }) => {
  await request.patch(`${BASE_URL}/api/settings`, { data: { githubEnabled: true, nextcloudEnabled: true } });
  try {
    rmSync(folder, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    /* best-effort cleanup */
  }
});

test('GitHub and Nextcloud can be turned off and on again in Settings', async ({ page, request }) => {
  const appName = `E2E Features ${randomUUID().slice(0, 8)}`;
  const created = await request.post(`${BASE_URL}/api/apps`, { data: { name: appName, workspacePath: folder, githubRepo: 'o/r', deckBoardId: 1 } });
  expect(created.ok()).toBeTruthy();
  const { id: appId } = await created.json();

  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto('/');
  const nav = page.getByRole('navigation', { name: 'Chats' });
  await nav.getByTestId('mode-switch').getByRole('button', { name: 'Code' }).click();
  await nav.getByTestId(`group-heading-${appId}`).getByRole('button', { name: new RegExp(`^${appName}`) }).click();
  const panel = page.getByTestId('code-panel');
  await expect(panel.getByTestId('code-panel-tab-issues')).toBeVisible();
  await expect(panel.getByTestId('code-panel-tab-deck')).toBeVisible();
  await expect(page.getByTestId('app-home-issues')).toBeVisible();

  const toggle = async (key: 'githubEnabled' | 'nextcloudEnabled', on: boolean): Promise<void> => {
    await page.getByRole('button', { name: 'Settings' }).click();
    await page.getByRole('tab', { name: 'Features' }).click();
    const box = page.getByTestId(`feature-${key}`);
    // It flips once the server has saved it.
    await box.click();
    await expect(box).toBeChecked({ checked: on });
    await page.getByRole('button', { name: 'Close settings' }).click();
  };

  await toggle('githubEnabled', false);
  await toggle('nextcloudEnabled', false);
  await expect(panel.getByTestId('code-panel-tab-issues')).toHaveCount(0);
  await expect(panel.getByTestId('code-panel-tab-deck')).toHaveCount(0);
  await expect(panel.getByTestId('code-panel-tab-wiki')).toHaveCount(0);
  await expect(panel.getByTestId('code-panel-tab-links')).toHaveCount(0);
  await expect(page.getByTestId('app-home-issues')).toHaveCount(0);
  // The server says no too, before gh or Nextcloud is reached.
  expect(await (await request.get(`${BASE_URL}/api/apps/${appId}/issues`)).json()).toMatchObject({ code: 'github-off' });
  expect(await (await request.get(`${BASE_URL}/api/apps/${appId}/deck`)).json()).toMatchObject({ code: 'nextcloud-off' });
  // The Nextcloud settings tab goes too.
  await page.getByRole('button', { name: 'Settings' }).click();
  await expect(page.getByRole('tab', { name: 'Nextcloud' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Close settings' }).click();

  await toggle('githubEnabled', true);
  await toggle('nextcloudEnabled', true);
  await expect(panel.getByTestId('code-panel-tab-issues')).toBeVisible();
  await expect(panel.getByTestId('code-panel-tab-deck')).toBeVisible();
  await expect(page.getByTestId('app-home-issues')).toBeVisible();
});
