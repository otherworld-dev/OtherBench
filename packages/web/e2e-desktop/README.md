# Desktop smoke tests

A handful of Playwright checks against the real desktop app (Tauri v2,
WebView2) rather than the UI in Chromium. Each covers a kind of bug that passed
every browser e2e and only showed in the app's window. Windows only.

## Run

```sh
npm run build                                # server + web UI (the test build embeds packages/web/dist)
npm run app:e2e -w @otherbench/desktop       # the test build, about 2 min from clean, seconds after
npm run e2e:desktop                          # the suite, about a minute
```

`app:e2e` is `tauri build --debug --no-bundle` with `src-tauri/tauri.e2e.conf.json`
on top: no installer, no updater artifacts, the UI embedded. It writes
`desktop/src-tauri/target/debug/otherbench-e2e.exe`. Rebuild it after a change
to the web UI or the shell; a server change needs only `npm run build`, since
the test build runs `packages/server/dist/cli.js` from this checkout.

The drag test moves the real mouse for about two seconds, with the app's
window made topmost meanwhile: leave the mouse alone while it runs. Everything
else runs in the app's windows without needing focus.

The app's own output goes to `packages/web/test-results/e2e-desktop/app-0.log`.
`OTHERBENCH_E2E_KEEP=1` keeps the scratch folder (path printed at the end),
which holds the server's database and its `server.log`.

## What it never touches

Adam's installed OtherBench, running or not, and its data:

- The test build is a separate app: identifier `dev.otherworld.otherbench.e2e`,
  exe `otherbench-e2e.exe`, product name *OtherBench E2E*. Its single-instance
  lock is its own, so a launch never reaches (or focuses) a running OtherBench,
  and the suite only ever stops the process it started, by PID.
- Its server's database is in a scratch folder: the shell passes
  `--db <OTHERBENCH_E2E_DATA_DIR>/otherbench.db --peer-port 0`. Only a build
  whose identifier ends in `.e2e` reads that variable, and such a build refuses
  to start its server without it (main.rs `test_data_dir`), so neither app can
  open the other's database. The peer listener, if anything starts it, takes
  any free port instead of 4748.
- `USERPROFILE`, `APPDATA` and `LOCALAPPDATA` point into the scratch folder, and
  Windows resolves the known folders Tauri asks for from them, so the shell's
  logs, window state and undocked list land there too, as does anything the
  server writes in the home folder (a run leaves a `.claude.json`). The webview's
  storage is `WEBVIEW2_USER_DATA_FOLDER`, also there. The harness checks the
  database and the shell's log are in the scratch folder before any test writes.
- The DevTools port (`WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=N`)
  and the server's port are free ones picked per run.
- If a test build is already running, the suite stops and says so rather than
  ending it.

## The checks

1. The app loads, the sidecar answers with the launch's token, and it's the
   scratch server.
2. A new chat streams the mock reply, and every stream (`/api/events`, the
   chat's stream) went to its own `sNNNNNNNN.localhost` name.
3. A chat row dragged onto a project heading with the real mouse lands in the
   project. Playwright's own `dragTo` is synthesised inside Chromium and passes
   even with WebView2's drop handler on; this one goes through Windows' drag and
   drop, and fails (both tries) on a build with `dragDropEnabled: true`.
4. Code and the Overview undock into their own windows (main hears
   `docks-changed`), and a Code chat clicked on the Overview opens in the Code
   window while main keeps its own chat: the `emit_to("code")` reaches only
   that window. Then both dock again.
5. With four windows open (main, Code, Overview, hidden quick chat) and four
   panes streaming `#slow` at once, every send still gets its reply, and a send
   after them answers straight away.

## CI

Not in CI. It could run on a GitHub `windows-latest` runner (it has an
interactive desktop session and WebView2), but check 3 moves the real mouse
and needs a visible, unobscured window, and the build needs Rust and about
2 minutes more. Checks 1, 2, 4 and 5 would be the ones to try there first.
