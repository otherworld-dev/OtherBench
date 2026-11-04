import { realpathSync } from 'node:fs';
import { defineWorkspace } from 'vitest/config';

// A run started from `e:\...` when Windows spells the folder `E:\...` loads
// modules under both spellings, and every vi.mock of a relative path ('./x.js')
// then quietly misses: each web test file that has one fails with
// "mockReset is not a function". `npm test` (scripts/vitest.mjs) starts vitest
// from the folder's real spelling; this stops a direct `npx vitest` that wasn't.
if (process.platform === 'win32') {
  const cwd = process.cwd();
  const real = realpathSync.native(cwd);
  if (real !== cwd && real.toLowerCase() === cwd.toLowerCase()) {
    throw new Error(`vitest was started in ${cwd}, but Windows spells it ${real}; vi.mock misses under the wrong case. Run \`npm test\`, or cd to ${real} first.`);
  }
}

export default defineWorkspace(['packages/*', 'desktop']);
