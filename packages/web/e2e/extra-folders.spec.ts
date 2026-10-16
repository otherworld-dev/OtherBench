import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { BASE_URL } from '../playwright.config.js';
import { openInspectorSection } from './inspector.js';

/**
 * Extra folders (spec 2026-10-07-extra-folders): a file outside the workspace
 * can't be read until its folder is added to the chat in the Inspector, and
 * then can, by its absolute path. Uses the keyless mock's `#tool <path>`,
 * which runs the real read_file through the real broker and fs tools.
 */
let workspaceRoot: string;
let otherFolder: string;

test.beforeEach(() => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'otherbench-e2e-folders-ws-'));
  otherFolder = mkdtempSync(join(tmpdir(), 'otherbench-e2e-folders-other-'));
  writeFileSync(join(otherFolder, 'notes.txt'), 'THE MAP IS IN THE OTHER FOLDER');
});

test.afterEach(() => {
  for (const dir of [workspaceRoot, otherFolder]) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
  }
});

test('a file in another folder is out of reach until that folder is added to the chat', async ({ page, request }) => {
  const suffix = randomUUID().slice(0, 8);
  const conn = await request.post(`${BASE_URL}/api/connections`, { data: { name: `Mock ${suffix}`, kind: 'mock' } });
  const { id: connectionId } = await conn.json();
  const profile = await request.post(`${BASE_URL}/api/profiles`, {
    data: {
      name: `Folders Profile ${suffix}`,
      connectionId,
      modelId: 'mock-standard',
      isDefault: true,
      // Reads run without asking, so the only thing deciding this read is where the file is.
      toolPolicy: { fs: 'readwrite', shell: false, mcpServerIds: [], approvalMode: 'ask_on_mutate' },
    },
  });
  const { id: profileId } = await profile.json();
  const chatTitle = `Extra Folders E2E - ${suffix}`;
  const chat = await request.post(`${BASE_URL}/api/chats`, { data: { title: chatTitle, profileId, workspaceRoot } });
  expect(chat.ok()).toBeTruthy();

  await page.goto('/');
  await page.getByRole('button', { name: chatTitle }).click();
  const textbox = page.getByRole('textbox', { name: /message/i });
  const replies = page.locator('article[data-role="assistant"] .markdown-body');
  const file = join(otherFolder, 'notes.txt');

  await textbox.fill(`#tool ${file}`);
  await textbox.press('Enter');
  await expect(replies.last()).toContainText('did not go through');
  await expect(page.getByLabel('streaming')).toHaveCount(0);

  // Add the folder, read-only, from the Inspector.
  const folders = await openInspectorSection(page, 'Other folders');
  await folders.getByRole('textbox', { name: 'Add a folder for this chat' }).fill(otherFolder);
  await folders.getByRole('button', { name: 'Add' }).click();
  await expect(folders.getByTestId('extra-folder')).toContainText(otherFolder);
  await expect(folders.getByRole('combobox', { name: `Access to ${otherFolder}` })).toHaveValue('read');

  await textbox.fill(`#tool ${file}`);
  await textbox.press('Enter');
  await expect(replies).toHaveCount(2);
  await expect(replies.last()).toContainText('THE MAP IS IN THE OTHER FOLDER');
  await expect(page.getByLabel('streaming')).toHaveCount(0);
});
