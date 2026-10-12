import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32 } from 'node:zlib';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { BASE_URL } from '../playwright.config.js';

/**
 * Office files (spec 2026-10-12-office-files §7): an attached Word file's
 * text reaches the model; the Mock model's `#office <kind>` makes a
 * spreadsheet or a document through the real tool, which the viewer
 * previews, downloads as the made file and saves into the workspace.
 */
let ws: string;
test.beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), 'grunt-e2e-office-'));
});
test.afterEach(() => {
  try {
    rmSync(ws, { recursive: true, force: true });
  } catch {
    /* best-effort cleanup */
  }
});

/** A Mock profile and a chat in `ws`; returns the chat's title. */
async function mockChat(request: APIRequestContext): Promise<string> {
  const suffix = randomUUID().slice(0, 8);
  const conn = await request.post(`${BASE_URL}/api/connections`, { data: { name: `Mock ${suffix}`, kind: 'mock' } });
  const { id: connectionId } = await conn.json();
  const profile = await request.post(`${BASE_URL}/api/profiles`, {
    data: { name: `Office ${suffix}`, connectionId, modelId: 'mock-standard', isDefault: true, toolPolicy: { fs: 'off', shell: false, mcpServerIds: [], approvalMode: 'always_ask' } },
  });
  const { id: profileId } = await profile.json();
  const title = `Office E2E - ${suffix}`;
  expect((await request.post(`${BASE_URL}/api/chats`, { data: { title, profileId, workspaceRoot: ws } })).ok()).toBeTruthy();
  return title;
}

async function send(page: Page, text: string): Promise<void> {
  const textbox = page.getByRole('textbox', { name: /message/i });
  await textbox.fill(text);
  await textbox.press('Enter');
  await expect(page.getByLabel('streaming')).toHaveCount(0);
}

/** A .docx with a heading and a paragraph: only the part Grunt reads, stored uncompressed. */
function minimalDocx(heading: string, text: string): Buffer {
  const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
  const files: [string, string][] = [
    ['[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>'],
    ['word/document.xml', `<?xml version="1.0" encoding="UTF-8"?><w:document ${W}><w:body><w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>${heading}</w:t></w:r></w:p><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`],
  ];
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of files) {
    const data = Buffer.from(content, 'utf8');
    const nameBytes = Buffer.from(name, 'utf8');
    const crc = crc32(data) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x800, 6);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x800, 8);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, data);
    centrals.push(central, nameBytes);
    offset += local.length + nameBytes.length + data.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

test("an attached Word file's text reaches the model", async ({ page, request }) => {
  const title = await mockChat(request);
  await page.goto('/');
  await page.getByRole('button', { name: title }).click();
  await page.getByTestId('composer-file-input').setInputFiles({
    name: 'memo.docx',
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    buffer: minimalDocx('Quarterly memo', 'Grunt reads this memo end to end'),
  });
  await expect(page.getByTestId('composer-dropzone').getByTestId('attachment-chip')).toContainText('memo.docx');
  await send(page, '#echo-user');
  await expect(page.locator('article[data-role="assistant"]').last()).toContainText('Grunt reads this memo end to end');
});

test('the model makes a spreadsheet: previewed with its formula, downloaded and saved as a real .xlsx', async ({ page, request }) => {
  const title = await mockChat(request);
  await page.goto('/');
  await page.getByRole('button', { name: title }).click();
  await send(page, '#office spreadsheet');

  await page.getByRole('button', { name: /Mock budget.*Created v1/ }).click();
  const viewer = page.getByRole('complementary', { name: 'Viewer' });
  await expect(viewer.getByRole('cell', { name: 'Total' })).toBeVisible();
  await expect(viewer.getByText('=SUM(B2:B3)')).toBeVisible();

  const downloading = page.waitForEvent('download');
  await viewer.getByRole('button', { name: 'Download' }).click();
  const download = await downloading;
  expect(download.suggestedFilename()).toBe('budget.xlsx');
  expect(readFileSync(await download.path()).subarray(0, 2).toString('latin1')).toBe('PK');

  await viewer.getByRole('button', { name: 'Save to workspace' }).click();
  await expect(viewer.getByRole('textbox', { name: 'Save as' })).toHaveValue('budget.xlsx');
  await viewer.getByRole('button', { name: 'Save file' }).click();
  await expect(viewer.getByRole('status')).toContainText('Saved to');
  expect(readFileSync(join(ws, 'budget.xlsx')).subarray(0, 2).toString('latin1')).toBe('PK');
});

test('the model makes a document, previewed with its heading', async ({ page, request }) => {
  const title = await mockChat(request);
  await page.goto('/');
  await page.getByRole('button', { name: title }).click();
  await send(page, '#office document');
  await page.getByRole('button', { name: /Mock memo.*Created v1/ }).click();
  const viewer = page.getByRole('complementary', { name: 'Viewer' });
  await expect(viewer.getByRole('heading', { name: 'Quarterly memo' })).toBeVisible();
});
