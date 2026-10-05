import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';

const webDir = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Two Grunt servers on this machine standing in for the PC and the laptop
 * (v2 plan, Task 54): pair through the UI, sync a chat with a folder in a
 * location, run it on the PC from the laptop, then stop the PC, run it on
 * the laptop instead, and see the new branch reach the PC once it's back.
 * The servers are started here rather than by the config's webServer, so
 * the PC can be stopped and started again mid-test. Both use the keyless
 * mock provider.
 */

const PC = { name: 'PC', port: 4761, peerPort: 4771 };
const LAPTOP = { name: 'Laptop', port: 4762, peerPort: 4772 };
const url = (m: { port: number }, path = ''): string => `http://127.0.0.1:${m.port}${path}`;

const root = mkdtempSync(join(tmpdir(), 'grunt-two-node-'));
const servers = new Map<string, ChildProcess>();

async function healthy(m: { port: number }): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(url(m, '/api/health'))).ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`server on ${m.port} did not start`);
}

async function start(m: typeof PC): Promise<void> {
  const dir = join(root, m.name);
  mkdirSync(dir, { recursive: true });
  const child = spawn(
    process.execPath,
    ['../server/dist/cli.js', 'serve', '--port', String(m.port), '--db', join(dir, 'grunt.db'), '--peer-port', String(m.peerPort), '--peer-host', '127.0.0.1'],
    { cwd: webDir, stdio: 'ignore' }
  );
  servers.set(m.name, child);
  await healthy(m);
}

async function stop(m: typeof PC): Promise<void> {
  const child = servers.get(m.name);
  if (!child || child.exitCode !== null) return;
  const exited = new Promise((r) => child.once('exit', r));
  child.kill();
  await exited;
  servers.delete(m.name);
}

async function api<T>(m: { port: number }, method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(url(m, `/api${path}`), { method, headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  if (!res.ok) throw new Error(`${method} ${path} on ${m.port}: ${res.status} ${await res.text()}`);
  return (res.status === 204 ? undefined : await res.json()) as T;
}

async function openMachines(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('tab', { name: 'Machines' }).click();
}

test.describe.configure({ mode: 'serial' });

test.afterAll(async () => {
  await stop(PC);
  await stop(LAPTOP);
  rmSync(root, { recursive: true, force: true });
});

test('pair through the UI, run a PC chat from the laptop, then run it on the laptop while the PC is away', async ({ browser }) => {
  test.setTimeout(120_000);
  await start(PC);
  await start(LAPTOP);
  await api(PC, 'PATCH', '/node', { name: 'PC' });
  await api(LAPTOP, 'PATCH', '/node', { name: 'Laptop' });

  // On the PC: a mock profile, a location, and a chat in a folder inside it.
  const pcFolder = join(root, 'pc-files');
  const laptopFolder = join(root, 'laptop-files');
  mkdirSync(join(pcFolder, 'project'), { recursive: true });
  mkdirSync(join(laptopFolder, 'project'), { recursive: true });
  const connection = await api<{ id: string }>(PC, 'POST', '/connections', { name: 'Mock', kind: 'mock' });
  const profile = await api<{ id: string }>(PC, 'POST', '/profiles', { name: 'Mock Profile', connectionId: connection.id, modelId: 'mock-standard', isDefault: true });
  await api(PC, 'POST', '/locations', { name: 'Work', path: pcFolder });
  const chat = await api<{ id: string }>(PC, 'POST', '/chats', { title: 'Shared chat', profileId: profile.id, workspacePath: join(pcFolder, 'project') });

  const pc = await browser.newPage();
  const laptop = await browser.newPage();
  await pc.goto(url(PC));
  await laptop.goto(url(LAPTOP));

  // Pair: the PC shows a code, the laptop enters it.
  await openMachines(pc);
  await pc.getByRole('button', { name: 'Show a code' }).click();
  const shown = pc.getByTestId('pairing-code');
  await expect(shown).toBeVisible();
  const code = (await shown.locator('p.font-mono').first().textContent())!.trim();
  await openMachines(laptop);
  await laptop.getByRole('textbox', { name: 'Address' }).fill(`127.0.0.1:${PC.peerPort}`);
  await laptop.getByRole('textbox', { name: 'Code' }).fill(code);
  await laptop.getByRole('button', { name: 'Add' }).click();
  await expect(laptop.getByTestId(/^peer-/).first()).toContainText('PC');
  await expect(pc.getByTestId(/^peer-/).first()).toContainText('Laptop');
  await laptop.getByRole('button', { name: 'Close settings' }).click();

  // The PC's chat arrives on the laptop.
  const chatRow = laptop.getByText('Shared chat');
  await expect(chatRow).toBeVisible({ timeout: 15_000 });
  await chatRow.click();

  // It runs on the PC: the laptop sends, the PC answers.
  const box = laptop.getByRole('textbox', { name: /message/i });
  await box.fill('hello from the laptop');
  await box.press('Enter');
  const thread = laptop.getByTestId('thread-scroll');
  await expect(thread.getByText(/Here is a mock reply from Grunt/)).toBeVisible({ timeout: 20_000 });
  await expect(laptop.getByLabel('streaming')).toHaveCount(0);
  const onPc = await api<{ messages: { originNode?: string }[] }>(PC, 'GET', `/chats/${chat.id}/messages`);
  expect(onPc.messages.length).toBeGreaterThanOrEqual(2);

  // The PC goes away mid-reply: the laptop keeps what it said, and offers to run the chat here.
  await box.fill('tell me slowly #slow');
  await box.press('Enter');
  await expect(thread.getByText(/This reply trickles/)).toBeVisible({ timeout: 20_000 });
  await stop(PC);
  await expect(thread.getByText('PC stopped responding.')).toBeVisible({ timeout: 20_000 });
  await expect(laptop.getByTestId('unreachable-banner')).toBeVisible({ timeout: 20_000 });
  await laptop.getByRole('button', { name: 'Run here' }).click();

  // Here, the location has no folder yet: the laptop asks where it is.
  await expect(laptop.getByText('Where is Work on this machine?')).toBeVisible();
  await laptop.getByRole('textbox', { name: 'Location folder on this machine' }).fill(laptopFolder);
  await laptop.getByRole('button', { name: 'Save' }).click();
  await expect(laptop.getByTestId('workspace-prompt')).toHaveCount(0);

  // Carrying on from the cut-off reply works here.
  await box.fill('carrying on while the PC is off');
  await box.press('Enter');
  await expect(thread.getByText(/Here is a mock reply from Grunt/)).toHaveCount(2, { timeout: 20_000 });
  await expect(laptop.getByLabel('streaming')).toHaveCount(0);
  await expect(thread.getByText(/This reply trickles/)).toBeVisible();

  // The PC comes back and picks up the branch written on the laptop.
  await start(PC);
  await expect
    .poll(
      async () => {
        const after = await api<{ messages: { parts: { type: string; text?: string }[] }[] }>(PC, 'GET', `/chats/${chat.id}/messages`).catch(() => null);
        return after?.messages.some((m) => m.parts.some((p) => p.text === 'carrying on while the PC is off')) ?? false;
      },
      { timeout: 30_000 }
    )
    .toBe(true);
});
