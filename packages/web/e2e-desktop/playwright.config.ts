import { defineConfig } from '@playwright/test';

/**
 * The desktop smoke suite: drives the real Tauri app (WebView2) over the
 * Chrome DevTools Protocol instead of the UI in Chromium. `app.ts` starts the
 * test build of the app (`npm run app:e2e -w @otherbench/desktop`) with its
 * own identifier, a scratch data folder and its own ports, and every spec
 * shares that one launch. See README.md beside this file.
 *
 * Windows only, one worker, nothing in parallel: the specs run in order
 * against one app, and each worker would otherwise start an app of its own.
 */
export default defineConfig({
  testDir: '.',
  testMatch: '*.spec.ts',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  outputDir: '../test-results/e2e-desktop',
  use: { trace: 'off' },
});
