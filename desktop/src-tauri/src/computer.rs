//! Computer use in the shell: its end of the channel to the server
//! (`.superpowers/sdd/2026-10-12-computer-use/shell-wire-spec.md`; rpc.rs
//! reads and writes the lines).
//!
//! It ships switched OFF: `computer.hello` reports `available: false` unless
//! the Windows driver is built in (it is, on Windows) AND the shell was
//! started with GRUNT_COMPUTER_USE=1, which only Adam sets, for his live
//! check. With the switch off the shell has no driver at all (`Shell::new`
//! gets `None`), so no input, capture or window call can be reached.
//!
//! The shell reports facts and presses what it is told; core decides
//! everything else. It does refuse its own shortcuts, check the expectation
//! it is handed before every step, and never trust a remembered keyboard.
//!
//!   session.rs  the sessions, their tokens and the answers (platform-free, tested with a fake)
//!   act.rs      reading an action and carrying it out with its checks
//!   keys.rs     the key table (exactly core's key names)
//!   facts.rs    what is reported about a window, and the pure parts of finding it out
//!   image.rs    screenshot scaling, coordinates and PNG
//!   win.rs      the Win32 calls (Windows only; never run by a test)
//!   desktop.rs  the real driver: win.rs plus the dialog, hotkey, indicator and tray

mod act;
mod facts;
mod image;
mod keys;
mod session;

#[cfg(windows)]
mod desktop;
#[cfg(windows)]
mod win;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde_json::{json, Value};

pub use facts::{Facts, Identity};
pub use session::{Limits, Shell};

/// Set to "1" to switch computer use on in this shell. Off when unset.
pub const SWITCH_ENV: &str = "GRUNT_COMPUTER_USE";
pub const OFF_REASON: &str = "Computer use is off in this Grunt desktop app.";
/// The answer to a request for a chat that has no live session (or names another token).
pub const NO_SESSION: &str = "Grunt is not controlling this computer for that chat.";
/// Registered only while a chat is in control.
pub const STOP_HOTKEY: &str = "Ctrl+Alt+Backspace";
/// The indicator bar's window label (capabilities/indicator.json) and the event it listens for.
pub const INDICATOR: &str = "computer-indicator";

/// The Windows driver is compiled in on Windows. It still only runs with GRUNT_COMPUTER_USE=1.
const DRIVER_BUILT: bool = cfg!(windows);

pub fn switched_on(value: Option<&str>) -> bool {
    value == Some("1")
}

pub fn enabled() -> bool {
    DRIVER_BUILT && switched_on(std::env::var(SWITCH_ENV).ok().as_deref())
}

/// Node's name for a platform (`process.platform`), which the server checks.
pub fn node_platform(os: &str) -> &str {
    match os {
        "windows" => "win32",
        "macos" => "darwin",
        other => other,
    }
}

/// Whether an accelerator is the stop hotkey, however it is spelled.
pub fn is_stop_hotkey(accelerator: &str) -> bool {
    use std::str::FromStr;
    use tauri_plugin_global_shortcut::Shortcut;
    match (Shortcut::from_str(accelerator), Shortcut::from_str(STOP_HOTKEY)) {
        (Ok(a), Ok(stop)) => a.mods == stop.mods && a.key == stop.key,
        _ => false,
    }
}

/// The answer to `computer.hello`: every field the server requires.
pub fn hello_result(available: bool, shortcuts: Vec<String>) -> Value {
    json!({
        "platform": node_platform(std::env::consts::OS),
        "version": env!("CARGO_PKG_VERSION"),
        "available": available,
        "shortcuts": shortcuts,
        "sessions": 0,
    })
}

// ---- what the driver is asked to do -----------------------------------------

/// Which window to look at.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Where {
    /// The top-level window under a screen point.
    Point(i32, i32),
    /// The foreground window.
    Foreground,
    /// A window by its id (re-activation only).
    Window(String),
}

/// The real modifier state, read before anything is pressed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Keyboard {
    Clear,
    /// A modifier (either Ctrl, Alt, Shift or Windows key) is down, physically or logically.
    Held,
    /// The state can't be read (the input desktop isn't the user's: locked, a UAC prompt).
    Unknown,
}

/// The person's answer to the native start dialog.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Consent {
    Yes,
    /// Cancel, closed, dismissed by the shell, or timed out.
    No,
    /// The dialog could not be shown.
    Failed,
}

/// One input event. A down and its up are separate events, so a guard can
/// tell exactly which keys and buttons it left down.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Input {
    Key { vk: u16, extended: bool, up: bool },
    /// A UTF-16 unit typed as a character (`KEYEVENTF_UNICODE`).
    Unicode { unit: u16, up: bool },
    Button { right: bool, up: bool },
    /// One notch: 120 or -120.
    Wheel { delta: i32, horizontal: bool },
}

impl Input {
    /// The up that releases this event, if it is a down.
    pub fn release(&self) -> Option<Input> {
        match *self {
            Input::Key { vk, extended, up: false } => Some(Input::Key { vk, extended, up: true }),
            Input::Unicode { unit, up: false } => Some(Input::Unicode { unit, up: true }),
            Input::Button { right, up: false } => Some(Input::Button { right, up: true }),
            _ => None,
        }
    }

    pub fn is_up(&self) -> bool {
        matches!(self, Input::Key { up: true, .. } | Input::Unicode { up: true, .. } | Input::Button { up: true, .. })
    }
}

/// A capture of the primary monitor, already scaled: top-down BGRA rows.
pub struct Capture {
    pub bgra: Vec<u8>,
    pub width: u32,
    pub height: u32,
    pub screen_w: u32,
    pub screen_h: u32,
}

/// The start dialog's handle: another thread dismisses it (an end, a hello,
/// the channel closing), and it dismisses itself at its deadline. Dismissing
/// is always Cancel, never OK.
#[derive(Clone)]
pub struct Dialog(Arc<(AtomicBool, Instant)>);

impl Dialog {
    pub fn new(limit: Duration) -> Self {
        Self(Arc::new((AtomicBool::new(false), Instant::now() + limit)))
    }

    pub fn dismiss(&self) {
        self.0 .0.store(true, Ordering::SeqCst);
    }

    pub fn dismissed(&self) -> bool {
        self.0 .0.load(Ordering::SeqCst)
    }

    pub fn expired(&self) -> bool {
        Instant::now() >= self.0 .1
    }

    /// The dialog must close now (as Cancel).
    pub fn should_close(&self) -> bool {
        self.dismissed() || self.expired()
    }
}

/// What the session needs of the machine. The real one is desktop.rs (only
/// built when the switch is on); tests use a fake that touches nothing.
pub trait Desktop: Send + Sync {
    /// Shows the native start dialog and waits for the person, closing it
    /// (as Cancel) once `dialog.should_close()`.
    fn consent(&self, text: &str, dialog: &Dialog) -> Consent;
    /// Registers or unregisters the stop hotkey.
    fn stop_hotkey(&self, on: bool) -> Result<(), String>;
    /// Shows the indicator bar (and the tray says so) for a chat's title, or takes it away.
    fn indicator(&self, title: Option<&str>);
    /// The indicator's line for the last action (never typed text).
    fn indicator_action(&self, label: &str);
    fn capture(&self, max: (u32, u32)) -> Result<Capture, String>;
    fn screen_size(&self) -> Result<(u32, u32), String>;
    fn cursor(&self) -> Result<(i32, i32), String>;
    fn facts(&self, at: &Where) -> Result<Facts, String>;
    /// The facts an action is checked against, quickly (no signature check).
    fn identity(&self, at: &Where) -> Result<Identity, String>;
    /// Brings exactly this window forward; false if it couldn't.
    fn activate(&self, window_id: &str) -> bool;
    fn keyboard(&self) -> Keyboard;
    fn move_to(&self, x: i32, y: i32) -> Result<(), String>;
    /// Sends events in order, all in one go; how many were taken.
    fn send(&self, inputs: &[Input]) -> usize;
}

/// The shell for this app: with the switch on (Windows only), the real
/// driver; otherwise none, and computer use reports off.
pub fn shell(app: &tauri::AppHandle) -> Arc<Shell> {
    let shortcuts = || crate::hotkey::registered().into_iter().collect();
    #[cfg(windows)]
    if enabled() {
        return Arc::new(Shell::new(shortcuts, Some(Arc::new(desktop::WinDesktop::new(app.clone())) as Arc<dyn Desktop>), Limits::default()));
    }
    let _ = app;
    Arc::new(Shell::new(shortcuts, None, Limits::default()))
}

/// Stop from the shell itself: the hotkey, the indicator's Stop. Off the
/// calling thread, which may be the main one the hotkey needs.
pub fn stop_from_shell(app: &tauri::AppHandle, why: &'static str) {
    use tauri::Manager;
    if let Some(shell) = app.try_state::<Arc<Shell>>() {
        let shell = shell.inner().clone();
        std::thread::spawn(move || shell.stop(why));
    }
}

/// Grunt is quitting: end every session and tell the server, before the pipes close.
pub fn shutdown(app: &tauri::AppHandle) {
    use tauri::Manager;
    if let Some(shell) = app.try_state::<Arc<Shell>>() {
        shell.stop("quit");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ships_switched_off() {
        assert!(!enabled(), "GRUNT_COMPUTER_USE must not be set where tests run");
        assert!(switched_on(Some("1")));
        for v in [None, Some(""), Some("0"), Some("true"), Some("yes"), Some(" 1")] {
            assert!(!switched_on(v), "{v:?}");
        }
        assert_eq!(hello_result(false, vec![])["available"], json!(false));
    }

    #[test]
    fn names_the_platform_as_node_does() {
        assert_eq!(node_platform("windows"), "win32");
        assert_eq!(node_platform("macos"), "darwin");
        assert_eq!(node_platform("linux"), "linux");
    }

    #[test]
    fn hello_answers_every_field() {
        let r = hello_result(true, vec!["Ctrl+Shift+Space".into()]);
        assert_eq!(r["available"], json!(true));
        assert_eq!(r["sessions"], json!(0));
        assert!(r["sessions"].is_u64());
        assert_eq!(r["shortcuts"], json!(["Ctrl+Shift+Space"]));
        assert_eq!(r["version"], json!(env!("CARGO_PKG_VERSION")));
        assert_eq!(r["platform"], json!(node_platform(std::env::consts::OS)));
    }

    #[test]
    fn knows_the_stop_hotkey_however_it_is_spelled() {
        assert!(is_stop_hotkey("Ctrl+Alt+Backspace"));
        assert!(is_stop_hotkey("alt+control+BACKSPACE"));
        assert!(!is_stop_hotkey("Ctrl+Shift+Backspace"));
        assert!(!is_stop_hotkey("not a shortcut"));
    }

    #[test]
    fn a_down_knows_its_up() {
        let down = Input::Key { vk: 0x41, extended: false, up: false };
        assert_eq!(down.release(), Some(Input::Key { vk: 0x41, extended: false, up: true }));
        assert!(down.release().unwrap().is_up());
        assert_eq!(Input::Wheel { delta: 120, horizontal: false }.release(), None);
        assert_eq!(Input::Unicode { unit: 0x61, up: false }.release(), Some(Input::Unicode { unit: 0x61, up: true }));
    }

    #[test]
    fn a_dialog_closes_when_dismissed_or_at_its_deadline() {
        let d = Dialog::new(Duration::from_secs(60));
        assert!(!d.should_close());
        d.clone().dismiss();
        assert!(d.should_close() && d.dismissed() && !d.expired());
        let d = Dialog::new(Duration::ZERO);
        assert!(d.should_close() && d.expired() && !d.dismissed());
    }
}
