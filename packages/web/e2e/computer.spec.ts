import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { COMPUTER_DESKTOP_ONLY_REASON } from '@grunt/core/domain/computer-apps.js';
import { BASE_URL } from '../playwright.config.js';

/**
 * Computer use end to end (spec 2026-10-12-computer-use-design section 9),
 * against the fake driver this server runs with (GRUNT_COMPUTER_FAKE_DRIVER=1,
 * playwright.config.ts): core's FakeComputerDriver, which touches no real
 * mouse, keyboard or screen. The Mock model's `#computer` takes a screenshot,
 * clicks at (10, 20) and types "hello from the mock" through the real tool,
 * then answers slowly enough for Stop to land.
 *
 * The fake's app is `FAKE_COMPUTER_APP` (C:\Program Files\Fake App\FakeApp.exe,
 * window title "Fake App"), which core finds ordinary, so its card offers
 * every answer and `describeApp` names it `FakeApp.exe`.
 *
 * One chat controls the computer at a time, server-wide, so these tests run
 * one after another and each ends its chat's session (and again afterwards,
 * in case a test failed half-way).
 */

test.describe.configure({ mode: 'serial' });

/** What the mock types: it must only ever show in the approval card's typed-text box. */
const TYPED = 'hello from the mock';

const used: string[] = [];

test.afterEach(async ({ request }) => {
  for (const chatId of used.splice(0)) await request.post(`${BASE_URL}/api/chats/${chatId}/computer/stop`, { data: {} });
});

async function seedChat(request: APIRequestContext, computer: boolean): Promise<{ chatId: string; profileId: string; profileName: string }> {
  const suffix = randomUUID().slice(0, 8);
  const conn = await request.post(`${BASE_URL}/api/connections`, { data: { name: `Mock ${suffix}`, kind: 'mock' } });
  expect(conn.ok()).toBeTruthy();
  const { id: connectionId } = (await conn.json()) as { id: string };
  const profileName = `Computer ${suffix}`;
  const profile = await request.post(`${BASE_URL}/api/profiles`, {
    data: {
      name: profileName,
      connectionId,
      modelId: 'mock-standard',
      toolPolicy: { fs: 'off', shell: false, mcpServerIds: [], approvalMode: 'always_ask', ...(computer ? { computer: true } : {}) },
    },
  });
  expect(profile.ok()).toBeTruthy();
  const { id: profileId } = (await profile.json()) as { id: string };
  const chat = await request.post(`${BASE_URL}/api/chats`, { data: { title: `Computer E2E ${suffix}`, profileId, workspaceRoot: null } });
  expect(chat.ok()).toBeTruthy();
  const { id: chatId } = (await chat.json()) as { id: string };
  used.push(chatId);
  return { chatId, profileId, profileName };
}

async function send(page: Page, chatId: string, text: string): Promise<void> {
  await page.getByTestId(`chat-row-${chatId}`).locator('[data-row-main]').click();
  const textbox = page.getByRole('textbox', { name: /message/i });
  await textbox.fill(text);
  await textbox.press('Enter');
}

/** How many times `text` is anywhere in the page's DOM text, folded-away parts included. */
function timesOnPage(page: Page, text: string): Promise<number> {
  return page.evaluate((t) => (document.body.textContent ?? '').split(t).length - 1, text);
}

type StoredPart = { type: string; name?: string; args?: unknown; result?: unknown; isError?: boolean };
type StoredMessage = { id: string; role: string; status: string; parts: StoredPart[] };

async function assistantReply(request: APIRequestContext, chatId: string): Promise<StoredMessage | undefined> {
  const { messages } = (await (await request.get(`${BASE_URL}/api/chats/${chatId}/messages`)).json()) as { messages: StoredMessage[] };
  return messages.find((m) => m.role === 'assistant');
}

test('computer use turned on for a profile: looks with no card, asks per action naming the fake app, does what was allowed, and Stop ends control and the reply', async ({ page, request }) => {
  test.setTimeout(90_000);
  const status = (await (await request.get(`${BASE_URL}/api/computer/status`)).json()) as { computerUse?: unknown };
  expect(status.computerUse).toBe(true);
  const { chatId, profileId, profileName } = await seedChat(request, false);

  // The profile's switch shows because this server has a driver; ticking it and saving turns the tool on.
  await page.goto('/');
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('tab', { name: 'Profiles' }).click();
  await page.getByTestId(`profile-row-${profileId}`).click();
  await expect(page.getByRole('textbox', { name: 'Name' })).toHaveValue(profileName);
  const toggle = page.getByRole('checkbox', { name: 'Computer use' });
  await expect(toggle).not.toBeChecked();
  await toggle.check();
  await page.getByRole('button', { name: 'Save' }).click();
  await expect
    .poll(async () => ((await (await request.get(`${BASE_URL}/api/profiles/${profileId}`)).json()) as { toolPolicy: { computer?: unknown } }).toolPolicy.computer)
    .toBe(true);
  await page.getByRole('button', { name: 'Close settings' }).click();

  await send(page, chatId, '#computer');

  // The screenshot needed no card (even under "always ask") and started control; the click asks, naming the fake app.
  const banner = page.getByTestId('computer-banner');
  const card = page.locator('[data-testid^="approval-prompt-"]');
  await expect(card).toHaveCount(1);
  await expect(card.getByTestId('approval-summary')).toHaveText('Use FakeApp.exe: click at 10, 20');
  await expect(card.getByTestId('computer-headline')).toContainText('Let the model use FakeApp.exe?');
  await expect(card.getByTestId('computer-app-path')).toHaveText('C:\\Program Files\\Fake App\\FakeApp.exe');
  await expect(card.getByTestId('computer-window-title')).toHaveText('Window title (set by the app): Fake App');
  await expect(card.getByTestId('computer-headline')).not.toContainText('Fake App');
  await expect(card.getByTestId('computer-app-unusual')).toHaveCount(0);
  await expect(card.getByTestId('computer-high-risk')).toHaveCount(0);
  await expect(card.getByRole('button', { name: 'Allow for this chat' })).toBeVisible();
  await expect(card.getByRole('button', { name: 'Always allow FakeApp.exe' })).toBeVisible();
  await expect(banner).toContainText('Grunt is controlling this computer.');
  await expect(banner.getByTestId('computer-banner-last')).toHaveCount(0);

  // While the computer is in control, an answer from anywhere but the desktop app's window (this browser stands in
  // for it: playwright.config.ts) is refused, so a model using a browser can't answer Grunt's cards in it.
  const requestId = ((await card.getAttribute('data-testid')) ?? '').replace('approval-prompt-', '');
  const elsewhere = await request.post(`${BASE_URL}/api/approvals/${requestId}/resolve`, { data: { choice: 'once' } });
  expect(elsewhere.status()).toBe(403);
  expect(((await elsewhere.json()) as { error?: string }).error).toBe(COMPUTER_DESKTOP_ONLY_REASON);
  await expect(card).toHaveCount(1);
  await expect(banner.getByTestId('computer-banner-last')).toHaveCount(0);
  // Outside the desktop app the card says where to answer.
  await expect(card.getByTestId('desktop-only-note')).toBeVisible();

  // Allow once: the fake carries the click out (the banner's last action changes only on an action carried out).
  await card.getByRole('button', { name: 'Allow once' }).click();
  await expect(banner.getByTestId('computer-banner-last')).toHaveText('Last: click at 10, 20');

  // Once was only once: the typing asks again, and its text is in the card's own box and nowhere else.
  await expect(card).toHaveCount(1);
  await expect(card.getByTestId('approval-summary')).toHaveText('Use FakeApp.exe: type 19 characters');
  await expect(card.getByTestId('computer-typed-text')).toHaveText(TYPED);
  expect(await timesOnPage(page, TYPED)).toBe(1);
  await card.getByRole('button', { name: 'Allow once' }).click();
  await expect(card).toHaveCount(0);
  await expect(banner.getByTestId('computer-banner-last')).toHaveText('Last: type 19 characters');
  expect(await timesOnPage(page, TYPED)).toBe(0);

  // The thread names each call by what it does, and shows the screenshots (the look, and one after each action) as
  // thumbnails through the chat's own tool-image route.
  await page.getByText('Used 3 tools: computer ×3').click();
  await expect(page.getByTestId('computer-call')).toContainText(['computer: take a screenshot', 'computer: click at 10, 20', 'computer: type 19 characters']);
  expect(await timesOnPage(page, TYPED)).toBe(0);
  await expect(page.getByRole('img', { name: 'Screenshot' })).toHaveCount(3);
  const thumbnail = page.getByRole('img', { name: 'Screenshot' }).first();
  await expect(thumbnail).toBeVisible();
  await expect(thumbnail).toHaveAttribute('src', new RegExp(`/api/chats/${chatId}/messages/[^/]+/tool-images/[^/]+$`));
  await expect.poll(() => thumbnail.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBe(true);
  await expect(page.getByText('Screenshot not available.')).toHaveCount(0);

  // Stop ends control and the reply, which is still talking (a word a second).
  const answer = page.locator('article[data-role="assistant"] .markdown-body');
  await expect(answer).toContainText('I clicked');
  await expect(page.getByLabel('streaming')).not.toHaveCount(0);
  await banner.getByRole('button', { name: 'Stop' }).click();
  await expect(banner).toHaveCount(0);
  await expect(page.getByLabel('streaming')).toHaveCount(0, { timeout: 15_000 });
  await expect.poll(async () => (await assistantReply(request, chatId))?.status).toBe('cancelled');
  await expect(answer).not.toContainText('one word at a time.');
  const reply = await assistantReply(request, chatId);
  const results = (reply?.parts ?? []).filter((p) => p.type === 'tool-result');
  expect(results.map((p) => [p.name, p.isError])).toEqual([
    ['computer', false],
    ['computer', false],
    ['computer', false],
  ]);
});

test('a denied click is not carried out, and the reply says so', async ({ page, request }) => {
  test.setTimeout(60_000);
  const { chatId } = await seedChat(request, true);
  await page.goto('/');
  await send(page, chatId, '#computer');

  const banner = page.getByTestId('computer-banner');
  const card = page.locator('[data-testid^="approval-prompt-"]');
  await expect(card.getByTestId('approval-summary')).toHaveText('Use FakeApp.exe: click at 10, 20');
  await card.getByRole('button', { name: 'Deny' }).click();
  await expect(card).toHaveCount(0);

  await expect(page.locator('article[data-role="assistant"] .markdown-body')).toContainText("The computer didn't work:");
  await expect(page.getByLabel('streaming')).toHaveCount(0);
  // Control started with the screenshot, and nothing was carried out: the banner has no last action.
  await expect(banner).toContainText('Grunt is controlling this computer.');
  await expect(banner.getByTestId('computer-banner-last')).toHaveCount(0);
  const reply = await assistantReply(request, chatId);
  expect(reply?.status).toBe('complete');
  const calls = (reply?.parts ?? []).filter((p) => p.type === 'tool-call');
  expect(calls.map((p) => p.args)).toEqual([{ action: 'screenshot' }, { action: 'left_click', coordinate: [10, 20] }]);
  const results = (reply?.parts ?? []).filter((p) => p.type === 'tool-result');
  expect(results.map((p) => p.isError)).toEqual([false, true]);
  expect(await timesOnPage(page, TYPED)).toBe(0);

  await banner.getByRole('button', { name: 'Stop' }).click();
  await expect(banner).toHaveCount(0);
});
