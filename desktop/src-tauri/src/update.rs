//! Updating the installed app from GitHub releases
//! (docs/superpowers/specs/2026-10-29-auto-update-design.md).
//!
//! The decisions are pure and unit-tested here: which feed's build to take
//! (`choose`), whether now is a good moment to install it (`decide`), and the
//! order of the install itself (`install_ready`).

use semver::Version;

/// No input in any app window for this long counts as away.
pub const AWAY_MS: u64 = 10 * 60 * 1000;
/// An update that has waited this long for an idle moment asks instead of waiting on.
pub const ASK_AFTER_MS: u64 = 24 * 60 * 60 * 1000;

/// What one feed's `latest.json` said.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FeedResult {
    /// The version it offers.
    Found(String),
    /// No release on that channel yet (the feed is a 404).
    Missing,
    /// It couldn't be read: why.
    Failed(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Choice {
    /// Take feed `feed`'s build.
    Install { feed: usize, version: String },
    UpToDate,
    /// The betas switch is off and this build is newer than the newest full release: stay put, never downgrade.
    Ahead { newest: String },
    /// Nothing has been released on these channels yet.
    NoReleases,
    Error(String),
}

/// Picks the build to install from the feeds checked, in order `[full, beta]`
/// (`beta` only when the switch is on). The highest version across them wins,
/// and only one strictly higher than `current` is ever installed.
pub fn choose(current: &str, beta: bool, feeds: &[FeedResult]) -> Choice {
    let mut found: Vec<(usize, Version)> = Vec::new();
    let mut failed: Option<String> = None;
    for (i, feed) in feeds.iter().enumerate() {
        match feed {
            FeedResult::Found(v) => match Version::parse(v) {
                Ok(parsed) => found.push((i, parsed)),
                Err(e) => failed = failed.or(Some(format!("the feed's version \"{v}\" isn't a version ({e})"))),
            },
            FeedResult::Failed(e) => failed = failed.or(Some(e.clone())),
            FeedResult::Missing => {}
        }
    }
    let Some((feed, newest)) = found.iter().fold(None::<&(usize, Version)>, |best, f| match best {
        Some(b) if b.1 >= f.1 => Some(b),
        _ => Some(f),
    }) else {
        // A feed that failed may well have had something: only say "nothing released" when every feed said so.
        return match failed {
            Some(e) => Choice::Error(e),
            None => Choice::NoReleases,
        };
    };
    let Ok(current) = Version::parse(current) else {
        return Choice::Error(format!("this build's version \"{current}\" isn't a version"));
    };
    if *newest > current {
        return Choice::Install { feed: *feed, version: newest.to_string() };
    }
    if !beta && current > *newest {
        return Choice::Ahead { newest: newest.to_string() };
    }
    Choice::UpToDate
}

/// What the install waits on, at one moment.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Gate {
    /// What the server says is running (`GET /api/desktop/busy`); empty when nothing is. `None`: the server can't be reached.
    pub server_busy: Option<Vec<String>>,
    /// Since the last input in any app window.
    pub idle_ms: u64,
    pub any_window_visible: bool,
    /// A composer somewhere holds text that hasn't been sent.
    pub unsent_text: bool,
    /// Since the update finished downloading.
    pub ready_for_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Decision {
    Install,
    /// Not yet: what it's waiting for, in words for Settings.
    Wait(Vec<String>),
    /// It has waited a day: ask Adam instead of waiting on.
    Ask(Vec<String>),
}

/// Whether to install now. A server that can't be reached counts as idle,
/// so a build whose server doesn't start can still be replaced.
pub fn decide(gate: &Gate) -> Decision {
    let mut waiting: Vec<String> = gate.server_busy.clone().unwrap_or_default();
    if gate.unsent_text {
        waiting.push("a message you haven't sent".into());
    }
    if gate.any_window_visible && gate.idle_ms < AWAY_MS {
        waiting.push("you're using OtherBench".into());
    }
    if waiting.is_empty() {
        Decision::Install
    } else if gate.ready_for_ms >= ASK_AFTER_MS {
        Decision::Ask(waiting)
    } else {
        Decision::Wait(waiting)
    }
}

/// Stops the server (releasing the database lock the installer's files
/// depend on), then installs. `install` exits the process when it works; if it
/// fails, the failure is recorded (`record`, which must persist it: the
/// restart forgets everything else) and the app restarts on the build it has,
/// so it is never left running with no server.
pub fn install_ready(stop_server: impl FnOnce(), install: impl FnOnce() -> Result<(), String>, record: impl FnOnce(&str), restart: impl FnOnce()) -> Result<(), String> {
    stop_server();
    install().inspect_err(|e| {
        record(e);
        restart();
    })
}

/// The longest wait before trying a build that keeps failing again.
pub const RETRY_CAP_MS: u64 = 48 * 60 * 60 * 1000;

/// How long to wait before trying a build again after it has failed `count`
/// times in a row: the normal check interval after the first failure (so one
/// failure, say a dropped connection, changes nothing), doubling up to two days.
pub fn retry_delay_ms(count: u32) -> u64 {
    let base = CHECK_EVERY.as_millis() as u64;
    let doublings = count.saturating_sub(1).min(16);
    base.saturating_mul(1u64 << doublings).min(RETRY_CAP_MS)
}

/// One build's download or install failures, in a row.
#[derive(serde::Serialize, serde::Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct Failure {
    pub version: String,
    pub count: u32,
    /// When it last failed (ms since the epoch).
    pub at: u64,
    /// The last failure, in words for Settings.
    pub error: String,
}

/// What the updater remembers across restarts about getting onto a build
/// (`<app data>/update-attempts.json`). An install that fails restarts the
/// app, and a persistent one (a bad installer, antivirus blocking it) would
/// otherwise be downloaded and tried again within minutes of every restart.
#[derive(serde::Serialize, serde::Deserialize, Debug, Clone, PartialEq, Eq, Default)]
pub struct Attempts {
    pub failed: Option<Failure>,
    /// The version the installer was started for. The build that starts next
    /// says whether it took: the installer can fail after this process has gone.
    pub installing: Option<String>,
}

impl Attempts {
    /// What a saved file says, or nothing remembered when it can't be read.
    pub fn parse(text: &str) -> Self {
        serde_json::from_str(text).unwrap_or_default()
    }

    pub fn to_json(&self) -> String {
        serde_json::to_string(self).unwrap_or_default()
    }

    /// `version` failed again (counted on from its last failure), or a new version failed for the first time.
    pub fn failed(&mut self, version: &str, error: &str, now_ms: u64) {
        let count = match &self.failed {
            Some(f) if f.version == version => f.count.saturating_add(1),
            _ => 1,
        };
        self.failed = Some(Failure { version: version.into(), count, at: now_ms, error: error.into() });
        self.installing = None;
    }

    /// When `version` may be tried again, if its failures still hold it back.
    pub fn held_back(&self, version: &str, now_ms: u64) -> Option<u64> {
        let f = self.failed.as_ref().filter(|f| f.version == version)?;
        let at = f.at.saturating_add(retry_delay_ms(f.count));
        (now_ms < at).then_some(at)
    }

    /// After a check: failures of a build the check no longer chose are
    /// forgotten (a new version starts counting afresh). A check that failed
    /// says nothing new.
    pub fn settle(&mut self, choice: &Choice) {
        let keep = match choice {
            Choice::Error(_) => true,
            Choice::Install { version, .. } => self.failed.as_ref().is_some_and(|f| &f.version == version),
            _ => false,
        };
        if !keep {
            self.failed = None;
        }
    }

    /// At start, on build `current`: an install that was started either took
    /// (this is that build or newer: its failures are over) or didn't, which
    /// counts as a failure. Returns whether anything changed, to be saved.
    pub fn started(&mut self, current: &str, now_ms: u64) -> bool {
        let before = self.clone();
        let reached = |v: &str| matches!((Version::parse(current), Version::parse(v)), (Ok(c), Ok(v)) if c >= v);
        if let Some(v) = self.installing.take() {
            if !reached(&v) {
                self.failed(&v, &format!("Installing {v} didn't finish: this is still {current}"), now_ms);
            }
        }
        if self.failed.as_ref().is_some_and(|f| reached(&f.version)) {
            self.failed = None;
        }
        *self != before
    }
}

/// When to check next: the normal interval, or sooner if a held-back build's
/// wait ends first (and a second after it, so the check doesn't land a hair early).
pub fn next_check_in(retry_at_ms: Option<u64>, now_ms: u64) -> Duration {
    match retry_at_ms {
        Some(at) if at > now_ms => CHECK_EVERY.min(Duration::from_millis(at - now_ms) + Duration::from_secs(1)),
        _ => CHECK_EVERY,
    }
}

/// Which windows hold unsent text. Each window reports only its own, so one
/// window's "none" must never clear another's.
#[derive(Default, Debug)]
pub struct Unsent(std::collections::HashMap<String, bool>);

impl Unsent {
    pub fn set(&mut self, window: &str, has: bool) {
        self.0.insert(window.to_string(), has);
    }

    /// A closed window takes its text with it.
    pub fn window_gone(&mut self, window: &str) {
        self.0.remove(window);
    }

    pub fn any(&self) -> bool {
        self.0.values().any(|has| *has)
    }
}

/// Whether a build already downloaded still installs after a new check: only
/// if the check chose that same build. A check that failed says nothing new.
/// (Betas turned off after one was downloaded: it must not install.)
pub fn keep_ready(ready_version: &str, choice: &Choice) -> bool {
    match choice {
        Choice::Error(_) => true,
        Choice::Install { version, .. } => version == ready_version,
        _ => false,
    }
}

/// What asking the server whether it's busy came to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Probe {
    /// No server is running (it failed to start, or hasn't yet).
    NoServer,
    /// Nothing is listening on its port.
    Refused,
    Answered(Vec<String>),
    /// It's there but didn't answer properly in time: slow (a long sync batch blocks it), or wedged.
    NoAnswer,
}

/// After this many gate ticks in a row with no answer (10 minutes), a server that's there but silent counts as broken.
pub const NO_ANSWER_LIMIT: u32 = 20;

/// `Gate.server_busy` from a probe and how many no-answers in a row came
/// before it (including this one). A slow server holds the update back; only
/// a missing one, or one silent for 10 minutes, counts as idle, so a broken
/// build can still be replaced.
pub fn busy_from(probe: Probe, no_answers: u32) -> Option<Vec<String>> {
    match probe {
        Probe::NoServer | Probe::Refused => None,
        Probe::Answered(reasons) => Some(reasons),
        Probe::NoAnswer if no_answers >= NO_ANSWER_LIMIT => None,
        Probe::NoAnswer => Some(vec!["the server isn't answering".into()]),
    }
}

/// The gate ticks every 30 s; a gap of more than four ticks means the machine
/// slept. Waking counts as being used, so the update doesn't install the
/// moment the lid opens.
pub fn just_resumed(last_tick_ms: Option<u64>, now_ms: u64) -> bool {
    last_tick_ms.is_some_and(|last| now_ms.saturating_sub(last) > 4 * GATE_EVERY.as_millis() as u64)
}

/// The update download, given up after `limit` so a stalled connection can't hold the updater for good.
pub async fn within<T>(limit: Duration, download: impl std::future::Future<Output = Result<T, String>>) -> Result<T, String> {
    tokio::time::timeout(limit, download)
        .await
        .unwrap_or_else(|_| Err(format!("the download took too long (over {} minutes)", limit.as_secs() / 60)))
}

/// The reasons in the server's answer to `GET /api/desktop/busy` (empty when
/// it isn't busy), or `None` for anything but a 200 with that JSON.
pub fn parse_busy(response: &str) -> Option<Vec<String>> {
    let (head, body) = response.split_once("\r\n\r\n")?;
    let status = head.lines().next()?;
    if status.split_whitespace().nth(1) != Some("200") {
        return None;
    }
    #[derive(serde::Deserialize)]
    struct Busy {
        busy: bool,
        reasons: Vec<String>,
    }
    let busy: Busy = serde_json::from_str(body.trim()).ok()?;
    Some(if busy.busy { busy.reasons } else { Vec::new() })
}

/// How long the note written before an update install stays good: a relaunch after that isn't the update's.
const RELAUNCH_NOTE_MS: u64 = 10 * 60 * 1000;

#[derive(serde::Serialize, serde::Deserialize)]
struct RelaunchNote {
    at: u64,
    #[serde(rename = "mainVisible")]
    main_visible: bool,
}

/// Whether the main window was showing before the update restarted the app,
/// from the note written just before it, or `None` when there's no fresh note.
pub fn relaunch_show(note: &str, now_ms: u64) -> Option<bool> {
    let note: RelaunchNote = serde_json::from_str(note).ok()?;
    (now_ms.saturating_sub(note.at) <= RELAUNCH_NOTE_MS).then_some(note.main_visible)
}

// ---- the runtime: checks, downloads, the gate and the install --------------

use std::path::PathBuf;
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_updater::UpdaterExt;

/// Full releases: GitHub serves the release marked latest here, never a pre-release.
pub const FULL_FEED: &str = "https://github.com/otherworld-dev/OtherBench/releases/latest/download/latest.json";
/// Betas: a fixed pre-release whose `latest.json` CI only ever replaces with a higher version.
pub const BETA_FEED: &str = "https://github.com/otherworld-dev/OtherBench/releases/download/beta-channel/latest.json";

const FIRST_CHECK: Duration = Duration::from_secs(60);
const CHECK_EVERY: Duration = Duration::from_secs(4 * 60 * 60);
const GATE_EVERY: Duration = Duration::from_secs(30);
const BUSY_TIMEOUT: Duration = Duration::from_secs(2);
const FEED_TIMEOUT: Duration = Duration::from_secs(30);
/// Generous for a 115 MB installer on a slow line; a stalled one is given up and tried again at the next check.
const DOWNLOAD_LIMIT: Duration = Duration::from_secs(30 * 60);

/// What Settings → Desktop shows (web/src/views/settings/DesktopPanel.tsx), also sent as `update-status`.
#[derive(Clone, Serialize, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UpdateStatus {
    pub current: String,
    pub installed: bool,
    pub beta: bool,
    /// dev-build | idle | checking | up-to-date | ahead | no-releases | downloading | ready | ask | installing | failed | error
    /// (`failed`: `available` couldn't be downloaded or installed, `failures` times in a row, and `error` says why;
    /// `error`: the check itself failed.)
    pub state: String,
    pub available: Option<String>,
    pub newest_full: Option<String>,
    pub last_checked_at: Option<u64>,
    pub waiting_for: Vec<String>,
    pub error: Option<String>,
    /// While `failed`: when `available` is tried again (ms since the epoch); `None` when that's at the next check.
    pub retry_at: Option<u64>,
    pub failures: u32,
}

#[derive(serde::Serialize, serde::Deserialize, Default)]
struct Prefs {
    beta: bool,
}

struct Ready {
    update: tauri_plugin_updater::Update,
    bytes: Vec<u8>,
    since: Instant,
}

struct Inner {
    status: UpdateStatus,
    last_activity: Instant,
    unsent: Unsent,
    ready: Option<Ready>,
    check_requested: bool,
    /// The check asked for tries a held-back build now (Check now in Settings, not an automatic hint).
    retry_requested: bool,
    install_requested: bool,
    attempts: Attempts,
    /// Gate ticks in a row the server was there but didn't answer.
    no_answers: u32,
    /// The wall-clock time of the last gate tick, to notice a sleep.
    last_tick_ms: Option<u64>,
}

/// The local server's port and token, while it runs.
pub type ServerAddr = Box<dyn Fn() -> Option<(u16, String)> + Send + Sync>;
/// Stops the local server and releases its database lock.
pub type StopServer = Box<dyn Fn() + Send + Sync>;

pub struct Updates {
    app: AppHandle,
    inner: Mutex<Inner>,
    wake: Condvar,
    server_addr: ServerAddr,
    stop_server: StopServer,
}

fn locked<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn prefs_path(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_config_dir().ok().map(|d| d.join("updates.json"))
}

fn relaunch_path(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_data_dir().ok().map(|d| d.join("update-relaunch.json"))
}

fn attempts_path(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_data_dir().ok().map(|d| d.join("update-attempts.json"))
}

fn save_attempts(app: &AppHandle, attempts: &Attempts) {
    let Some(path) = attempts_path(app) else { return };
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Err(e) = std::fs::write(&path, attempts.to_json()) {
        eprintln!("[otherbench-desktop] couldn't save the update attempts: {e}");
    }
}

/// Puts a failed build in the status: what failed, how often, and when it's tried again.
fn show_failure(s: &mut UpdateStatus, failure: &Failure, retry_at: Option<u64>) {
    s.state = "failed".into();
    s.available = Some(failure.version.clone());
    s.error = Some(failure.error.clone());
    s.failures = failure.count;
    s.retry_at = retry_at;
    s.waiting_for.clear();
}

/// Reads and removes the note an update install left; `Some(main window was showing)` if it's fresh.
pub fn take_relaunch_note(app: &AppHandle) -> Option<bool> {
    let path = relaunch_path(app)?;
    let note = std::fs::read_to_string(&path).ok();
    let _ = std::fs::remove_file(&path);
    relaunch_show(&note?, now_ms())
}

impl Updates {
    /// `installed`: the app runs from its installer (the bundled server is there). Dev runs never update.
    pub fn new(app: &AppHandle, installed: bool, server_addr: ServerAddr, stop_server: StopServer) -> Arc<Self> {
        let prefs: Prefs = prefs_path(app).and_then(|p| std::fs::read_to_string(p).ok()).and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default();
        let current = app.package_info().version.to_string();
        let mut status = UpdateStatus {
            current: current.clone(),
            installed,
            beta: prefs.beta,
            state: if installed { "idle" } else { "dev-build" }.into(),
            available: None,
            newest_full: None,
            last_checked_at: None,
            waiting_for: Vec::new(),
            error: None,
            retry_at: None,
            failures: 0,
        };
        // A dev run shares the installed app's data folder: it leaves the installed app's record alone.
        let mut attempts = Attempts::default();
        if installed {
            attempts = attempts_path(app).and_then(|p| std::fs::read_to_string(p).ok()).map(|s| Attempts::parse(&s)).unwrap_or_default();
            let now = now_ms();
            if attempts.started(&current, now) {
                save_attempts(app, &attempts);
            }
            // Said from the start, not only after the first check: a failed install restarted the app.
            if let Some(f) = &attempts.failed {
                show_failure(&mut status, f, attempts.held_back(&f.version, now));
            }
        }
        Arc::new(Self {
            app: app.clone(),
            inner: Mutex::new(Inner {
                status,
                last_activity: Instant::now(),
                unsent: Unsent::default(),
                ready: None,
                check_requested: false,
                retry_requested: false,
                install_requested: false,
                attempts,
                no_answers: 0,
                last_tick_ms: None,
            }),
            wake: Condvar::new(),
            server_addr,
            stop_server,
        })
    }

    pub fn status(&self) -> UpdateStatus {
        locked(&self.inner).status.clone()
    }

    /// Starts the loop on a thread of its own. It never waits on the server: a build whose server doesn't start still updates.
    pub fn start(self: &Arc<Self>) {
        if !locked(&self.inner).status.installed {
            return;
        }
        let me = self.clone();
        std::thread::spawn(move || me.run());
    }

    /// Checks now instead of at the next 4-hourly check. `retry`: Adam asked
    /// (Check now in Settings), so a build held back by its failures is tried
    /// again now too; an automatic hint leaves it waiting.
    pub fn check_now(&self, retry: bool) {
        let mut inner = locked(&self.inner);
        inner.check_requested = true;
        inner.retry_requested |= retry;
        drop(inner);
        self.wake.notify_all();
    }

    pub fn set_beta(&self, beta: bool) -> Result<(), String> {
        let path = prefs_path(&self.app).ok_or("no settings folder")?;
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        std::fs::write(&path, serde_json::to_string(&Prefs { beta }).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        self.change(|s| s.beta = beta);
        self.check_now(false);
        Ok(())
    }

    /// "Restart and update now": installs the downloaded build without waiting for an idle moment.
    pub fn install_now(&self) {
        let mut inner = locked(&self.inner);
        if inner.ready.is_some() {
            inner.install_requested = true;
            drop(inner);
            self.wake.notify_all();
        }
    }

    /// Input in the app window `window`, and whether a composer in it holds unsent text.
    pub fn activity(&self, window: &str, unsent: bool) {
        let mut inner = locked(&self.inner);
        inner.last_activity = Instant::now();
        inner.unsent.set(window, unsent);
    }

    /// A window closed: its unsent text went with it.
    pub fn window_gone(&self, window: &str) {
        locked(&self.inner).unsent.window_gone(window);
    }

    fn change(&self, f: impl FnOnce(&mut UpdateStatus)) {
        let status = {
            let mut inner = locked(&self.inner);
            f(&mut inner.status);
            inner.status.clone()
        };
        let _ = self.app.emit("update-status", status);
    }

    fn run(self: Arc<Self>) {
        let mut next_check = Instant::now() + FIRST_CHECK;
        loop {
            let (check, install) = {
                let mut inner = locked(&self.inner);
                let timeout = if inner.ready.is_some() { GATE_EVERY } else { next_check.saturating_duration_since(Instant::now()) };
                inner = self.wake.wait_timeout_while(inner, timeout, |i| !i.check_requested && !i.install_requested).map(|(g, _)| g).unwrap_or_else(|e| e.into_inner().0);
                let check = inner.check_requested || Instant::now() >= next_check;
                let install = inner.install_requested;
                inner.check_requested = false;
                inner.install_requested = false;
                (check, install)
            };
            if check {
                tauri::async_runtime::block_on(self.check());
                let retry_at = locked(&self.inner).status.retry_at;
                next_check = Instant::now() + next_check_in(retry_at, now_ms());
            }
            if install || self.gate_says_install() {
                self.install();
            }
        }
    }

    async fn feed(&self, url: &str) -> (FeedResult, Option<tauri_plugin_updater::Update>) {
        let updater = tauri::Url::parse(url)
            .map_err(|e| e.to_string())
            .and_then(|u| self.app.updater_builder().endpoints(vec![u]).map_err(|e| e.to_string()))
            .and_then(|b| b.version_comparator(|_, _| true).timeout(FEED_TIMEOUT).build().map_err(|e| e.to_string()));
        let updater = match updater {
            Ok(u) => u,
            Err(e) => return (FeedResult::Failed(e), None),
        };
        match updater.check().await {
            Ok(Some(update)) => (FeedResult::Found(update.version.clone()), Some(update)),
            // A 404 (nothing released on that channel yet) comes back as ReleaseNotFound; a 204 as no update.
            Ok(None) | Err(tauri_plugin_updater::Error::ReleaseNotFound) => (FeedResult::Missing, None),
            Err(e) => (FeedResult::Failed(e.to_string()), None),
        }
    }

    async fn check(&self) {
        let (current, beta, retry) = {
            let mut inner = locked(&self.inner);
            let retry = std::mem::take(&mut inner.retry_requested);
            (inner.status.current.clone(), inner.status.beta, retry)
        };
        self.change(|s| s.state = "checking".into());
        let mut results = Vec::new();
        let mut updates = Vec::new();
        for url in if beta { vec![FULL_FEED, BETA_FEED] } else { vec![FULL_FEED] } {
            let (result, update) = self.feed(url).await;
            results.push(result);
            updates.push(update);
        }
        let newest_full = match results.first() {
            Some(FeedResult::Found(v)) => Some(v.clone()),
            _ => None,
        };
        let choice = choose(&current, beta, &results);
        {
            let mut inner = locked(&self.inner);
            if inner.ready.as_ref().is_some_and(|r| !keep_ready(&r.update.version, &choice)) {
                inner.ready = None;
            }
            let before = inner.attempts.clone();
            inner.attempts.settle(&choice);
            if inner.attempts != before {
                save_attempts(&self.app, &inner.attempts);
            }
        }
        self.change(|s| {
            s.last_checked_at = Some(now_ms());
            s.newest_full = newest_full;
            s.error = None;
            s.retry_at = None;
            s.failures = 0;
        });
        match choice {
            Choice::Install { feed, version } => {
                let already = locked(&self.inner).ready.as_ref().is_some_and(|r| r.update.version == version);
                if already {
                    return;
                }
                // A build that keeps failing waits longer each time, so a bad installer, or one antivirus
                // blocks, isn't fetched and tried over and over.
                let held = {
                    let inner = locked(&self.inner);
                    let at = if retry { None } else { inner.attempts.held_back(&version, now_ms()) };
                    at.zip(inner.attempts.failed.clone())
                };
                if let Some((at, failure)) = held {
                    self.change(|s| show_failure(s, &failure, Some(at)));
                    return;
                }
                let Some(update) = updates.get_mut(feed).and_then(Option::take) else { return };
                self.change(|s| {
                    s.state = "downloading".into();
                    s.available = Some(version.clone());
                });
                // The signature is checked here, before anything is stopped or installed.
                match within(DOWNLOAD_LIMIT, async { update.download(|_, _| {}, || {}).await.map_err(|e| e.to_string()) }).await {
                    Ok(bytes) => {
                        locked(&self.inner).ready = Some(Ready { update, bytes, since: Instant::now() });
                        self.change(|s| s.state = "ready".into());
                    }
                    Err(e) => self.record_failure(&version, &format!("Downloading {version} failed: {e}")),
                }
            }
            Choice::UpToDate => self.settled("up-to-date"),
            Choice::Ahead { .. } => self.settled("ahead"),
            Choice::NoReleases => self.settled("no-releases"),
            Choice::Error(e) => self.change(|s| {
                s.state = "error".into();
                s.error = Some(e);
            }),
        }
    }

    /// `version` failed to download or install: counted, saved (an install
    /// failure is followed by a restart), and shown with when it's tried again.
    fn record_failure(&self, version: &str, error: &str) {
        let (failure, retry_at) = {
            let mut inner = locked(&self.inner);
            let now = now_ms();
            inner.attempts.failed(version, error, now);
            save_attempts(&self.app, &inner.attempts);
            (inner.attempts.failed.clone(), inner.attempts.held_back(version, now))
        };
        if let Some(failure) = failure {
            self.change(|s| show_failure(s, &failure, retry_at));
        }
    }

    /// Nothing to install (`check` has already dropped any build the choice no longer wants).
    fn settled(&self, state: &str) {
        self.change(|s| {
            s.state = state.into();
            s.available = None;
            s.waiting_for.clear();
        });
    }

    fn probe_server(&self) -> Probe {
        use std::io::{Read, Write};
        let Some((port, token)) = (self.server_addr)() else { return Probe::NoServer };
        let addr = std::net::SocketAddr::from(([127, 0, 0, 1], port));
        let mut stream = match std::net::TcpStream::connect_timeout(&addr, BUSY_TIMEOUT) {
            Ok(s) => s,
            Err(e) if e.kind() == std::io::ErrorKind::ConnectionRefused => return Probe::Refused,
            Err(_) => return Probe::NoAnswer,
        };
        let asked = stream.set_read_timeout(Some(BUSY_TIMEOUT)).and_then(|_| stream.set_write_timeout(Some(BUSY_TIMEOUT))).and_then(|_| {
            // HTTP/1.0, so the answer is never chunked and ends when the connection closes.
            write!(stream, "GET /api/desktop/busy HTTP/1.0\r\nHost: 127.0.0.1:{port}\r\nAuthorization: Bearer {token}\r\n\r\n")
        });
        let mut response = String::new();
        if asked.and_then(|_| stream.take(64 * 1024).read_to_string(&mut response)).is_err() {
            return Probe::NoAnswer;
        }
        parse_busy(&response).map_or(Probe::NoAnswer, Probe::Answered)
    }

    fn server_busy(&self) -> Option<Vec<String>> {
        let probe = self.probe_server();
        let no_answers = {
            let mut inner = locked(&self.inner);
            inner.no_answers = if probe == Probe::NoAnswer { inner.no_answers.saturating_add(1) } else { 0 };
            inner.no_answers
        };
        busy_from(probe, no_answers)
    }

    fn gate_says_install(&self) -> bool {
        let (idle_ms, unsent, ready_for_ms) = {
            let mut inner = locked(&self.inner);
            let now = now_ms();
            if just_resumed(inner.last_tick_ms, now) {
                inner.last_activity = Instant::now();
            }
            inner.last_tick_ms = Some(now);
            let Some(ready) = &inner.ready else { return false };
            (inner.last_activity.elapsed().as_millis() as u64, inner.unsent.any(), ready.since.elapsed().as_millis() as u64)
        };
        let any_window_visible = self.app.webview_windows().values().any(|w| w.is_visible().unwrap_or(false));
        let gate = Gate { server_busy: self.server_busy(), idle_ms, any_window_visible, unsent_text: unsent, ready_for_ms };
        match decide(&gate) {
            Decision::Install => true,
            Decision::Wait(waiting) => {
                self.change(|s| {
                    s.state = "ready".into();
                    s.waiting_for = waiting;
                });
                false
            }
            Decision::Ask(waiting) => {
                self.change(|s| {
                    s.state = "ask".into();
                    s.waiting_for = waiting;
                });
                false
            }
        }
    }

    fn install(&self) {
        let Some(ready) = locked(&self.inner).ready.take() else { return };
        self.change(|s| {
            s.state = "installing".into();
            s.waiting_for.clear();
        });
        if let Some(path) = relaunch_path(&self.app) {
            let main_visible = self.app.get_webview_window("main").and_then(|w| w.is_visible().ok()).unwrap_or(false);
            if let Some(dir) = path.parent() {
                let _ = std::fs::create_dir_all(dir);
            }
            let _ = std::fs::write(&path, serde_json::to_string(&RelaunchNote { at: now_ms(), main_visible }).unwrap_or_default());
        }
        // Noted first: if the installer fails after this process has gone, the build that starts next counts it.
        let version = ready.update.version.clone();
        {
            let mut inner = locked(&self.inner);
            inner.attempts.installing = Some(version.clone());
            save_attempts(&self.app, &inner.attempts);
        }
        let app = self.app.clone();
        // A failure is recorded and shown before the restart (and stays shown if the restart doesn't happen).
        let _ = install_ready(
            || (self.stop_server)(),
            || ready.update.install(&ready.bytes).map_err(|e| e.to_string()),
            |e| self.record_failure(&version, &format!("Installing {version} failed: {e}")),
            move || app.restart(),
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn gate(server_busy: Option<Vec<String>>, idle_ms: u64, any_window_visible: bool, unsent_text: bool, ready_for_ms: u64) -> Gate {
        Gate { server_busy, idle_ms, any_window_visible, unsent_text, ready_for_ms }
    }

    #[test]
    fn a_newer_beta_is_installed_when_the_switch_is_on() {
        assert_eq!(
            choose("0.2.0-beta.5", true, &[FeedResult::Found("0.1.0".into()), FeedResult::Found("0.2.0-beta.6".into())]),
            Choice::Install { feed: 1, version: "0.2.0-beta.6".into() }
        );
    }

    #[test]
    fn a_full_release_outranks_its_betas() {
        assert_eq!(
            choose("0.2.0-beta.9", true, &[FeedResult::Found("0.2.0".into()), FeedResult::Found("0.2.0-beta.9".into())]),
            Choice::Install { feed: 0, version: "0.2.0".into() }
        );
    }

    #[test]
    fn turning_betas_off_never_downgrades() {
        assert_eq!(choose("0.2.0-beta.9", false, &[FeedResult::Found("0.1.0".into())]), Choice::Ahead { newest: "0.1.0".into() });
    }

    #[test]
    fn the_same_version_is_never_reinstalled() {
        assert_eq!(choose("0.2.0-beta.6", true, &[FeedResult::Missing, FeedResult::Found("0.2.0-beta.6".into())]), Choice::UpToDate);
    }

    #[test]
    fn no_full_release_yet_is_not_an_error() {
        assert_eq!(
            choose("0.2.0-beta.1", true, &[FeedResult::Missing, FeedResult::Found("0.2.0-beta.2".into())]),
            Choice::Install { feed: 1, version: "0.2.0-beta.2".into() }
        );
        assert_eq!(choose("0.2.0", false, &[FeedResult::Missing]), Choice::NoReleases);
    }

    #[test]
    fn one_feed_failing_does_not_hide_the_other() {
        assert_eq!(
            choose("0.2.0-beta.1", true, &[FeedResult::Failed("timeout".into()), FeedResult::Found("0.2.0-beta.2".into())]),
            Choice::Install { feed: 1, version: "0.2.0-beta.2".into() }
        );
        assert!(matches!(choose("0.2.0", false, &[FeedResult::Failed("dns".into())]), Choice::Error(_)));
    }

    #[test]
    fn a_version_that_does_not_parse_counts_as_a_failed_feed() {
        assert!(matches!(choose("0.2.0", false, &[FeedResult::Found("latest".into())]), Choice::Error(_)));
    }

    #[test]
    fn installs_when_away_and_nothing_runs() {
        assert_eq!(decide(&gate(Some(vec![]), 600_000, true, false, 0)), Decision::Install);
        assert_eq!(decide(&gate(Some(vec![]), 5_000, false, false, 0)), Decision::Install);
    }

    #[test]
    fn waits_while_adam_is_using_it() {
        assert!(matches!(decide(&gate(Some(vec![]), 599_999, true, false, 0)), Decision::Wait(_)));
    }

    #[test]
    fn waits_while_a_message_is_half_typed() {
        assert!(matches!(decide(&gate(Some(vec![]), 3_600_000, false, true, 0)), Decision::Wait(_)));
    }

    #[test]
    fn waits_while_the_server_is_busy_and_asks_after_a_day() {
        let busy = || Some(vec!["1 reply being written".to_string()]);
        assert_eq!(decide(&gate(busy(), 3_600_000, false, false, 1_000)), Decision::Wait(vec!["1 reply being written".into()]));
        assert!(matches!(decide(&gate(busy(), 3_600_000, false, false, 86_400_000)), Decision::Ask(_)));
    }

    #[test]
    fn a_server_that_did_not_start_does_not_block_its_replacement() {
        assert_eq!(decide(&gate(None, 600_000, true, false, 0)), Decision::Install);
    }

    #[test]
    fn a_failed_install_restarts_the_app() {
        let log = std::cell::RefCell::new(vec![]);
        let r = install_ready(
            || log.borrow_mut().push("stop"),
            || {
                log.borrow_mut().push("install");
                Err("no".into())
            },
            |_| log.borrow_mut().push("record"),
            || log.borrow_mut().push("restart"),
        );
        assert!(r.is_err());
        assert_eq!(*log.borrow(), vec!["stop", "install", "record", "restart"]);
    }

    #[test]
    fn reads_what_the_server_says_is_running() {
        let ok = "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\n\r\n{\"busy\":true,\"reasons\":[\"1 reply being written\"]}";
        assert_eq!(parse_busy(ok), Some(vec!["1 reply being written".to_string()]));
        let idle = "HTTP/1.1 200 OK\r\n\r\n{\"busy\":false,\"reasons\":[]}";
        assert_eq!(parse_busy(idle), Some(vec![]));
    }

    #[test]
    fn a_server_that_answers_wrongly_counts_as_unreachable() {
        assert_eq!(parse_busy("HTTP/1.1 401 Unauthorized\r\n\r\n{\"error\":\"no\"}"), None);
        assert_eq!(parse_busy("HTTP/1.1 200 OK\r\n\r\nnot json"), None);
        assert_eq!(parse_busy(""), None);
    }

    #[test]
    fn comes_back_the_way_it_was_after_an_update() {
        let now = 1_000_000_000;
        assert_eq!(relaunch_show("{\"at\":999999000,\"mainVisible\":false}", now), Some(false));
        assert_eq!(relaunch_show("{\"at\":999999000,\"mainVisible\":true}", now), Some(true));
    }

    #[test]
    fn an_old_or_broken_relaunch_note_is_ignored() {
        let now = 1_000_000_000;
        assert_eq!(relaunch_show(&format!("{{\"at\":{},\"mainVisible\":false}}", now - 10 * 60 * 1000 - 1), now), None);
        assert_eq!(relaunch_show("{\"at\":\"soon\"}", now), None);
        assert_eq!(relaunch_show("", now), None);
    }

    #[test]
    fn unsent_text_in_one_window_is_not_cleared_by_another() {
        let mut unsent = Unsent::default();
        unsent.set("code", true);
        unsent.set("main", false);
        assert!(unsent.any());
        unsent.set("code", false);
        assert!(!unsent.any());
        unsent.set("quick", true);
        unsent.window_gone("quick");
        assert!(!unsent.any());
    }

    #[test]
    fn a_ready_build_is_dropped_once_the_choice_no_longer_wants_it() {
        assert!(keep_ready("0.2.0-beta.8", &Choice::Install { feed: 1, version: "0.2.0-beta.8".into() }));
        assert!(!keep_ready("0.2.0-beta.8", &Choice::Install { feed: 1, version: "0.2.0-beta.9".into() }));
        // Betas turned off after one was downloaded: it must not install.
        assert!(!keep_ready("0.2.0-beta.8", &Choice::Ahead { newest: "0.1.0".into() }));
        assert!(!keep_ready("0.2.0-beta.8", &Choice::NoReleases));
        assert!(!keep_ready("0.2.0-beta.8", &Choice::UpToDate));
        // A feed that couldn't be read says nothing new: keep what's ready.
        assert!(keep_ready("0.2.0-beta.8", &Choice::Error("dns".into())));
    }

    #[test]
    fn a_server_that_is_slow_to_answer_counts_as_busy_until_it_has_been_silent_for_ten_minutes() {
        assert_eq!(busy_from(Probe::NoServer, 0), None);
        assert_eq!(busy_from(Probe::Refused, 0), None);
        assert_eq!(busy_from(Probe::Answered(vec!["1 reply being written".into()]), 0), Some(vec!["1 reply being written".to_string()]));
        assert_eq!(busy_from(Probe::NoAnswer, 1), Some(vec!["the server isn't answering".to_string()]));
        assert_eq!(busy_from(Probe::NoAnswer, NO_ANSWER_LIMIT - 1), Some(vec!["the server isn't answering".to_string()]));
        assert_eq!(busy_from(Probe::NoAnswer, NO_ANSWER_LIMIT), None);
        assert_eq!(NO_ANSWER_LIMIT as u64 * GATE_EVERY.as_millis() as u64, 10 * 60 * 1000);
    }

    #[test]
    fn waking_from_sleep_counts_as_being_used() {
        let tick = GATE_EVERY.as_millis() as u64;
        assert!(!just_resumed(None, 1_000_000));
        assert!(!just_resumed(Some(1_000_000), 1_000_000 + tick));
        assert!(just_resumed(Some(1_000_000), 1_000_000 + 4 * tick + 1));
    }

    #[test]
    fn a_download_that_stalls_gives_up() {
        let stalled = std::future::pending::<Result<Vec<u8>, String>>();
        let r = tauri::async_runtime::block_on(within(Duration::from_millis(20), stalled));
        assert!(r.unwrap_err().contains("took too long"));
        let quick = async { Ok::<_, String>(vec![1u8]) };
        assert_eq!(tauri::async_runtime::block_on(within(Duration::from_secs(5), quick)), Ok(vec![1u8]));
    }

    #[test]
    fn a_good_install_does_not_restart() {
        let log = std::cell::RefCell::new(vec![]);
        let r = install_ready(|| log.borrow_mut().push("stop"), || Ok(()), |_| log.borrow_mut().push("record"), || log.borrow_mut().push("restart"));
        assert!(r.is_ok());
        assert_eq!(*log.borrow(), vec!["stop"]);
    }

    const HOUR: u64 = 60 * 60 * 1000;

    #[test]
    fn the_wait_after_a_failure_doubles_up_to_two_days() {
        assert_eq!(retry_delay_ms(1), 4 * HOUR);
        assert_eq!(retry_delay_ms(2), 8 * HOUR);
        assert_eq!(retry_delay_ms(3), 16 * HOUR);
        assert_eq!(retry_delay_ms(4), 32 * HOUR);
        assert_eq!(retry_delay_ms(5), 48 * HOUR);
        assert_eq!(retry_delay_ms(u32::MAX), 48 * HOUR);
        // The first wait is the normal check interval: one failure changes nothing.
        assert_eq!(retry_delay_ms(1), CHECK_EVERY.as_millis() as u64);
    }

    #[test]
    fn a_failed_version_is_held_back_and_each_failure_waits_longer() {
        let t0 = 1_000_000_000;
        let mut a = Attempts::default();
        assert_eq!(a.held_back("0.2.1", t0), None);
        a.failed("0.2.1", "Downloading 0.2.1 failed: reset", t0);
        assert_eq!(a.failed.as_ref().map(|f| f.count), Some(1));
        assert_eq!(a.held_back("0.2.1", t0 + 1), Some(t0 + 4 * HOUR));
        assert_eq!(a.held_back("0.2.1", t0 + 4 * HOUR), None);
        let t1 = t0 + 4 * HOUR;
        a.failed("0.2.1", "Installing failed: blocked", t1);
        assert_eq!(a.failed.as_ref().map(|f| (f.count, f.error.as_str())), Some((2, "Installing failed: blocked")));
        assert_eq!(a.held_back("0.2.1", t1 + 4 * HOUR), Some(t1 + 8 * HOUR));
    }

    #[test]
    fn a_new_version_is_not_held_back_by_an_older_ones_failures() {
        let t0 = 1_000_000_000;
        let mut a = Attempts::default();
        a.failed("0.2.1", "e", t0);
        a.failed("0.2.1", "e", t0);
        assert_eq!(a.held_back("0.2.2", t0 + 1), None);
        a.failed("0.2.2", "e", t0 + 1);
        assert_eq!(a.failed.as_ref().map(|f| (f.version.as_str(), f.count)), Some(("0.2.2", 1)));
    }

    #[test]
    fn a_failure_is_forgotten_once_the_choice_no_longer_wants_that_build() {
        let failed = || {
            let mut a = Attempts::default();
            a.failed("0.2.1", "e", 1);
            a
        };
        let kept = |choice: Choice| {
            let mut a = failed();
            a.settle(&choice);
            a.failed.is_some()
        };
        assert!(kept(Choice::Install { feed: 0, version: "0.2.1".into() }));
        // A feed that couldn't be read says nothing new.
        assert!(kept(Choice::Error("dns".into())));
        assert!(!kept(Choice::Install { feed: 0, version: "0.2.2".into() }));
        assert!(!kept(Choice::UpToDate));
        assert!(!kept(Choice::Ahead { newest: "0.1.0".into() }));
        assert!(!kept(Choice::NoReleases));
    }

    #[test]
    fn the_build_that_starts_after_an_install_says_whether_it_took() {
        let now = 2_000_000_000;
        let mut tried = Attempts::default();
        tried.failed("0.2.1", "Downloading 0.2.1 failed: reset", 1);
        tried.installing = Some("0.2.1".into());

        // The new build started: it worked, and the failures go with it.
        let mut a = tried.clone();
        assert!(a.started("0.2.1", now));
        assert_eq!(a, Attempts::default());

        // Still the old build (the installer was blocked, or gave up): that's a failure, counted.
        let mut a = tried.clone();
        assert!(a.started("0.2.0", now));
        assert_eq!(a.installing, None);
        let f = a.failed.clone().unwrap();
        assert_eq!((f.version.as_str(), f.count, f.at), ("0.2.1", 2, now));
        assert!(f.error.contains("still 0.2.0"), "{}", f.error);

        // Nothing was being installed: nothing changes.
        let mut a = Attempts::default();
        a.failed("0.2.1", "e", 1);
        let before = a.clone();
        assert!(!a.started("0.2.0", now));
        assert_eq!(a, before);
    }

    #[test]
    fn a_failure_for_a_build_this_one_has_reached_is_dropped() {
        let mut a = Attempts::default();
        a.failed("0.2.1", "e", 1);
        assert!(a.started("0.2.2", 5));
        assert_eq!(a.failed, None);
    }

    #[test]
    fn failures_survive_a_restart_and_a_broken_file_is_ignored() {
        let mut a = Attempts::default();
        a.failed("0.2.1", "Installing failed: blocked", 123);
        a.installing = Some("0.2.1".into());
        assert_eq!(Attempts::parse(&a.to_json()), a);
        assert_eq!(Attempts::parse("not json"), Attempts::default());
        assert_eq!(Attempts::parse(""), Attempts::default());
    }

    #[test]
    fn a_failed_install_is_recorded_before_the_app_restarts() {
        let log = std::cell::RefCell::new(vec![]);
        let r = install_ready(
            || log.borrow_mut().push("stop".to_string()),
            || Err("blocked".into()),
            |e| log.borrow_mut().push(format!("record {e}")),
            || log.borrow_mut().push("restart".to_string()),
        );
        assert_eq!(r, Err("blocked".to_string()));
        assert_eq!(*log.borrow(), vec!["stop", "record blocked", "restart"]);
    }

    #[test]
    fn a_held_back_build_is_checked_again_when_its_wait_ends_not_a_check_later() {
        let now = 1_000_000_000;
        assert_eq!(next_check_in(None, now), CHECK_EVERY);
        assert_eq!(next_check_in(Some(now + HOUR), now), Duration::from_millis(HOUR) + Duration::from_secs(1));
        assert_eq!(next_check_in(Some(now + 40 * HOUR), now), CHECK_EVERY);
        assert_eq!(next_check_in(Some(now - 1), now), CHECK_EVERY);
    }
}
