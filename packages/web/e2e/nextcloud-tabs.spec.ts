import { randomUUID } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { BASE_URL, NEXTCLOUD_URL } from '../playwright.config.js';
import { openPanelTab } from './code-panel.js';

/**
 * The Deck, Wiki and Links tabs (spec docs/superpowers/specs/2026-10-22-nextcloud-tabs-design.md)
 * against the fake Nextcloud in e2e/fixtures/nextcloud-server.mjs: set up in
 * Settings > Nextcloud and tested, then an app linked to its board, page and
 * tag. A card is moved to Doing and then completed, which archives it; a wiki
 * page is opened from the tree; the tagged bookmark is listed.
 *
 * The app is created through the API, as the native folder picker can't be
 * driven; everything after that goes through the UI. The fixture keeps its
 * state for the run, so this spec runs once per fixture start.
 */
const PASSWORD = 'e2e-app-password';

let folder: string;

test.beforeEach(() => {
  folder = realpathSync.native(mkdtempSync(join(tmpdir(), 'otherbench-e2e-nextcloud-')));
});

test.afterEach(() => {
  if (!folder) return;
  try {
    rmSync(folder, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    /* best-effort cleanup */
  }
});

test('the Deck, Wiki and Links tabs work against a Nextcloud set up in Settings', async ({ page, request }) => {
  // The app first, so the sidebar has it when the page loads.
  const appName = `E2E Nextcloud ${randomUUID().slice(0, 8)}`;
  const created = await request.post(`${BASE_URL}/api/apps`, {
    data: {
      name: appName,
      workspacePath: folder,
      githubRepo: null,
      deckBoardId: 1,
      wikiCollective: 'Otherworld Dev',
      wikiPagePath: 'Products/E2E',
      bookmarkTag: 'e2e',
    },
  });
  expect(created.ok()).toBeTruthy();
  const { id: appId } = await created.json();

  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto('/');

  // Settings > Nextcloud: save the address, user and app password, then Test signs in.
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('tab', { name: 'Nextcloud' }).click();
  const settings = page.getByTestId('nextcloud-panel');
  await settings.getByLabel('Server URL').fill(NEXTCLOUD_URL);
  await settings.getByLabel('User name').fill('adam');
  await settings.getByLabel('App password').fill(PASSWORD);
  await settings.getByRole('button', { name: 'Save' }).click();
  await expect(settings.getByText('Saved.')).toBeVisible();
  await expect(settings.getByTestId('nextcloud-password-status')).toHaveText('A password is currently set.');
  await settings.getByRole('button', { name: 'Test' }).click();
  const result = settings.getByTestId('nextcloud-test-result');
  await expect(result).toContainText('Signed in');
  await expect(result.getByTestId('nextcloud-apps')).toHaveText('Deck ✓ / Collectives ✓ / Bookmarks ✓');
  // The password goes in and never comes back out.
  expect(JSON.stringify(await (await request.get(`${BASE_URL}/api/nextcloud`)).json())).not.toContain(PASSWORD);
  await page.getByRole('button', { name: 'Close settings' }).click();

  const nav = page.getByRole('navigation', { name: 'Chats' });
  await nav.getByTestId('mode-switch').getByRole('button', { name: 'Code' }).click();
  await nav.getByTestId(`group-heading-${appId}`).getByRole('button', { name: new RegExp(`^${appName}`) }).click();
  await expect(page.getByTestId('app-home').getByRole('heading', { name: appName })).toBeVisible();
  const panel = page.getByTestId('code-panel');

  // Deck: it opens on Doing.
  await openPanelTab(page, 'deck', 'Deck');
  const deck = panel.getByTestId('deck-tab');
  const columns = deck.getByRole('group', { name: 'Deck columns' });
  const column = (name: string) => columns.getByRole('button', { name: new RegExp(`^${name} \\d+$`) });
  await expect(column('Doing')).toHaveAttribute('aria-pressed', 'true');
  await expect(deck.getByTestId('card-row-102')).toContainText('Second card');
  await expect(deck.getByTestId('card-row-101')).toHaveCount(0);

  // To Do, open #101 and move it to Doing: it shows under Doing.
  await column('To Do').click();
  await expect(column('To Do')).toHaveAttribute('aria-pressed', 'true');
  await deck.getByTestId('card-row-101').click();
  const detail = deck.getByTestId('card-detail');
  await expect(detail.getByRole('heading', { name: '#101 First card' })).toBeVisible();
  await expect(detail.getByTestId('card-column')).toHaveText('To Do');
  await detail.getByLabel('Move to').selectOption({ label: 'Doing' });
  await expect(detail.getByTestId('card-column')).toHaveText('Doing');
  await deck.getByRole('button', { name: 'Back to the board' }).click();
  await expect(deck.getByText('No cards in this column')).toBeVisible();
  await column('Doing').click();
  await expect(deck.getByTestId('card-row-101')).toBeVisible();

  // Done moves it to Done, marks it and archives it: it shows under Archived.
  await deck.getByTestId('card-row-101').click();
  await detail.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(detail.getByTestId('card-column')).toHaveText('Done');
  await expect(detail).toContainText('Archived');
  await expect(detail.getByRole('button', { name: 'Reopen' })).toBeVisible();
  await deck.getByRole('button', { name: 'Back to the board' }).click();
  await expect(deck.getByTestId('card-row-101')).toHaveCount(0);
  await column('Archived').click();
  await expect(deck.getByTestId('card-row-101')).toContainText('First card');

  // Wiki: the tree starts at E2E; expanding it shows Notes, which opens with its text from WebDAV.
  await openPanelTab(page, 'wiki', 'Wiki');
  const wiki = panel.getByTestId('wiki-tab');
  const pages = wiki.getByRole('list', { name: 'Pages' });
  await expect(pages.getByRole('button', { name: 'Collapse E2E' })).toHaveAttribute('aria-expanded', 'true');
  await pages.getByRole('button', { name: 'Collapse E2E' }).click();
  await expect(pages.getByRole('button', { name: 'Notes' })).toHaveCount(0);
  await pages.getByRole('button', { name: 'Expand E2E' }).click();
  await pages.getByRole('button', { name: 'Notes', exact: true }).click();
  const wikiPage = wiki.getByTestId('wiki-page');
  await expect(wikiPage.getByRole('heading', { name: 'Notes', level: 3 })).toBeVisible();
  await expect(wikiPage).toContainText('E2E › Notes');
  await expect(wikiPage).toContainText('The notes page, read over WebDAV.');

  // Links: the bookmark tagged e2e, and not the other one.
  await openPanelTab(page, 'links', 'Links');
  const links = panel.getByTestId('links-tab');
  await expect(links.getByTestId('link-row-1')).toContainText('E2E bookmark');
  await expect(links.getByTestId('link-row-1')).toContainText('example.com/e2e-docs');
  await expect(links).toContainText('Tag e2e · 1');
  await expect(links.getByTestId('link-row-2')).toHaveCount(0);

  // Clean up for whatever runs next against this server.
  expect((await request.delete(`${BASE_URL}/api/apps/${appId}`)).ok()).toBeTruthy();
});
