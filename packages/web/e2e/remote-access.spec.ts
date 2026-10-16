import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, request as playwrightRequest, test, type APIRequestContext, type Page } from '@playwright/test';

/**
 * Remote access (spec 2026-10-12-remote-access §10): a server in sign-in mode
 * with its own certificate, used from a browser that ignores the certificate
 * warning (the CA isn't installed). Started here, not by the config's
 * webServer, which keeps serving every other spec in open mode. It trusts
 * 127.0.0.1 as a proxy so (g) can sign in from many addresses with
 * `X-Forwarded-For`; the browser sends none, so it is still 127.0.0.1.
 * (a)-(f) spend 11 of the budget's 20 password checks; (g) spends the rest.
 */

const webDir = join(dirname(fileURLToPath(import.meta.url)), '..');
/** Its own port; OTHERBENCH_E2E_REMOTE_PORT moves it when 4781 is taken. */
const PORT = Number(process.env.OTHERBENCH_E2E_REMOTE_PORT ?? 4781);
const BASE = `https://127.0.0.1:${PORT}`;
const PASSWORD = 'e2e remote password';
const TOKEN = 'e2e-remote-token';
const root = mkdtempSync(join(tmpdir(), 'otherbench-remote-e2e-'));
const db = join(root, 'otherbench.db');
let server: ChildProcess | null = null;
let api: APIRequestContext;
let chatTitle = '';
let artifactChatTitle = '';

test.describe.configure({ mode: 'serial' });
test.use({ ignoreHTTPSErrors: true });

function run(args: string[], stdin?: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['../server/dist/cli.js', ...args], { cwd: webDir, stdio: ['pipe', 'ignore', 'inherit'] });
    child.once('error', reject);
    child.once('exit', (code) => resolve(code ?? 1));
    child.stdin!.end(stdin ?? '');
  });
}

test.beforeAll(async () => {
  test.setTimeout(60_000);
  expect(await run(['password', '--db', db], `${PASSWORD}\n`)).toBe(0);
  server = spawn(process.execPath, ['../server/dist/cli.js', 'serve', '--port', String(PORT), '--db', db, '--public-url', BASE, '--tls', 'auto', '--trust-proxy', '127.0.0.1'], {
    cwd: webDir,
    stdio: 'ignore',
    env: { ...process.env, OTHERBENCH_TOKEN: TOKEN },
  });
  api = await playwrightRequest.newContext({ baseURL: BASE, ignoreHTTPSErrors: true, extraHTTPHeaders: { Authorization: `Bearer ${TOKEN}` } });
  const deadline = Date.now() + 15_000;
  for (;;) {
    try {
      if ((await api.get('/api/health')).ok()) break;
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) throw new Error('the sign-in server did not start');
    await new Promise((r) => setTimeout(r, 100));
  }
  // A mock profile and a chat, seeded with the token.
  const conn = await (await api.post('/api/connections', { data: { name: 'Mock', kind: 'mock' } })).json();
  // The same tool policy artifacts.spec.ts uses, so #artifact makes its page without an approval.
  const profile = await (
    await api.post('/api/profiles', {
      data: { name: 'Mock Profile', connectionId: conn.id, modelId: 'mock-standard', isDefault: true, toolPolicy: { fs: 'off', shell: false, mcpServerIds: [], approvalMode: 'always_ask' } },
    })
  ).json();
  chatTitle = 'Remote chat';
  expect((await api.post('/api/chats', { data: { title: chatTitle, profileId: profile.id, workspaceRoot: root } })).ok()).toBeTruthy();
  // (b) sends a message, which retitles its chat from the first message; (c) gets a chat of its own.
  artifactChatTitle = 'Remote artifact chat';
  expect((await api.post('/api/chats', { data: { title: artifactChatTitle, profileId: profile.id, workspaceRoot: root } })).ok()).toBeTruthy();
});

test.afterAll(async () => {
  await api?.dispose();
  if (server && server.exitCode === null) {
    const exited = new Promise((r) => server!.once('exit', r));
    server.kill();
    await exited;
  }
  rmSync(root, { recursive: true, force: true });
});

async function signIn(page: Page, password = PASSWORD): Promise<void> {
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

test('(a) the login page comes first; a wrong password says so; the right one loads the app, and a reload stays signed in', async ({ page }) => {
  await page.goto(BASE);
  await expect(page.getByRole('link', { name: "Download OtherBench's certificate" })).toBeVisible();

  await signIn(page, 'not the password at all');
  await expect(page.getByRole('alert')).toHaveText('Wrong password.');

  await signIn(page);
  await expect(page.getByRole('button', { name: 'Settings' })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('button', { name: 'Settings' })).toBeVisible();
  await expect(page.getByLabel('Password')).toHaveCount(0);
});

test('(b) a reply streams over the cookie, and an attached image preview loads', async ({ page }) => {
  await page.goto(BASE);
  await signIn(page);
  await page.getByRole('button', { name: chatTitle }).click();
  const textbox = page.getByRole('textbox', { name: /message/i });
  await textbox.fill('Hello over HTTPS');
  await textbox.press('Enter');
  await expect(page.getByTestId('thread-scroll').getByText(/Here is a mock reply from OtherBench/)).toBeVisible({ timeout: 20_000 });
  await expect(page.getByLabel('streaming')).toHaveCount(0, { timeout: 20_000 });

  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
  const preview = page.waitForResponse((r) => /\/api\/attachments\/[^/]+\/content$/.test(r.url()));
  await page.getByTestId('composer-file-input').setInputFiles({ name: 'dot.png', mimeType: 'image/png', buffer: png });
  const res = await preview;
  expect(res.status()).toBe(200);
  expect(res.headers()['content-type']).toBe('image/png');
});

test("(c) a page in the viewer's sandbox can't use the session", async ({ page }) => {
  await page.goto(BASE);
  await signIn(page);
  await page.getByRole('button', { name: artifactChatTitle }).click();
  const textbox = page.getByRole('textbox', { name: /message/i });
  await textbox.fill('#artifact');
  await textbox.press('Enter');
  await expect(page.getByLabel('streaming')).toHaveCount(0, { timeout: 20_000 });
  await page.getByRole('button', { name: /Mock page.*Created v1/ }).click();
  const viewer = page.getByRole('complementary', { name: 'Viewer' });
  await viewer.getByRole('button', { name: 'Edit' }).click();

  // `no-cors` so the browser doesn't discard the (CORS-less) answer: the status is what proves the session cookie wasn't sent.
  const fromSandbox = page.waitForResponse((r) => r.url() === `${BASE}/api/chats` && r.request().frame() !== page.mainFrame());
  await viewer.getByRole('textbox', { name: 'Artifact source' }).fill(`<!doctype html><h1 id="h">Probe</h1><script>fetch('/api/chats', { credentials: 'include', mode: 'no-cors' })</script>`);
  await viewer.getByRole('button', { name: 'Save', exact: true }).click();

  expect((await fromSandbox).status()).toBe(401);
});

test('(d) Sign out shows the login page, and the API refuses the old session', async ({ page }) => {
  await page.goto(BASE);
  await signIn(page);
  await expect(page.getByRole('button', { name: 'Settings' })).toBeVisible();

  await page.getByRole('button', { name: 'Sign out' }).click();

  await expect(page.getByLabel('Password')).toBeVisible();
  expect((await page.request.get(`${BASE}/api/chats`)).status()).toBe(401);
});

test('(e) the login page and Sign out work on a phone-sized screen', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(BASE);
  const button = page.getByRole('button', { name: 'Sign in' });
  const box = await button.boundingBox();
  expect(box && box.x >= 0 && box.x + box.width <= 390).toBeTruthy();

  await signIn(page);
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByLabel('Password')).toBeVisible();
});

test('(f) six wrong passwords lock this address out', async ({ page }) => {
  await page.goto(BASE);
  for (let i = 0; i < 5; i++) {
    await signIn(page, `wrong password number ${i}`);
    await expect(page.getByRole('alert')).toHaveText('Wrong password.');
  }
  await signIn(page, 'wrong password number 6');
  await expect(page.getByRole('alert')).toHaveText(/^Too many tries\. Try again in 15 minutes\.$/);
});

test('(g) under a flood of wrong passwords a clean address still signs in, a new device is told when to come back once fresh addresses spend the reserve, and a remembered one gets straight in', async () => {
  test.setTimeout(90_000);
  // No bearer token: these are sign-ins, each from its own forwarded address (127.0.0.1 is locked by (f)).
  const remembered = await playwrightRequest.newContext({ baseURL: BASE, ignoreHTTPSErrors: true });
  const stranger = await playwrightRequest.newContext({ baseURL: BASE, ignoreHTTPSErrors: true });
  let next = 0;
  const attempt = async (ctx: APIRequestContext, password: string, address?: string, remember = false): Promise<{ status: number; retryAfter: number; ms: number }> => {
    next += 1;
    const started = Date.now();
    const res = await ctx.post('/api/auth/login', { data: { password, remember }, headers: { 'X-Forwarded-For': address ?? `203.0.113.${next}` } });
    return { status: res.status(), retryAfter: Number(res.headers()['retry-after'] ?? 0), ms: Date.now() - started };
  };
  try {
    // A sign-in with "Keep me signed in" leaves a remembered-device cookie in this context's jar.
    expect((await attempt(remembered, PASSWORD, undefined, true)).status).toBe(200);
    const jar = await remembered.storageState();
    expect(jar.cookies.some((c) => c.name === '__Host-otherbench_device' && c.httpOnly && c.secure && c.sameSite === 'Strict')).toBeTruthy();

    // Addresses that keep guessing (4 tries each, short of a lock) spend what any address may and are then refused...
    let guessersRefused = false;
    for (let g = 0; g < 4 && !guessersRefused; g++) {
      for (let i = 0; i < 4 && !guessersRefused; i++) {
        const r = await attempt(stranger, `a guess ${g}.${i}`, `198.51.100.${g + 1}`);
        if (r.status === 429) guessersRefused = true;
        else expect(r.status).toBe(401);
      }
    }
    expect(guessersRefused).toBeTruthy();
    // ...but not the 5 checks kept for addresses that haven't guessed wrong: a new device on a clean address signs in.
    const cleanDevice = await playwrightRequest.newContext({ baseURL: BASE, ignoreHTTPSErrors: true });
    try {
      expect((await attempt(cleanDevice, PASSWORD)).status).toBe(200);
    } finally {
      await cleanDevice.dispose();
    }

    // Wrong passwords from ever new addresses, each clean, spend even those (401) until the budget runs out, then are refused at once (429).
    let refused: { status: number; retryAfter: number } | null = null;
    for (let i = 0; i < 40 && refused === null; i++) {
      const r = await attempt(stranger, `wrong password from afar ${i}`);
      if (r.status === 429) refused = r;
      else expect(r.status).toBe(401);
    }
    expect(refused).not.toBeNull();
    expect(refused!.retryAfter).toBeGreaterThanOrEqual(1);
    expect(refused!.retryAfter).toBeLessThanOrEqual(55);

    // The right password from a new device is told when to come back, never locked out...
    const fresh = await attempt(stranger, PASSWORD);
    expect(fresh.status).toBe(429);
    expect(fresh.retryAfter).toBeGreaterThanOrEqual(1);
    // ...while the remembered device skips the queue and signs in at once.
    const back = await attempt(remembered, PASSWORD);
    expect(back.status).toBe(200);
    expect(back.ms).toBeLessThan(5000);
  } finally {
    await remembered.dispose();
    await stranger.dispose();
  }
});
