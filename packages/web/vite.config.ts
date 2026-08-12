import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// Dev-only convenience: `vite dev` runs on its own port, so proxy `/api` to
// a locally running `grunt serve` (default port 4747) rather than requiring
// every contributor to configure CORS. The production bundle is served BY
// grunt serve itself (packages/server/src/static.ts), same-origin, so this
// proxy never matters outside `npm run dev`.
const DEV_API_PROXY_TARGET = process.env['GRUNT_API_PROXY'] ?? 'http://127.0.0.1:4747';

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
  },
});
