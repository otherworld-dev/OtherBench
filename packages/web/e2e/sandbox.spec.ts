import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type APIRequestContext } from '@playwright/test';
import { BASE_URL } from '../playwright.config.js';

/**
 * The sandboxed shell end to end (spec 2026-10-12-sandbox-design §6, "E2e"),
 * against the e2e server's FakeSandbox (GRUNT_SANDBOX=fake): set it up from
 * Settings, choose "in the sandbox" on a profile, and a mock #run turn comes
 * back tagged sandbox with no approval card under ask on mutate.
 */

const suffix = (): string => randomUUID().slice(0, 8);

async function mockProfile(request: APIRequestContext, toolPolicy: Record<string, unknown>): Promise<string> {
  const conn = await request.post(`${BASE_URL}/api/connections`, { data: { name: `Mock ${suffix()}`, kind: 'mock' } });
  expect(conn.ok()).toBeTruthy();
  const { id: connectionId } = (await conn.json()) as { id: string };
  const profile = await request.post(`${BASE_URL}/api/profiles`, { data: { name: `Sandbox ${suffix()}`, connectionId, modelId: 'mock-standard', toolPolicy } });
  expect(profile.ok()).toBeTruthy();
  return ((await profile.json()) as { id: string }).id;
}

test.describe.configure({ mode: 'serial' });

test('sets up the sandbox from Settings', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('tab', { name: 'Sandbox' }).click();
  const state = page.getByTestId('sandbox-state');
  await expect(state).toBeVisible();
  // Another spec run against this server may have set it up already.
  if ((await state.textContent())?.includes('Not set up')) await page.getByRole('button', { name: 'Set up' }).click();
  await expect(state).toContainText('Ready');
  await expect(page.getByTestId('sandbox-versions')).toContainText('0.0.79');
});

test('chooses "in the sandbox" for a profile', async ({ page, request }) => {
  const profileId = await mockProfile(request, { fs: 'readwrite', shell: true, mcpServerIds: [], approvalMode: 'ask_on_mutate' });
  await page.goto('/');
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('tab', { name: 'Profiles' }).click();
  await page.getByTestId(`profile-row-${profileId}`).click();
  await page.getByLabel('Shell runs').selectOption('sandbox');
  await expect(page.getByLabel('The sandbox can reach')).toHaveValue(/registry\.npmjs\.org/);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect
    .poll(async () => ((await (await request.get(`${BASE_URL}/api/profiles/${profileId}`)).json()) as { toolPolicy: { shellRuns?: string } }).toolPolicy.shellRuns)
    .toBe('sandbox');
  await request.delete(`${BASE_URL}/api/profiles/${profileId}`);
});

test('a sandboxed command runs with no card under ask on mutate, and its result is tagged sandbox', async ({ page, request }) => {
  expect((await request.post(`${BASE_URL}/api/sandbox/setup`)).status()).toBe(202);
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'grunt-e2e-sandbox-'));
  try {
    const profileId = await mockProfile(request, { fs: 'readwrite', shell: true, shellRuns: 'sandbox', mcpServerIds: [], approvalMode: 'ask_on_mutate' });
    const title = `Sandbox run ${suffix()}`;
    expect((await request.post(`${BASE_URL}/api/chats`, { data: { title, profileId, workspaceRoot } })).ok()).toBeTruthy();

    await page.goto('/');
    await page.getByRole('button', { name: title }).click();
    const textbox = page.getByRole('textbox', { name: /message/i });
    await textbox.fill('#run uname -a');
    await textbox.press('Enter');

    await expect(page.locator('article[data-role="assistant"] .markdown-body')).toContainText('I ran it in the sandbox: fake sandbox ran: uname -a');
    await expect(page.getByLabel('streaming')).toHaveCount(0);
    await expect(page.locator('[data-testid^="approval-prompt-"]')).toHaveCount(0);
    await page.getByText('Used 1 tool: run_command').click();
    await expect(page.getByTestId('sandbox-tag')).toBeVisible();
    await request.delete(`${BASE_URL}/api/profiles/${profileId}`);
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});
