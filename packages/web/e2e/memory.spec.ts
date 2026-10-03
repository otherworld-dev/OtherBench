import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { BASE_URL } from '../playwright.config.js';

/**
 * Project memory (spec docs/superpowers/specs/2026-10-03-project-memory-design.md §7):
 * edit a project's memory in the Inspector, then send a turn in a chat of that
 * project with the keyless mock profile. The mock's `#echo-system` trigger
 * replies with the system prompt it received, so the note showing up in the
 * reply proves the model saw it.
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

test("a project's edited memory reaches the model in its system prompt", async ({ page, request }) => {
  const projectName = `E2E Memory ${randomUUID().slice(0, 8)}`;
  const fact = `pinned-fact-${randomUUID().slice(0, 8)}`;
  const created = await request.post(`${BASE_URL}/api/projects`, { data: { name: projectName } });
  expect(created.ok()).toBeTruthy();

  await page.goto('/');
  const nav = page.getByRole('navigation', { name: 'Chats' });
  const group = nav.getByRole('group', { name: projectName });
  await group.getByRole('button', { name: `New chat in ${projectName}` }).click();
  await expect(group.locator('[data-testid^="chat-row-"]')).toHaveCount(1);

  // Edit the project's memory from the Inspector.
  const memory = page.getByTestId('memory-section');
  await expect(memory.getByTestId('memory-updated')).toHaveText('Not saved yet');
  await memory.getByRole('button', { name: 'Edit' }).click();
  await memory
    .getByRole('textbox', { name: 'Project memory' })
    .fill(`## Pinned\n- ${fact}\n\n## Goals\n- Prove memory reaches the model\n\n## Decisions\n\n## Current focus\n\n## Open questions`);
  await memory.getByRole('button', { name: 'Save' }).click();
  await expect(memory.getByTestId('memory-note')).toContainText(fact);
  await expect(memory.getByTestId('memory-updated')).toContainText('by you');

  // A turn in this chat: the mock model echoes its system prompt.
  const textbox = page.getByRole('textbox', { name: /message/i });
  await textbox.fill('#echo-system');
  await textbox.press('Enter');

  const reply = page.locator('article[data-role="assistant"] .markdown-body');
  await expect(reply).toContainText(`Project memory: ${projectName}`);
  await expect(reply).toContainText(fact);
  await expect(reply).toContainText('Background notes distilled from earlier chats in this project.');
  await expect(page.getByLabel('streaming')).toHaveCount(0);
});
