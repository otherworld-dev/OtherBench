import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { BASE_URL } from '../playwright.config.js';

/**
 * Global memory (spec docs/superpowers/specs/2026-10-08-global-memory-design.md):
 * About you set in Settings > Memory and a fact pinned in the learned note reach
 * a chat outside any project, and a profile with "Use global memory" off gets
 * neither. The mock model's `#echo-system` trigger replies with the system
 * prompt it received.
 */
const RUN = randomUUID().slice(0, 8);
const ON = `Global on ${RUN}`;
const OFF = `Global off ${RUN}`;

test.beforeEach(async ({ request }) => {
  const conn = await request.post(`${BASE_URL}/api/connections`, { data: { name: 'Mock', kind: 'mock' } });
  expect(conn.ok()).toBeTruthy();
  const { id: connectionId } = await conn.json();
  for (const [name, useGlobalMemory] of [[ON, true], [OFF, false]] as const) {
    const profile = await request.post(`${BASE_URL}/api/profiles`, { data: { name, connectionId, modelId: 'mock-standard', useGlobalMemory } });
    expect(profile.ok()).toBeTruthy();
  }
});

test.afterEach(async ({ request }) => {
  // Global memory is shared by every spec in the run: leave it empty again.
  await request.put(`${BASE_URL}/api/memory/global/about`, { data: { about: '' } });
  await request.put(`${BASE_URL}/api/memory/global`, { data: { body: '## Pinned\n\n## Preferences\n\n## Setup and tools\n\n## Working style' } });
});

async function echoSystem(page: Page, request: import('@playwright/test').APIRequestContext, profileName: string): Promise<string> {
  const profiles = (await (await request.get(`${BASE_URL}/api/profiles`)).json()) as { id: string; name: string }[];
  const profileId = profiles.find((p) => p.name === profileName)!.id;
  const title = `Echo ${profileName}`;
  const created = await request.post(`${BASE_URL}/api/chats`, { data: { title, profileId } });
  expect(created.ok()).toBeTruthy();
  const { id: chatId } = await created.json();

  await page.goto('/');
  await page.getByTestId(`chat-row-${chatId}`).locator('[data-row-main]').click();
  const textbox = page.getByRole('textbox', { name: /message/i });
  await textbox.fill('#echo-system');
  await textbox.press('Enter');
  const reply = page.locator('article[data-role="assistant"] .markdown-body');
  await expect(reply).toHaveCount(1);
  await expect(page.getByLabel('streaming')).toHaveCount(0);
  return (await reply.textContent()) ?? '';
}

test('About you and the learned note reach every chat on a profile that uses global memory, and none on one that does not', async ({ page, request }) => {
  const about = `about-${RUN}`;
  const fact = `pinned-${RUN}`;

  // Set About you and pin a fact, through Settings > Memory.
  await page.goto('/');
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('tab', { name: 'Memory' }).click();
  await page.getByRole('textbox', { name: 'About you' }).fill(`I am ${about}.`);
  await page.getByRole('button', { name: 'Save About you' }).click();
  await expect(page.getByTestId('about-saved')).toBeVisible();

  const note = page.getByTestId('global-memory-section');
  await note.getByRole('button', { name: 'Edit' }).click();
  await note
    .getByRole('textbox', { name: 'Learned note' })
    .fill(`## Pinned\n- ${fact}\n\n## Preferences\n\n## Setup and tools\n\n## Working style`);
  await note.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByTestId('global-memory-note')).toContainText(fact);
  await page.getByRole('button', { name: 'Close settings' }).click();

  const on = await echoSystem(page, request, ON);
  expect(on).toContain('About the user');
  expect(on).toContain(`I am ${about}.`);
  expect(on).toContain('What you know about the user');
  expect(on).toContain(fact);

  const off = await echoSystem(page, request, OFF);
  expect(off).not.toContain('About the user');
  expect(off).not.toContain(fact);
});
