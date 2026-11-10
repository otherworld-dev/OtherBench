import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, expect, request as playwrightRequest, test as base, type APIRequestContext, type Browser, type BrowserContext, type Locator, type Page } from '@playwright/test';

/**
 * Starts the desktop smoke tests' build of OtherBench and attaches Playwright to
 * its webviews over the Chrome DevTools Protocol.
 *
 * Isolation from the installed app and its data, in layers:
 * - The build (desktop/src-tauri/tauri.e2e.conf.json) has its own identifier
 *   and exe name, so its single-instance lock, webview storage, logs, window
 *   state and process name are never the installed app's: a launch can't
 *   reach a running OtherBench, and nothing here ever stops one.
 * - Its server keeps its database in a scratch folder (`OTHERBENCH_E2E_DATA_DIR`,
 *   main.rs `test_data_dir`), and its peer listener takes any free port. That
 *   build refuses to start its server without the variable, and the installed
 *   app never reads it.
 * - Everything else is under the same scratch folder: the webview's storage
 *   (`WEBVIEW2_USER_DATA_FOLDER`), the home folder (`USERPROFILE`: a run leaves a `.claude.json` and
 *   `.claude/backups` there, which would otherwise be written in the real one), the
 *   shell's logs, window state and undocked list (`APPDATA` / `LOCALAPPDATA`:
 *   Windows expands the known folders Tauri asks for from them), and the
 *   Cowork / Claude Desktop files the server might read. The DevTools port is
 *   a free one picked per run.
 * - The checks below that the database and the shell's logs really are in the
 *   scratch folder run before any test writes anything.
 */

export const E2E_IDENTIFIER = 'dev.otherworld.otherbench.e2e';
const EXE_NAME = 'otherbench-e2e.exe';
const REPO_ROOT = resolve(fileURLToPath(new URL('../../../', import.meta.url)));
/** Where `npm run app:e2e -w @otherbench/desktop` writes the test build. Deliberately not overridable. */
export const EXE = join(REPO_ROOT, 'desktop', 'src-tauri', 'target', 'debug', EXE_NAME);
const SERVER_SCRIPT = join(REPO_ROOT, 'packages', 'server', 'dist', 'cli.js');

export type View = 'code' | 'overview';

export interface DesktopApp {
  context: BrowserContext;
  /** The main window. */
  main: Page;
  /** The app's own server, as the main window was told it (the `bootstrap` command). */
  server: { baseUrl: string; token: string };
  /** The server's API, signed in with this launch's token. */
  api: APIRequestContext;
  /** The scratch folder the server keeps its database in. */
  dataDir: string;
  /** The default profile the mock connection seeded. */
  profileId: string;
  /** Every request any of the app's windows has made, as URLs, in order. */
  requests: string[];
  /** The window an undocked view opened, once it has. */
  windowFor(view: View): Promise<Page>;
  /** Whether a window for `view` is open. */
  hasWindow(view: View): boolean;
  /** Calls one of the shell's commands from `page`, as the web app does. */
  invoke<T>(page: Page, command: string, args?: Record<string, unknown>): Promise<T>;
  /**
   * Drags `source` onto `target` in the main window with the real mouse (real-drag.ps1), through Windows' own drag
   * and drop as a person's drag goes. Moves the cursor for about two seconds and puts it back.
   */
  realDrag(source: Locator, target: Locator): Promise<void>;
}

const REAL_DRAG = fileURLToPath(new URL('./real-drag.ps1', import.meta.url));

/** A point inside `box`, `dx` CSS pixels from its left edge, in the window's physical pixels. */
function devicePoint(box: { x: number; y: number; width: number; height: number }, dx: number, dpr: number): { x: number; y: number } {
  return { x: Math.round((box.x + Math.min(dx, box.width / 2)) * dpr), y: Math.round((box.y + box.height / 2) * dpr) };
}

function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolvePort(port));
    });
  });
}

/** The PIDs of processes running `image`. */
function running(image: string): number[] {
  const out = spawnSync('tasklist', ['/FI', `IMAGENAME eq ${image}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8' }).stdout ?? '';
  return out
    .split(/\r?\n/)
    .filter((line) => line.toLowerCase().startsWith(`"${image.toLowerCase()}"`))
    .map((line) => Number(line.split('","')[1]))
    .filter((pid) => Number.isInteger(pid));
}

async function waitFor<T>(what: string, timeoutMs: number, probe: () => Promise<T | null> | T | null): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== null) return value;
    if (Date.now() > deadline) throw new Error(`Timed out after ${timeoutMs} ms waiting for ${what}.`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

const isAppPage = (url: string): boolean => url.startsWith('http://tauri.localhost/');
const viewOf = (url: string): string | null => new URL(url).searchParams.get('view');

function invokeIn<T>(page: Page, command: string, args: Record<string, unknown> = {}): Promise<T> {
  return page.evaluate(
    ([cmd, a]) => (window as unknown as { __TAURI_INTERNALS__: { invoke: (c: string, x: unknown) => Promise<unknown> } }).__TAURI_INTERNALS__.invoke(cmd, a),
    [command, args] as const,
  ) as Promise<T>;
}

/**
 * The PIDs of processes whose command line names `root` (this run's own scratch folder, so only ever ours): the
 * webview's processes, which can outlive the app (`taskkill /T` doesn't always reach them) and hold the folder.
 */
function processesUsing(root: string): number[] {
  const script = `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($env:E2E_ROOT) } | ForEach-Object { $_.ProcessId }`;
  const out = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', env: { ...process.env, E2E_ROOT: root } }).stdout ?? '';
  return out
    .split(/\r?\n/)
    .map((s) => Number(s.trim()))
    .filter((pid) => Number.isInteger(pid) && pid > 0 && pid !== process.pid);
}

const SCRATCH_PREFIX = 'otherbench-desktop-e2e-';

/** Removes a scratch folder, trying for about `tries` seconds while something still holds it; warns if it can't. */
async function removeScratch(dir: string, tries: number): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch (err) {
      if (attempt >= tries) {
        if (tries > 0) console.warn(`[e2e-desktop] couldn't remove the scratch folder ${dir} (a later run removes it): ${String(err)}`);
        return;
      }
      await new Promise((r) => setTimeout(r, 1_000));
    }
  }
}

/** Stops the test build's process tree by its PID (never by name), then anything still using this run's folder. */
async function stop(child: ChildProcess, root: string): Promise<void> {
  if (child.pid !== undefined && child.exitCode === null) {
    const exited = new Promise<void>((r) => child.once('exit', () => r()));
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    await Promise.race([exited, new Promise((r) => setTimeout(r, 10_000))]);
  }
  for (const pid of processesUsing(root)) spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
}

async function launch(logPath: string): Promise<{ app: DesktopApp; close: () => Promise<void> }> {
  if (process.platform !== 'win32') throw new Error('The desktop smoke tests drive WebView2, so they run on Windows only.');
  if (!existsSync(EXE)) throw new Error(`No test build at ${EXE}. Run \`npm run build\` and then \`npm run app:e2e -w @otherbench/desktop\` first.`);
  if (!existsSync(SERVER_SCRIPT)) throw new Error(`No server build at ${SERVER_SCRIPT}. Run \`npm run build\` first.`);
  const leftover = running(EXE_NAME);
  if (leftover.length > 0) {
    // Its single-instance lock would swallow this launch. It is only ever a test build, but it isn't ours to stop.
    throw new Error(`A test build is already running (${EXE_NAME}, PID ${leftover.join(', ')}). Quit it from its tray icon, or end that PID, and run again.`);
  }

  const root = mkdtempSync(join(tmpdir(), SCRATCH_PREFIX));
  const dataDir = join(root, 'data');
  const home = join(root, 'home');
  const roamingDir = join(home, 'AppData', 'Roaming');
  const localDir = join(home, 'AppData', 'Local');
  for (const dir of [dataDir, roamingDir, localDir, join(root, 'webview'), join(root, 'cowork')]) mkdirSync(dir, { recursive: true });

  const cdpPort = await freePort();
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    // Nothing of the caller's OtherBench or WebView2 settings reaches the test build, nor Playwright's colour switches.
    if (!/^(OTHERBENCH_|WEBVIEW2_|FORCE_COLOR$|NO_COLOR$)/i.test(key)) env[key] = value;
  }
  Object.assign(env, {
    OTHERBENCH_E2E_DATA_DIR: dataDir,
    OTHERBENCH_SERVER_SCRIPT: SERVER_SCRIPT,
    OTHERBENCH_SANDBOX: 'fake',
    OTHERBENCH_COWORK_ROOT: join(root, 'cowork'),
    OTHERBENCH_CLAUDE_DESKTOP_CONFIG: join(root, 'claude_desktop_config.json'),
    USERPROFILE: home,
    HOME: home,
    APPDATA: roamingDir,
    LOCALAPPDATA: localDir,
    WEBVIEW2_USER_DATA_FOLDER: join(root, 'webview'),
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${cdpPort}`,
  });

  mkdirSync(join(logPath, '..'), { recursive: true });
  const log = createWriteStream(logPath);
  const child = spawn(EXE, [], { env, cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout?.pipe(log);
  child.stderr?.pipe(log);
  let browser: Browser | null = null;
  let api: APIRequestContext | null = null;

  const close = async (): Promise<void> => {
    await api?.dispose().catch(() => {});
    if (browser) {
      // The webview's browser process outlives the app by a minute or more, holding the scratch folder, and
      // taskkill can't end it: ask it to close over CDP first. (Playwright's close() only disconnects here.)
      await browser
        .newBrowserCDPSession()
        .then((session) => session.send('Browser.close'))
        .catch(() => {});
      await browser.close().catch(() => {});
    }
    await stop(child, root);
    log.end();
    if (process.env['OTHERBENCH_E2E_KEEP'] === '1') {
      console.log(`[e2e-desktop] kept the scratch folder ${root}`);
      return;
    }
    await removeScratch(root, 30);
    // Earlier runs' folders, if they couldn't be removed then: only ones over ten minutes old, skipped quietly while in use.
    for (const name of readdirSync(tmpdir())) {
      const dir = join(tmpdir(), name);
      if (name.startsWith(SCRATCH_PREFIX) && Date.now() - statSync(dir).mtimeMs > 10 * 60_000) await removeScratch(dir, 0);
    }
  };

  try {
    const endpoint = `http://127.0.0.1:${cdpPort}`;
    await waitFor('the test build to open its DevTools port', 60_000, async () => {
      if (child.exitCode !== null) throw new Error(`The test build exited (code ${child.exitCode}) before its webview opened; see ${logPath}.`);
      const res = await fetch(`${endpoint}/json/version`).catch(() => null);
      return res?.ok ? true : null;
    });
    browser = await chromium.connectOverCDP(endpoint);
    const context = browser.contexts()[0] ?? (await waitFor('a browser context', 10_000, () => browser!.contexts()[0] ?? null));
    const requests: string[] = [];
    context.on('request', (r) => requests.push(r.url()));

    const main = await waitFor('the main window', 30_000, () => context.pages().find((p) => isAppPage(p.url()) && viewOf(p.url()) === null) ?? null);
    const server = await invokeIn<{ baseUrl: string; token: string }>(main, 'bootstrap');
    expect(server.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);

    // Before anything is written: the server opened the scratch database, so it isn't using the real one.
    expect(existsSync(join(dataDir, 'otherbench.db')), `the server's database should be in ${dataDir}`).toBe(true);
    // And the shell's own folders (logs, window state, undocked list) are under the scratch home: Windows expands the
    // known folders from USERPROFILE / APPDATA / LOCALAPPDATA, which point there.
    const serverLog = join(localDir, E2E_IDENTIFIER, 'logs', 'server.log');
    expect(existsSync(serverLog), `the shell's logs should be in ${serverLog}`).toBe(true);

    api = await playwrightRequest.newContext({ baseURL: server.baseUrl, extraHTTPHeaders: { Authorization: `Bearer ${server.token}` } });
    expect((await api.get('/api/health')).ok()).toBeTruthy();

    // The keyless mock provider, as the browser e2e seeds it (e2e/smoke.spec.ts).
    const conn = await api.post('/api/connections', { data: { name: 'Mock', kind: 'mock' } });
    expect(conn.ok()).toBeTruthy();
    const { id: connectionId } = (await conn.json()) as { id: string };
    const profile = await api.post('/api/profiles', { data: { name: 'Mock Profile', connectionId, modelId: 'mock-standard', isDefault: true } });
    expect(profile.ok()).toBeTruthy();
    const { id: profileId } = (await profile.json()) as { id: string };
    await main.reload();
    await expect(main.getByRole('navigation', { name: 'Chats' })).toBeVisible();

    const findWindow = (view: View): Page | null => context.pages().find((p) => isAppPage(p.url()) && viewOf(p.url()) === view && !p.isClosed()) ?? null;
    const app: DesktopApp = {
      context,
      main,
      server,
      api,
      dataDir,
      profileId,
      requests,
      windowFor: (view) => waitFor(`the ${view} window`, 15_000, () => findWindow(view)),
      hasWindow: (view) => findWindow(view) !== null,
      invoke: (page, command, args) => invokeIn(page, command, args),
      realDrag: async (source, target) => {
        await source.scrollIntoViewIfNeeded();
        const dpr = await main.evaluate(() => window.devicePixelRatio);
        const [a, b] = [await source.boundingBox(), await target.boundingBox()];
        if (!a || !b) throw new Error('Both ends of the drag must be on screen.');
        const from = devicePoint(a, 20, dpr);
        const to = devicePoint(b, 40, dpr);
        const args = ['-AppPid', String(child.pid), '-Title', 'OtherBench', '-FromX', String(from.x), '-FromY', String(from.y), '-ToX', String(to.x), '-ToY', String(to.y)];
        const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', REAL_DRAG, ...args], { encoding: 'utf8', timeout: 30_000 });
        if (result.status !== 0) throw new Error(`real-drag.ps1 failed (exit ${String(result.status)}): ${result.stderr || result.stdout}`);
      },
    };
    return { app, close };
  } catch (err) {
    await close();
    throw err;
  }
}

/** `test` with `app`: one launch of the test build, shared by every spec in the worker. */
export const test = base.extend<object, { app: DesktopApp }>({
  app: [
    async ({}, use, workerInfo) => {
      const { app, close } = await launch(join(workerInfo.project.outputDir, `app-${workerInfo.workerIndex}.log`));
      try {
        await use(app);
      } finally {
        await close();
      }
    },
    { scope: 'worker', timeout: 180_000 },
  ],
});

export { expect };
