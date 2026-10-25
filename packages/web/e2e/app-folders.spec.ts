import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { BASE_URL } from '../playwright.config.js';

/**
 * App folders in the Code sidebar (spec docs/superpowers/specs/2026-10-25-app-folders-design.md):
 * make a folder, file an app into it by really dragging its heading, fold the
 * folder, and find it still folded with its count after a reload; file a second
 * app through the menu's Move to folder…; delete the folder and find both apps
 * back at the top level.
 *
 * The apps are created through the API, as the native folder picker can't be
 * driven. Their folders needn't exist: nothing here reads them.
 */
test('a folder holds dragged and menu-filed apps, stays folded across a reload, and deleting it frees its apps', async ({ page, request }) => {
  const suffix = randomUUID().slice(0, 8);
  const folderName = `Games ${suffix}`;
  const ids: Record<'one' | 'two', string> = { one: '', two: '' };
  const names = { one: `Folder App One ${suffix}`, two: `Folder App Two ${suffix}` };
  for (const key of ['one', 'two'] as const) {
    const created = await request.post(`${BASE_URL}/api/apps`, {
      data: { name: names[key], workspacePath: process.cwd(), githubRepo: null },
    });
    expect(created.ok()).toBeTruthy();
    ids[key] = (await created.json()).id;
  }

  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto('/');
  const nav = page.getByRole('navigation', { name: 'Chats' });
  await nav.getByTestId('mode-switch').getByRole('button', { name: 'Code' }).click();
  await expect(nav.getByTestId(`group-${ids.one}`)).toBeVisible();
  await expect(nav.getByTestId(`group-${ids.two}`)).toBeVisible();

  // + New folder opens its name for editing.
  await nav.getByRole('button', { name: '+ New folder' }).click();
  const nameBox = nav.getByRole('textbox');
  await expect(nameBox).toBeVisible();
  await nameBox.fill(folderName);
  await nameBox.press('Enter');
  const heading = nav.locator('[data-testid^="group-heading-folder:"]').filter({ hasText: folderName });
  await expect(heading).toBeVisible();
  const folderKey = (await heading.getAttribute('data-testid'))!.replace(/^group-heading-/, '');
  const folderId = folderKey.replace(/^folder:/, '');
  const folderGroup = nav.getByTestId(`group-${folderKey}`);

  // Drag the first app's heading onto the folder's (real HTML5 drag-and-drop).
  const appHeading = (id: string) => nav.getByTestId(`group-heading-${id}`);
  await appHeading(ids.one).locator('[data-heading-main]').dragTo(heading);
  await expect(folderGroup.getByTestId(`group-${ids.one}`)).toBeVisible();
  await expect(nav.getByTestId(`group-count-${folderKey}`)).toHaveText('1');
  await expect(nav.getByTestId(`group-${ids.two}`)).toBeVisible();
  await expect(folderGroup.getByTestId(`group-${ids.two}`)).toHaveCount(0);

  // Fold it; the fold survives a reload, with the count still showing.
  // A folder has no page to open, so its name button is the fold toggle.
  const toggle = heading.locator('[data-heading-main]');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(folderGroup.getByTestId(`group-${ids.one}`)).toHaveCount(0);
  await page.reload();
  await expect(nav.getByTestId('mode-switch').getByRole('button', { name: 'Code' })).toHaveAttribute('aria-pressed', 'true');
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(nav.getByTestId(`group-count-${folderKey}`)).toHaveText('1');
  await expect(folderGroup.getByTestId(`group-${ids.one}`)).toHaveCount(0);
  await toggle.click();
  await expect(folderGroup.getByTestId(`group-${ids.one}`)).toBeVisible();

  // The other path: the second app's menu, Move to folder….
  await appHeading(ids.two).getByRole('button', { name: 'App actions' }).click();
  await page.getByRole('menuitem', { name: 'Move to folder…' }).click();
  await page.getByRole('menuitemradio', { name: folderName }).click();
  await expect(folderGroup.getByTestId(`group-${ids.two}`)).toBeVisible();
  await expect(nav.getByTestId(`group-count-${folderKey}`)).toHaveText('2');

  // Deleting the folder frees its apps and deletes none of them.
  await heading.getByRole('button', { name: 'Folder actions' }).click();
  await page.getByRole('menuitem', { name: /^Delete/ }).click();
  const dialog = page.getByRole('alertdialog');
  await expect(dialog).toContainText('Its apps move out of the folder; nothing is deleted.');
  await dialog.getByRole('button', { name: 'Delete' }).click();
  await expect(nav.getByTestId(`group-${folderKey}`)).toHaveCount(0);
  for (const key of ['one', 'two'] as const) {
    await expect(nav.getByTestId(`group-${ids[key]}`)).toBeVisible();
  }
  const apps = (await (await request.get(`${BASE_URL}/api/apps`)).json()) as { id: string; folderId: string | null }[];
  for (const key of ['one', 'two'] as const) {
    expect(apps.find((a) => a.id === ids[key])?.folderId).toBeNull();
  }
  const folders = (await (await request.get(`${BASE_URL}/api/app-folders`)).json()) as { id: string }[];
  expect(folders.some((f) => f.id === folderId)).toBe(false);

  for (const key of ['one', 'two'] as const) await request.delete(`${BASE_URL}/api/apps/${ids[key]}`);
});
