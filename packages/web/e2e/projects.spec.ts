import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
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
  const folder = mkdtempSync(join(tmpdir(), 'otherbench-e2e-project-'));
  try {
    await page.goto('/');
    const nav = page.getByRole('navigation', { name: 'Chats' });

    // Create the project, with its folder, on the project page.
    await nav.getByRole('button', { name: 'New project' }).click();
    const projectPage = page.getByTestId('project-view');
    await projectPage.getByRole('textbox', { name: 'Name' }).fill(projectName);
    await projectPage.getByRole('textbox', { name: 'Main folder' }).fill(folder);
    await projectPage.getByRole('button', { name: 'Create project' }).click();
    await expect(projectPage).toHaveCount(0);
    const group = nav.getByRole('group', { name: projectName });
    await expect(group).toBeVisible();

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

  await nav.getByRole('button', { name: 'New project' }).click();
  await page.getByRole('textbox', { name: 'Name' }).fill(projectName);
  await page.getByRole('button', { name: 'Create project' }).click();
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

/** Picks a layout from the tab bar's Layout dropdown. */
async function chooseLayout(page: Page, name: string): Promise<void> {
  await page.getByRole('button', { name: /^Layout: / }).click();
  await page.getByRole('menuitemradio', { name }).click();
}

test('Open in new tab from any project, two side by side, and tabs and layout survive a reload (#824)', async ({ page, request }) => {
  const run = randomUUID().slice(0, 8);
  const project = (await (await request.post(`${BASE_URL}/api/projects`, { data: { name: `E2E Tabs ${run}` } })).json()) as { id: string };
  const inProject = (await (await request.post(`${BASE_URL}/api/chats`, { data: { projectId: project.id, title: `Planning ${run}` } })).json()) as { id: string };
  const profiles = (await (await request.get(`${BASE_URL}/api/profiles`)).json()) as { id: string }[];
  const loose = (await (await request.post(`${BASE_URL}/api/chats`, { data: { profileId: profiles[0]!.id, title: `Admin ${run}` } })).json()) as { id: string };

  await page.goto('/');
  const nav = page.getByRole('navigation', { name: 'Chats' });
  // A sidebar click shows a chat without opening a tab.
  await nav.getByTestId(`chat-row-${loose.id}`).locator('[data-row-main]').click();
  await expect(page.getByTestId('tab-bar')).toHaveCount(0);

  // Opening another chat in a new tab keeps the one on show as a tab too, rather than replacing it.
  await nav.getByTestId(`chat-row-${inProject.id}`).locator('[data-row-main]').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Open in new tab' }).click();
  const tabs = page.getByRole('tablist', { name: 'Open tabs' }).getByRole('tab');
  await expect(tabs).toHaveCount(2);
  await expect(tabs.nth(0)).toContainText(`Admin ${run}`);
  await nav.getByTestId(`chat-row-${loose.id}`).locator('[data-row-main]').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Go to tab' }).click();

  await chooseLayout(page, 'Two side by side');
  const main = page.getByRole('main');
  await expect(main.getByTestId('pane-0')).toContainText(`Admin ${run}`);
  await expect(main.getByTestId('pane-1')).toContainText(`Planning ${run}`);
  await main.getByTestId('pane-1').click();
  await expect(main.getByTestId('pane-1')).toHaveAttribute('data-focused', 'true');

  await page.reload();
  await expect(tabs).toHaveCount(2);
  await expect(page.getByRole('button', { name: 'Layout: Two side by side' })).toBeVisible();
  await expect(main.getByTestId('pane-0')).toContainText(`Admin ${run}`);
  await expect(main.getByTestId('pane-1')).toContainText(`Planning ${run}`);

  // Back to one chat for whatever runs next in this browser.
  await chooseLayout(page, 'One chat');
  await page.getByRole('button', { name: `Close tab Admin ${run}` }).click();
  await expect(tabs).toHaveCount(1);
  await expect(nav.getByTestId(`chat-row-${loose.id}`)).toBeVisible();
});

test('dragging a divider resizes panes and is remembered; Ctrl+Shift+Enter maximises the focused pane (#824)', async ({ page, request }) => {
  const run = randomUUID().slice(0, 8);
  const profiles = (await (await request.get(`${BASE_URL}/api/profiles`)).json()) as { id: string }[];
  const ids: string[] = [];
  for (const title of [`One ${run}`, `Two ${run}`]) {
    ids.push(((await (await request.post(`${BASE_URL}/api/chats`, { data: { profileId: profiles[0]!.id, title } })).json()) as { id: string }).id);
  }

  await page.goto('/');
  const nav = page.getByRole('navigation', { name: 'Chats' });
  for (const id of ids) {
    await nav.getByTestId(`chat-row-${id}`).locator('[data-row-main]').click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Open in new tab' }).click();
  }
  await chooseLayout(page, 'Two side by side');
  const main = page.getByRole('main');
  const left = main.getByTestId('pane-0');
  const before = (await left.boundingBox())!.width;

  const divider = main.getByRole('separator', { name: 'Resize panes' });
  const box = (await divider.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 150, box.y + box.height / 2, { steps: 5 });
  await page.mouse.up();
  await expect.poll(async () => (await left.boundingBox())!.width).toBeGreaterThan(before + 100);

  await page.reload();
  await expect.poll(async () => (await main.getByTestId('pane-0').boundingBox())!.width).toBeGreaterThan(before + 100);

  await main.getByTestId('pane-1').click();
  await page.keyboard.press('Control+Shift+Enter');
  await expect(main.getByTestId('pane-0')).toBeHidden();
  await expect(main.getByRole('button', { name: 'Restore pane' })).toBeVisible();
  await page.keyboard.press('Control+Shift+Enter');
  await expect(main.getByTestId('pane-0')).toBeVisible();

  // Back to one chat for whatever runs next in this browser.
  await chooseLayout(page, 'One chat');
});

test("a project's instructions, set from Project settings…, reach the model in every chat", async ({ page, request }) => {
  const projectName = `E2E Instructions ${randomUUID().slice(0, 8)}`;
  const rule = `rule-${randomUUID().slice(0, 8)}`;
  const created = await request.post(`${BASE_URL}/api/projects`, { data: { name: projectName } });
  expect(created.ok()).toBeTruthy();

  await page.goto('/');
  const nav = page.getByRole('navigation', { name: 'Chats' });
  const group = nav.getByRole('group', { name: projectName });

  // Set the instructions on the project page, opened from the project's ⋯ menu.
  await group.getByRole('button', { name: 'Project actions' }).click();
  await page.getByRole('menuitem', { name: 'Project settings…' }).click();
  const projectPage = page.getByTestId('project-view');
  await projectPage.getByRole('textbox', { name: 'Instructions' }).fill(`Always mention ${rule}.`);
  await projectPage.getByRole('button', { name: 'Save' }).click();
  await expect(projectPage).toHaveCount(0);

  // A chat in the project: the mock model echoes its system prompt.
  await group.getByRole('button', { name: `New chat in ${projectName}` }).click();
  await expect(group.locator('[data-testid^="chat-row-"]')).toHaveCount(1);
  const textbox = page.getByRole('textbox', { name: /message/i });
  await textbox.fill('#echo-system');
  await textbox.press('Enter');

  const reply = page.locator('article[data-role="assistant"] .markdown-body');
  await expect(reply).toContainText(`Project instructions: ${projectName}`);
  await expect(reply).toContainText(`Always mention ${rule}.`);
  await expect(page.getByLabel('streaming')).toHaveCount(0);
});

test("a sub-project made from its parent's menu nests in the sidebar, its chats get the parent's instructions, and it outlives its parent", async ({ page, request }) => {
  const parentName = `E2E Parent ${randomUUID().slice(0, 8)}`;
  const subName = `E2E Sub ${randomUUID().slice(0, 8)}`;
  const rule = `rule-${randomUUID().slice(0, 8)}`;
  const created = await request.post(`${BASE_URL}/api/projects`, { data: { name: parentName, instructions: `Always mention ${rule}.` } });
  expect(created.ok()).toBeTruthy();

  await page.goto('/');
  const nav = page.getByRole('navigation', { name: 'Chats' });
  const parentGroup = nav.getByRole('group', { name: parentName });

  // New sub-project… from the parent's ⋯ menu: the page opens with the parent chosen.
  await parentGroup.getByRole('button', { name: 'Project actions' }).first().click();
  await page.getByRole('menuitem', { name: 'New sub-project…' }).click();
  const projectPage = page.getByTestId('project-view');
  await expect(projectPage.getByRole('combobox', { name: 'Parent' })).toHaveValue(/.+/);
  await expect(projectPage.getByTestId('inherited-instructions')).toContainText(rule);
  await projectPage.getByRole('textbox', { name: 'Name' }).fill(subName);
  await projectPage.getByRole('button', { name: 'Create project' }).click();
  await expect(projectPage).toHaveCount(0);

  // It sits inside the parent's group.
  const subGroup = parentGroup.getByRole('group', { name: subName });
  await expect(subGroup).toBeVisible();

  // A chat in the sub-project: the mock model echoes its system prompt, which carries the parent's instructions.
  await subGroup.getByRole('button', { name: `New chat in ${subName}` }).click();
  await expect(subGroup.locator('[data-testid^="chat-row-"]')).toHaveCount(1);
  const textbox = page.getByRole('textbox', { name: /message/i });
  await textbox.fill('#echo-system');
  await textbox.press('Enter');
  const reply = page.locator('article[data-role="assistant"] .markdown-body');
  await expect(reply).toContainText(`Project instructions: ${parentName}`);
  await expect(reply).toContainText(`Always mention ${rule}.`);
  await expect(page.getByLabel('streaming')).toHaveCount(0);

  // Deleting the parent leaves the sub-project, now at the top level, with its chat.
  await parentGroup.getByRole('button', { name: 'Project actions' }).first().click();
  await page.getByRole('menuitem', { name: 'Delete…' }).click();
  await expect(page.getByRole('alertdialog')).toContainText('Its sub-projects become top-level projects.');
  await page.getByRole('alertdialog').getByRole('button', { name: 'Delete' }).click();
  await expect(nav.getByRole('group', { name: parentName })).toHaveCount(0);
  const topLevel = nav.getByRole('group', { name: subName });
  await expect(topLevel).toBeVisible();
  await expect(topLevel.locator('[data-testid^="chat-row-"]')).toHaveCount(1);
});

test('dragging a project heading onto the top half of another puts it above, and the order survives a reload', async ({ page, request }) => {
  const tag = randomUUID().slice(0, 8);
  const names = [`E2E Drag first ${tag}`, `E2E Drag second ${tag}`];
  const ids: string[] = [];
  for (const name of names) {
    const res = await request.post(`${BASE_URL}/api/projects`, { data: { name } });
    expect(res.ok()).toBeTruthy();
    ids.push(((await res.json()) as { id: string }).id);
  }
  const [first, second] = ids as [string, string];

  await page.goto('/');
  const nav = page.getByRole('navigation', { name: 'Chats' });
  const order = () =>
    nav.locator('[data-testid^="group-heading-"]').evaluateAll(
      (els, mine) => els.map((el) => el.getAttribute('data-testid')!.slice('group-heading-'.length)).filter((id) => mine.includes(id)),
      ids
    );
  await expect.poll(order).toEqual([first, second]);

  const source = nav.getByTestId(`group-heading-${second}`).locator('[data-heading-main]');
  const target = nav.getByTestId(`group-heading-${first}`);
  await source.dragTo(target, { targetPosition: { x: 40, y: 2 } });
  await expect.poll(order).toEqual([second, first]);

  await page.reload();
  await expect.poll(order).toEqual([second, first]);
});
