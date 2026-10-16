import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import { formatInZone } from '@otherbench/core/domain/schedule.js';
import { BASE_URL } from '../playwright.config.js';

/**
 * Scheduled tasks (spec docs/superpowers/specs/2026-10-12-scheduled-tasks-design.md §7.2).
 * Every schedule is set for twelve hours from now, so nothing fires on its own
 * during the run; each test uses Run now, which runs exactly as a scheduled
 * run does (unattended). The keyless Mock model answers.
 */

/** HH:MM twelve hours from now, in this machine's zone (the server's too). */
function laterTime(): string {
  const d = new Date(Date.now() + 12 * 60 * 60_000);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

const suffix = (): string => randomUUID().slice(0, 8);

async function mockProfile(request: APIRequestContext): Promise<string> {
  const s = suffix();
  const conn = await request.post(`${BASE_URL}/api/connections`, { data: { name: `Mock ${s}`, kind: 'mock' } });
  expect(conn.ok()).toBeTruthy();
  const { id: connectionId } = (await conn.json()) as { id: string };
  const profile = await request.post(`${BASE_URL}/api/profiles`, { data: { name: `Scheduled ${s}`, connectionId, modelId: 'mock-standard' } });
  expect(profile.ok()).toBeTruthy();
  return ((await profile.json()) as { id: string }).id;
}

async function newChat(request: APIRequestContext, profileId: string): Promise<string> {
  const res = await request.post(`${BASE_URL}/api/chats`, { data: { title: `Sched chat ${suffix()}`, profileId, workspaceRoot: null } });
  expect(res.ok()).toBeTruthy();
  return ((await res.json()) as { id: string }).id;
}

async function fillEditor(page: Page, name: string, prompt: string): Promise<void> {
  const dialog = page.getByRole('dialog', { name: 'New schedule' });
  await dialog.getByLabel('Name').fill(name);
  await dialog.getByLabel('Prompt').fill(prompt);
  await dialog.getByLabel('Repeats').selectOption('daily');
  await dialog.getByLabel('Time').fill(laterTime());
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(dialog).toHaveCount(0);
}

function row(page: Page, name: string): Locator {
  return page.getByTestId('schedules-view').locator('[data-testid^="schedule-row-"]').filter({ hasText: name });
}

/** Run now, open the history, and wait for the newest run to complete. Returns that run's history line. */
async function runNowAndWait(page: Page, name: string): Promise<Locator> {
  const r = row(page, name);
  await r.getByRole('button', { name: 'Run now' }).click();
  await r.getByRole('button', { name: 'History' }).click();
  const newest = r.locator('[data-testid^="schedule-run-"]').first();
  await expect(newest.getByTestId('run-status')).toHaveText('Complete', { timeout: 20_000 });
  return newest;
}

test("a chat schedule: made from the chat's menu, run by hand, its reply in the chat", async ({ page, request }) => {
  const profileId = await mockProfile(request);
  const chatId = await newChat(request, profileId);
  const name = `Daily hello ${suffix()}`;

  await page.goto('/');
  await page.getByTestId(`chat-row-${chatId}`).locator('[data-row-main]').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Schedule…' }).click();
  await fillEditor(page, name, 'hello');
  await expect(row(page, name).getByTestId('schedule-next')).toContainText('Next run:');
  await expect(row(page, name).getByTestId('schedule-next')).not.toContainText('Paused');

  const run = await runNowAndWait(page, name);
  await run.getByRole('button', { name: 'Open' }).click();
  await expect(page.getByTestId('schedules-view')).toHaveCount(0);
  const asked = page.locator('article[data-role="user"]').last();
  await expect(asked).toContainText(`Run by hand from schedule "${name}"`);
  await expect(asked).toContainText('Nobody is watching this run');
  await expect(asked).toContainText('hello');
  await expect(page.locator('article[data-role="assistant"] .markdown-body').last()).toContainText('mock reply');
});

test('a project schedule makes a chat in the project, titled with the name and date', async ({ page, request }) => {
  const profileId = await mockProfile(request);
  const projectName = `Sched project ${suffix()}`;
  const created = await request.post(`${BASE_URL}/api/projects`, { data: { name: projectName, defaultProfileId: profileId } });
  expect(created.ok()).toBeTruthy();
  const name = `Report ${suffix()}`;

  await page.goto('/');
  const group = page.getByRole('navigation', { name: 'Chats' }).getByRole('group', { name: projectName });
  await group.hover();
  await group.getByRole('button', { name: 'Project actions' }).click();
  await page.getByRole('menuitem', { name: 'Schedule…' }).click();
  await fillEditor(page, name, 'hello');
  await runNowAndWait(page, name);
  await page.getByRole('button', { name: 'Close schedules' }).click();

  const title = `${name} · ${formatInZone(Date.now(), Intl.DateTimeFormat().resolvedOptions().timeZone, 'short')}`;
  await expect(group.locator('[data-testid^="chat-row-"]').filter({ hasText: title })).toHaveCount(1);
});

test('an unattended run refuses a tool call that needs approval, and no card appears', async ({ page, request }) => {
  const profileId = await mockProfile(request);
  const chatId = await newChat(request, profileId);
  const name = `Recall ${suffix()}`;
  const created = await request.post(`${BASE_URL}/api/schedules`, {
    data: { name, prompt: '#recall anything', profileId, target: { chatId }, rule: { cadence: 'daily', time: laterTime() } },
  });
  expect(created.status()).toBe(201);

  await page.goto('/');
  await page.getByRole('button', { name: 'Scheduled tasks' }).click();
  const run = await runNowAndWait(page, name);
  await expect(run).toContainText('1 tool call refused (needed approval)');
  await expect(page.locator('[data-testid^="approval-prompt-"]')).toHaveCount(0);

  await run.getByRole('button', { name: 'Open' }).click();
  await expect(page.locator('article[data-role="assistant"] .markdown-body').last()).toContainText('approval_unavailable');
  await expect(page.locator('[data-testid^="approval-prompt-"]')).toHaveCount(0);
});

test('pausing and resuming a schedule', async ({ page, request }) => {
  const profileId = await mockProfile(request);
  const chatId = await newChat(request, profileId);
  const name = `Pausable ${suffix()}`;
  const created = await request.post(`${BASE_URL}/api/schedules`, {
    data: { name, prompt: 'hello', profileId, target: { chatId }, rule: { cadence: 'daily', time: laterTime() } },
  });
  expect(created.status()).toBe(201);

  await page.goto('/');
  await page.getByRole('button', { name: 'Scheduled tasks' }).click();
  const r = row(page, name);
  await r.getByRole('button', { name: 'Pause' }).click();
  await expect(r.getByTestId('schedule-next')).toHaveText('Next run: Paused');
  await r.getByRole('button', { name: 'Resume' }).click();
  await expect(r.getByTestId('schedule-next')).not.toContainText('Paused');
  await expect(r.getByTestId('schedule-next')).toContainText(')');
});
