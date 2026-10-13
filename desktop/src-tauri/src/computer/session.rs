//! The shell's sessions and its answers on the channel
//! (shell-wire-spec.md sections 4 to 7 and 11). Platform-free: everything it
//! does to the machine goes through `Desktop`, which is `None` while computer
//! use is switched off, and a fake in the tests.
//!
//! - A session belongs to one chat and is created only by the person's OK in
//!   the native dialog. It is named by a fresh token (256 random bits); every
//!   later request must carry it byte for byte, or it is answered `no-session`
//!   and nothing is done.
//! - One chat at a time: a start is refused while another chat holds a
//!   session or has a dialog up. Each chat's session, dialog and answers are
//!   kept apart.
//! - An end is not token-checked. The reader thread marks the chat's session
//!   dead and its dialog cancelled before it reads the next line (`take`), so
//!   any later request for the chat is `no-session` whichever worker runs it.
//!   The end then waits (at most `Limits::settle`) for an act in progress to
//!   stop at its next check and release what it pressed, so nothing is
//!   pressed after its answer, and answers well inside the server's 4 s.
//! - Answers for one chat are written in the order their effects took place:
//!   an end that ended a session waits for that session's start to have
//!   written its yes.
//! - Events go out only after the hello's answer: `computer.shortcuts`
//!   whenever the list changes (before the start's yes that registered the
//!   stop hotkey), `computer.stopped` only for the shell's own ends.

use std::collections::HashMap;
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::thread;
use std::time::{Duration, Instant};

use base64::Engine as _;
use serde_json::{json, Value};

use super::image::{self, Shot};
use super::{act, keys, Consent, Desktop, Dialog, Where, NO_SESSION, OFF_REASON, STOP_HOTKEY};
use crate::rpc::{self, Reply, Request, Writer};

const BUSY: &str = "Another chat is controlling this computer, or asking to. Stop it first.";
const DECLINED: &str = "The user didn't let Grunt control the computer.";
const UNANSWERED: &str = "Nobody answered the desktop app's question in time, so Grunt didn't take control.";
const NOT_ASKED: &str = "The desktop app couldn't ask whether Grunt may control the computer.";
const STOPPED_FIRST: &str = "Control was stopped before it started, so nothing was started.";
const NO_HOTKEY: &str = "Grunt couldn't register its stop hotkey (Ctrl+Alt+Backspace), so it didn't take control.";
const NO_TOKEN: &str = "Grunt couldn't make a session token, so it didn't take control.";
const UNREADABLE: &str = "The desktop app couldn't read that request.";
const STILL_RUNNING: &str = "An action for that chat had not stopped yet; it was told to stop.";
const NO_CURSOR: &str = "The cursor is not on the screen Grunt last looked at.";
const TOO_BIG: &str = "The screenshot is larger than Grunt can send.";

/// How long things may take. The defaults are the wire's; tests shorten them.
#[derive(Debug, Clone, Copy)]
pub struct Limits {
    /// The start dialog closes itself (as Cancel) after this: the server gives up at 120 s.
    pub dialog: Duration,
    /// A session with no act, screenshot, target or cursor read for this long ends.
    pub idle: Duration,
    pub idle_tick: Duration,
    /// How long an end waits for an act to stop: the server waits 4 s for the answer.
    pub settle: Duration,
    /// An act stops by this: the server waits 60 s.
    pub act: Duration,
    /// Quick-chat hotkey changes are reported after this much quiet.
    pub debounce: Duration,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            dialog: Duration::from_secs(110),
            idle: Duration::from_secs(10 * 60),
            idle_tick: Duration::from_secs(5),
            settle: Duration::from_millis(2500),
            act: Duration::from_secs(55),
            debounce: Duration::from_millis(300),
        }
    }
}

fn locked<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// A chat's live session.
pub struct Live {
    pub chat: String,
    token: String,
    state: Mutex<LiveState>,
    changed: Condvar,
}

struct LiveState {
    ended: bool,
    shot: Option<Shot>,
    last_used: Instant,
    /// Acts for this session that have begun and not answered.
    acting: u32,
    /// The start's yes has been written.
    announced: bool,
    /// A key or button pressed for it may still be down.
    stuck: bool,
}

impl Live {
    fn new(chat: String, token: String) -> Self {
        Self {
            chat,
            token,
            state: Mutex::new(LiveState { ended: false, shot: None, last_used: Instant::now(), acting: 0, announced: false, stuck: false }),
            changed: Condvar::new(),
        }
    }

    fn lock(&self) -> MutexGuard<'_, LiveState> {
        locked(&self.state)
    }

    pub fn ended(&self) -> bool {
        self.lock().ended
    }

    pub fn set_stuck(&self) {
        self.lock().stuck = true;
    }

    fn end(&self) {
        self.lock().ended = true;
        self.changed.notify_all();
    }

    fn announce(&self) {
        self.lock().announced = true;
        self.changed.notify_all();
    }

    fn touch(&self) {
        self.lock().last_used = Instant::now();
    }

    fn shot(&self) -> Option<Shot> {
        self.lock().shot
    }
}

/// An act that has begun for a session: the end waits for it to drop.
struct Acting(Arc<Live>);

impl Drop for Acting {
    fn drop(&mut self) {
        self.0.lock().acting -= 1;
        self.0.changed.notify_all();
    }
}

/// A start whose dialog is up. Its replies (the start, and any further start
/// for the same chat) are answered once, by whoever settles it.
struct Pending {
    chat: String,
    replies: Mutex<Vec<Reply>>,
    cancelled: std::sync::atomic::AtomicBool,
    dialog: Dialog,
}

impl Pending {
    fn cancel(&self) {
        self.cancelled.store(true, std::sync::atomic::Ordering::SeqCst);
        self.dialog.dismiss();
    }

    fn cancelled(&self) -> bool {
        self.cancelled.load(std::sync::atomic::Ordering::SeqCst)
    }

    fn take(&self) -> Vec<Reply> {
        std::mem::take(&mut *locked(&self.replies))
    }

    fn refuse_all(&self, reason: &str) {
        for reply in self.take() {
            reply.ok(json!({ "ok": false, "reason": reason }));
        }
    }
}

struct State {
    /// The channel closed or was lost: nothing more is acted on.
    off: bool,
    sessions: HashMap<String, Arc<Live>>,
    dialogs: HashMap<String, Arc<Pending>>,
    /// Dialogs still on the screen, cancelled ones included.
    on_screen: usize,
}

struct Events {
    hello_done: bool,
    last: Option<Vec<String>>,
}

/// The shell's own UI for a session: the stop hotkey and the indicator.
struct Ui {
    hotkey: bool,
    indicator: bool,
}

/// What a `computer.end` took off the chat, on the reader thread.
struct Taken {
    live: Option<Arc<Live>>,
    pending: Option<Arc<Pending>>,
}

struct Inner {
    shortcuts: Box<dyn Fn() -> Vec<String> + Send + Sync>,
    desktop: Option<Arc<dyn Desktop>>,
    limits: Limits,
    writer: Mutex<Option<Writer>>,
    state: Mutex<State>,
    /// Held while the hello is answered and while any event is written, so no event comes before the hello's answer.
    events: Mutex<Events>,
    ui: Mutex<Ui>,
    /// One act at a time, for the shell as a whole.
    acting: Mutex<()>,
    debounce: Mutex<u64>,
}

/// The shell's side of the channel (rpc.rs hands it every line).
#[derive(Clone)]
pub struct Shell(Arc<Inner>);

impl Shell {
    /// `shortcuts`: the global shortcuts registered besides the stop hotkey
    /// (the quick-chat hotkey). `desktop`: the driver, or `None` while
    /// computer use is switched off.
    pub fn new(shortcuts: impl Fn() -> Vec<String> + Send + Sync + 'static, desktop: Option<Arc<dyn Desktop>>, limits: Limits) -> Self {
        Self(Arc::new(Inner {
            shortcuts: Box::new(shortcuts),
            desktop,
            limits,
            writer: Mutex::new(None),
            state: Mutex::new(State { off: false, sessions: HashMap::new(), dialogs: HashMap::new(), on_screen: 0 }),
            events: Mutex::new(Events { hello_done: false, last: None }),
            ui: Mutex::new(Ui { hotkey: false, indicator: false }),
            acting: Mutex::new(()),
            debounce: Mutex::new(0),
        }))
    }

    /// The quick-chat hotkey changed: the new list is reported after a short
    /// quiet, so a settings screen that re-registers on every keystroke can't
    /// flood the channel.
    pub fn shortcuts_changed(&self) {
        let generation = {
            let mut g = locked(&self.0.debounce);
            *g += 1;
            *g
        };
        let inner = self.0.clone();
        thread::spawn(move || {
            thread::sleep(inner.limits.debounce);
            if *locked(&inner.debounce) == generation {
                inner.report_shortcuts();
            }
        });
    }

    /// The shell ends every session itself: `why` is "hotkey", "button",
    /// "idle" or "quit". Each is ended as `computer.end` would, then the
    /// server is told with `computer.stopped`.
    pub fn stop(&self, why: &str) {
        let (lives, pendings) = {
            let mut st = locked(&self.0.state);
            let lives: Vec<_> = st.sessions.drain().map(|(_, l)| l).collect();
            let pendings: Vec<_> = st.dialogs.drain().map(|(_, p)| p).collect();
            for l in &lives {
                l.end();
            }
            for p in &pendings {
                p.cancel();
            }
            (lives, pendings)
        };
        for p in pendings {
            p.refuse_all(STOPPED_FIRST);
        }
        for l in &lives {
            self.0.stopped(l, why);
        }
        self.0.settle_ui();
        self.0.report_shortcuts();
    }
}

impl rpc::Handler for Shell {
    fn attach(&self, writer: Writer) {
        *locked(&self.0.writer) = Some(writer);
    }

    fn request(&self, request: Request, reply: Reply) {
        self.0.clone().request(request, reply);
    }

    fn notification(&self, method: &str, _params: &Value) -> bool {
        if method == "computer.close" {
            self.0.close_all();
            return true;
        }
        false
    }

    fn lost(&self) {
        self.0.close_all();
    }
}

/// A chat id as the server sends it: a string of 1 to 128 UTF-16 units, compared byte for byte.
fn chat_of(params: &Value) -> Option<String> {
    params.get("chatId").and_then(Value::as_str).filter(|c| !c.is_empty() && c.encode_utf16().count() <= 128).map(str::to_string)
}

/// 256 random bits as 64 lowercase hex digits: within `[A-Za-z0-9_-]{16,128}`, never reused.
fn mint_token() -> Option<String> {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).ok()?;
    Some(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

/// A chat title as the dialog shows it: one plain line, no control, hidden
/// or direction-changing character, at most 80 characters with the ellipsis.
pub fn clean_title(title: &str) -> String {
    let hidden = |c: char| {
        let u = c as u32;
        c.is_control()
            || matches!(u, 0xAD | 0x34F | 0x61C | 0x115F | 0x1160 | 0x17B4 | 0x17B5 | 0x180B..=0x180F | 0x200B..=0x200F | 0x2028..=0x202E | 0x2060..=0x206F)
            || matches!(u, 0x3164 | 0xFE00..=0xFE0F | 0xFEFF | 0xFFA0 | 0xFFF0..=0xFFFB | 0x1D173..=0x1D17A | 0xE0000..=0xE0FFF)
    };
    let plain: String = title.chars().map(|c| if hidden(c) { ' ' } else { c }).collect();
    let line = plain.split_whitespace().collect::<Vec<_>>().join(" ");
    let line = if line.is_empty() { "this chat".to_string() } else { line };
    if line.chars().count() > 80 {
        format!("{}\u{2026}", line.chars().take(79).collect::<String>())
    } else {
        line
    }
}

/// The native dialog's text. The title is the chat's name, untrusted (the
/// model may have written it): plain text, marked as the chat's name, and
/// isolated so its letters can't reorder the rest. It can't change what the
/// buttons say or do (Windows draws them).
pub fn dialog_text(title: &str) -> String {
    format!(
        "Let Grunt control this computer for the chat named '\u{2068}{}\u{2069}'?\n\nIt will ask before using each app. Stop any time with Ctrl+Alt+Backspace.",
        clean_title(title)
    )
}

impl Inner {
    fn state(&self) -> MutexGuard<'_, State> {
        locked(&self.state)
    }

    fn writer(&self) -> Option<Writer> {
        locked(&self.writer).clone()
    }

    /// On the reader thread, in the order the lines came.
    fn request(self: Arc<Self>, request: Request, reply: Reply) {
        if self.state().off {
            return;
        }
        let Request { method, params, .. } = request;
        match method.as_str() {
            "computer.end" => {
                // Before the next line is read: the session is dead and the dialog cancelled.
                let taken = chat_of(&params).map(|chat| self.take(&chat));
                self.spawn(move |me| me.end(taken, reply));
            }
            "computer.hello" | "computer.start" | "computer.screenshot" | "computer.cursor" | "computer.target" | "computer.act" => {
                self.spawn(move |me| me.dispatch(&method, &params, reply));
            }
            _ => reply.err("Unknown method.", None),
        }
    }

    /// Runs on a worker of its own. A worker that can't start drops its reply, which answers it.
    fn spawn(self: &Arc<Self>, work: impl FnOnce(&Arc<Inner>) + Send + 'static) {
        let me = self.clone();
        let _ = thread::Builder::new().name("computer-use".into()).spawn(move || work(&me));
    }

    fn dispatch(self: &Arc<Self>, method: &str, params: &Value, reply: Reply) {
        match method {
            "computer.hello" => self.hello(reply),
            "computer.start" => self.start(params, reply),
            _ => {
                let Some(live) = self.live(params) else {
                    return reply.err(NO_SESSION, Some(rpc::NO_SESSION_CODE));
                };
                let Some(desktop) = self.desktop.clone() else {
                    return reply.err(OFF_REASON, None);
                };
                match method {
                    "computer.screenshot" => self.screenshot(&*desktop, &live, reply),
                    "computer.cursor" => self.cursor(&*desktop, &live, reply),
                    "computer.target" => self.target(&*desktop, &live, params, reply),
                    _ => self.act(&*desktop, live, params, reply),
                }
            }
        }
    }

    /// The chat's live session, when `session` is exactly its token.
    fn live(&self, params: &Value) -> Option<Arc<Live>> {
        let chat = chat_of(params)?;
        let token = params.get("session")?.as_str()?;
        let st = self.state();
        let live = st.sessions.get(&chat)?;
        (live.token.as_bytes() == token.as_bytes() && !live.ended()).then(|| live.clone())
    }

    // ---- hello ----------------------------------------------------------------

    fn hello(&self, reply: Reply) {
        let (lives, pendings) = {
            let mut st = self.state();
            let lives: Vec<_> = st.sessions.drain().map(|(_, l)| l).collect();
            let pendings: Vec<_> = st.dialogs.drain().map(|(_, p)| p).collect();
            for l in &lives {
                l.end();
            }
            for p in &pendings {
                p.cancel();
            }
            (lives, pendings)
        };
        for p in pendings {
            p.refuse_all(STOPPED_FIRST);
        }
        for l in &lives {
            let _ = self.settle(l);
        }
        self.settle_ui();
        // The answer goes out under the events lock: nothing is told before it.
        let mut events = locked(&self.events);
        let list = self.shortcut_list();
        reply.ok(super::hello_result(self.desktop.is_some(), list.clone()));
        events.hello_done = true;
        events.last = Some(list);
    }

    // ---- start ----------------------------------------------------------------

    fn start(self: &Arc<Self>, params: &Value, reply: Reply) {
        let Some(desktop) = self.desktop.clone() else {
            return reply.ok(json!({ "ok": false, "reason": OFF_REASON }));
        };
        let (Some(chat), Some(title)) = (chat_of(params), params.get("title").and_then(Value::as_str)) else {
            return reply.err(UNREADABLE, None);
        };
        let pending = {
            let mut st = self.state();
            if st.off {
                return reply.ok(json!({ "ok": false, "reason": STOPPED_FIRST }));
            }
            // The hot path: the same token at once, no dialog, no event, no idle reset.
            if let Some(live) = st.sessions.get(&chat) {
                let token = live.token.clone();
                drop(st);
                return reply.ok(json!({ "ok": true, "session": token }));
            }
            if st.sessions.keys().any(|c| *c != chat) || st.dialogs.keys().any(|c| *c != chat) || (st.on_screen > 0 && !st.dialogs.contains_key(&chat)) {
                drop(st);
                return reply.ok(json!({ "ok": false, "reason": BUSY }));
            }
            if let Some(pending) = st.dialogs.get(&chat) {
                // One dialog per chat: this start gets the same answer when it comes.
                locked(&pending.replies).push(reply);
                return;
            }
            let pending = Arc::new(Pending { chat: chat.clone(), replies: Mutex::new(vec![reply]), cancelled: false.into(), dialog: Dialog::new(self.limits.dialog) });
            st.dialogs.insert(chat.clone(), pending.clone());
            st.on_screen += 1;
            pending
        };

        // The person, and nobody else, answers this.
        let consent = desktop.consent(&dialog_text(title), &pending.dialog);
        self.state().on_screen -= 1;
        let refused = match consent {
            Consent::Yes if !pending.cancelled() => None,
            Consent::Yes => Some(STOPPED_FIRST),
            Consent::No if pending.cancelled() => Some(STOPPED_FIRST),
            Consent::No if pending.dialog.expired() => Some(UNANSWERED),
            Consent::No => Some(DECLINED),
            Consent::Failed => Some(NOT_ASKED),
        };
        if let Some(reason) = refused {
            return self.refuse_pending(&pending, reason);
        }

        // The shell's side first: the stop hotkey and the indicator.
        {
            let mut ui = locked(&self.ui);
            if !ui.hotkey {
                if desktop.stop_hotkey(true).is_err() {
                    drop(ui);
                    return self.refuse_pending(&pending, NO_HOTKEY);
                }
                ui.hotkey = true;
            }
            desktop.indicator(Some(&clean_title(title)));
            ui.indicator = true;
        }
        let Some(token) = mint_token() else {
            return self.refuse_pending(&pending, NO_TOKEN);
        };
        let live = Arc::new(Live::new(chat.clone(), token.clone()));
        let replies = {
            let mut st = self.state();
            let current = st.dialogs.get(&chat).is_some_and(|p| Arc::ptr_eq(p, &pending));
            if st.off || !current || pending.cancelled() {
                None
            } else {
                st.dialogs.remove(&chat);
                st.sessions.insert(chat.clone(), live.clone());
                Some(pending.take())
            }
        };
        let Some(replies) = replies else {
            // Ended while the shell's side was set up; whoever ended it answered the start.
            self.settle_ui();
            self.report_shortcuts();
            return;
        };
        // The new list (stop hotkey included) before the yes.
        self.report_shortcuts();
        for reply in replies {
            reply.ok(json!({ "ok": true, "session": token }));
        }
        live.announce();
        self.watch_idle(live);
    }

    fn refuse_pending(&self, pending: &Arc<Pending>, reason: &str) {
        {
            let mut st = self.state();
            if st.dialogs.get(&pending.chat).is_some_and(|p| Arc::ptr_eq(p, pending)) {
                st.dialogs.remove(&pending.chat);
            }
        }
        pending.refuse_all(reason);
        self.settle_ui();
        self.report_shortcuts();
    }

    // ---- end ------------------------------------------------------------------

    /// The reader thread's part of an end.
    fn take(&self, chat: &str) -> Taken {
        let mut st = self.state();
        let live = st.sessions.remove(chat);
        if let Some(l) = &live {
            l.end();
        }
        let pending = st.dialogs.remove(chat);
        if let Some(p) = &pending {
            p.cancel();
        }
        Taken { live, pending }
    }

    fn end(&self, taken: Option<Taken>, reply: Reply) {
        let Some(taken) = taken else {
            return reply.err(UNREADABLE, None);
        };
        if let Some(pending) = taken.pending {
            pending.refuse_all(STOPPED_FIRST);
        }
        let outcome = taken.live.as_ref().map_or(Ok(()), |l| self.settle(l));
        self.settle_ui();
        self.report_shortcuts();
        match outcome {
            Ok(()) => reply.ok(json!({ "ok": true })),
            Err(reason) => reply.ok(json!({ "ok": false, "reason": reason })),
        }
    }

    /// Waits for an ended session's start to have answered and its act (if
    /// any) to have stopped and released what it pressed.
    fn settle(&self, live: &Live) -> Result<(), String> {
        let deadline = Instant::now() + self.limits.settle;
        let mut s = live.lock();
        while !s.announced || s.acting > 0 {
            let now = Instant::now();
            if now >= deadline {
                break;
            }
            s = live.changed.wait_timeout(s, deadline - now).unwrap_or_else(|e| e.into_inner()).0;
        }
        if s.acting > 0 {
            return Err(STILL_RUNNING.into());
        }
        if s.stuck {
            return Err(act::STUCK.into());
        }
        Ok(())
    }

    /// Takes the stop hotkey and the indicator away once no chat holds a session or has a dialog up.
    fn settle_ui(&self) {
        let mut ui = locked(&self.ui);
        let idle = {
            let st = self.state();
            st.sessions.is_empty() && st.dialogs.is_empty()
        };
        if !idle {
            return;
        }
        let Some(desktop) = self.desktop.as_ref() else { return };
        if ui.hotkey && desktop.stop_hotkey(false).is_ok() {
            ui.hotkey = false;
        }
        if ui.indicator {
            desktop.indicator(None);
            ui.indicator = false;
        }
    }

    /// The shell ended a session itself: everything an end does, then `computer.stopped`.
    fn stopped(&self, live: &Arc<Live>, why: &str) {
        let _ = self.settle(live);
        self.settle_ui();
        self.report_shortcuts();
        self.event("computer.stopped", json!({ "chatId": live.chat, "why": why }));
    }

    /// `computer.close`, or the pipes are gone: end everything at once and act on nothing more.
    fn close_all(self: &Arc<Self>) {
        let (lives, pendings) = {
            let mut st = self.state();
            if st.off {
                return;
            }
            st.off = true;
            let lives: Vec<_> = st.sessions.drain().map(|(_, l)| l).collect();
            let pendings: Vec<_> = st.dialogs.drain().map(|(_, p)| p).collect();
            for l in &lives {
                l.end();
            }
            for p in &pendings {
                p.cancel();
            }
            (lives, pendings)
        };
        self.spawn(move |me| {
            for p in pendings {
                p.refuse_all(STOPPED_FIRST);
            }
            for l in &lives {
                let _ = me.settle(l);
            }
            me.settle_ui();
        });
    }

    fn watch_idle(self: &Arc<Self>, live: Arc<Live>) {
        let me = self.clone();
        thread::spawn(move || loop {
            thread::sleep(me.limits.idle_tick);
            {
                let s = live.lock();
                if s.ended {
                    return;
                }
                if s.last_used.elapsed() < me.limits.idle {
                    continue;
                }
            }
            let mine = {
                let mut st = me.state();
                let current = st.sessions.get(&live.chat).is_some_and(|l| Arc::ptr_eq(l, &live));
                if current {
                    st.sessions.remove(&live.chat);
                    live.end();
                }
                current
            };
            if mine {
                me.stopped(&live, "idle");
            }
            return;
        });
    }

    // ---- events ---------------------------------------------------------------

    /// The shell's registered shortcuts now: the quick-chat hotkey, and the stop hotkey while it is registered.
    fn shortcut_list(&self) -> Vec<String> {
        let mut list = (self.shortcuts)();
        if locked(&self.ui).hotkey {
            list.push(STOP_HOTKEY.to_string());
        }
        list.truncate(64);
        list
    }

    /// Every shortcut a `key` action may not press: the stop hotkey whether or not it is registered.
    fn own_shortcuts(&self) -> Vec<String> {
        let mut list = (self.shortcuts)();
        list.push(STOP_HOTKEY.to_string());
        list
    }

    fn report_shortcuts(&self) {
        let mut events = locked(&self.events);
        if !events.hello_done {
            return;
        }
        let list = self.shortcut_list();
        if events.last.as_ref() == Some(&list) {
            return;
        }
        if let Some(w) = self.writer() {
            w.event("computer.shortcuts", &json!({ "shortcuts": list }));
        }
        events.last = Some(list);
    }

    fn event(&self, name: &str, params: Value) {
        let events = locked(&self.events);
        if !events.hello_done {
            return;
        }
        if let Some(w) = self.writer() {
            w.event(name, &params);
        }
    }

    // ---- looking ----------------------------------------------------------------

    fn screenshot(&self, desktop: &dyn Desktop, live: &Live, reply: Reply) {
        live.touch();
        let capture = match desktop.capture(image::MAX_SHOT) {
            Ok(c) => c,
            Err(e) => return reply.err(&e, None),
        };
        let png = match image::encode_png(&capture.bgra, capture.width, capture.height) {
            Ok(p) => p,
            Err(e) => return reply.err(&e, None),
        };
        if png.len() > image::MAX_PNG_BYTES {
            return reply.err(TOO_BIG, None);
        }
        let shot = Shot { width: capture.width, height: capture.height, screen_w: capture.screen_w, screen_h: capture.screen_h };
        {
            let mut s = live.lock();
            if s.ended {
                drop(s);
                return reply.err(NO_SESSION, Some(rpc::NO_SESSION_CODE));
            }
            s.shot = Some(shot);
        }
        reply.ok(json!({ "png": base64::engine::general_purpose::STANDARD.encode(&png), "width": shot.width, "height": shot.height }));
    }

    fn cursor(&self, desktop: &dyn Desktop, live: &Live, reply: Reply) {
        live.touch();
        let Some(shot) = live.shot() else {
            return reply.err(NO_CURSOR, None);
        };
        let same_screen = desktop.screen_size().is_ok_and(|s| s == (shot.screen_w, shot.screen_h));
        match desktop.cursor() {
            Ok((x, y)) if same_screen => match shot.from_screen(x, y) {
                Some((x, y)) => reply.ok(json!({ "x": x, "y": y })),
                None => reply.err(NO_CURSOR, None),
            },
            _ => reply.err(NO_CURSOR, None),
        }
    }

    fn target(&self, desktop: &dyn Desktop, live: &Live, params: &Value, reply: Reply) {
        live.touch();
        let refuse = |reply: Reply, why: &str| reply.ok(json!({ "refuse": why }));
        let at = if params.get("foreground") == Some(&Value::Bool(true)) {
            Where::Foreground
        } else {
            let Some(shot) = live.shot() else {
                return refuse(reply, "Take a screenshot first.");
            };
            let (Some(x), Some(y)) = (params.get("x").and_then(Value::as_i64), params.get("y").and_then(Value::as_i64)) else {
                return refuse(reply, "That point is not inside the last screenshot.");
            };
            if !shot.contains(x, y) {
                return refuse(reply, "That point is not inside the last screenshot.");
            }
            if !desktop.screen_size().is_ok_and(|s| s == (shot.screen_w, shot.screen_h)) {
                return refuse(reply, "The screen changed size since the last screenshot; take another.");
            }
            let (sx, sy) = shot.to_screen(x as u32, y as u32);
            Where::Point(sx, sy)
        };
        match desktop.facts(&at) {
            Ok(facts) => reply.ok(facts.to_json()),
            Err(why) => refuse(reply, &why),
        }
    }

    // ---- acting ---------------------------------------------------------------------

    fn act(&self, desktop: &dyn Desktop, live: Arc<Live>, params: &Value, reply: Reply) {
        let refuse = |reply: Reply, why: &str| reply.ok(json!({ "ok": false, "reason": why }));
        // Counted before anything else, so an end waits for this act's answer.
        {
            let mut s = live.lock();
            if s.ended {
                drop(s);
                return refuse(reply, act::STOPPED);
            }
            s.acting += 1;
            s.last_used = Instant::now();
        }
        let _acting = Acting(live.clone());
        let (action, expect) = match act::parse(params, live.shot()) {
            Ok(parsed) => parsed,
            Err(why) => return refuse(reply, &why),
        };
        if let act::Action::Key { combo } = &action {
            if let Err(why) = keys::refuse_own(combo, &self.own_shortcuts()) {
                return refuse(reply, &why);
            }
        }
        let _one = locked(&self.acting);
        if live.ended() {
            return refuse(reply, act::STOPPED);
        }
        live.touch();
        let deadline = Instant::now() + self.limits.act;
        match act::run(desktop, &live, &action, &expect, live.shot(), deadline) {
            Ok(()) => {
                desktop.indicator_action(&act::label(&action));
                reply.ok(json!({ "ok": true }));
            }
            Err(why) => refuse(reply, &why),
        }
    }
}

#[cfg(test)]
mod tests;
