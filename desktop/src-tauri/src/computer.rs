//! Computer use in the shell: its end of the channel to the server
//! (`.superpowers/sdd/2026-10-12-computer-use/shell-wire-spec.md`; rpc.rs
//! reads and writes the lines).
//!
//! It ships switched OFF: `computer.hello` reports `available: false` unless
//! a driver is built in AND the shell was started with GRUNT_COMPUTER_USE=1,
//! which only Adam sets, for his live check. In this build there is no driver
//! at all, so every start is refused and nothing else can have a session.

use std::sync::atomic::{AtomicBool, Ordering};

use serde_json::{json, Value};

use crate::rpc::{self, Reply, Request, Writer};

/// Set to "1" to switch computer use on in this shell. Off when unset.
pub const SWITCH_ENV: &str = "GRUNT_COMPUTER_USE";
pub const OFF_REASON: &str = "Computer use is off in this Grunt desktop app.";
/// The answer to a request for a chat that has no live session (or names another token).
pub const NO_SESSION: &str = "Grunt is not controlling this computer for that chat.";
/// Registered only while a chat is in control.
pub const STOP_HOTKEY: &str = "Ctrl+Alt+Backspace";

/// Whether a driver is compiled in. There is none in this build.
const DRIVER_BUILT: bool = false;

pub fn switched_on(value: Option<&str>) -> bool {
    value == Some("1")
}

pub fn enabled() -> bool {
    DRIVER_BUILT && cfg!(windows) && switched_on(std::env::var(SWITCH_ENV).ok().as_deref())
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

/// The shell's side of the channel. With no driver it holds no session, so
/// it answers every request at once, on the reader thread.
pub struct Shell {
    /// The global shortcuts the shell has registered now (hotkey.rs).
    shortcuts: Box<dyn Fn() -> Vec<String> + Send + Sync>,
    closed: AtomicBool,
}

impl Shell {
    pub fn new(shortcuts: impl Fn() -> Vec<String> + Send + Sync + 'static) -> Self {
        Self { shortcuts: Box::new(shortcuts), closed: AtomicBool::new(false) }
    }

    /// The quick-chat hotkey changed. Nothing is told: computer use is off.
    pub fn shortcuts_changed(&self) {}
}

impl rpc::Handler for Shell {
    fn attach(&self, _writer: Writer) {}

    fn request(&self, request: Request, reply: Reply) {
        if self.closed.load(Ordering::SeqCst) {
            return;
        }
        match request.method.as_str() {
            "computer.hello" => reply.ok(hello_result(enabled(), (self.shortcuts)())),
            "computer.start" => reply.ok(json!({ "ok": false, "reason": OFF_REASON })),
            // Nothing is ever held, so an end has nothing to end.
            "computer.end" => reply.ok(json!({ "ok": true })),
            "computer.screenshot" | "computer.cursor" | "computer.target" | "computer.act" => reply.err(NO_SESSION, Some(rpc::NO_SESSION_CODE)),
            _ => reply.err("Unknown method.", None),
        }
    }

    fn notification(&self, method: &str, _params: &Value) -> bool {
        if method == "computer.close" {
            self.closed.store(true, Ordering::SeqCst);
            return true;
        }
        false
    }

    fn lost(&self) {
        self.closed.store(true, Ordering::SeqCst);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rpc::tests::writer;
    use crate::rpc::Handler;

    fn ask(shell: &Shell, id: u64, method: &str, params: Value) -> (Writer, crate::rpc::tests::Sink) {
        let (w, sink) = writer();
        shell.request(Request { id, method: method.into(), params }, Reply::new(id, w.clone()));
        (w, sink)
    }

    #[test]
    fn ships_switched_off() {
        assert!(!DRIVER_BUILT);
        assert!(!enabled());
        assert!(switched_on(Some("1")));
        for v in [None, Some(""), Some("0"), Some("true"), Some("yes"), Some(" 1")] {
            assert!(!switched_on(v), "{v:?}");
        }
    }

    #[test]
    fn names_the_platform_as_node_does() {
        assert_eq!(node_platform("windows"), "win32");
        assert_eq!(node_platform("macos"), "darwin");
        assert_eq!(node_platform("linux"), "linux");
    }

    #[test]
    fn hello_answers_every_field_with_computer_use_off() {
        let shell = Shell::new(|| vec!["Ctrl+Shift+Space".to_string()]);
        let (_, sink) = ask(&shell, 1, "computer.hello", json!({}));
        let m = &sink.messages()[0];
        assert_eq!(m["id"], json!(1));
        let r = &m["result"];
        assert_eq!(r["available"], json!(false));
        assert_eq!(r["sessions"], json!(0));
        assert!(r["sessions"].is_u64());
        assert_eq!(r["shortcuts"], json!(["Ctrl+Shift+Space"]));
        assert_eq!(r["version"], json!(env!("CARGO_PKG_VERSION")));
        assert_eq!(r["platform"], json!(node_platform(std::env::consts::OS)));
    }

    #[test]
    fn every_other_method_answers_as_a_shell_with_no_session() {
        let shell = Shell::new(Vec::new);
        let (_, s) = ask(&shell, 2, "computer.start", json!({ "chatId": "c", "title": "t" }));
        assert_eq!(s.messages()[0]["result"], json!({ "ok": false, "reason": OFF_REASON }));
        let (_, s) = ask(&shell, 3, "computer.end", json!({ "chatId": "c" }));
        assert_eq!(s.messages()[0]["result"], json!({ "ok": true }));
        for (id, m) in [(4, "computer.screenshot"), (5, "computer.cursor"), (6, "computer.target"), (7, "computer.act")] {
            let (_, s) = ask(&shell, id, m, json!({ "chatId": "c", "session": "x".repeat(32) }));
            assert_eq!(s.messages()[0], json!({ "id": id, "error": { "message": NO_SESSION, "code": "no-session" } }), "{m}");
        }
        let (_, s) = ask(&shell, 8, "computer.dance", json!({}));
        assert_eq!(s.messages()[0], json!({ "id": 8, "error": { "message": "Unknown method." } }));
    }

    #[test]
    fn after_close_nothing_more_is_acted_on() {
        let shell = Shell::new(Vec::new);
        assert!(shell.notification("computer.close", &json!({})));
        assert!(!Shell::new(Vec::new).notification("computer.other", &json!({})));
        let (w, s) = writer();
        // The reply goes unanswered on purpose: the server reads nothing after close (it is dropped, which writes a plain error).
        shell.request(Request { id: 9, method: "computer.hello".into(), params: json!({}) }, Reply::new(9, w));
        assert!(s.messages()[0].get("result").is_none());
    }

    #[test]
    fn knows_the_stop_hotkey_however_it_is_spelled() {
        assert!(is_stop_hotkey("Ctrl+Alt+Backspace"));
        assert!(is_stop_hotkey("alt+control+BACKSPACE"));
        assert!(!is_stop_hotkey("Ctrl+Shift+Backspace"));
        assert!(!is_stop_hotkey("not a shortcut"));
    }
}
