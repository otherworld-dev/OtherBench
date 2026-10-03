import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { BASE_URL } from '../playwright.config.js';

/**
 * Real-browser verification for task 21 (attachments + capability
 * fallback). Everything else (upload/dedupe mechanics, the degrade-to-
 * extracted-text logic, the EngineRequest a vision-less profile actually
 * receives) is already covered by unit/integration tests
 * (packages/server/test/routes/attachments.test.ts,
 * packages/core/test/turn.test.ts) -- this file exists ONLY to prove the
 * two things that need a real DOM and a real drag/paste event to prove at
 * all:
 *
 *   1. Drag-and-drop and paste-to-attach actually work in a browser and
 *      produce a visible chip the user can remove before sending.
 *   2. When the composer's chosen profile lacks vision support, the
 *      degradation note actually renders on screen -- not silence.
 *
 * Uses the keyless mock connection (same technique as smoke.spec.ts) with
 * two profiles: one whose model declares vision support, one that doesn't.
 */

function uniqueSuffix(): string {
  return randomUUID().slice(0, 8);
}

async function seedProfiles(
  request: import('@playwright/test').APIRequestContext,
  suffix: string
): Promise<{ visionProfileName: string; noVisionProfileName: string }> {
  const conn = await request.post(`${BASE_URL}/api/connections`, { data: { name: `Mock ${suffix}`, kind: 'mock' } });
  expect(conn.ok()).toBeTruthy();
  const { id: connectionId } = await conn.json();

  const visionModel = await request.post(`${BASE_URL}/api/models`, {
    data: { connectionId, modelId: `vision-model-${suffix}`, displayName: `Vision Model ${suffix}`, supportsVision: true },
  });
  expect(visionModel.ok()).toBeTruthy();

  const noVisionModel = await request.post(`${BASE_URL}/api/models`, {
    data: { connectionId, modelId: `no-vision-model-${suffix}`, displayName: `No-Vision Model ${suffix}`, supportsVision: false },
  });
  expect(noVisionModel.ok()).toBeTruthy();

  const visionProfileName = `Vision Profile ${suffix}`;
  const visionProfile = await request.post(`${BASE_URL}/api/profiles`, {
    data: { name: visionProfileName, connectionId, modelId: `vision-model-${suffix}`, isDefault: true },
  });
  expect(visionProfile.ok()).toBeTruthy();

  const noVisionProfileName = `No-Vision Profile ${suffix}`;
  const noVisionProfile = await request.post(`${BASE_URL}/api/profiles`, {
    data: { name: noVisionProfileName, connectionId, modelId: `no-vision-model-${suffix}` },
  });
  expect(noVisionProfile.ok()).toBeTruthy();

  return { visionProfileName, noVisionProfileName };
}

/**
 * Constructs a real `File` + `DataTransfer` in the PAGE's own JS context
 * (not Node's) and dispatches `dragover` then `drop` directly on the
 * element matching `selector` -- the standard way to exercise a custom
 * (non-`<input type=file>`) drop zone in Playwright, since there is no real
 * OS-level drag to simulate against.
 */
async function dropFile(
  page: import('@playwright/test').Page,
  selector: string,
  filename: string,
  mime: string,
  content: string
): Promise<void> {
  await page.evaluate(
    ({ selector, filename, mime, content }) => {
      const dt = new DataTransfer();
      dt.items.add(new File([content], filename, { type: mime }));
      const el = document.querySelector(selector);
      if (!el) throw new Error(`dropFile: no element matches "${selector}"`);
      el.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
      el.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
    },
    { selector, filename, mime, content }
  );
}

/** Same technique as `dropFile`, but for a `paste` ClipboardEvent on the composer's textarea. */
async function pasteFile(
  page: import('@playwright/test').Page,
  selector: string,
  filename: string,
  mime: string,
  content: string
): Promise<void> {
  await page.evaluate(
    ({ selector, filename, mime, content }) => {
      const dt = new DataTransfer();
      dt.items.add(new File([content], filename, { type: mime }));
      const el = document.querySelector(selector);
      if (!el) throw new Error(`pasteFile: no element matches "${selector}"`);
      el.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt }));
    },
    { selector, filename, mime, content }
  );
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function chooseProfile(page: import('@playwright/test').Page, profileName: string): Promise<void> {
  await page.getByRole('button', { name: /choose a profile|·/ }).click();
  // Anchored at the start: "Vision Profile <suffix>" would otherwise also
  // match as a SUBSTRING of "No-Vision Profile <suffix>" (Playwright's
  // getByRole name-as-regex is unanchored by default), hitting Playwright's
  // strict-mode "resolved to 2 elements" error.
  await page.getByRole('option', { name: new RegExp(`^${escapeRegExp(profileName)}`) }).click();
}

test('drag-and-drop attaches a file, shows a removable chip, and the sent message carries the attachment (visible on the user\'s own message)', async ({ page, request }) => {
  const suffix = uniqueSuffix();
  const { visionProfileName } = await seedProfiles(request, suffix);

  await page.goto('/');
  await page.getByRole('button', { name: '+ New chat' }).click();
  await chooseProfile(page, visionProfileName);

  await dropFile(page, '[data-testid="composer-dropzone"]', 'holiday.png', 'image/png', 'x'.repeat(200));

  // The chip appears before sending, with a working remove button.
  const chip = page.getByTestId('attachment-chip');
  await expect(chip).toBeVisible();
  await expect(chip).toContainText('holiday.png');
  await expect(page.getByRole('button', { name: /remove holiday.png/i })).toBeVisible();

  const textbox = page.getByRole('textbox', { name: /message/i });
  await textbox.fill('What do you see?');
  await textbox.press('Enter');

  // The chip is cleared from the composer after sending...
  await expect(page.getByTestId('composer-dropzone').getByTestId('attachment-chip')).toHaveCount(0);
  // ...and reappears attached to the user's own message in the thread, next
  // to its text -- decision #5's "visible chip per attachment", surviving
  // the round trip through the server and back.
  await expect(page.getByTestId('thread-scroll').getByText('What do you see?')).toBeVisible();
  await expect(page.locator('article[data-role="user"]').getByTestId('attachment-chip')).toBeVisible();
});

test('paste-to-attach works, and a profile without vision support shows the degradation note on its reply -- not silence', async ({ page, request }) => {
  const suffix = uniqueSuffix();
  const { noVisionProfileName } = await seedProfiles(request, suffix);

  await page.goto('/');
  await page.getByRole('button', { name: '+ New chat' }).click();
  await chooseProfile(page, noVisionProfileName);

  const textbox = page.getByRole('textbox', { name: /message/i });
  await pasteFile(page, 'textarea[aria-label="Message"]', 'pasted.png', 'image/png', 'y'.repeat(200));
  await expect(page.getByTestId('attachment-chip')).toBeVisible();

  await textbox.fill('Describe this image');
  await textbox.press('Enter');

  // The mock provider replies regardless -- what matters here is that the
  // assistant's own reply carries an honest, visible note that the image
  // was degraded, because THIS profile's model has no vision support.
  const note = page.locator('article[data-role="assistant"]').getByRole('note');
  await expect(note).toBeVisible();
  await expect(note).toContainText('does not support image input');
  await expect(note).toContainText('pasted.png');
});
