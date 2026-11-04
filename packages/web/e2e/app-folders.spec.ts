import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { BASE_URL } from '../playwright.config.js';

/**
 * App folders on the All apps page (spec docs/superpowers/specs/2026-10-25-app-folders-design.md,
 * moved there by 2026-11-04-open-apps-design.md): make a folder, file an app into it by really
 * dragging its card, fold the folder, and find it still folded with its count after a reload; file a
 * second app through the card menu's Move to folder…; delete the folder and find both apps Unfiled.
 *
 * The apps are created through the API, as the native folder picker can't be driven. Their folders
 * needn't exist: nothing here reads them.
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
  await nav.getByTestId('all-apps-entry').click();
  const allApps = page.getByTestId('all-apps-page');
  const card = (id: string) => allApps.getByTestId(`all-apps-card-${id}`);
  await expect(card(ids.one)).toBeVisible();
  await expect(card(ids.two)).toBeVisible();

  // + New folder opens its name for editing.
  await allApps.getByRole('button', { name: '+ New folder' }).click();
  const nameBox = allApps.getByRole('textbox', { name: 'Folder name' });
  await expect(nameBox).toBeVisible();
  await nameBox.fill(folderName);
  await nameBox.press('Enter');
  const createdHeading = allApps.locator('[data-testid^="all-apps-heading-folder:"]').filter({ hasText: folderName });
  await expect(createdHeading).toBeVisible();
  const folderKey = (await createdHeading.getAttribute('data-testid'))!.replace(/^all-apps-heading-/, '');
  const folderId = folderKey.replace(/^folder:/, '');
  const heading = allApps.getByTestId(`all-apps-heading-${folderKey}`);
  const folderSection = allApps.getByTestId(`all-apps-section-${folderKey}`);
  const count = allApps.getByTestId(`all-apps-count-${folderKey}`);
  const appRows = async () => (await (await request.get(`${BASE_URL}/api/apps`)).json()) as { id: string; folderId: string | null }[];
  const folderRows = async () => (await (await request.get(`${BASE_URL}/api/app-folders`)).json()) as { id: string; name: string; sortOrder: number }[];

  // Rename from the folder's menu, in the UI and in the API.
  const renamed = `Play ${suffix}`;
  await heading.getByRole('button', { name: 'Folder actions' }).click();
  await page.getByRole('menuitem', { name: 'Rename' }).click();
  const renameBox = allApps.getByRole('textbox', { name: 'Folder name' });
  await renameBox.fill(renamed);
  await renameBox.press('Enter');
  await expect(heading).toContainText(renamed);
  await expect(heading).not.toContainText(folderName);
  await expect.poll(async () => (await folderRows()).find((f) => f.id === folderId)?.name).toBe(renamed);

  // Drag the first app's card onto the folder's section (real HTML5 drag-and-drop).
  await card(ids.one).dragTo(folderSection);
  await expect(folderSection.getByTestId(`all-apps-card-${ids.one}`)).toBeVisible();
  await expect(count).toHaveText('1');
  await expect(card(ids.two)).toBeVisible();
  await expect(folderSection.getByTestId(`all-apps-card-${ids.two}`)).toHaveCount(0);

  // Fold it; the fold survives a reload, with the count still showing.
  const toggle = heading.getByRole('button', { name: new RegExp(renamed) });
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(folderSection.getByTestId(`all-apps-card-${ids.one}`)).toHaveCount(0);
  await page.reload();
  await expect(nav.getByTestId('mode-switch').getByRole('button', { name: 'Code' })).toHaveAttribute('aria-pressed', 'true');
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(count).toHaveText('1');
  await expect(folderSection.getByTestId(`all-apps-card-${ids.one}`)).toHaveCount(0);
  await toggle.click();
  await expect(folderSection.getByTestId(`all-apps-card-${ids.one}`)).toBeVisible();

  // The other path: the second app's menu, Move to folder….
  await card(ids.two).getByRole('button', { name: 'App actions' }).click();
  await page.getByRole('menuitem', { name: 'Move to folder…' }).click();
  await page.getByRole('menuitemradio', { name: renamed }).click();
  await expect(folderSection.getByTestId(`all-apps-card-${ids.two}`)).toBeVisible();
  await expect(count).toHaveText('2');
  expect((await appRows()).find((a) => a.id === ids.two)?.folderId).toBe(folderId);

  // Reorder: a second folder starts below this one; its menu's Move up puts it above, in the page and in the API.
  const secondName = `Work ${suffix}`;
  await allApps.getByRole('button', { name: '+ New folder' }).click();
  const secondBox = allApps.getByRole('textbox', { name: 'Folder name' });
  await secondBox.fill(secondName);
  await secondBox.press('Enter');
  const secondHeading = allApps.locator('[data-testid^="all-apps-heading-folder:"]').filter({ hasText: secondName });
  await expect(secondHeading).toBeVisible();
  const secondKey = (await secondHeading.getAttribute('data-testid'))!.replace(/^all-apps-heading-/, '');
  const secondId = secondKey.replace(/^folder:/, '');
  const sectionKeys = () =>
    allApps.locator('[data-testid^="all-apps-section-folder:"]').evaluateAll((els) => els.map((el) => el.getAttribute('data-testid')!.replace(/^all-apps-section-/, '')));
  const mine = async () => (await sectionKeys()).filter((k) => k === folderKey || k === secondKey);
  expect(await mine()).toEqual([folderKey, secondKey]);
  await secondHeading.getByRole('button', { name: 'Folder actions' }).click();
  await page.getByRole('menuitem', { name: 'Move up' }).click();
  await expect.poll(mine).toEqual([secondKey, folderKey]);
  await expect
    .poll(async () => {
      const rows = await folderRows();
      return rows.find((f) => f.id === secondId)!.sortOrder < rows.find((f) => f.id === folderId)!.sortOrder;
    })
    .toBe(true);
  await page.reload();
  await expect.poll(mine).toEqual([secondKey, folderKey]);
  await request.delete(`${BASE_URL}/api/app-folders/${secondId}`);

  // Deleting the folder frees its apps and deletes none of them.
  await heading.getByRole('button', { name: 'Folder actions' }).click();
  await page.getByRole('menuitem', { name: /^Delete/ }).click();
  const dialog = page.getByRole('alertdialog');
  await expect(dialog).toContainText('Its apps move out of the folder; nothing is deleted.');
  await dialog.getByRole('button', { name: 'Delete' }).click();
  await expect(allApps.getByTestId(`all-apps-section-${folderKey}`)).toHaveCount(0);
  const unfiled = allApps.getByTestId('all-apps-section-folder:unfiled');
  for (const key of ['one', 'two'] as const) {
    await expect(unfiled.getByTestId(`all-apps-card-${ids[key]}`)).toBeVisible();
  }
  const apps = await appRows();
  for (const key of ['one', 'two'] as const) {
    expect(apps.find((a) => a.id === ids[key])?.folderId).toBeNull();
  }
  const folders = (await (await request.get(`${BASE_URL}/api/app-folders`)).json()) as { id: string }[];
  expect(folders.some((f) => f.id === folderId)).toBe(false);

  for (const key of ['one', 'two'] as const) await request.delete(`${BASE_URL}/api/apps/${ids[key]}`);
});
