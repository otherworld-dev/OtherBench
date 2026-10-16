import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { BASE_URL } from '../playwright.config.js';

/**
 * Real-browser verification for task 26 (the ONLY thing this file exists to
 * prove -- everything else is already covered by unit/integration tests):
 *
 *   1. A turn that triggers a tool call shows the approval prompt INLINE in
 *      the thread.
 *   2. Approving it lets the tool's REAL result (not a fabrication -- see
 *      mock-provider.ts's `#tool` routing, task 26) feed back into the
 *      model's answer.
 *   3. Denying a later one produces a tool error the model can respond to,
 *      not a hung turn.
 *
 * Uses the keyless mock connection (same as smoke.spec.ts) with a profile
 * whose toolPolicy enables fs with `approvalMode: 'always_ask'` (read_file
 * is risk 'read', which `ask_on_mutate` would auto-approve with no prompt
 * at all -- see PermissionBroker.decide -- so `always_ask` is what actually
 * forces the approval path this file exists to exercise), and a chat whose
 * `workspaceRoot` is a REAL temp directory containing a REAL file -- so a
 * successful approval reads genuine bytes off disk through the full
 * PermissionBroker -> OtherBenchToolProvider -> fs-tools.readFileTool chain, not
 * a mock standing in for any part of it.
 */

let workspaceRoot: string;

test.beforeEach(() => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'otherbench-e2e-tool-approval-'));
  writeFileSync(join(workspaceRoot, 'secrets.txt'), 'THE TREASURE IS BURIED UNDER THE OAK TREE');
});

test.afterEach(() => {
  try {
    rmSync(workspaceRoot, { recursive: true, force: true });
  } catch {
    /* best-effort cleanup */
  }
});

// The e2e run shares ONE scratch database across every test in this file
// (playwright.config.ts starts the server once, not per-test) -- a fixed
// chat/profile name would collide across tests, or across repeated runs of
// this same suite (--repeat-each, retries), and make `getByRole` throw
// "resolved to N elements" instead of finding the one THIS test just
// seeded. Every name below gets a short id unique to this test invocation.
function uniqueSuffix(): string {
  return randomUUID().slice(0, 8);
}

async function seedToolProfile(
  request: import('@playwright/test').APIRequestContext,
  chatTitle: string
): Promise<{ chatId: string }> {
  const conn = await request.post(`${BASE_URL}/api/connections`, { data: { name: `Mock ${uniqueSuffix()}`, kind: 'mock' } });
  expect(conn.ok()).toBeTruthy();
  const { id: connectionId } = await conn.json();

  const profile = await request.post(`${BASE_URL}/api/profiles`, {
    data: {
      name: `Tool Profile ${uniqueSuffix()}`,
      connectionId,
      modelId: 'mock-standard',
      isDefault: true,
      toolPolicy: { fs: 'readwrite', shell: false, mcpServerIds: [], approvalMode: 'always_ask' },
    },
  });
  expect(profile.ok()).toBeTruthy();
  const { id: profileId } = await profile.json();

  const chat = await request.post(`${BASE_URL}/api/chats`, {
    data: { title: chatTitle, profileId, workspaceRoot },
  });
  expect(chat.ok()).toBeTruthy();
  const { id: chatId } = await chat.json();

  return { chatId };
}

test('approving a tool call feeds the real result back into the model, and a real file is genuinely read', async ({ page, request }) => {
  const chatTitle = `Tool Approval E2E - approve - ${uniqueSuffix()}`;
  await seedToolProfile(request, chatTitle);

  await page.goto('/');
  await page.getByRole('button', { name: chatTitle }).click();

  const textbox = page.getByRole('textbox', { name: /message/i });
  await textbox.fill('#tool secrets.txt');
  await textbox.press('Enter');

  // The approval prompt appears inline in the thread, under the streaming assistant message.
  const prompt = page.locator('[data-testid^="approval-prompt-"]');
  await expect(prompt).toBeVisible();
  await expect(prompt).toContainText('read_file');

  await prompt.getByRole('button', { name: 'Allow once' }).click();

  // The prompt disappears once resolved.
  await expect(prompt).toHaveCount(0);

  // And the REAL file content -- not a fabricated string -- appears in the model's answer
  // (scoped to the reply body: the collapsed tool group and the Inspector outline also mention it).
  await expect(page.locator('article[data-role="assistant"] .markdown-body').getByText(/THE TREASURE IS BURIED UNDER THE OAK TREE/)).toBeVisible();
  await expect(page.getByLabel('streaming')).toHaveCount(0);

  // Independently confirm (outside the browser) that the file is untouched --
  // read_file is read-only, this is just a sanity check the workspace is real.
  expect(readFileSync(join(workspaceRoot, 'secrets.txt'), 'utf8')).toContain('OAK TREE');
});

test('denying a tool call surfaces a tool error the model responds to, instead of hanging', async ({ page, request }) => {
  const chatTitle = `Tool Approval E2E - deny - ${uniqueSuffix()}`;
  await seedToolProfile(request, chatTitle);

  await page.goto('/');
  await page.getByRole('button', { name: chatTitle }).click();

  const textbox = page.getByRole('textbox', { name: /message/i });
  await textbox.fill('#tool secrets.txt');
  await textbox.press('Enter');

  const prompt = page.locator('[data-testid^="approval-prompt-"]');
  await expect(prompt).toBeVisible();
  await prompt.getByRole('button', { name: 'Deny' }).click();
  await expect(prompt).toHaveCount(0);

  // The turn does not hang: it reaches a terminal (non-streaming) state...
  await expect(page.getByLabel('streaming')).toHaveCount(0, { timeout: 15_000 });
  // ...and the model's own answer text visibly reacts to the denial, proving
  // the tool-result (an error) reached the model rather than the turn just
  // silently dying. Scoped to the markdown body specifically -- the raw
  // tool-result block above it ALSO contains "approval_denied" (the
  // redacted JSON itself), which is fine/expected, just not what this
  // assertion is about.
  const answerBody = page.locator('article[data-role="assistant"] .markdown-body');
  await expect(answerBody).toContainText('did not go through');
  await expect(answerBody).toContainText('approval_denied');
});

test('an approval raised by one variant of a compare turn does not block its sibling', async ({ page, request }) => {
  const suffix = uniqueSuffix();
  const connRes = await request.post(`${BASE_URL}/api/connections`, { data: { name: `Mock ${suffix}`, kind: 'mock' } });
  const { id: connectionId } = await connRes.json();

  const toolPolicy = { fs: 'readwrite', shell: false, mcpServerIds: [], approvalMode: 'always_ask' };
  const variantAName = `Variant A ${suffix}`;
  const variantBName = `Variant B ${suffix}`;
  const chatTitle = `Compare Tool Approval E2E - ${suffix}`;

  const profileARes = await request.post(`${BASE_URL}/api/profiles`, {
    data: { name: variantAName, connectionId, modelId: 'mock-standard', isDefault: true, toolPolicy },
  });
  const { id: profileAId } = await profileARes.json();
  await request.post(`${BASE_URL}/api/profiles`, {
    data: { name: variantBName, connectionId, modelId: 'mock-standard', toolPolicy },
  });

  const chatRes = await request.post(`${BASE_URL}/api/chats`, {
    data: { title: chatTitle, profileId: profileAId, workspaceRoot },
  });
  expect(chatRes.ok()).toBeTruthy();

  await page.goto('/');
  await page.getByRole('button', { name: chatTitle }).click();

  // Add Variant B to the turn via the Compare (+) picker (a plain
  // checkbox list, not role="option" -- unlike the primary-profile picker).
  // Closed by clicking its own toggle button again -- Escape does not close
  // it (no such handler exists), and leaving it open lets its dropdown
  // intercept later clicks underneath it (flaky failure observed: "Deny"
  // click blocked by the still-open listbox overlapping it).
  await page.getByRole('button', { name: 'Compare', exact: true }).click();
  await page.getByRole('checkbox', { name: variantBName }).check();
  await page.getByRole('button', { name: 'Compare', exact: true }).click();
  await expect(page.getByRole('listbox', { name: 'Compare profiles' })).toBeHidden();

  const textbox = page.getByRole('textbox', { name: /message/i });
  await textbox.fill('#tool secrets.txt');
  await textbox.press('Enter');

  // The tab strip shows only the ACTIVE variant's card at a time; Split
  // view renders every variant simultaneously, which is what lets both
  // variants' approval prompts be visible (and asserted on) together.
  await page.getByRole('button', { name: 'Split view' }).click();

  // Both variants raise their own approval prompt independently.
  const prompts = page.locator('[data-testid^="approval-prompt-"]');
  await expect(prompts).toHaveCount(2, { timeout: 15_000 });

  // Approve exactly one of them.
  const first = prompts.first();
  await first.getByRole('button', { name: 'Allow once' }).click();

  // Exactly one prompt resolves; the sibling's is still sitting there,
  // completely unaffected -- the concurrency guarantee task 26 exists to
  // deliver (decision #2), now verified in a real browser, not just at the
  // provider/reducer layers.
  await expect(prompts).toHaveCount(1, { timeout: 10_000 });

  // The still-pending one can still be answered on its own.
  await prompts.first().getByRole('button', { name: 'Deny' }).click();
  await expect(prompts).toHaveCount(0);

  await expect(page.getByLabel('streaming')).toHaveCount(0, { timeout: 15_000 });
});

test('stopping a turn while an approval card is up removes the card and ends the turn', async ({ page, request }) => {
  const chatTitle = `Tool Approval E2E - stop - ${uniqueSuffix()}`;
  await seedToolProfile(request, chatTitle);

  await page.goto('/');
  await page.getByRole('button', { name: chatTitle }).click();

  const textbox = page.getByRole('textbox', { name: /message/i });
  await textbox.fill('#tool secrets.txt');
  await textbox.press('Enter');

  const prompt = page.locator('[data-testid^="approval-prompt-"]');
  await expect(prompt).toBeVisible();

  await page.getByRole('button', { name: 'Stop', exact: true }).click();

  // The card goes away (nobody answered it) and the turn reaches a terminal state.
  await expect(prompt).toHaveCount(0);
  await expect(page.getByLabel('streaming')).toHaveCount(0, { timeout: 15_000 });
});
