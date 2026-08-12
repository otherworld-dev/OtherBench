import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig } from '@playwright/test';

const PORT = 4756;
export const BASE_URL = `http://127.0.0.1:${PORT}`;

// A fresh scratch dir per run -- keeps the e2e run from ever touching a
// real ~/.grunt (which resolveSecretsPassphrase falls back to for `--db
// :memory:`), and guarantees each run starts from an empty database.
const dbDir = mkdtempSync(join(tmpdir(), 'grunt-e2e-'));

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
  },
  // Requires `npm run build` (root or `-w @grunt/server -w @grunt/web`) to
  // have already produced packages/{server,web}/dist -- this only starts
  // the already-built server, it doesn't build it.
  webServer: {
    command: `node ../server/dist/cli.js serve --port ${PORT} --db "${join(dbDir, 'grunt.db')}"`,
    url: `${BASE_URL}/api/health`,
    reuseExistingServer: false,
    timeout: 15_000,
  },
});
