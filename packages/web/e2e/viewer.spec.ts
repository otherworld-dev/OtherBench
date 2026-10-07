import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { BASE_URL } from '../playwright.config.js';

/**
 * The viewer (spec 2026-10-07-viewer): a file a tool read opens formatted in
 * the panel; a workspace HTML page runs in the sandbox and can't reach Grunt;
 * an image shows. Uses the keyless mock's `#tool <path>` (a real read_file).
 */
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
let ws: string;

test.beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), 'grunt-e2e-viewer-'));
  writeFileSync(join(ws, 'notes.md'), '# Viewer heading\n\nSome *notes*.');
  writeFileSync(
    join(ws, 'page.html'),
    '<!doctype html><body><p id="out">waiting</p><script>let r; try { r = parent.document.title; r = "reached the app"; } catch (e) { r = "isolated"; } document.getElementById("out").textContent = r;</script></body>'
  );
  writeFileSync(join(ws, 'pic.png'), PNG);
});

test.afterEach(() => {
  try {
    rmSync(ws, { recursive: true, force: true });
  } catch {
    /* best-effort cleanup */
  }
});

test('opens a file a tool read, a sandboxed page and an image in the viewer', async ({ page, request }) => {
  const suffix = randomUUID().slice(0, 8);
  const conn = await request.post(`${BASE_URL}/api/connections`, { data: { name: `Mock ${suffix}`, kind: 'mock' } });
  const { id: connectionId } = await conn.json();
  const profile = await request.post(`${BASE_URL}/api/profiles`, {
    data: { name: `Viewer ${suffix}`, connectionId, modelId: 'mock-standard', isDefault: true, toolPolicy: { fs: 'readwrite', shell: false, mcpServerIds: [], approvalMode: 'ask_on_mutate' } },
  });
  const { id: profileId } = await profile.json();
  const title = `Viewer E2E - ${suffix}`;
  expect((await request.post(`${BASE_URL}/api/chats`, { data: { title, profileId, workspaceRoot: ws } })).ok()).toBeTruthy();

  await page.goto('/');
  await page.getByRole('button', { name: title }).click();
  const textbox = page.getByRole('textbox', { name: /message/i });
  await textbox.fill('#tool notes.md');
  await textbox.press('Enter');
  await expect(page.getByLabel('streaming')).toHaveCount(0);

  await page.locator('article[data-role="assistant"] summary').first().click();
  await page.getByRole('button', { name: 'Open notes.md' }).click();
  const viewer = page.getByRole('complementary', { name: 'Viewer' });
  await expect(viewer.getByRole('heading', { name: 'Viewer heading' })).toBeVisible();

  const address = viewer.getByRole('textbox', { name: 'Open a path or web address' });
  await address.fill('page.html');
  await address.press('Enter');
  await expect(viewer.frameLocator('iframe[title="page.html"]').locator('#out')).toHaveText('isolated');

  await address.fill('pic.png');
  await address.press('Enter');
  const img = viewer.getByRole('img', { name: 'pic.png' });
  await expect(img).toBeVisible();
  expect(await img.evaluate((el) => (el as HTMLImageElement).naturalWidth)).toBe(1);
});
