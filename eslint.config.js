// A deliberately small rule set: only rules that find real bugs, not style.
// `tsc` strict mode already covers what most "recommended" sets would add.
// The type-aware rules read each package's tsconfig.test.json (src, tests
// and e2e together) and resolve other packages through their built `dist`
// types, so run `tsc -b` first, as `npm run lint` does.
import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';

export default defineConfig(
  // .claude/ holds agents' worktrees, each a full copy of the repo: walking them runs eslint out of memory.
  { ignores: ['**/dist/**', '**/node_modules/**', 'desktop/**', '.claude/**', '**/*.js', '**/*.mjs', '**/*.cjs'] },
  {
    files: ['packages/*/{src,test,e2e}/**/*.{ts,tsx}'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { project: ['packages/*/tsconfig.test.json'], tsconfigRootDir: import.meta.dirname },
    },
    // Off: the code has disables for rules this set doesn't run (no-console and others).
    linterOptions: { reportUnusedDisableDirectives: 'off' },
    plugins: { '@typescript-eslint': tseslint.plugin },
    rules: {
      // A promise nobody awaits loses its error: an unhandled rejection in the
      // server, or a test assertion (`expect(...).rejects`) that never runs.
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      // Awaiting a value that isn't a promise usually means an API stopped being async.
      '@typescript-eslint/await-thenable': 'error',
      // A new event or message kind fails the build where a switch doesn't handle it.
      '@typescript-eslint/switch-exhaustiveness-check': ['error', { considerDefaultExhaustiveForUnions: true }],
      // A cast that changes nothing hides the casts that do.
      '@typescript-eslint/no-unnecessary-type-assertion': 'error',
    },
  },
  {
    files: ['packages/web/{src,test,e2e}/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'error',
      // A render reads no clock and no ref, and an effect doesn't set state straight away: each of
      // those is a stale value on screen or a second render (lib/useChanged.ts, lib/useNow.ts).
      'react-hooks/purity': 'error',
      'react-hooks/refs': 'error',
      'react-hooks/immutability': 'error',
      'react-hooks/set-state-in-effect': 'error',
    },
  },
);
