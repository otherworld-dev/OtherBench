import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { BASE_URL } from '../playwright.config.js';

/**
 * End-to-end verification (task 19/20 brief, decision #5): builds nothing
 * itself -- `playwright.config.ts`'s `webServer` starts the already-built
 * `grunt serve` against a scratch database -- and drives the real browser
 * app against it, using the keyless mock provider (`ConnectionKind:
 * 'mock'`, packages/engine-aisdk/src/mock-provider.ts) so no API key or
 * network access is required. Seeds one connection + one default profile
 * via the real HTTP API before each test, mirroring exactly what a user
 * would do via Settings (not built yet) rather than reaching into the
 * database directly.
 */
async function seedMockProfile(request: import('@playwright/test').APIRequestContext): Promise<void> {
  const conn = await request.post(`${BASE_URL}/api/connections`, { data: { name: 'Mock', kind: 'mock' } });
  expect(conn.ok()).toBeTruthy();
  const { id: connectionId } = await conn.json();

  const profile = await request.post(`${BASE_URL}/api/profiles`, {
    data: { name: 'Mock Profile', connectionId, modelId: 'mock-standard', isDefault: true },
  });
  expect(profile.ok()).toBeTruthy();
}

test.beforeEach(async ({ request }) => {
  await seedMockProfile(request);
});

test('creating a chat, sending a message, and watching it stream in', async ({ page }) => {
  await page.goto('/');

  await page.getByRole('button', { name: '+ New chat' }).click();

  const textbox = page.getByRole('textbox', { name: /message/i });
  await expect(textbox).toBeVisible();
  await textbox.fill('Hello from Playwright');
  await textbox.press('Enter');

  // The user's own message renders immediately (optimistic local stub).
  await expect(page.getByTestId('thread-scroll').getByText('Hello from Playwright')).toBeVisible();

  // The mock provider's canned reply streams in over several chunks;
  // asserting on it proves text actually arrived over the live SSE
  // connection, not just that the turn was created.
  await expect(page.getByTestId('thread-scroll').getByText(/Here is a mock reply from Grunt/)).toBeVisible();

  // And the turn reaches a terminal state -- the streaming caret goes away.
  await expect(page.getByLabel('streaming')).toHaveCount(0);
});

test('#slow renders progressively, chunk by chunk, before completing', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '+ New chat' }).click();

  const textbox = page.getByRole('textbox', { name: /message/i });
  await textbox.fill('#slow');
  await textbox.press('Enter');

  // Still streaming, and only part of the 20-word reply has arrived yet
  // (chunks land one per 400ms; the full reply takes ~8s). Waiting for the
  // body to become non-empty (rather than a fixed sleep) lands this
  // assertion right after the first chunk or two.
  await expect(page.getByLabel('streaming')).toBeVisible();
  const partial = page.locator('article[data-role="assistant"] .markdown-body');
  await expect(partial).not.toHaveText('');
  const partialText = (await partial.innerText()).trim();
  expect(partialText.length).toBeGreaterThan(0);
  expect(partialText).not.toContain('smoothly across chat pane now'); // the reply's last words

  // Eventually the full reply lands and the turn completes.
  await expect(page.getByText(/smoothly across chat pane now/)).toBeVisible();
  await expect(page.getByLabel('streaming')).toHaveCount(0);
});

test('#fail surfaces an error state instead of hanging', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '+ New chat' }).click();

  const textbox = page.getByRole('textbox', { name: /message/i });
  await textbox.fill('#fail');
  await textbox.press('Enter');

  await expect(page.locator('article[data-role="assistant"][data-status="error"]')).toBeVisible();
  await expect(page.getByText(/simulated rate limit/)).toBeVisible();
});

// ---------------------------------------------------------------------------
// Full product journey (task 31)
//
// The three tests above, and the dedicated tool-approval.spec.ts /
// attachments.spec.ts files, already cover streaming variants, approve/deny/
// compare-independence, and drag-drop/paste in depth -- this test does NOT
// re-verify any of that. Its only job is to prove the pieces actually chain
// together into one real session the way a user would experience it: create
// a connection and profile, start a chat, send a message and watch it
// stream, trigger a tool call and approve it, compare across three profiles
// and keep one, then search the kept conversation back up. Each step reuses
// the exact seeding/selector conventions established in the other e2e files
// (cited inline below) rather than inventing new ones.
// ---------------------------------------------------------------------------

function uniqueSuffix(): string {
  return randomUUID().slice(0, 8);
}

test('full product journey: connection + profile, chat, streaming, tool approval, three-way compare, keep, and search', async ({
  page,
  request,
}) => {
  const suffix = uniqueSuffix();
  const chatTitle = `Smoke Journey ${suffix}`;
  const searchToken = `smoketoken${suffix}`;
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'grunt-e2e-smoke-journey-'));
  writeFileSync(join(workspaceRoot, 'notes.txt'), 'THE SMOKE TEST FILE CONTENTS');

  try {
    // --- Create a connection and three profiles. There is no Settings UI
    // yet (see README.md's "add a connection and a profile" section) so this
    // is the same real HTTP API a user drives by hand today, in the same
    // shape seedMockProfile() above and tool-approval.spec.ts's
    // seedToolProfile() already use. Profile A is primary with tool access
    // and `always_ask` (required to force the approval prompt -- see
    // tool-approval.spec.ts's doc comment: `ask_on_mutate` would silently
    // auto-approve read_file since it is risk 'read'); B and C are plain
    // compare partners.
    const conn = await request.post(`${BASE_URL}/api/connections`, { data: { name: `Smoke ${suffix}`, kind: 'mock' } });
    expect(conn.ok()).toBeTruthy();
    const { id: connectionId } = await conn.json();

    const toolPolicy = { fs: 'readwrite', shell: false, mcpServerIds: [], approvalMode: 'always_ask' };
    const profileAName = `Profile A ${suffix}`;
    const profileBName = `Profile B ${suffix}`;
    const profileCName = `Profile C ${suffix}`;

    const profileA = await request.post(`${BASE_URL}/api/profiles`, {
      data: { name: profileAName, connectionId, modelId: 'mock-standard', isDefault: true, toolPolicy },
    });
    expect(profileA.ok()).toBeTruthy();
    const { id: profileAId } = await profileA.json();

    const profileB = await request.post(`${BASE_URL}/api/profiles`, { data: { name: profileBName, connectionId, modelId: 'mock-standard' } });
    expect(profileB.ok()).toBeTruthy();
    const profileC = await request.post(`${BASE_URL}/api/profiles`, { data: { name: profileCName, connectionId, modelId: 'mock-standard' } });
    expect(profileC.ok()).toBeTruthy();

    // --- Start a chat. Seeded with a real workspace root (same technique as
    // tool-approval.spec.ts) so the tool-call step below reads a genuine
    // file through the full PermissionBroker -> GruntToolProvider ->
    // fs-tools.readFileTool chain, not a stand-in.
    const chatRes = await request.post(`${BASE_URL}/api/chats`, { data: { title: chatTitle, profileId: profileAId, workspaceRoot } });
    expect(chatRes.ok()).toBeTruthy();

    await page.goto('/');
    await page.getByRole('button', { name: chatTitle }).click();
    const textbox = page.getByRole('textbox', { name: /message/i });
    // Every thread-content assertion below is scoped to <main> (Thread.tsx's
    // own root, the only <main> on the page), never bare `page.getByText`.
    // Auto-titling (subscribeAutoTitle, packages/server/src/routes/chats.ts)
    // renames EVERY chat -- including this one, and regardless of the
    // explicit title it was created with -- to a snippet of its own first
    // exchange as soon as that turn completes, with no guard against
    // overwriting an explicit title. Every other test in this suite that
    // sends a plain (untriggered) message gets the exact same mock
    // DEFAULT_REPLY back, so its auto-generated title is the identical
    // truncated string -- an unscoped page-wide getByText for that text (or
    // for `chatTitle`, once it has been renamed) collides with those other
    // chats' sidebar entries. Scoping to `main` sidesteps the whole thing
    // rather than depending on run order or timing to avoid it.
    const main = page.locator('main');

    // --- Send a message and see it stream.
    await textbox.fill(`Hello from the smoke journey ${searchToken}`);
    await textbox.press('Enter');
    await expect(main.getByText(new RegExp(`Hello from the smoke journey ${searchToken}`))).toBeVisible();
    await expect(main.getByText(/Here is a mock reply from Grunt/)).toBeVisible();
    await expect(page.getByLabel('streaming')).toHaveCount(0);

    // --- Trigger a tool call and approve it.
    await textbox.fill('#tool notes.txt');
    await textbox.press('Enter');
    const approval = page.locator('[data-testid^="approval-prompt-"]');
    await expect(approval).toBeVisible();
    await expect(approval).toContainText('read_file');
    await approval.getByRole('button', { name: 'Allow once' }).click();
    await expect(approval).toHaveCount(0);
    await expect(main.locator('article[data-role="assistant"] .markdown-body').getByText(/THE SMOKE TEST FILE CONTENTS/)).toBeVisible();
    await expect(page.getByLabel('streaming')).toHaveCount(0);

    // --- Run a compare turn across all three profiles.
    await page.getByRole('button', { name: '+ Compare' }).click();
    await page.getByRole('checkbox', { name: profileBName }).check();
    await page.getByRole('checkbox', { name: profileCName }).check();
    await page.getByRole('button', { name: '+ Compare' }).click(); // closes the picker -- Escape has no handler (see tool-approval.spec.ts)
    await expect(page.getByRole('listbox', { name: 'Compare profiles' })).toBeHidden();

    await textbox.fill('Compare all three of you');
    await textbox.press('Enter');

    const tabs = main.getByRole('tablist', { name: 'Compare variants' }).getByRole('tab');
    await expect(tabs).toHaveCount(3);
    await expect(page.getByLabel('streaming')).toHaveCount(0, { timeout: 15_000 });

    // --- Keep one (Profile C's variant, picked by switching to its tab first).
    await main.getByRole('tab', { name: new RegExp(`^${profileCName}`) }).click();
    await main.getByRole('button', { name: 'Keep this one' }).click();

    // The tab strip collapses to an ordinary message plus a chip for the two
    // variants that were not kept -- they still exist, just off the active path.
    await expect(page.getByTestId('variant-tabs')).toHaveCount(0);
    await expect(page.getByTestId('reopen-variants-chip')).toContainText('2 other variants');

    // --- Search the result back. The FTS index is over message text, not
    // chat titles (ChatList.tsx's own doc comment says otherwise; see
    // README/HANDOVER), so this searches for a term that only ever appeared
    // in the first message sent above -- unique enough (a per-run random
    // suffix) that exactly one chat anywhere in this scratch database can
    // match. Verified by re-opening the result and finding that same message
    // still there, not by the chat's sidebar title text, which -- per the
    // note above -- will not still read `chatTitle` by this point.
    await page.getByRole('searchbox', { name: 'Search chats' }).fill(searchToken);
    const results = page.locator('nav[aria-label="Chats"] [data-testid^="chat-row-"]');
    await expect(results).toHaveCount(1);
    await results.first().locator('[data-row-main]').click();
    await expect(main.getByText(new RegExp(`Hello from the smoke journey ${searchToken}`))).toBeVisible();
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});
