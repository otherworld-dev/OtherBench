import { randomUUID } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { BASE_URL } from '../playwright.config.js';

/**
 * A Code tab chat changes Claude account from its composer, with the Code panel
 * left where it opens: the Inspector's picker sits behind that panel's Chat tab.
 * Nothing is sent, so no Claude login is used: the account's folder is empty.
 */
let folder: string;
let accountSlug: string | null = null;

test.beforeEach(() => {
  folder = realpathSync.native(mkdtempSync(join(tmpdir(), 'otherbench-e2e-account-')));
});

test.afterEach(async ({ request }) => {
  if (accountSlug) await request.delete(`${BASE_URL}/api/claude/accounts/${accountSlug}`);
  accountSlug = null;
  try {
    rmSync(folder, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    /* best-effort cleanup */
  }
});

test('an app chat moves to another Claude account from its composer, with the Code panel on Issues', async ({ page, request }) => {
  const suffix = randomUUID().slice(0, 8);
  const conn = await request.post(`${BASE_URL}/api/connections`, { data: { name: `Claude ${suffix}`, kind: 'claude_code' } });
  expect(conn.ok()).toBeTruthy();
  const { id: connectionId } = await conn.json();
  const profile = await request.post(`${BASE_URL}/api/profiles`, { data: { name: `Claude Profile ${suffix}`, connectionId, modelId: 'sonnet', isDefault: true } });
  expect(profile.ok()).toBeTruthy();
  const { id: profileId } = await profile.json();
  const appName = `Account App ${suffix}`;
  const app = await request.post(`${BASE_URL}/api/apps`, { data: { name: appName, workspacePath: folder, githubRepo: null, defaultProfileId: profileId } });
  expect(app.ok()).toBeTruthy();
  const { id: appId } = await app.json();
  const account = await request.post(`${BASE_URL}/api/claude/accounts`, { data: { name: `Second ${suffix}`, colour: '#336699', configDir: join(folder, 'claude-config') } });
  expect(account.ok()).toBeTruthy();
  const { account: { slug, name } } = await account.json();
  accountSlug = slug;

  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto('/');
  const nav = page.getByRole('navigation', { name: 'Chats' });
  await nav.getByTestId('mode-switch').getByRole('button', { name: 'Code' }).click();
  await nav.getByTestId(`group-heading-${appId}`).getByRole('button', { name: new RegExp(`^${appName}`) }).click();
  await page.getByTestId('app-home').getByTestId('app-home-new-chat').click();

  await expect(page.getByTestId('code-panel-tab-issues')).toHaveAttribute('aria-selected', 'true');
  const picker = page.getByRole('combobox', { name: 'Claude account' });
  await expect(picker).toBeVisible();
  await expect(picker).toHaveValue('');
  await picker.selectOption({ label: name });

  // On the server, not just in the box: a reload reads it back.
  const chats = page.getByRole('region', { name: 'Conversation' });
  await expect(chats.getByLabel('Claude account')).toHaveText(name);
  await page.reload();
  await expect(page.getByRole('combobox', { name: 'Claude account' })).toHaveValue(slug);
  await page.screenshot({ path: test.info().outputPath('code-tab-account.png') });
});
