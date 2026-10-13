//! The real driver (Windows only): win.rs for the machine, Tauri for the
//! shell's own pieces (the stop hotkey, the indicator bar, the tray). Built
//! only when the shell was started with GRUNT_COMPUTER_USE=1 (computer.rs
//! `shell`); no test builds one.

use std::sync::mpsc;
use std::thread::{self, ThreadId};
use std::time::Duration;

use serde_json::json;
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

use super::facts::{Facts, Identity};
use super::{win, Capture, Consent, Desktop, Dialog, Input, Keyboard, Where, INDICATOR, STOP_HOTKEY};

const INDICATOR_WIDTH: f64 = 460.0;
const INDICATOR_HEIGHT: f64 = 56.0;
const NO_WINDOW: &str = "There is no window there.";

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

    /// Runs `work` on the main thread and waits for it, at most a second (an
    /// end must still answer inside the server's 4 s); directly when already
    /// there, so the main thread never waits on itself.
    fn on_main<T: Send + 'static>(&self, work: impl FnOnce(&AppHandle) -> T + Send + 'static) -> Option<T> {
        if thread::current().id() == self.main {
            return Some(work(&self.app));
        }
        let (tx, rx) = mpsc::channel();
        let app = self.app.clone();
        self.app.run_on_main_thread(move || {
            let _ = tx.send(work(&app));
        }).ok()?;
        rx.recv_timeout(Duration::from_secs(1)).ok()
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
        win::consent(text, "Grunt", dialog)
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
        .unwrap_or_else(|| Err("the main thread didn't answer".into()))
    }

    fn indicator(&self, title: Option<&str>) {
        if let Some(window) = self.app.get_webview_window(INDICATOR) {
            let _ = window.destroy();
        }
        crate::tray::set_control_tooltip(&self.app, title);
        let Some(title) = title else { return };
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
        let built = WebviewWindowBuilder::new(&self.app, INDICATOR, WebviewUrl::App(url.into()))
            .title("Grunt is controlling this computer")
            .decorations(false)
            .always_on_top(true)
            .skip_taskbar(true)
            .focused(false)
            .resizable(false)
            .inner_size(INDICATOR_WIDTH, INDICATOR_HEIGHT)
            .position(x, 8.0)
            .build();
        if let Ok(window) = built {
            if let Ok(hwnd) = window.hwnd() {
                let raw = hwnd.0 as isize;
                let _ = self.on_main(move |_| win::exclude_from_capture(raw));
            }
        }
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
