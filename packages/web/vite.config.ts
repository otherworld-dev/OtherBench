import { configDefaults, defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// Dev-only convenience: `vite dev` runs on its own port, so proxy `/api` to
// a locally running `otherbench serve` (default port 4747) rather than requiring
// every contributor to configure CORS. The production bundle is served BY
// otherbench serve itself (packages/server/src/static.ts), same-origin, so this
// proxy never matters outside `npm run dev`.
const DEV_API_PROXY_TARGET = process.env['OTHERBENCH_API_PROXY'] ?? 'http://127.0.0.1:4747';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      '/api': { target: DEV_API_PROXY_TARGET, changeOrigin: true },
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./test/setup.ts'],
    css: true,
    // `e2e/**` holds @playwright/test specs (playwright.config.ts's own
    // testDir), which use a different `test`/`expect` -- vitest's default
    // include pattern (`**/*.spec.ts`) would otherwise try to collect them
    // too and fail on the import.
    exclude: [...configDefaults.exclude, 'e2e/**'],
  },
});
