import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type APIRequestContext } from '@playwright/test';
import { BASE_URL } from '../playwright.config.js';

/**
 * Sub-agents for API profiles (spec 2026-10-12-api-subagents-design), on the
 * keyless mock connection: `#subagents <rest>` makes the parent call the real
 * `subagent` tool twice at once. The first helper's prompt is the rest of the
 * line, so `#tool secrets.txt` makes that sub-agent call the real, gated
 * read_file on a real file; the second just says hello.
 */

let workspaceRoot: string;

test.beforeEach(() => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'otherbench-e2e-subagents-'));
  writeFileSync(join(workspaceRoot, 'secrets.txt'), 'THE TREASURE IS BURIED UNDER THE OAK TREE');
});

test.afterEach(() => {
  try {
    rmSync(workspaceRoot, { recursive: true, force: true });
  } catch {
    /* best-effort cleanup */
  }
});

const suffix = (): string => randomUUID().slice(0, 8);

async function seed(request: APIRequestContext, chatTitle: string): Promise<{ chatId: string; profileId: string }> {
  const conn = await request.post(`${BASE_URL}/api/connections`, { data: { name: `Mock ${suffix()}`, kind: 'mock' } });
  expect(conn.ok()).toBeTruthy();
  const { id: connectionId } = await conn.json();
  const profile = await request.post(`${BASE_URL}/api/profiles`, {
    data: {
      name: `Sub-agents ${suffix()}`,
      connectionId,
      modelId: 'mock-standard',
      isDefault: true,
      toolPolicy: { fs: 'read', shell: false, mcpServerIds: [], approvalMode: 'always_ask', subagents: true },
    },
  });
  expect(profile.ok()).toBeTruthy();
  const { id: profileId } = await profile.json();
  const chat = await request.post(`${BASE_URL}/api/chats`, { data: { title: chatTitle, profileId, workspaceRoot } });
  expect(chat.ok()).toBeTruthy();
  const { id: chatId } = await chat.json();
  return { chatId, profileId };
}

test('two sub-agents run at once, one waits on its own card, and their cards survive a reload', async ({ page, request }) => {
  const chatTitle = `Sub-agents E2E - run - ${suffix()}`;
  const { chatId, profileId } = await seed(request, chatTitle);

  await page.goto('/');
  await page.getByRole('button', { name: chatTitle }).click();
  const textbox = page.getByRole('textbox', { name: /message/i });
  await textbox.fill('#subagents read #tool secrets.txt');
  await textbox.press('Enter');

  const cards = page.getByTestId('subagent-card');
  const first = cards.filter({ hasText: 'First helper' });
  const second = cards.filter({ hasText: 'Second helper' });
  await expect(cards).toHaveCount(2, { timeout: 15_000 });

  const prompt = page.locator('[data-testid^="approval-prompt-"]');
  await expect(prompt).toBeVisible();
  await expect(prompt).toContainText('Sub-agent: First helper');
  await expect(prompt).toContainText('read_file');
  // It ran alongside: the second helper is done while the first still waits on its card.
  await expect(second).toHaveAttribute('data-status', 'complete');
  await expect(first).toContainText('needs your approval');

  await prompt.getByRole('button', { name: 'Allow once' }).click();
  await expect(prompt).toHaveCount(0);
  await expect(first).toHaveAttribute('data-status', 'complete');
  await expect(page.getByLabel('streaming')).toHaveCount(0, { timeout: 15_000 });

  const answer = page.locator('article[data-role="assistant"]').getByText(/Sub-agents answered:/);
  await expect(answer).toContainText('THE TREASURE IS BURIED UNDER THE OAK TREE');
  await expect(answer).toContainText('Here is a mock reply from OtherBench');

  // The two helper cards sit side by side, so they share one closed fold.
  const fold = page.getByTestId('activity-fold');
  await expect(fold.locator('summary').first()).toContainText('2 helpers');
  await fold.locator('summary').first().click();
  await first.locator('summary').first().click();
  await expect(first.getByText(/Used 1 tool: read_file/)).toBeVisible();

  await page.reload();
  await page.getByTestId(`chat-row-${chatId}`).locator('[data-row-main]').click();
  await expect(cards).toHaveCount(2);
  await expect(first).toHaveAttribute('data-status', 'complete');
  await expect(second).toHaveAttribute('data-status', 'complete');
  expect(await first.evaluate((el) => (el as HTMLDetailsElement).open)).toBe(false);

  const usage = await request.get(`${BASE_URL}/api/usage?chatId=${chatId}`);
  expect(usage.ok()).toBeTruthy();
  const rollup = (await usage.json()) as { profiles: { profileId: string; subagentCount: number; completeCount: number }[] };
  expect(rollup.profiles.find((p) => p.profileId === profileId)).toMatchObject({ subagentCount: 2, completeCount: 1 });
});

test('Stop while a sub-agent waits on its card stops it and the reply', async ({ page, request }) => {
  const chatTitle = `Sub-agents E2E - stop - ${suffix()}`;
  await seed(request, chatTitle);

  await page.goto('/');
  await page.getByRole('button', { name: chatTitle }).click();
  const textbox = page.getByRole('textbox', { name: /message/i });
  await textbox.fill('#subagents read #tool secrets.txt');
  await textbox.press('Enter');

  const prompt = page.locator('[data-testid^="approval-prompt-"]');
  await expect(prompt).toBeVisible({ timeout: 15_000 });
  await page.getByRole('button', { name: 'Stop', exact: true }).click();

  await expect(prompt).toHaveCount(0);
  const first = page.getByTestId('subagent-card').filter({ hasText: 'First helper' });
  await expect(first).toHaveAttribute('data-status', 'cancelled');
  await expect(first).toContainText('stopped');
  await expect(page.locator('article[data-role="assistant"]').last()).toHaveAttribute('data-status', 'cancelled');
});
