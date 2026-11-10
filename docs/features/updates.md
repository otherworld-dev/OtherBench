# Updates

Spec *docs/superpowers/specs/2026-10-29-auto-update-design.md*. Machines on
different builds stop syncing (a schema or protocol mismatch is refused), so
every installed build keeps itself current.

- **Releases.** CI (`.github/workflows/ci.yml`, job `release`, after `test`)
  builds and publishes them with `desktop/scripts/release/publish.mjs`:
  - Every push of `dev` to GitHub → a beta, `vX.Y.Z-beta.N` (a pre-release,
    `N` = the run number, `X.Y.Z` the next full version: `desktop/package.json`'s
    while that's ahead of every full release, else the newest one's patch + 1).
    A newer push cancels a beta still building.
  - A `vX.Y.Z` tag → a full release, marked latest. To cut one: merge `dev`
    into `main`, tag `vX.Y.Z` on it, push the tag to `github`. Afterwards,
    set `desktop/package.json` to the next version you mean to ship (betas
    move to the next patch by themselves if you don't).
  - Each release holds the installer, its `.sig` and `latest.json`.
  - Re-running the job (a flaky test held it up, or it died half way) is
    safe: the GitHub steps (`desktop/scripts/release/github.mjs`) make a new
    release as a draft and publish it once its files are up, and reuse a
    release of that version that's there already, published or a leftover
    draft, replacing its files. A run cancelled by a newer push can leave a
    draft behind; it's harmless and can be deleted by hand.
- **Feeds.** Full channel: `releases/latest/download/latest.json`. Beta
  channel: the `latest.json` of the fixed pre-release `beta-channel`, which
  `publish.mjs` never moves to a lower version. The same version does
  replace it (a re-run's installer is signed afresh, so the feed must carry
  the new signature), and a feed that can't be read stops the run rather
  than being overwritten. A beta machine reads
  both and takes the higher (a full release outranks its betas). GitHub's
  release list is not in version order, so nothing ever takes "the first one
  listed".
- **The shell** (`desktop/src-tauri/src/update.rs`) checks 60 s after start and
  every 4 hours (Settings → Desktop → Updates: Check now, and "Get beta
  releases early", kept per machine in `<app config>/updates.json`). It
  downloads (the signature is checked then), and installs only when nothing
  is running and Adam is away: no reply being written and no scheduled run
  (`GET /api/desktop/busy`), no unsent composer text, and no input in any app
  window for 10 minutes or no window showing. A server that can't be reached
  counts as idle, so a build whose server won't start is still replaced. After
  a day of waiting it asks instead ("Restart and update now"). It stops the
  server, then runs the installer passively; the installer relaunches the app,
  which comes back hidden if it was (`update-relaunch.json`). Turning betas
  off never downgrades. Dev runs never update.
- **Failures back off.** A build that fails to download or install is held
  back: tried again after 4 hours, then 8, 16, 32, then every 2 days, while
  it's still the one on offer (a new version starts afresh). The count is kept
  in `<app data>/update-attempts.json`, since a failed install restarts the
  app. That file also notes the version being installed just before the
  installer runs, so an installer that fails after the app has gone is
  counted by the build that starts next (still the old one), and the new
  build clears it. Settings shows "failed", why, how many times and when it
  tries again; its Check now tries straight away, the automatic check a
  version mismatch asks for doesn't.
- **Database copy.** Before a new build migrates the database to a higher
  schema it copies it to `otherbench.db.before-schema-<from>` (newest 3 kept,
  `store-sqlite/src/backup.ts`); if the copy fails it doesn't start.
- **Sync refusals.** The refusal names both builds, is kept in
  `app_setting` `sync-version-mismatch:<node>` until a pull succeeds (so it
  survives a restart), shows in Settings → Machines and the tray as "sync
  stopped, versions differ", raises a toast once, and when the other machine
  is ahead asks the updater to check now (`web/src/desktop/useUpdateHint.ts`).
- **The key.** The updater's private key and password are the GitHub secrets
  `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`; the
  public key is in `tauri.conf.json`. Adam keeps the offline copy
  (`%USERPROFILE%\.tauri\otherbench-updater.key` and `.password`). Losing it
  means reinstalling every machine by hand with a build carrying a new key.
- **Fix forward.** There's no rollback: a broken beta is fixed by pushing the
  next one. A fix to the updater itself that stops updates working has to be
  installed by hand, as did the first build that had the updater.
- **Not done.** Authenticode signing is wired in but off until there is a
  certificate (see [Code signing](code-signing.md)), so SmartScreen warns on
  a fresh install; updates aren't affected. When it is on, the installer is
  signed before its `.sig` is written. Windows only.
