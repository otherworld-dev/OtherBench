import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type Locator } from '@playwright/test';
import { BASE_URL } from '../playwright.config.js';

/**
 * Lists in rendered Markdown show their numbers and bullets: Tailwind's reset
 * clears list-style, and `.markdown-body` puts it back. Checked in a chat reply
 * (the mock's `#lists`) and in a workspace file open in the viewer.
 */
let ws: string;

test.beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), 'grunt-e2e-lists-'));
  writeFileSync(join(ws, 'lists.md'), '# Lists\n\n3. Third\n4. Fourth\n\n- Apples\n  - Green\n- [ ] Task\n\nMixed:\n\n1. Outer\n   - Middle\n     1. Inner\n\nSame type:\n\n1. Top\n   1. Sub\n');
});

test.afterEach(() => {
  try {
    rmSync(ws, { recursive: true, force: true });
  } catch {
    /* best-effort cleanup */
  }
});

const listStyle = (el: Locator) => el.evaluate((node) => getComputedStyle(node).listStyleType);

test('numbered and bulleted lists keep their markers in a chat reply and in the viewer', async ({ page, request }) => {
  const suffix = randomUUID().slice(0, 8);
  const conn = await request.post(`${BASE_URL}/api/connections`, { data: { name: `Mock ${suffix}`, kind: 'mock' } });
  const { id: connectionId } = await conn.json();
  const profile = await request.post(`${BASE_URL}/api/profiles`, {
    data: { name: `Lists ${suffix}`, connectionId, modelId: 'mock-standard', isDefault: true, toolPolicy: { fs: 'readwrite', shell: false, mcpServerIds: [], approvalMode: 'ask_on_mutate' } },
  });
  const { id: profileId } = await profile.json();
  const title = `Lists E2E - ${suffix}`;
  expect((await request.post(`${BASE_URL}/api/chats`, { data: { title, profileId, workspaceRoot: ws } })).ok()).toBeTruthy();

  await page.goto('/');
  await page.getByRole('button', { name: title }).click();
  const textbox = page.getByRole('textbox', { name: /message/i });
  await textbox.fill('#lists');
  await textbox.press('Enter');
  await expect(page.getByLabel('streaming')).toHaveCount(0);

  const reply = page.locator('article[data-role="assistant"] .markdown-body').first();
  await expect(reply.locator('ol').first()).toBeVisible();
  expect(await listStyle(reply.locator('ol').first())).toBe('decimal');
  expect(await listStyle(reply.locator('ul').first())).toBe('disc');
  expect(await listStyle(reply.locator('ul ul'))).toBe('circle');
  // The second numbered list carries on from 3, and a task-list item shows its checkbox, not a bullet.
  await expect(reply.locator('ol[start="3"]')).toHaveCount(1);
  expect(await listStyle(reply.locator('li.task-list-item').first())).toBe('none');

  // The same rule in a file the viewer shows.
  await textbox.fill('#tool lists.md');
  await textbox.press('Enter');
  await expect(page.getByLabel('streaming')).toHaveCount(0);
  await page.locator('article[data-role="assistant"] summary').last().click();
  await page.getByRole('button', { name: 'Open lists.md' }).click();
  const viewer = page.getByRole('complementary', { name: 'Viewer' });
  await expect(viewer.getByRole('heading', { name: 'Lists' })).toBeVisible();
  const topOl = viewer.locator('.markdown-body > ol').first();
  expect(await listStyle(topOl)).toBe('decimal');
  await expect(topOl).toHaveAttribute('start', '3');
  expect(await listStyle(viewer.locator('.markdown-body > ul').first())).toBe('disc');
  // Only same-type nesting changes the marker: an ol inside a ul inside an ol stays decimal, an ol inside an ol is lower-alpha.
  expect(await listStyle(viewer.locator('.markdown-body ol > li > ul > li > ol'))).toBe('decimal');
  expect(await listStyle(viewer.locator('.markdown-body ol > li > ol'))).toBe('lower-alpha');
});
