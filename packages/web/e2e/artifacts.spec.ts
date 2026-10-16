import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type APIRequestContext } from '@playwright/test';
import { BASE_URL } from '../playwright.config.js';

/**
 * Artifacts (spec 2026-10-07-artifacts): the Mock model's `#artifact` makes an
 * HTML page through the real tool; its card opens it in the viewer's sandbox;
 * an edit makes v2; Save to workspace writes the file.
 */
let ws: string;
test.beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), 'otherbench-e2e-artifacts-'));
});
test.afterEach(() => {
  try {
    rmSync(ws, { recursive: true, force: true });
  } catch {
    /* best-effort cleanup */
  }
});

/** A Mock profile and a chat in `ws`; returns the chat's title. */
async function mockChat(request: APIRequestContext): Promise<string> {
  const suffix = randomUUID().slice(0, 8);
  const conn = await request.post(`${BASE_URL}/api/connections`, { data: { name: `Mock ${suffix}`, kind: 'mock' } });
  const { id: connectionId } = await conn.json();
  const profile = await request.post(`${BASE_URL}/api/profiles`, {
    data: { name: `Artifacts ${suffix}`, connectionId, modelId: 'mock-standard', isDefault: true, toolPolicy: { fs: 'off', shell: false, mcpServerIds: [], approvalMode: 'always_ask' } },
  });
  const { id: profileId } = await profile.json();
  const title = `Artifacts E2E - ${suffix}`;
  expect((await request.post(`${BASE_URL}/api/chats`, { data: { title, profileId, workspaceRoot: ws } })).ok()).toBeTruthy();
  return title;
}

test('the model makes a page; it opens sandboxed, takes an edit, and saves to the workspace', async ({ page, request }) => {
  const title = await mockChat(request);
  await page.goto('/');
  await page.getByRole('button', { name: title }).click();
  const textbox = page.getByRole('textbox', { name: /message/i });
  await textbox.fill('#artifact');
  await textbox.press('Enter');
  await expect(page.getByLabel('streaming')).toHaveCount(0);

  await page.getByRole('button', { name: /Mock page.*Created v1/ }).click();
  const viewer = page.getByRole('complementary', { name: 'Viewer' });
  await expect(viewer.frameLocator('iframe[title="page.html"]').locator('#h')).toHaveText('Mock artifact');

  await viewer.getByRole('button', { name: 'Edit' }).click();
  await viewer.getByRole('textbox', { name: 'Artifact source' }).fill('<!doctype html><h1 id="h">Edited</h1>');
  await viewer.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(viewer.getByRole('combobox', { name: 'Version' })).toHaveValue(/.+/);
  await expect(viewer.frameLocator('iframe[title="page.html"]').locator('#h')).toHaveText('Edited');

  await viewer.getByRole('button', { name: 'Save to workspace' }).click();
  await viewer.getByRole('button', { name: 'Save file' }).click();
  await expect(viewer.getByRole('status')).toContainText('Saved to');
  expect(readFileSync(join(ws, 'page.html'), 'utf8')).toContain('Edited');
});

test("an open viewer lists the page as the reply makes it, and opens it following the branch", async ({ page, request }) => {
  const title = await mockChat(request);
  await page.goto('/');
  await page.getByRole('button', { name: title }).click();
  await page.getByRole('button', { name: 'Viewer', exact: true }).click();
  const viewer = page.getByRole('complementary', { name: 'Viewer' });

  const textbox = page.getByRole('textbox', { name: /message/i });
  await textbox.fill('#artifact');
  await textbox.press('Enter');
  await expect(page.getByLabel('streaming')).toHaveCount(0);

  const listed = viewer.getByRole('list', { name: 'Artifacts' }).getByRole('button', { name: /Mock page/ });
  await expect(listed).toBeVisible();
  await listed.click();
  await expect(viewer.frameLocator('iframe[title="page.html"]').locator('#h')).toHaveText('Mock artifact');
});
