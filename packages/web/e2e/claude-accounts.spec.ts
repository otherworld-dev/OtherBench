import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import type { AccountView } from '@otherbench/core/types/claude-accounts.js';
import { BASE_URL } from '../playwright.config.js';
import { openInspectorSection } from './inspector.js';

/**
 * Claude accounts end to end: add one in Settings, pin a Claude-login chat to it
 * in the Inspector, see the thread tinted, and see an account-switch toast open
 * its chat. Every /api/claude/* call is stubbed, so no Claude Code process starts.
 * The chat PATCH goes to the real e2e server.
 */

const MAIN: AccountView = { slug: 'main', name: 'Main', colour: null, configDir: null, main: true, limitedUntil: null, signedIn: true, email: 'main@example.invalid', subscriptionType: 'max', signingIn: false };

/** Stubs the Claude account routes with a list the page can add to. */
async function stubClaude(page: Page): Promise<AccountView[]> {
  const accounts: AccountView[] = [MAIN];
  await page.route('**/api/claude/plan-usage*', (route) => route.fulfill({ json: { usage: null } }));
  await page.route('**/api/claude/accounts', async (route) => {
    const req = route.request();
    if (req.method() === 'POST') {
      const body = req.postDataJSON() as { name: string; colour: string; configDir?: string };
      const account: AccountView = {
        slug: body.name.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
        name: body.name,
        colour: body.colour,
        configDir: body.configDir ?? `/e2e/accounts/${body.name}`,
        main: false,
        limitedUntil: null,
        signedIn: true,
        email: 'spare@example.invalid',
        subscriptionType: 'pro',
        signingIn: false,
      };
      accounts.push(account);
      await route.fulfill({ status: 201, json: { account } });
    } else {
      await route.fulfill({ json: { accounts } });
    }
  });
  return accounts;
}

/**
 * Replaces the app event stream with one the test controls. It answers every
 * connect with a hello, plus the one event queued by `send` if there is one;
 * the page reconnects on its own when the stream ends.
 */
async function forgeEvents(page: Page): Promise<(event: object) => void> {
  const queue: object[] = [];
  await page.route('**/api/events*', (route) => {
    const hello = { pendingApprovals: [], runningTurns: [], computerSessions: [], backgroundChats: [] };
    const events = queue.splice(0).map((e) => `data: ${JSON.stringify(e)}\n\n`);
    return route.fulfill({ status: 200, headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store' }, body: `event: hello\ndata: ${JSON.stringify(hello)}\n\n${events.join('')}` });
  });
  return (event) => void queue.push(event);
}

test('add an account, pin a chat to it, and follow a switch toast', async ({ page, request }) => {
  const tag = randomUUID().slice(0, 8);
  const conn = await request.post(`${BASE_URL}/api/connections`, { data: { name: `Claude login ${tag}`, kind: 'claude_code' } });
  expect(conn.ok()).toBeTruthy();
  const profile = await request.post(`${BASE_URL}/api/profiles`, { data: { name: `Claude ${tag}`, connectionId: (await conn.json()).id, modelId: 'claude-opus-5-5' } });
  expect(profile.ok()).toBeTruthy();
  const profileId = (await profile.json()).id as string;
  const first = (await (await request.post(`${BASE_URL}/api/chats`, { data: { profileId, title: `Pinned ${tag}` } })).json()) as { id: string };
  const second = (await (await request.post(`${BASE_URL}/api/chats`, { data: { profileId, title: `Moved ${tag}` } })).json()) as { id: string };

  await stubClaude(page);
  const send = await forgeEvents(page);

  // Settings: add the account.
  await page.goto('/');
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('tab', { name: 'Claude accounts' }).click();
  await expect(page.getByTestId('claude-account-main')).toBeVisible();
  await page.getByLabel('Account name').fill('Spare');
  await page.getByRole('button', { name: 'Add account' }).click();
  await expect(page.getByTestId('claude-account-spare')).toContainText('spare@example.invalid');
  await page.getByRole('button', { name: 'Close settings' }).click();

  // Inspector: pick it for the first chat.
  await page.getByTestId(`chat-row-${first.id}`).getByRole('button').first().click();
  const section = await openInspectorSection(page, 'Claude Code session');
  const thread = page.getByRole('region', { name: `Pinned ${tag}` });
  await expect(thread).not.toHaveAttribute('data-account', /.+/);
  await section.getByLabel('Account').selectOption('spare');

  // The thread is tinted and the header badge shows.
  await expect(thread).toHaveAttribute('data-account', 'spare');
  await expect(thread.getByLabel('Claude account')).toBeVisible();
  await expect(section.getByLabel('Switch automatically')).not.toBeChecked();

  // A forged switch event for the other chat toasts, and the toast opens that chat.
  send({ type: 'claude-account-switched', chatId: second.id, from: 'Main', to: 'Spare', resetsAt: null, midReply: false });
  const toast = page.getByTestId('toast');
  await expect(toast).toContainText(`Moved ${tag} moved to Spare: Main hit its limit`);
  await toast.getByRole('button').first().click();
  await expect(page.getByRole('region', { name: `Moved ${tag}` })).toBeVisible();
  await expect(toast).toHaveCount(0);
});
