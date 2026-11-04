import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { BASE_URL } from '../playwright.config.js';

/**
 * Open apps (spec docs/superpowers/specs/2026-11-04-open-apps-design.md): the Code sidebar lists only
 * the apps that are open. A closed app is found on the All apps page, opened from its card, shown in
 * the sidebar, closed again with its ×, and brought back by the toast's Undo. Closing from the app's
 * home works the same way.
 *
 * The app is created through the API, as the native folder picker can't be driven.
 */
test('an app is opened from All apps, listed in the sidebar, closed with × and brought back with Undo', async ({ page, request }) => {
  const suffix = randomUUID().slice(0, 8);
  const name = `Open App ${suffix}`;
  const created = await request.post(`${BASE_URL}/api/apps`, { data: { name, workspacePath: process.cwd(), githubRepo: null } });
  expect(created.ok()).toBeTruthy();
  const appId = (await created.json()).id as string;
  // Start from a closed app, whatever a new app defaults to.
  expect((await request.patch(`${BASE_URL}/api/apps/${appId}`, { data: { open: false } })).ok()).toBeTruthy();

  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto('/');
  const nav = page.getByRole('navigation', { name: 'Chats' });
  await nav.getByTestId('mode-switch').getByRole('button', { name: 'Code' }).click();

  // Closed: not in the sidebar, but in All apps.
  await expect(nav.getByTestId('all-apps-entry')).toBeVisible();
  await expect(nav.getByTestId(`group-${appId}`)).toHaveCount(0);
  await nav.getByTestId('all-apps-entry').click();
  const card = page.getByTestId(`all-apps-card-${appId}`);
  await expect(card).toBeVisible();

  // Its card opens it: the home shows, and the sidebar lists it.
  await card.click();
  const home = page.getByTestId('app-home');
  await expect(home.getByRole('heading', { name })).toBeVisible();
  await expect(nav.getByTestId(`group-${appId}`)).toBeVisible();
  await expect(home.getByRole('button', { name: 'Close app' })).toBeVisible();

  // × on the heading closes it; the toast says so and Undo puts it back.
  const heading = nav.getByTestId(`group-heading-${appId}`);
  await heading.hover();
  await heading.getByRole('button', { name: `Close ${name}` }).click();
  await expect(nav.getByTestId(`group-${appId}`)).toHaveCount(0);
  const toast = page.getByRole('status').filter({ hasText: `Closed ${name}. It's still in All apps.` });
  await expect(toast).toBeVisible();
  await toast.getByRole('button', { name: 'Undo' }).click();
  await expect(nav.getByTestId(`group-${appId}`)).toBeVisible();
  await expect
    .poll(async () => ((await (await request.get(`${BASE_URL}/api/apps`)).json()) as { id: string; open: boolean }[]).find((a) => a.id === appId)?.open)
    .toBe(true);

  // From the app's home: Close app removes it from the sidebar, Keep in sidebar brings it back.
  await home.getByRole('button', { name: 'Close app' }).click();
  await expect(nav.getByTestId(`group-${appId}`)).toHaveCount(0);
  await expect(home.getByRole('navigation', { name: 'Breadcrumb' })).toContainText(name);
  await home.getByRole('button', { name: 'Keep in sidebar' }).click();
  await expect(nav.getByTestId(`group-${appId}`)).toBeVisible();

  await request.delete(`${BASE_URL}/api/apps/${appId}`);
});
