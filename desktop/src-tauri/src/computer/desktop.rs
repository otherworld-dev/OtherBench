//! The real driver (Windows only): win.rs for the machine, Tauri for the
//! shell's own pieces (the stop hotkey, the indicator bar, the tray). Built
//! only when the shell was started with OTHERBENCH_COMPUTER_USE=1 (computer.rs
//! `shell`); no test builds one.
//!
//! Every call that needs the main thread (the event loop) is time-bounded,
//! so no worker waits on it for long and the main thread never waits on a
//! worker: hotkey and tray work goes through `on_main` (at most a second),
//! and building or destroying the indicator window runs on a thread of its
//! own that is waited for at most a few seconds.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc};
use std::thread::{self, ThreadId};
use std::time::Duration;

use serde_json::json;
use tauri::{AppHandle, Emitter, Manager, WebviewUrl};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

use super::facts::{Facts, Identity};
use super::{win, Capture, Consent, Desktop, Dialog, Input, Keyboard, Where, INDICATOR, STOP_HOTKEY};

const INDICATOR_WIDTH: f64 = 460.0;
const INDICATOR_HEIGHT: f64 = 56.0;
const NO_WINDOW: &str = "There is no window there.";
/// How long the main thread gets for a hotkey or tray call.
const MAIN_WAIT: Duration = Duration::from_secs(1);
/// How long building or destroying the indicator window may take.
const WINDOW_WAIT: Duration = Duration::from_secs(3);

pub struct WinDesktop {
    app: AppHandle,
    /// The thread Tauri's event loop runs on: global shortcuts are registered there.
    main: ThreadId,
}

impl WinDesktop {
    /// Made in `setup`, which runs on the main thread.
    pub fn new(app: AppHandle) -> Self {
        Self { app, main: thread::current().id() }
    }

    /// Runs `work` on the main thread and waits for it at most `MAIN_WAIT`;
    /// directly when already there, so the main thread never waits on itself.
    /// Closures run on the main thread in the order they were queued, so a
    /// late one (after a timeout) is followed by the next, never overtaken.
    fn on_main<T: Send + 'static>(&self, work: impl FnOnce(&AppHandle) -> T + Send + 'static) -> Option<T> {
        if thread::current().id() == self.main {
            return Some(work(&self.app));
        }
        let (tx, rx) = mpsc::channel();
        let app = self.app.clone();
        self.app
            .run_on_main_thread(move || {
                let _ = tx.send(work(&app));
            })
            .ok()?;
        rx.recv_timeout(MAIN_WAIT).ok()
    }

    /// Runs `work` on a thread of its own, waited for at most `WINDOW_WAIT`.
    /// `abandoned` is set when it was not waited for to the end.
    fn bounded<T: Send + 'static>(&self, work: impl FnOnce(&AppHandle, &AtomicBool) -> T + Send + 'static) -> Option<T> {
        let (tx, rx) = mpsc::channel();
        let app = self.app.clone();
        let abandoned = Arc::new(AtomicBool::new(false));
        let flag = abandoned.clone();
        thread::spawn(move || {
            let _ = tx.send(work(&app, &flag));
        });
        let out = rx.recv_timeout(WINDOW_WAIT).ok();
        if out.is_none() {
            abandoned.store(true, Ordering::SeqCst);
        }
        out
    }

    fn tooltip(&self, text: Option<String>) {
        let _ = self.on_main(move |app| crate::tray::set_override(app, text));
    }

    fn destroy_indicator(&self) {
        let _ = self.bounded(|app, _| {
            if let Some(window) = app.get_webview_window(INDICATOR) {
                let _ = window.destroy();
            }
        });
    }
}

/// Percent-encodes everything but unreserved characters, for the indicator's URL.
pub fn percent_encode(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => (b as char).to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect()
}

impl Desktop for WinDesktop {
    fn consent(&self, text: &str, dialog: &Dialog) -> Consent {
        win::consent(text, "OtherBench", dialog)
    }

    fn stop_hotkey(&self, on: bool) -> Result<(), String> {
        self.on_main(move |app| {
            let shortcuts = app.global_shortcut();
            if on {
                shortcuts
                    .on_shortcut(STOP_HOTKEY, |app, _shortcut, event| {
                        if event.state == ShortcutState::Pressed {
                            super::stop_from_shell(app, "hotkey");
                        }
                    })
                    .map_err(|e| e.to_string())
            } else {
                shortcuts.unregister(STOP_HOTKEY).map_err(|e| e.to_string())
            }
        })
        .unwrap_or_else(|| Err("the main thread didn't answer in time".into()))
    }

    fn indicator(&self, title: &str) -> Result<(), String> {
        self.destroy_indicator();
        let x = self
            .app
            .primary_monitor()
            .ok()
            .flatten()
            .map(|m| {
                let scale = m.scale_factor();
                m.position().x as f64 / scale + ((m.size().width as f64 / scale) - INDICATOR_WIDTH).max(0.0) / 2.0
            })
            .unwrap_or(400.0);
        let url = format!("index.html?view=indicator&title={}", percent_encode(title));
        let built = self.bounded(move |app, abandoned| {
            let window = crate::links::window(app, INDICATOR, WebviewUrl::App(url.into()))
                .title("OtherBench is controlling this computer")
                .decorations(false)
                .always_on_top(true)
                .skip_taskbar(true)
                .focused(false)
                .resizable(false)
                .inner_size(INDICATOR_WIDTH, INDICATOR_HEIGHT)
                .position(x, 8.0)
                .build()
                .map_err(|e| e.to_string())?;
            if abandoned.load(Ordering::SeqCst) {
                // Nobody waited for it: the session was refused, so it must not stay up.
                let _ = window.destroy();
                return Err("too late".to_string());
            }
            window.hwnd().map(|h| h.0 as isize).map_err(|e| e.to_string())
        });
        let raw = match built {
            Some(Ok(raw)) => raw,
            _ => return Err("the indicator bar couldn't be shown".into()),
        };
        let _ = self.on_main(move |_| win::exclude_from_capture(raw));
        self.tooltip(Some(crate::tray::control_tooltip(title)));
        Ok(())
    }

    fn hide_indicator(&self) {
        self.destroy_indicator();
        self.tooltip(None);
    }

    fn channel_off(&self) {
        self.tooltip(Some(crate::tray::COMPUTER_OFF_TOOLTIP.to_string()));
        let _ = crate::notify::show(&self.app, "OtherBench", "Computer use is off until OtherBench restarts.", None, None);
    }

    fn indicator_action(&self, label: &str) {
        let _ = self.app.emit_to(INDICATOR, INDICATOR, json!({ "lastAction": label }));
    }

    fn capture(&self, max: (u32, u32)) -> Result<Capture, String> {
        win::capture(max)
    }

    fn screen_size(&self) -> Result<(u32, u32), String> {
        win::screen_size()
    }

    fn cursor(&self) -> Result<(i32, i32), String> {
        win::cursor()
    }

    fn facts(&self, at: &Where) -> Result<Facts, String> {
        win::facts(win::window(at).ok_or(NO_WINDOW)?)
    }

    fn identity(&self, at: &Where) -> Result<Identity, String> {
        win::identity(win::window(at).ok_or(NO_WINDOW)?)
    }

    fn activate(&self, window_id: &str) -> bool {
        win::window(&Where::Window(window_id.to_string())).is_some_and(win::activate)
    }

    fn keyboard(&self) -> Keyboard {
        win::keyboard()
    }

    fn move_to(&self, x: i32, y: i32) -> Result<(), String> {
        win::move_to(x, y)
    }

    fn send(&self, inputs: &[Input]) -> usize {
        win::send(inputs)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn percent_encodes_a_chat_title() {
        assert_eq!(percent_encode("Budget & plans"), "Budget%20%26%20plans");
        assert_eq!(percent_encode("\u{e9}"), "%C3%A9");
        assert_eq!(percent_encode("a?view=main#x"), "a%3Fview%3Dmain%23x");
    }
}
