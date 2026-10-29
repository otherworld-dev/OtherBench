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
/// fails, the app restarts on the build it has, so it is never left running
/// with no server.
pub fn install_ready(stop_server: impl FnOnce(), install: impl FnOnce() -> Result<(), String>, restart: impl FnOnce()) -> Result<(), String> {
    stop_server();
    install().inspect_err(|_| restart())
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

/// What Settings → Desktop shows (web/src/views/settings/DesktopPanel.tsx), also sent as `update-status`.
#[derive(Clone, Serialize, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UpdateStatus {
    pub current: String,
    pub installed: bool,
    pub beta: bool,
    /// dev-build | idle | checking | up-to-date | ahead | no-releases | downloading | ready | ask | installing | error
    pub state: String,
    pub available: Option<String>,
    pub newest_full: Option<String>,
    pub last_checked_at: Option<u64>,
    pub waiting_for: Vec<String>,
    pub error: Option<String>,
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
    unsent: bool,
    ready: Option<Ready>,
    check_requested: bool,
    install_requested: bool,
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
        let status = UpdateStatus {
            current: app.package_info().version.to_string(),
            installed,
            beta: prefs.beta,
            state: if installed { "idle" } else { "dev-build" }.into(),
            available: None,
            newest_full: None,
            last_checked_at: None,
            waiting_for: Vec::new(),
            error: None,
        };
        Arc::new(Self {
            app: app.clone(),
            inner: Mutex::new(Inner { status, last_activity: Instant::now(), unsent: false, ready: None, check_requested: false, install_requested: false }),
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

    pub fn check_now(&self) {
        locked(&self.inner).check_requested = true;
        self.wake.notify_all();
    }

    pub fn set_beta(&self, beta: bool) -> Result<(), String> {
        let path = prefs_path(&self.app).ok_or("no settings folder")?;
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        std::fs::write(&path, serde_json::to_string(&Prefs { beta }).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        self.change(|s| s.beta = beta);
        self.check_now();
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

    /// Input in one of the app's windows, and whether any composer holds unsent text.
    pub fn activity(&self, unsent: bool) {
        let mut inner = locked(&self.inner);
        inner.last_activity = Instant::now();
        inner.unsent = unsent;
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
                next_check = Instant::now() + CHECK_EVERY;
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
        let (current, beta) = {
            let inner = locked(&self.inner);
            (inner.status.current.clone(), inner.status.beta)
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
        self.change(|s| {
            s.last_checked_at = Some(now_ms());
            s.newest_full = newest_full;
            s.error = None;
        });
        match choice {
            Choice::Install { feed, version } => {
                let already = locked(&self.inner).ready.as_ref().is_some_and(|r| r.update.version == version);
                if already {
                    return;
                }
                let Some(update) = updates.get_mut(feed).and_then(Option::take) else { return };
                self.change(|s| {
                    s.state = "downloading".into();
                    s.available = Some(version.clone());
                });
                // The signature is checked here, before anything is stopped or installed.
                match update.download(|_, _| {}, || {}).await {
                    Ok(bytes) => {
                        locked(&self.inner).ready = Some(Ready { update, bytes, since: Instant::now() });
                        self.change(|s| s.state = "ready".into());
                    }
                    Err(e) => self.change(|s| {
                        s.state = "error".into();
                        s.error = Some(format!("Downloading {version} failed: {e}"));
                    }),
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

    /// Nothing to install: a build downloaded earlier stays ready unless the switch made it pointless.
    fn settled(&self, state: &str) {
        let has_ready = locked(&self.inner).ready.is_some();
        if !has_ready {
            self.change(|s| {
                s.state = state.into();
                s.available = None;
                s.waiting_for.clear();
            });
        }
    }

    fn server_busy(&self) -> Option<Vec<String>> {
        use std::io::{Read, Write};
        let (port, token) = (self.server_addr)()?;
        let addr = std::net::SocketAddr::from(([127, 0, 0, 1], port));
        let mut stream = std::net::TcpStream::connect_timeout(&addr, BUSY_TIMEOUT).ok()?;
        stream.set_read_timeout(Some(BUSY_TIMEOUT)).ok()?;
        stream.set_write_timeout(Some(BUSY_TIMEOUT)).ok()?;
        // HTTP/1.0, so the answer is never chunked and ends when the connection closes.
        write!(stream, "GET /api/desktop/busy HTTP/1.0\r\nHost: 127.0.0.1:{port}\r\nAuthorization: Bearer {token}\r\n\r\n").ok()?;
        let mut response = String::new();
        stream.take(64 * 1024).read_to_string(&mut response).ok()?;
        parse_busy(&response)
    }

    fn gate_says_install(&self) -> bool {
        let (idle_ms, unsent, ready_for_ms) = {
            let inner = locked(&self.inner);
            let Some(ready) = &inner.ready else { return false };
            (inner.last_activity.elapsed().as_millis() as u64, inner.unsent, ready.since.elapsed().as_millis() as u64)
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
        let app = self.app.clone();
        let result = install_ready(|| (self.stop_server)(), || ready.update.install(&ready.bytes).map_err(|e| e.to_string()), move || app.restart());
        if let Err(e) = result {
            // Not reached when the restart works; kept for the status if it doesn't.
            self.change(|s| {
                s.state = "error".into();
                s.error = Some(format!("Installing failed: {e}"));
            });
        }
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
            || log.borrow_mut().push("restart"),
        );
        assert!(r.is_err());
        assert_eq!(*log.borrow(), vec!["stop", "install", "restart"]);
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
    fn a_good_install_does_not_restart() {
        let log = std::cell::RefCell::new(vec![]);
        let r = install_ready(|| log.borrow_mut().push("stop"), || Ok(()), || log.borrow_mut().push("restart"));
        assert!(r.is_ok());
        assert_eq!(*log.borrow(), vec!["stop"]);
    }
}
