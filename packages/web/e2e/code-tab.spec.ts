import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { expect, test } from '@playwright/test';
import { BASE_URL } from '../playwright.config.js';
import { openPanelTab } from './code-panel.js';

/**
 * The Code tab's happy path (spec docs/superpowers/specs/2026-10-20-code-tab-design.md):
 * an app over a real git repo shows in Code mode's sidebar, its home opens, a
 * chat started there gets the mock reply and a git bar with the repo's branch,
 * Files lists the repo, and the chat lives only in Code mode, showing again
 * when Code mode comes back. Neither the home nor the chat becomes a tab.
 *
 * The app is created through the API, as the native folder picker can't be
 * driven; everything after that goes through the UI. Issues aren't covered:
 * there is no `gh` in CI, and the app has no GitHub repo, so nothing calls it.
 */
const BRANCH = 'code-e2e';
const FILE = 'README.md';

const hasGit = spawnSync('git', ['--version'], { stdio: 'ignore' }).status === 0;

let repo: string;

function git(...args: string[]): void {
  const r = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
}

test.beforeEach(() => {
  test.skip(!hasGit, 'git is not installed');
  // realpath: the app's folder must be the repo's top level, as git reports it (no 8.3 short names).
  // tmpdir() is already in drive-letter form on Windows.
  repo = realpathSync.native(mkdtempSync(join(tmpdir(), 'otherbench-e2e-code-')));
  git('init', '-q');
  git('symbolic-ref', 'HEAD', `refs/heads/${BRANCH}`);
  git('config', 'user.name', 'OtherBench E2E');
  git('config', 'user.email', 'e2e@example.invalid');
  git('config', 'commit.gpgsign', 'false');
  writeFileSync(join(repo, FILE), '# Code tab e2e\n');
  git('add', FILE);
  git('commit', '-q', '-m', 'First commit');
});

test.afterEach(() => {
  if (!repo) return;
  try {
    rmSync(repo, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    /* best-effort cleanup */
  }
});

test('an app chat runs in Code mode with its git bar and files, and stays out of Chat mode', async ({ page, request }) => {
  const suffix = randomUUID().slice(0, 8);
  const conn = await request.post(`${BASE_URL}/api/connections`, { data: { name: `Mock ${suffix}`, kind: 'mock' } });
  expect(conn.ok()).toBeTruthy();
  const { id: connectionId } = await conn.json();
  const profile = await request.post(`${BASE_URL}/api/profiles`, {
    data: { name: `Code Profile ${suffix}`, connectionId, modelId: 'mock-standard', isDefault: true },
  });
  expect(profile.ok()).toBeTruthy();
  const { id: profileId } = await profile.json();

  const appName = `E2E App ${suffix}`;
  const created = await request.post(`${BASE_URL}/api/apps`, {
    data: { name: appName, workspacePath: repo, githubRepo: null, defaultProfileId: profileId },
  });
  expect(created.ok()).toBeTruthy();
  const { id: appId } = await created.json();

  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto('/');
  const nav = page.getByRole('navigation', { name: 'Chats' });
  const modes = nav.getByTestId('mode-switch');

  // Code mode lists the app; Chat mode doesn't.
  await expect(modes.getByRole('button', { name: 'Chat' })).toHaveAttribute('aria-pressed', 'true');
  await expect(nav.getByTestId(`group-${appId}`)).toHaveCount(0);
  await modes.getByRole('button', { name: 'Code' }).click();
  await expect(modes.getByRole('button', { name: 'Code' })).toHaveAttribute('aria-pressed', 'true');
  const group = nav.getByTestId(`group-${appId}`);
  await expect(group).toBeVisible();

  // The app's name opens its home.
  await nav.getByTestId(`group-heading-${appId}`).getByRole('button', { name: new RegExp(`^${appName}`) }).click();
  const home = page.getByTestId('app-home');
  await expect(home.getByRole('heading', { name: appName })).toBeVisible();
  await expect(home.getByTestId('app-home-folder')).toContainText(repo);
  await expect(home.getByTestId('app-home-repo')).toContainText('No GitHub repo set for this app');

  // A new chat from the home, answered by the mock, with the repo's branch in the git bar.
  await home.getByTestId('app-home-new-chat').click();
  const textbox = page.getByRole('textbox', { name: /message/i });
  await textbox.fill('Hello from the code tab');
  await textbox.press('Enter');
  const thread = page.getByTestId('thread-scroll');
  await expect(thread.getByText('Hello from the code tab')).toBeVisible();
  await expect(thread.getByText(/Here is a mock reply from OtherBench/)).toBeVisible();
  await expect(page.getByLabel('streaming')).toHaveCount(0);
  const gitBar = page.getByTestId('git-bar');
  await expect(gitBar).toContainText(appName);
  await expect(gitBar.getByTestId('git-branch')).toContainText(BRANCH);
  await expect(gitBar.getByTestId('git-changed-count')).toHaveText('0 changed');

  // The chat is listed under its app.
  const rows = group.locator('li[data-testid^="chat-row-"]');
  await expect(rows).toHaveCount(1);
  const chatId = (await rows.first().getAttribute('data-testid'))!.replace(/^chat-row-/, '');
  // Shown in the pane, not made a tab: only what the user asks to be a tab becomes one.
  await expect(page.getByRole('tablist', { name: 'Open tabs' }).getByRole('tab')).toHaveCount(0);

  // Files lists the repo's file. The panel may be too narrow for its tab, which is then under More tabs.
  const panel = page.getByTestId('code-panel');
  await openPanelTab(page, 'files', 'Files');
  await expect(panel.getByRole('tree', { name: 'Files' }).getByRole('button', { name: FILE })).toBeVisible();

  // Chat mode has neither the app nor its chat, in the sidebar or the tabs.
  await modes.getByRole('button', { name: 'Chat' }).click();
  await expect(modes.getByRole('button', { name: 'Chat' })).toHaveAttribute('aria-pressed', 'true');
  await expect(nav.getByTestId(`group-${appId}`)).toHaveCount(0);
  await expect(page.getByTestId(`chat-row-${chatId}`)).toHaveCount(0);
  await expect(page.getByTestId(`tab-${chatId}`)).toHaveCount(0);
  await expect(page.getByTestId('git-bar')).toHaveCount(0);
  await expect(page.getByTestId('code-panel')).toHaveCount(0);

  // Code mode comes back as it was: the chat is still the one showing.
  await modes.getByRole('button', { name: 'Code' }).click();
  await expect(thread.getByText('Hello from the code tab')).toBeVisible();
  await expect(page.getByTestId('git-bar').getByTestId('git-branch')).toContainText(BRANCH);
  await expect(page.getByTestId('code-panel-tab-files')).toHaveAttribute('aria-selected', 'true');

  // And so does a reload: the mode and what its pane shows are remembered per browser.
  await page.reload();
  await expect(modes.getByRole('button', { name: 'Code' })).toHaveAttribute('aria-pressed', 'true');
  await expect(thread.getByText('Hello from the code tab')).toBeVisible();
});

test('the terminal tab runs a shell in the app folder, keeps it across a reload, and the panel widens', async ({ page, request }) => {
  const status = await (await request.get(`${BASE_URL}/api/terminal/status`)).json();
  test.skip(!status.available, `no terminals on this server (${status.reason})`);
  const suffix = randomUUID().slice(0, 8);
  const appName = `E2E Terminal ${suffix}`;
  const created = await request.post(`${BASE_URL}/api/apps`, { data: { name: appName, workspacePath: repo, githubRepo: null } });
  expect(created.ok()).toBeTruthy();
  const { id: appId } = await created.json();

  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto('/');
  const nav = page.getByRole('navigation', { name: 'Chats' });
  await nav.getByTestId('mode-switch').getByRole('button', { name: 'Code' }).click();
  await nav.getByTestId(`group-heading-${appId}`).getByRole('button', { name: new RegExp(`^${appName}`) }).click();
  await expect(page.getByTestId('app-home').getByRole('heading', { name: appName })).toBeVisible();

  // The panel's left edge widens it.
  const panel = page.getByTestId('code-panel');
  const before = (await panel.boundingBox())!.width;
  const edge = page.getByRole('separator', { name: 'Resize code panel' });
  const box = (await edge.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x - 200, box.y + box.height / 2, { steps: 5 });
  await page.mouse.up();
  await expect.poll(async () => (await panel.boundingBox())!.width).toBeGreaterThan(before + 150);

  // Opening the tab starts a shell; what's typed runs in the repo.
  await openPanelTab(page, 'terminal', 'Terminal');
  const screen = panel.getByTestId('terminal-screen');
  await expect(screen.locator('.xterm-rows')).toBeVisible();
  await screen.locator('.xterm-helper-textarea').focus();
  // The prompt (PowerShell's and bash's alike) names the folder the shell started in.
  await expect(screen.locator('.xterm-rows')).toContainText(basename(repo), { timeout: 20_000 });
  await page.keyboard.type('echo ob-e2e-hi');
  await page.keyboard.press('Enter');
  await expect(screen.locator('.xterm-rows')).toContainText(/ob-e2e-hi[\s\S]*ob-e2e-hi/, { timeout: 20_000 });

  // A reload attaches to the same shell, its output replayed.
  await page.reload();
  await expect(page.getByTestId('code-panel').getByTestId('code-panel-tab-terminal')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('terminal-screen').locator('.xterm-rows')).toContainText('ob-e2e-hi', { timeout: 20_000 });
  const terminals = await (await request.get(`${BASE_URL}/api/apps/${appId}/terminals`)).json();
  expect(terminals).toHaveLength(1);

  // Deleting the app ends its shell.
  expect((await request.delete(`${BASE_URL}/api/apps/${appId}`)).ok()).toBeTruthy();
});
