import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type APIRequestContext } from '@playwright/test';
import { BASE_URL } from '../playwright.config.js';

/**
 * Live artifacts (spec 2026-10-12-live-artifacts): the Mock model's
 * `#live-artifact` makes a page that reads the fixture MCP server's `lookup`.
 * It shows not_approved until the user allows it in the viewer, then data,
 * with no approval card in the chat; fetch is blocked; Refresh asks the
 * server again and reopening within 30 s is served from the cache; a page
 * that leaves is closed; Stop takes the data away again.
 */
const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'tools', 'test', 'fixtures', 'live-server.js');

interface Seeded {
  title: string;
  chatId: string;
  tool: string;
  serverId: string;
  profileId: string;
}

async function seed(request: APIRequestContext): Promise<Seeded> {
  const suffix = randomUUID().slice(0, 8);
  const serverName = `LiveFixture${suffix}`;
  const server = await request.post(`${BASE_URL}/api/mcp-servers`, { data: { name: serverName, transport: 'stdio', command: process.execPath, args: [FIXTURE] } });
  expect(server.ok()).toBeTruthy();
  const { id: serverId } = (await server.json()) as { id: string };
  await expect
    .poll(async () => ((await (await request.get(`${BASE_URL}/api/mcp-servers`)).json()) as { id: string; status: string }[]).find((s) => s.id === serverId)?.status, { timeout: 15_000 })
    .toBe('ok');
  const conn = await request.post(`${BASE_URL}/api/connections`, { data: { name: `Mock ${suffix}`, kind: 'mock' } });
  const { id: connectionId } = (await conn.json()) as { id: string };
  const profile = await request.post(`${BASE_URL}/api/profiles`, {
    data: { name: `Live ${suffix}`, connectionId, modelId: 'mock-standard', isDefault: true, toolPolicy: { fs: 'off', shell: false, mcpServerIds: [serverId], approvalMode: 'always_ask' } },
  });
  const { id: profileId } = (await profile.json()) as { id: string };
  const title = `Live E2E - ${suffix}`;
  const chat = await request.post(`${BASE_URL}/api/chats`, { data: { title, profileId } });
  expect(chat.ok()).toBeTruthy();
  const { id: chatId } = (await chat.json()) as { id: string };
  return { title, chatId, tool: `mcp__${serverName}__lookup`, serverId, profileId };
}

test('a live page gets data once allowed, refreshes, caches, closes when it leaves, and stops', async ({ page, request }) => {
  const seeded = await seed(request);
  try {
    await page.goto('/');
    await page.getByRole('button', { name: seeded.title }).click();
    const textbox = page.getByRole('textbox', { name: /message/i });
    await textbox.fill(`#live-artifact ${seeded.tool}`);
    await textbox.press('Enter');
    await expect(page.getByLabel('streaming')).toHaveCount(0);

    const openCard = () => page.getByRole('button', { name: /Live dashboard.*Created v1/ }).click();
    await openCard();
    const viewer = page.getByRole('complementary', { name: 'Viewer' });
    const frame = () => viewer.frameLocator('iframe[title="dash.html"]');
    const panel = viewer.getByRole('region', { name: 'Live data' });

    // 1. Not allowed yet: the page says so, and the panel lists the call.
    await expect(frame().locator('#out')).toHaveText('error: not_approved');
    await expect(panel).toContainText('lookup');
    await expect(panel).toContainText('key: a, b (default a)');

    // 2. Allowed: data, and no approval card in the chat.
    await panel.getByRole('button', { name: 'Allow live data' }).click();
    await expect(frame().locator('#out')).toHaveText('value-of-b');
    await expect(page.locator('[data-testid^="approval-prompt-"]')).toHaveCount(0);

    // 3. The page can't fetch.
    await expect(frame().locator('#csp')).toContainText('connect-src');

    // 4. Refresh asks the server again; reopening within 30 s is served from the cache.
    const first = Number(await frame().locator('#n').textContent());
    await viewer.getByRole('button', { name: 'Refresh' }).click();
    await expect.poll(async () => Number(await frame().locator('#n').textContent())).toBeGreaterThan(first);
    const refreshed = await frame().locator('#n').textContent();
    await page.reload();
    // The chat got a title from its first reply, so find its row by id.
    await page.getByTestId(`chat-row-${seeded.chatId}`).locator('[data-row-main]').click();
    await openCard();
    await expect(frame().locator('#n')).toHaveText(refreshed ?? '');
    await expect(viewer.getByRole('region', { name: 'Live data' })).toContainText('(cached)');

    // 5. A page that navigates its own frame is closed; Reopen brings it back.
    await frame().locator('#leave').click();
    await expect(viewer.getByText('This page went to another address, so Grunt closed it.')).toBeVisible();
    await viewer.getByRole('button', { name: 'Reopen' }).click();
    await expect(frame().locator('#out')).toHaveText('value-of-b');

    // 6. Stop live data: not_approved again.
    await viewer.getByRole('button', { name: 'Stop live data' }).click();
    await expect(frame().locator('#out')).toHaveText('error: not_approved');
  } finally {
    await request.delete(`${BASE_URL}/api/mcp-servers/${seeded.serverId}`);
    await request.delete(`${BASE_URL}/api/profiles/${seeded.profileId}`);
  }
});
