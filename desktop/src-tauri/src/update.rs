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
    fn a_good_install_does_not_restart() {
        let log = std::cell::RefCell::new(vec![]);
        let r = install_ready(|| log.borrow_mut().push("stop"), || Ok(()), || log.borrow_mut().push("restart"));
        assert!(r.is_ok());
        assert_eq!(*log.borrow(), vec!["stop"]);
    }
}
