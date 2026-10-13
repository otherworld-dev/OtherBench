import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig } from '@playwright/test';

const PORT = Number(process.env.GRUNT_E2E_PORT ?? 4756);
export const BASE_URL = `http://127.0.0.1:${PORT}`;
/** The fixture site browser.spec.ts opens (e2e/fixtures/site-server.mjs). */
export const SITE_PORT = Number(process.env.GRUNT_E2E_SITE_PORT ?? 4797);
export const SITE_URL = `http://127.0.0.1:${SITE_PORT}`;
/** The one Cowork session the e2e server finds (claude-import.spec.ts imports it). */
export const COWORK_SESSION = { id: 'local_e2e_cowork', title: 'Cowork e2e session' };

// A fresh scratch dir per run -- keeps the e2e run from ever touching a
// real ~/.grunt (which resolveSecretsPassphrase falls back to for `--db
// :memory:`), and guarantees each run starts from an empty database.
const dbDir = mkdtempSync(join(tmpdir(), 'grunt-e2e-'));

// A Cowork folder laid out as Claude Desktop keeps one, so the server never
// reads the real one on the machine running the tests (GRUNT_COWORK_ROOT).
const coworkDir = join(dbDir, 'cowork');
const org = join(coworkDir, 'account', 'organisation');
mkdirSync(join(org, COWORK_SESSION.id, '.claude', 'projects', 'folder'), { recursive: true });
writeFileSync(join(org, `${COWORK_SESSION.id}.json`), JSON.stringify({ sessionId: COWORK_SESSION.id, cliSessionId: 'e2e-cli', title: COWORK_SESSION.title, model: 'claude-opus-4-7' }));
writeFileSync(
  join(org, COWORK_SESSION.id, '.claude', 'projects', 'folder', 'e2e-cli.jsonl'),
  [
    { type: 'user', uuid: 'e2e-u1', parentUuid: null, timestamp: '2026-01-01T12:00:00Z', message: { role: 'user', content: 'cowork question' } },
    { type: 'assistant', uuid: 'e2e-a1', parentUuid: 'e2e-u1', timestamp: '2026-01-01T12:01:00Z', message: { role: 'assistant', model: 'claude-opus-4-7', content: [{ type: 'text', text: 'cowork answer' }] } },
  ]
    .map((line) => JSON.stringify(line))
    .join('\n')
);

// A Claude Desktop config the server reads instead of the real one
// (GRUNT_CLAUDE_DESKTOP_CONFIG), for mcp-import.spec.ts. The commands don't
// exist anywhere, so importing a server never starts anything.
export const DESKTOP_SERVERS = { secret: 'e2e-desktop-secret-value', command: 'grunt-e2e-no-such-command' };
const desktopConfig = join(dbDir, 'claude_desktop_config.json');
writeFileSync(
  desktopConfig,
  JSON.stringify({
    mcpServers: {
      'E2E Desktop Notes': { command: DESKTOP_SERVERS.command, args: ['notes'], env: { NOTES_TOKEN: DESKTOP_SERVERS.secret } },
      'E2E Desktop Legacy': { type: 'sse', url: 'https://example.invalid/sse' },
    },
  })
);

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
  webServer: [
    {
      command: `node ../server/dist/cli.js serve --port ${PORT} --db "${join(dbDir, 'grunt.db')}"`,
      url: `${BASE_URL}/api/health`,
      reuseExistingServer: false,
      timeout: 15_000,
      env: {
        ...(process.env as Record<string, string>),
        GRUNT_COWORK_ROOT: coworkDir,
        GRUNT_CLAUDE_DESKTOP_CONFIG: desktopConfig,
        // The model's browser may reach the fixture site on 127.0.0.1 (tests only).
        GRUNT_BROWSER_ALLOW_LOOPBACK_PORTS: String(SITE_PORT),
        // Computer use is carried out by core's FakeComputerDriver, which touches nothing on this machine (computer.spec.ts).
        GRUNT_COMPUTER_FAKE_DRIVER: '1',
      },
    },
    {
      command: `node e2e/fixtures/site-server.mjs ${SITE_PORT}`,
      url: `${SITE_URL}/`,
      reuseExistingServer: false,
      timeout: 10_000,
    },
  ],
});
