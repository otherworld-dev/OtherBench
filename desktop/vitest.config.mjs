import { defineProject } from 'vitest/config';

// Only the release scripts' tests: src-tauri/target holds build output that is never scanned.
export default defineProject({
  test: {
    name: '@otherbench/desktop',
    include: ['scripts/**/*.test.mjs'],
  },
});
