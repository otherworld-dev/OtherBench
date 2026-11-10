import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { expect, test } from './app.js';

/**
 * Smoke checks that only the real desktop app can fail: each covers a bug
 * that passed every browser e2e and showed only in the Tauri window. They run
 * in order against one launch (app.ts), using the keyless mock provider.
 */
test.describe.configure({ mode: 'serial' });

const STREAM_HOST = /^s[0-9a-f]{8}\.localhost$/;
const mockReply = /Here is a mock reply from OtherBench/;

async function createChat(api: import('@playwright/test').APIRequestContext, data: Record<string, unknown>): Promise<string> {
  const res = await api.post('/api/chats', { data });
  expect(res.ok()).toBeTruthy();
  return ((await res.json()) as { id: string }).id;
}

const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Chats' });

test('the app loads, its server answers, and it is the scratch one', async ({ app }) => {
  await expect(sidebar(app.main).getByRole('button', { name: '+ New chat' })).toBeVisible();
  const health = await app.api.get('/api/health');
  expect(health.ok()).toBeTruthy();
  // The UI reached the server itself, with the launch's token, not only this test.
  expect(app.requests.some((url) => url.startsWith(`${app.server.baseUrl}/api/`))).toBe(true);
  expect(app.server.baseUrl).not.toBe('http://127.0.0.1:4747');
});

test('a new chat streams the mock reply, over a stream host of its own', async ({ app }) => {
  const page = app.main;
  await sidebar(page).getByRole('button', { name: '+ New chat' }).click();
  const box = page.getByRole('textbox', { name: /message/i });
  await box.fill('Hello from the desktop smoke test');
  await box.press('Enter');
  const thread = page.getByTestId('thread-scroll');
  await expect(thread.getByText('Hello from the desktop smoke test')).toBeVisible();
  await expect(thread.getByText(mockReply)).toBeVisible();
  await expect(page.getByLabel('streaming')).toHaveCount(0);

  // The desktop app gives each stream its own `sNNNNNNNN.localhost` name (state/transport.ts `streamApiUrl`).
  const streams = app.requests.filter((url) => /\/api\/(events|chats\/[^/]+\/stream)(\?|$)/.test(url));
  expect(streams.length).toBeGreaterThan(0);
  for (const url of streams) expect(new URL(url).hostname, url).toMatch(STREAM_HOST);
});

test('dragging a chat row onto a project heading with the real mouse moves it into the project', async ({ app }) => {
  // WebView2 swallows HTML5 drag and drop unless the window has `dragDropEnabled: false` (tauri.conf.json, docks.rs).
  // Only a drag through Windows shows that: Playwright's dragTo passes with the drop handler on (tried), so this one
  // moves the real cursor (app.ts `realDrag`).
  const page = app.main;
  const project = await app.api.post('/api/projects', { data: { name: 'Desktop drop target' } });
  expect(project.ok()).toBeTruthy();
  const { id: projectId } = (await project.json()) as { id: string };
  const chatId = await createChat(app.api, { profileId: app.profileId, title: 'Drag me into the project' });
  await page.reload();

  const nav = sidebar(page);
  const row = nav.getByTestId(`chat-row-${chatId}`);
  await expect(row).toBeVisible();
  await expect(nav.getByTestId(`group-${projectId}`).getByTestId(`chat-row-${chatId}`)).toHaveCount(0);
  // A second go if the first doesn't land: a hand on the mouse during the drag throws it off. With the drop handler on,
  // both fail.
  const moved = nav.getByTestId(`group-${projectId}`).getByTestId(`chat-row-${chatId}`);
  for (let attempt = 1; attempt <= 2; attempt++) {
    await app.realDrag(row.locator('[data-row-main]'), nav.getByTestId(`group-heading-${projectId}`));
    const landed = await moved.waitFor({ timeout: 3_000 }).then(
      () => true,
      () => false,
    );
    if (landed) break;
    test.info().annotations.push({ type: 'drag', description: `attempt ${attempt} didn't land` });
  }
  await expect(moved).toBeVisible();
  await expect.poll(async () => ((await (await app.api.get(`/api/chats/${chatId}`)).json()) as { projectId: string | null }).projectId).toBe(projectId);
});

test('Code and the Overview undock into windows of their own, and a handed-over chat opens only in its window', async ({ app }) => {
  const page = app.main;
  const workspace = mkdtempSync(join(tmpdir(), 'otherbench-desktop-e2e-app-'));
  try {
    // A Code chat with a reply, so the Overview lists it.
    const created = await app.api.post('/api/apps', { data: { name: 'Desktop App', workspacePath: workspace, githubRepo: null, defaultProfileId: app.profileId } });
    expect(created.ok()).toBeTruthy();
    const { id: appId } = (await created.json()) as { id: string };
    const codeChat = await createChat(app.api, { appId, profileId: app.profileId, title: 'Code chat for the Overview' });
    const sent = await app.api.post(`/api/chats/${codeChat}/turns`, {
      data: { parentId: null, parts: [{ type: 'text', text: 'a code question from the smoke test' }], profileIds: [app.profileId] },
    });
    expect(sent.status()).toBe(202);
    const { userMessageId } = (await sent.json()) as { userMessageId: string };
    await app.api.post(`/api/chats/${codeChat}/head`, { data: { messageId: userMessageId } });
    await expect
      .poll(async () => {
        const { messages } = (await (await app.api.get(`/api/chats/${codeChat}/messages`)).json()) as { messages: { role: string; status: string }[] };
        return messages.some((m) => m.role === 'assistant' && m.status === 'complete');
      })
      .toBe(true);
    expect((await app.api.post('/api/overview/refresh')).ok()).toBeTruthy();
    await page.reload();

    const nav = sidebar(page);
    const modes = nav.getByTestId('mode-switch');

    // Code out into its own window; main is told (docks-changed) and marks it.
    await modes.getByRole('button', { name: 'Code', exact: true }).click();
    await nav.getByRole('button', { name: 'Open Code in its own window' }).click();
    const code = await app.windowFor('code');
    await expect(sidebar(code).getByRole('button', { name: 'Put Code back in the main window' })).toBeVisible();
    await expect(modes.getByRole('button', { name: 'Code', exact: true })).toHaveAttribute('title', 'Code is in its own window');

    // The Overview out into its own window.
    await modes.getByRole('button', { name: 'Overview' }).click();
    await nav.getByRole('button', { name: 'Open the Overview in its own window' }).click();
    const overview = await app.windowFor('overview');
    const row = overview.getByTestId(`overview-chat-${codeChat}`);
    await expect(row).toBeVisible();

    // Main shows a chat-mode chat.
    const mainChat = await createChat(app.api, { profileId: app.profileId, title: 'Main window chat' });
    await page.reload();
    await sidebar(page).getByTestId(`chat-row-${mainChat}`).locator('[data-row-main]').click();
    await expect(page.getByRole('main').getByText('Main window chat').first()).toBeVisible();

    // Clicking the Code chat on the Overview hands it to the Code window only (emit_to "code").
    // Unscoped, main heard it too, opened it and sent it back: the windows fought over focus forever.
    await row.click();
    await expect(code.getByTestId('thread-scroll').getByText('a code question from the smoke test')).toBeVisible();
    await page.waitForTimeout(1_500);
    await expect(page.getByText('a code question from the smoke test')).toHaveCount(0);
    await expect(page.getByRole('main').getByText('Main window chat').first()).toBeVisible();

    // Dock both again: their windows close and the shell's list empties.
    await sidebar(code).getByRole('button', { name: 'Put Code back in the main window' }).click();
    await expect.poll(() => app.hasWindow('code')).toBe(false);
    await app.invoke(page, 'dock', { view: 'overview' });
    await expect.poll(() => app.hasWindow('overview')).toBe(false);
    expect(await app.invoke<string[]>(page, 'undocked')).toEqual([]);
    await expect(modes.getByRole('button', { name: 'Code', exact: true })).not.toHaveAttribute('title', 'Code is in its own window');
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('several windows streaming at once never stall a send', async ({ app }) => {
  // Every window's /api/events and every chat pane's stream holds a connection open. On one host name they shared
  // the webview's six, so a send queued behind them and nothing happened. Here four windows are open (main, Code,
  // Overview and the hidden quick chat) and four panes stream at once: every send must still get its reply.
  const page = app.main;
  await app.invoke(page, 'undock', { view: 'code' });
  await app.invoke(page, 'undock', { view: 'overview' });
  const code = await app.windowFor('code');
  const overview = await app.windowFor('overview');
  await expect(sidebar(code)).toBeVisible();
  await expect(overview.getByTestId('overview-tile-chats')).toBeVisible();

  const ids: string[] = [];
  for (let i = 1; i <= 4; i++) ids.push(await createChat(app.api, { profileId: app.profileId, title: `Stream ${i}` }));
  await page.reload();
  const nav = sidebar(page);
  for (const id of ids) {
    await nav.getByTestId(`chat-row-${id}`).locator('[data-row-main]').click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Open in new tab' }).click();
  }
  await page.getByRole('button', { name: /^Layout: / }).click();
  await page.getByRole('menuitemradio', { name: 'Four in a grid' }).click();

  const main = page.getByRole('main');
  const panes = [0, 1, 2, 3].map((n) => main.getByTestId(`pane-${n}`));
  for (const pane of panes) {
    const box = pane.getByRole('textbox', { name: /message/i });
    await box.fill('#slow');
    await box.press('Enter');
    // The send went through while the earlier panes still stream: its reply has started.
    await expect(pane.locator('article[data-role="assistant"] .markdown-body')).not.toHaveText('', { timeout: 10_000 });
  }
  await expect(page.getByLabel('streaming')).toHaveCount(0, { timeout: 30_000 });
  for (const pane of panes) await expect(pane.getByText(/smoothly across chat pane now/)).toBeVisible();

  // And once they're done, an ordinary send still answers straight away.
  const box = panes[0]!.getByRole('textbox', { name: /message/i });
  await box.fill('one more after the slow ones');
  await box.press('Enter');
  await expect(panes[0]!.getByText(mockReply)).toBeVisible({ timeout: 10_000 });

  const streams = app.requests.filter((url) => /\/api\/(events|chats\/[^/]+\/stream)(\?|$)/.test(url));
  for (const url of streams) expect(new URL(url).hostname, url).toMatch(STREAM_HOST);

  await app.invoke(page, 'dock', { view: 'code' });
  await app.invoke(page, 'dock', { view: 'overview' });
});
