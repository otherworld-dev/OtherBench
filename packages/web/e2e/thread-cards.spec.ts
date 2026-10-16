import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { BASE_URL } from '../playwright.config.js';

/**
 * Thread cards (spec 2026-10-12-thread-cards-design) in a real browser, on
 * the keyless mock connection: #todos (checklist), #ask (question card, tab
 * dot, reload) and #plan (Plan mode refuses a write, changes, approval, then
 * the write's own approval card). Names are unique per test: the e2e server
 * keeps one database for the whole run.
 */

const suffix = (): string => randomUUID().slice(0, 8);

async function seed(request: APIRequestContext, title: string, opts: { workspaceRoot?: string; toolPolicy?: Record<string, unknown> } = {}): Promise<{ chatId: string }> {
  const conn = await request.post(`${BASE_URL}/api/connections`, { data: { name: `Mock ${suffix()}`, kind: 'mock' } });
  expect(conn.ok()).toBeTruthy();
  const { id: connectionId } = (await conn.json()) as { id: string };
  const profile = await request.post(`${BASE_URL}/api/profiles`, {
    data: {
      name: `Cards ${suffix()}`,
      connectionId,
      modelId: 'mock-standard',
      isDefault: true,
      toolPolicy: opts.toolPolicy ?? { fs: 'off', shell: false, mcpServerIds: [], approvalMode: 'always_ask' },
    },
  });
  expect(profile.ok()).toBeTruthy();
  const { id: profileId } = (await profile.json()) as { id: string };
  const chat = await request.post(`${BASE_URL}/api/chats`, { data: { title, profileId, ...(opts.workspaceRoot ? { workspaceRoot: opts.workspaceRoot } : {}) } });
  expect(chat.ok()).toBeTruthy();
  return { chatId: ((await chat.json()) as { id: string }).id };
}

async function send(page: Page, text: string): Promise<void> {
  const textbox = page.getByRole('textbox', { name: /message/i });
  await textbox.fill(text);
  await textbox.press('Enter');
}

test('#todos: a live checklist under the reply and in the Inspector, folded once it ends, with no update_todos in the tools', async ({ page, request }) => {
  const title = `Cards todos ${suffix()}`;
  await seed(request, title);
  await page.goto('/');
  await page.getByRole('button', { name: title }).click();
  await send(page, '#todos');

  const reply = page.locator('article[data-role="assistant"]');
  const inspector = page.getByRole('complementary', { name: 'Inspector' });
  await expect(reply.getByTestId('todo-checklist')).toContainText('1 of 2 done');
  await expect(inspector.getByTestId('todo-checklist')).toContainText(/of 2 done/);

  await expect(page.getByLabel('streaming')).toHaveCount(0, { timeout: 15_000 });
  const checklist = reply.getByTestId('todo-checklist');
  await expect(checklist).toContainText('2 of 2 done');
  expect(await checklist.evaluate((d) => (d as HTMLDetailsElement).open)).toBe(false);
  await expect(reply).not.toContainText('update_todos');
  await expect(inspector.getByTestId('todo-checklist')).toHaveCount(0);
});

test('#ask: the question card marks the tab, survives a reload, and its answer reaches the model', async ({ page, request }) => {
  const title = `Cards ask ${suffix()}`;
  const { chatId } = await seed(request, title);
  await page.goto('/');
  await page.getByRole('button', { name: title }).click();
  await send(page, '#ask');

  const card = page.locator('[data-testid^="ask-card-"][data-kind="question"]');
  await expect(card).toBeVisible();
  await expect(card).toContainText('Which colour?');

  await page.getByRole('navigation', { name: 'Chats' }).getByTestId(`chat-row-${chatId}`).locator('[data-row-main]').click({ button: 'right' });
  await page.getByRole('menuitem', { name: /Open in new tab|Go to tab/ }).click();
  await expect(page.getByTestId(`tab-status-${chatId}`)).toHaveAttribute('data-status', 'waiting');

  await page.reload();
  await expect(card).toBeVisible();
  await card.getByRole('radio', { name: /^Blue/ }).check();
  await card.getByRole('button', { name: 'Send answer' }).click();
  await expect(card).toHaveCount(0);
  await expect(page.locator('article[data-role="assistant"] .markdown-body').getByText(/Blue/)).toBeVisible();
});

test('#plan: Plan mode refuses the write without a card, takes changes, then approval lets the write ask as usual', async ({ page, request }) => {
  const ws = mkdtempSync(join(tmpdir(), 'otherbench-e2e-plan-'));
  try {
    const title = `Cards plan ${suffix()}`;
    await seed(request, title, { workspaceRoot: ws, toolPolicy: { fs: 'readwrite', shell: false, mcpServerIds: [], approvalMode: 'always_ask' } });
    await page.goto('/');
    await page.getByRole('button', { name: title }).click();

    const pill = page.getByRole('button', { name: 'Plan mode' });
    await pill.click();
    await expect(pill).toHaveAttribute('aria-pressed', 'true');
    await send(page, '#plan');

    const card = page.locator('[data-testid^="ask-card-"][data-kind="plan"]');
    await expect(card).toBeVisible();
    await expect(card).toContainText('Write planned.txt');
    await expect(page.locator('[data-testid^="approval-prompt-"]')).toHaveCount(0);

    await card.getByRole('button', { name: 'Ask for changes' }).click();
    await card.getByRole('textbox', { name: 'Changes to the plan' }).fill('smaller');
    await card.getByRole('button', { name: 'Send changes' }).click();
    await expect(card).toContainText('revised');

    await card.getByRole('button', { name: 'Approve plan' }).click();
    const prompt = page.locator('[data-testid^="approval-prompt-"]');
    await expect(prompt).toBeVisible();
    await expect(prompt).toContainText('write_file');
    await prompt.getByRole('button', { name: 'Allow once' }).click();
    await expect(page.getByLabel('streaming')).toHaveCount(0, { timeout: 15_000 });
    expect(readFileSync(join(ws, 'planned.txt'), 'utf8')).toBe('planned');
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});
