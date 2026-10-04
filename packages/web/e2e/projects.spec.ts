import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { BASE_URL } from '../playwright.config.js';

/**
 * Projects (spec docs/superpowers/specs/2026-10-03-projects-design.md §7):
 * create a project with a folder through the sidebar, start a chat from its
 * +, check the Inspector shows the inherited folder, then move the chat to No
 * project from its row menu. Seeds a keyless mock profile through the real
 * API, like smoke.spec.ts. The folder is a real temp directory, so its path
 * is native on whichever OS runs this.
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

test('a project with a folder: a chat from its + inherits the folder, then moves to No project', async ({ page }) => {
  const projectName = `E2E Project ${randomUUID().slice(0, 8)}`;
  const folder = mkdtempSync(join(tmpdir(), 'grunt-e2e-project-'));
  try {
    await page.goto('/');
    const nav = page.getByRole('navigation', { name: 'Chats' });

    // Create the project.
    await nav.getByRole('button', { name: '+ New project' }).click();
    const nameInput = nav.getByRole('textbox', { name: 'Project name' });
    await nameInput.fill(projectName);
    await nameInput.press('Enter');
    const group = nav.getByRole('group', { name: projectName });
    await expect(group).toBeVisible();

    // Give it a folder from its ⋯ menu.
    await group.getByRole('button', { name: 'Project actions' }).click();
    await page.getByRole('menuitem', { name: 'Set folder…' }).click();
    const folderInput = group.getByRole('textbox', { name: 'Project folder' });
    await folderInput.fill(folder);
    await group.getByRole('button', { name: 'Save' }).click();
    await expect(folderInput).toHaveCount(0);

    // A chat from the project's + opens, starting in that folder.
    await group.getByRole('button', { name: `New chat in ${projectName}` }).click();
    const row = group.locator('[data-testid^="chat-row-"]');
    await expect(row).toHaveCount(1);
    const rowTestId = await row.getAttribute('data-testid');
    await expect(page.getByTestId('workspace-root-value')).toHaveText(folder);
    await expect(page.getByTestId('inspector-project')).toHaveText(projectName);

    // Move it to No project from its row menu.
    await row.hover();
    await row.getByRole('button', { name: 'Chat actions' }).click();
    await page.getByRole('menuitem', { name: 'Move to project…' }).click();
    await page.getByRole('menuitemradio', { name: 'No project' }).click();

    await expect(group.locator('[data-testid^="chat-row-"]')).toHaveCount(0);
    await expect(group.getByText('No chats yet')).toBeVisible();
    await expect(nav.getByTestId('group-__no_project__').getByTestId(rowTestId!)).toBeVisible();
    await expect(page.getByTestId('inspector-project')).toHaveText('No project');
    // Moving keeps the chat's folder.
    await expect(page.getByTestId('workspace-root-value')).toHaveText(folder);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test('archiving a chat moves it to the archived section, and Unarchive brings it back', async ({ page }) => {
  const projectName = `E2E Archive ${randomUUID().slice(0, 8)}`;
  await page.goto('/');
  const nav = page.getByRole('navigation', { name: 'Chats' });

  await nav.getByRole('button', { name: '+ New project' }).click();
  const nameInput = nav.getByRole('textbox', { name: 'Project name' });
  await nameInput.fill(projectName);
  await nameInput.press('Enter');
  const group = nav.getByRole('group', { name: projectName });
  await expect(group).toBeVisible();

  await group.getByRole('button', { name: `New chat in ${projectName}` }).click();
  const row = group.locator('[data-testid^="chat-row-"]');
  await expect(row).toHaveCount(1);
  const rowTestId = (await row.getAttribute('data-testid'))!;

  // Archive it from its row menu: it leaves the group and the section appears.
  await row.hover();
  await row.getByRole('button', { name: 'Chat actions' }).click();
  await page.getByRole('menuitem', { name: 'Archive' }).click();
  await expect(group.locator('[data-testid^="chat-row-"]')).toHaveCount(0);
  const toggle = nav.getByRole('button', { name: 'Show archived (1)' });
  await expect(toggle).toBeVisible();

  // Open the section, Unarchive: it returns to its group.
  await toggle.click();
  const archivedRow = nav.getByTestId('archived-section').getByTestId(rowTestId);
  await expect(archivedRow).toBeVisible();
  await archivedRow.hover();
  await archivedRow.getByRole('button', { name: 'Chat actions' }).click();
  await page.getByRole('menuitem', { name: 'Unarchive' }).click();

  await expect(group.getByTestId(rowTestId)).toBeVisible();
  await expect(nav.getByTestId('archived-section')).toHaveCount(0);
});

test('dragging a chat onto the top half of another places it there, and the order survives a reload', async ({ page, request }) => {
  const projectName = `E2E Order ${randomUUID().slice(0, 8)}`;
  const project = (await (await request.post(`${BASE_URL}/api/projects`, { data: { name: projectName } })).json()) as { id: string };
  const ids: string[] = [];
  for (const title of ['first', 'second', 'third']) {
    const res = await request.post(`${BASE_URL}/api/chats`, { data: { projectId: project.id, title } });
    expect(res.ok()).toBeTruthy();
    ids.push(((await res.json()) as { id: string }).id);
    await new Promise((r) => setTimeout(r, 5)); // distinct createdAt, so a distinct starting order
  }
  const [first, second, third] = ids as [string, string, string];

  await page.goto('/');
  const group = page.getByRole('navigation', { name: 'Chats' }).getByRole('group', { name: projectName });
  const order = () => group.locator('[data-testid^="chat-row-"]').evaluateAll((els) => els.map((el) => el.getAttribute('data-testid')!.slice('chat-row-'.length)));
  await expect.poll(order).toEqual([third, second, first]);

  const source = group.getByTestId(`chat-row-${first}`).locator('[data-row-main]');
  const target = group.getByTestId(`chat-row-${third}`);
  await source.dragTo(target, { targetPosition: { x: 20, y: 2 } });
  await expect.poll(order).toEqual([first, third, second]);

  await page.reload();
  await expect.poll(order).toEqual([first, third, second]);
});
