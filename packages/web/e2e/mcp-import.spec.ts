import { expect, test } from '@playwright/test';
import { BASE_URL, DESKTOP_SERVERS } from '../playwright.config.js';

/**
 * Settings > MCP servers > Import from Claude Desktop (spec
 * 2026-10-11-claude-code-clean-chat-and-mcp-design §3), against the fixture
 * config playwright.config.ts points the server at: the usable server is
 * imported, the SSE one can't be ticked, and the secret's value is never shown.
 */
test('imports an MCP server from Claude Desktop without showing its secret', async ({ page, request }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('tab', { name: 'MCP Servers' }).click();
  await page.getByRole('button', { name: 'Import from Claude Desktop…' }).click();

  const dialog = page.getByRole('region', { name: 'Import from Claude Desktop' });
  await expect(dialog.getByRole('checkbox', { name: 'E2E Desktop Legacy' })).toBeDisabled();
  await expect(dialog).toContainText('NOTES_TOKEN');
  await expect(dialog).not.toContainText(DESKTOP_SERVERS.secret);
  await dialog.getByRole('checkbox', { name: 'E2E Desktop Notes' }).check();
  await dialog.getByRole('button', { name: 'Import' }).click();
  await expect(dialog.getByRole('status')).toContainText('Imported E2E Desktop Notes.');
  await expect(page.getByTestId('mcp-servers-list')).toContainText('E2E Desktop Notes');
  await expect(page.locator('body')).not.toContainText(DESKTOP_SERVERS.secret);

  // Clean up for whatever runs next against this server.
  const servers = (await (await request.get(`${BASE_URL}/api/mcp-servers`)).json()) as { id: string; name: string }[];
  for (const s of servers.filter((x) => x.name === 'E2E Desktop Notes')) await request.delete(`${BASE_URL}/api/mcp-servers/${s.id}`);
});
