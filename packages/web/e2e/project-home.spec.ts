import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { BASE_URL } from '../playwright.config.js';

/**
 * Project home (spec docs/superpowers/specs/2026-10-15-project-home-design.md
 * §5): a project's name opens its page as a tab, and a chat started from the
 * page's box opens in the pane with the mock reply, the page's tab staying.
 */
test.beforeEach(async ({ request }) => {
  const conn = await request.post(`${BASE_URL}/api/connections`, { data: { name: 'Mock', kind: 'mock' } });
  expect(conn.ok()).toBeTruthy();
  const { id: connectionId } = await conn.json();
  const profile = await request.post(`${BASE_URL}/api/profiles`, {
    data: { name: 'Mock Profile', connectionId, modelId: 'mock-standard', isDefault: true },
  });
  expect(profile.ok()).toBeTruthy();
});

test("a project's name opens its page, and a chat started there opens in the pane", async ({ page }) => {
  const projectName = `E2E Home ${randomUUID().slice(0, 8)}`;
  await page.goto('/');
  const nav = page.getByRole('navigation', { name: 'Chats' });

  await nav.getByRole('button', { name: 'New project' }).click();
  const settings = page.getByTestId('project-view');
  await settings.getByRole('textbox', { name: 'Name' }).fill(projectName);
  await settings.getByRole('button', { name: 'Create project' }).click();
  await expect(settings).toHaveCount(0);
  const group = nav.getByRole('group', { name: projectName });

  await group.getByRole('button', { name: new RegExp(`^${projectName}`) }).click();
  const home = page.getByTestId('project-home');
  await expect(home.getByRole('heading', { name: projectName })).toBeVisible();
  await expect(page.getByTestId('tab-bar').getByRole('tab', { name: new RegExp(projectName) })).toBeVisible();
  await expect(home.getByText('No chats yet')).toBeVisible();

  const box = home.getByRole('textbox', { name: `Start a chat in ${projectName}` });
  await box.fill('Hello from the project page');
  await box.press('Enter');

  await expect(page.getByTestId('thread-scroll').getByText('Hello from the project page')).toBeVisible();
  await expect(page.getByTestId('thread-scroll').getByText(/Here is a mock reply from Grunt/)).toBeVisible();
  await expect(page.getByTestId('tab-bar').getByRole('tab', { name: new RegExp(projectName) })).toBeVisible();
  await expect(group.locator('[data-testid^="chat-row-"]')).toHaveCount(1);
});
