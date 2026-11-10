# Testing notes

How the test setup behaves and why, moved out of `HANDOVER.md` on 2026-11-09. Commands are in `CLAUDE.md`.

- **Test files are typechecked.** `tsc -b` builds `src` only, so tests were
  never typechecked. `npm run typecheck:tests` (each package's
  `tsconfig.test.json`, after `tsc -b`) checks them. It found 146 errors at
  first; the cheap ones were fixed then, and the rest (175 by 2026-11-04,
  with the tests written since) were fixed for Deck d954. CI now runs it as a
  required step, so a test that doesn't compile fails the build.
- **Tests run the other packages' source, not their `dist/`.** Each
  package's `exports` point at `dist/`, so a test in store-sqlite, server or
  web used to run whatever core was last built (a test added to core's store
  contract once silently didn't run in the SQLite suite). `vitest.workspace.ts`
  now resolves `@otherbench/<pkg>/<path>.js` to `packages/<pkg>/src/<path>.ts`
  for tests only; `tsc -b`, Node and the bundles still use `dist/`. What still
  needs `npx tsc -b` first: the server tests that start a real worker thread
  (`office/render.test.ts`, the Claude import reader), because Node runs the
  worker from `packages/server/dist`, and `npm run typecheck:tests`, which
  reads the other packages' types from `dist/`.
- **Start vitest from the folder's real spelling on Windows.** Started from
  `e:\...` when the folder is `E:\...`, vitest 2 loads modules under both
  spellings and every `vi.mock` of a relative path quietly misses: each web
  test file with one fails ("mockReset is not a function"), 72 files at
  d71c5a08, 88 now. This was the "first full run after a merge fails 72 web
  files" flake. Git Bash and PowerShell hand Node `E:`, while a process
  started with a lowercase cwd (`cmd /c "cd /d e:\..."` reproduces it) keeps
  `e:`, which most likely is why a re-run from another shell passed. `npm
  test` (`scripts/vitest.mjs`) now starts vitest from the real path, and
  `vitest.workspace.ts` refuses a direct `npx vitest` started from the wrong
  case with a message saying so.
- **Test time limits allow for a busy machine.** With other full runs going
  at once (parallel agents), tests that start real processes (git, MCP
  servers over stdio, the SQLite secret store's concurrent writes) or render
  big panels missed vitest's 5 s, and `findBy*` missed testing-library's 1 s,
  with nothing wrong. `vitest.workspace.ts` gives every package 20 s per test
  and hook, and `packages/web/test/setup.ts` gives `findBy*`/`waitFor` 5 s; a
  passing test is no slower. Tests that need wall-clock order use a fake
  clock instead: the Office render queue (`office/render.test.ts`, which
  missed a 1.5 s limit under load) and ChatList's date headings (which failed
  in the first minute after midnight). Still on the real clock:
  `blob-gc.test.ts`'s "real timing" sweep (3,000 blobs, its own 30 s), which
  timed out in loaded runs on 2026-11-04, and `provider-live.test.ts`'s
  300 ms live-call limit.
- **The desktop app has its own smoke suite** (`packages/web/e2e-desktop/`,
  added 2026-11-10; its README has the details). The browser e2e runs the UI
  in Chromium, which never showed three bugs the Tauri window did: WebView2
  swallowing HTML5 drag and drop unless `dragDropEnabled: false`, the six
  connections per host shared by every window, and `listen()` hearing every
  window unless scoped to its label. Five checks drive the real app over CDP:

  ```sh
  npm run build
  npm run app:e2e -w @otherbench/desktop   # tauri build --debug --no-bundle + tauri.e2e.conf.json
  npm run e2e:desktop
  ```

  The test build is a separate app (identifier `dev.otherworld.otherbench.e2e`,
  exe `otherbench-e2e.exe`) and its server's database, home folder, AppData,
  webview storage and ports are all scratch, so it never touches an installed
  OtherBench or its data, running or not. `OTHERBENCH_E2E_DATA_DIR` is read
  only by that build, which won't start its server without it. Two things
  learned building it: Playwright's `dragTo` is synthesised inside Chromium and
  passes with WebView2's drop handler on, so the drag check moves the real
  mouse (`real-drag.ps1`); and a fresh server took 18-25 s to start on a
  machine at 100% CPU, past the shell's 15 s, so the test build waits 90 s.
  WebView2's browser process outlives a killed app by a minute or more and
  `taskkill` can't end it; the harness closes it over CDP first. Not in CI
  (the drag check needs the real mouse and a visible window).
