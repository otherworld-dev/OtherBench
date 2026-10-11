import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { BASE_URL, DESKTOP_SERVERS } from '../playwright.config.js';

/**
 * Settings > MCP servers > Import from Claude Desktop (spec
 * 2026-10-11-claude-code-clean-chat-and-mcp-design §3), against the fixture
 * config playwright.config.ts points the server at: the usable server is
 * imported and turned on for the profile ticked under "Turn on for", the SSE
 * one can't be ticked, and the secret's value is never shown. The chat's
 * Inspector then shows the server as on for its profile, and can turn it off.
 */
test('imports an MCP server from Claude Desktop for a profile, without showing its secret', async ({ page, request }) => {
  const conn = await request.post(`${BASE_URL}/api/connections`, { data: { name: 'Mock', kind: 'mock' } });
  const { id: connectionId } = (await conn.json()) as { id: string };
  const profileName = `Import target ${randomUUID().slice(0, 8)}`;
  const profile = (await (await request.post(`${BASE_URL}/api/profiles`, { data: { name: profileName, connectionId, modelId: 'mock-standard' } })).json()) as { id: string };
  const chat = (await (await request.post(`${BASE_URL}/api/chats`, { data: { profileId: profile.id, title: `MCP toggles ${profileName}` } })).json()) as { id: string };

  await page.goto('/');
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('tab', { name: 'MCP Servers' }).click();
  await page.getByRole('button', { name: 'Import from Claude Desktop…' }).click();

  const dialog = page.getByRole('region', { name: 'Import from Claude Desktop' });
  await expect(dialog.getByRole('checkbox', { name: 'E2E Desktop Legacy' })).toBeDisabled();
  await expect(dialog).toContainText('NOTES_TOKEN');
  await expect(dialog).not.toContainText(DESKTOP_SERVERS.secret);
  await dialog.getByRole('checkbox', { name: 'E2E Desktop Notes' }).check();
  await dialog.getByRole('group', { name: 'Turn on for' }).getByRole('checkbox', { name: profileName }).check();
  await dialog.getByRole('button', { name: 'Import' }).click();
  await expect(dialog.getByRole('status')).toContainText(`Imported E2E Desktop Notes. Turned on for ${profileName}.`);
  await expect(page.getByTestId('mcp-servers-list')).toContainText('E2E Desktop Notes');
  await expect(page.locator('body')).not.toContainText(DESKTOP_SERVERS.secret);

  // The chat's Inspector shows it on for the profile, and turning it off saves to the profile.
  await page.getByRole('button', { name: 'Close settings' }).click();
  await page.getByRole('navigation', { name: 'Chats' }).getByTestId(`chat-row-${chat.id}`).click();
  const mcp = page.getByRole('heading', { name: 'MCP servers' }).locator('xpath=ancestor::section[1]');
  await expect(mcp).toContainText(`Ticked servers are on for ${profileName}`);
  const box = mcp.getByRole('checkbox', { name: `Use E2E Desktop Notes in ${profileName}` });
  await expect(box).toBeChecked();
  await box.uncheck();
  await expect(box).not.toBeChecked();
  await expect
    .poll(async () => ((await (await request.get(`${BASE_URL}/api/profiles/${profile.id}`)).json()) as { toolPolicy: { mcpServerIds: string[] } }).toolPolicy.mcpServerIds)
    .toEqual([]);

  // Clean up for whatever runs next against this server.
  const servers = (await (await request.get(`${BASE_URL}/api/mcp-servers`)).json()) as { id: string; name: string }[];
  for (const s of servers.filter((x) => x.name === 'E2E Desktop Notes')) await request.delete(`${BASE_URL}/api/mcp-servers/${s.id}`);
  await request.delete(`${BASE_URL}/api/profiles/${profile.id}`);
});
