import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { BASE_URL } from '../playwright.config.js';

/**
 * Import from claude.ai (spec 2026-10-09-claude-import-design): a small
 * export folder, checked and imported from Settings > Import, lands as a chat
 * with its reply labelled claude.ai and a new project.
 */
const ROOT = '00000000-0000-4000-8000-000000000000';
let dir: string;
const chatId = randomUUID();
const projectId = randomUUID();

test.beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'grunt-e2e-claude-export-'));
});

// The sidebar is shared by the specs after this one, and some of them need its rows to fit on screen.
test.afterEach(async ({ request }) => {
  rmSync(dir, { recursive: true, force: true });
  await request.delete(`${BASE_URL}/api/chats/${chatId}`);
  await request.delete(`${BASE_URL}/api/projects/${projectId}`);
});

test('imports a claude.ai export from Settings > Import', async ({ page, request }) => {
  const conn = await request.post(`${BASE_URL}/api/connections`, { data: { name: 'Mock', kind: 'mock' } });
  expect(conn.ok()).toBeTruthy();
  const { id: connectionId } = await conn.json();
  const profile = await request.post(`${BASE_URL}/api/profiles`, { data: { name: 'Import Profile', connectionId, modelId: 'mock-standard' } });
  expect(profile.ok()).toBeTruthy();

  const tag = randomUUID().slice(0, 8);
  const question = randomUUID();
  const at = (minute: number) => new Date(Date.UTC(2026, 0, 1, 12, minute)).toISOString();
  mkdirSync(join(dir, 'conversations'));
  writeFileSync(
    join(dir, 'conversations', 'conversations.json'),
    JSON.stringify([
      {
        uuid: chatId,
        name: `Imported ${tag}`,
        created_at: at(0),
        updated_at: at(2),
        chat_messages: [
          { uuid: question, sender: 'human', parent_message_uuid: ROOT, created_at: at(1), content: [{ type: 'text', text: `question ${tag}` }], attachments: [], files: [] },
          { uuid: randomUUID(), sender: 'assistant', parent_message_uuid: question, created_at: at(2), content: [{ type: 'text', text: `answer ${tag}` }], attachments: [], files: [] },
        ],
      },
    ])
  );
  mkdirSync(join(dir, 'projects'));
  writeFileSync(join(dir, 'projects', 'p.json'), JSON.stringify({ uuid: projectId, name: `Garden ${tag}`, description: '', prompt_template: 'Be brief.', docs: [] }));

  await page.goto('/');
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('tab', { name: 'Import' }).click();
  await page.getByLabel('Export folder').fill(dir);
  await page.getByRole('button', { name: 'Check folder' }).click();
  const preview = page.getByTestId('import-preview');
  await expect(preview).toContainText('1 chat (2 messages)');
  await expect(preview).toContainText(`Project “Garden ${tag}”: new, instructions`);

  await page.getByLabel('Profile for imported chats').selectOption({ label: 'Import Profile' });
  await page.getByRole('button', { name: 'Import 1 chat' }).click();
  const report = page.getByTestId('import-report');
  await expect(report).toContainText('Imported 1 chat (2 messages)');
  await expect(report).toContainText(`New projects: Garden ${tag}`);

  await page.getByRole('button', { name: 'Close settings' }).click();
  await page.locator('[data-testid^="chat-row-"]', { hasText: `Imported ${tag}` }).click();
  const thread = page.getByTestId('thread-scroll');
  await expect(thread.getByText(`question ${tag}`)).toBeVisible();
  await expect(thread.getByText(`answer ${tag}`)).toBeVisible();
  await expect(thread.getByText('claude.ai', { exact: true })).toBeVisible();
});
