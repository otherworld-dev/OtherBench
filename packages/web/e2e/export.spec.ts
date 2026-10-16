import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { BASE_URL } from '../playwright.config.js';

/** Export a chat from its row menu (#820): the download is the shown conversation as Markdown, or the tree as JSON. */
test.beforeEach(async ({ request }) => {
  const conn = await request.post(`${BASE_URL}/api/connections`, { data: { name: 'Mock', kind: 'mock' } });
  expect(conn.ok()).toBeTruthy();
  const { id: connectionId } = await conn.json();
  const profile = await request.post(`${BASE_URL}/api/profiles`, { data: { name: 'Mock Profile', connectionId, modelId: 'mock-standard', isDefault: true } });
  expect(profile.ok()).toBeTruthy();
});

test('exports a chat as Markdown and as JSON from its menu', async ({ page }) => {
  const question = `export check ${randomUUID().slice(0, 8)}`;
  await page.goto('/');
  await page.getByRole('button', { name: '+ New chat' }).click();
  const box = page.getByRole('textbox', { name: /message/i });
  await box.fill(question);
  await box.press('Enter');
  await expect(page.getByTestId('thread-scroll').getByText(/Here is a mock reply from OtherBench/)).toBeVisible();
  await expect(page.getByLabel('streaming')).toHaveCount(0);

  const row = page.locator('[aria-current="true"]').locator('xpath=ancestor::li[1]');
  async function exportAs(item: string) {
    await row.hover();
    await row.getByRole('button', { name: 'Chat actions' }).click();
    await page.getByRole('menuitem', { name: 'Export…' }).click();
    const download = page.waitForEvent('download');
    await page.getByRole('menuitem', { name: item }).click();
    return download;
  }

  const md = await exportAs('Markdown (shown conversation)');
  expect(md.suggestedFilename()).toMatch(/\.md$/);
  // A toast says it downloaded. In a browser there's no folder to show: the browser decides where it went.
  const toast = page.getByTestId('toast').filter({ hasText: `Downloaded ${md.suggestedFilename()}` });
  await expect(toast).toBeVisible();
  await expect(toast.getByRole('button', { name: 'Show in folder' })).toHaveCount(0);
  const text = readFileSync((await md.path())!, 'utf8');
  expect(text).toContain(`## You\n\n${question}`);
  // Which profile answers depends on what earlier specs left as the default, so match any "Profile (model)" heading.
  expect(text).toMatch(/\n## .+ \(.+\)\n\nHere is a mock reply from OtherBench/);

  const json = await exportAs('JSON (every branch)');
  expect(json.suggestedFilename()).toMatch(/\.json$/);
  const body = JSON.parse(readFileSync((await json.path())!, 'utf8')) as { format: string; messages: unknown[]; shownPath: string[] };
  expect(body.format).toBe('otherbench-chat-export');
  expect(body.messages).toHaveLength(2);
  expect(body.shownPath).toHaveLength(2);
});
