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
//!   kept apart. No dialog is shown while an act is still pressing.
//! - The reader thread does each request's bookkeeping before it reads the
//!   next line. A start is admitted there (its pending entry exists before
//!   any dialog is shown), and an end marks the chat's session dead and its
//!   start cancelled there (`take`), so any later request for the chat is
//!   `no-session` whichever worker runs it, and a start it overtook never
//!   shows its dialog.
//! - Input is only sent while the session is held and after a last look
//!   (act.rs `Press`), so nothing is pressed once an end has been read. The
//!   end waits (at most `Limits::settle`) for the act to say it stopped and
//!   for the start that made the session to have said yes, then answers:
//!   `{ ok: true }` only when both happened and nothing is left down. The
//!   shell's own UI (the stop hotkey, the indicator, the tray) is put away
//!   after the answer, never before it.
//! - Events go out only after the hello's answer: `computer.shortcuts`
//!   whenever the list changes (before the start's yes that registered the
//!   stop hotkey), `computer.stopped` only for the shell's own ends.
//! - The shell's UI calls go to the main thread and are time-bounded; they
//!   are made one at a time (`ui_ops`) and never under a lock that the main
//!   thread or the reader thread takes.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Condvar, Mutex, MutexGuard};
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
const NO_INDICATOR: &str = "Grunt couldn't show that it is controlling the computer, so it didn't take control.";
const NO_TOKEN: &str = "Grunt couldn't make a session token, so it didn't take control.";
const UNREADABLE: &str = "The desktop app couldn't read that request.";
const STILL_RUNNING: &str = "An action for that chat had not stopped yet; it was told to stop.";
const NOT_ANNOUNCED: &str = "The start of that session had not finished yet; it was ended.";
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
            settle: Duration::from_millis(3000),
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

    /// Runs `work` (a last look and one send) while the session is held and
    /// not ended: an end that comes meanwhile waits for it, and once an end
    /// has been read nothing runs. `work` must be quick and must not touch
    /// this session.
    pub fn while_live<T>(&self, work: impl FnOnce() -> Result<T, String>) -> Result<T, String> {
        let s = self.lock();
        if s.ended {
            return Err(act::STOPPED.into());
        }
        let out = work();
        drop(s);
        out
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

/// An act that has begun for a session: the end waits for it to drop, which
/// is its word that it stopped and released what it pressed.
struct Acting(Arc<Live>);

impl Drop for Acting {
    fn drop(&mut self) {
        self.0.lock().acting -= 1;
        self.0.changed.notify_all();
    }
}

/// A start admitted and not yet settled (its dialog may not be up yet). Its
/// replies (the start, and any further start for the same chat) are
/// answered once, by whoever settles it.
struct Pending {
    chat: String,
    title: String,
    replies: Mutex<Vec<Reply>>,
    cancelled: AtomicBool,
    dialog: Dialog,
}

impl Pending {
    fn cancel(&self) {
        self.cancelled.store(true, Ordering::SeqCst);
        self.dialog.dismiss();
    }

    fn cancelled(&self) -> bool {
        self.cancelled.load(Ordering::SeqCst)
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
    /// Starts admitted and not yet settled, one per chat.
    dialogs: HashMap<String, Arc<Pending>>,
    /// Starts whose dialog may still be on the screen, cancelled ones included.
    on_screen: usize,
}

struct Events {
    hello_done: bool,
    last: Option<Vec<String>>,
}

/// What the shell believes about its own UI. Only ever locked briefly, never
/// across a `Desktop` call.
struct Ui {
    hotkey: bool,
    indicator: bool,
    /// A hotkey call failed or timed out, so its state is unknown: the next
    /// start or clean-up unregisters it again.
    unsure: bool,
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
    /// The shell's UI changes, one at a time. Held across `Desktop` UI calls
    /// (each time-bounded), and only ever on a worker thread: never by the
    /// reader, the main thread, or an end before it answers.
    ui_ops: Mutex<()>,
    /// One act at a time, for the shell as a whole; also held while a start's dialog is up.
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
            ui: Mutex::new(Ui { hotkey: false, indicator: false, unsure: false }),
            ui_ops: Mutex::new(()),
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
    /// "idle" or "quit". Each is ended as `computer.end` would (dead, its act
    /// stopped and released), then the server is told with
    /// `computer.stopped`, and then the UI is put away, as after an end's
    /// answer. (On quit the main thread waits only briefly, so the server must
    /// hear before the UI calls that need it.)
    pub fn stop(&self, why: &str) {
        let (lives, pendings) = self.0.take_all();
        for p in pendings {
            p.refuse_all(STOPPED_FIRST);
        }
        for l in &lives {
            let _ = self.0.settle(l);
        }
        for l in &lives {
            self.0.event("computer.stopped", json!({ "chatId": l.chat, "why": why }));
        }
        self.0.clean_up();
    }

    /// `stop("quit")` on a thread of its own, waited for at most `wait`: a
    /// worker holding the UI can't keep the caller (the main thread, quitting) waiting.
    pub fn shutdown(&self, wait: Duration) {
        let (tx, rx) = mpsc::channel();
        let shell = self.clone();
        thread::spawn(move || {
            shell.stop("quit");
            let _ = tx.send(());
        });
        let _ = rx.recv_timeout(wait);
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
                // Before the next line is read: the session is dead and the start cancelled.
                let taken = chat_of(&params).map(|chat| self.take(&chat));
                self.spawn(move |me| me.end(taken, reply));
            }
            "computer.start" => self.admit(&params, reply),
            "computer.hello" | "computer.screenshot" | "computer.cursor" | "computer.target" | "computer.act" => {
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
        if method == "computer.hello" {
            return self.hello(reply);
        }
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

    /// The chat's live session, when `session` is exactly its token.
    fn live(&self, params: &Value) -> Option<Arc<Live>> {
        let chat = chat_of(params)?;
        let token = params.get("session")?.as_str()?;
        let st = self.state();
        let live = st.sessions.get(&chat)?;
        (live.token.as_bytes() == token.as_bytes() && !live.ended()).then(|| live.clone())
    }

    /// Every session ended and every start cancelled, at once.
    fn take_all(&self) -> (Vec<Arc<Live>>, Vec<Arc<Pending>>) {
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
    }

    // ---- hello ----------------------------------------------------------------

    fn hello(&self, reply: Reply) {
        let (lives, pendings) = self.take_all();
        for p in pendings {
            p.refuse_all(STOPPED_FIRST);
        }
        for l in &lives {
            let _ = self.settle(l);
        }
        self.clean_up();
        // The answer goes out under the events lock: nothing is told before it.
        let mut events = locked(&self.events);
        let list = self.shortcut_list();
        reply.ok(super::hello_result(self.desktop.is_some(), list.clone()));
        events.hello_done = true;
        events.last = Some(list);
    }

    // ---- start ----------------------------------------------------------------

    /// The reader thread's part of a start: answered at once (off, unreadable,
    /// the hot path, busy), joined to the chat's start already admitted, or
    /// admitted as a new one whose dialog a worker shows.
    fn admit(self: &Arc<Self>, params: &Value, reply: Reply) {
        if self.desktop.is_none() {
            return reply.ok(json!({ "ok": false, "reason": OFF_REASON }));
        }
        let (Some(chat), Some(title)) = (chat_of(params), params.get("title").and_then(Value::as_str)) else {
            return reply.err(UNREADABLE, None);
        };
        let mut st = self.state();
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
        let pending = Arc::new(Pending {
            chat: chat.clone(),
            title: title.to_string(),
            replies: Mutex::new(vec![reply]),
            cancelled: AtomicBool::new(false),
            dialog: Dialog::new(self.limits.dialog),
        });
        st.dialogs.insert(chat, pending.clone());
        st.on_screen += 1;
        drop(st);
        self.spawn(move |me| me.ask(pending));
    }

    /// The worker's part of a start: the dialog, then the session.
    fn ask(self: &Arc<Self>, pending: Arc<Pending>) {
        let Some(desktop) = self.desktop.clone() else { return };
        // No dialog while an act (of a session that has just ended) is still pressing.
        let no_acts = locked(&self.acting);
        // The person, and nobody else, answers this; a start already ended shows nothing.
        let consent = if pending.cancelled() { Consent::No } else { desktop.consent(&dialog_text(&pending.title), &pending.dialog) };
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
            drop(no_acts);
            return self.refuse_pending(&pending, reason);
        }
        // The shell's side first: the stop hotkey and the indicator, both confirmed.
        if let Err(reason) = self.show_controls(&*desktop, &pending.title) {
            drop(no_acts);
            return self.refuse_pending(&pending, reason);
        }
        let Some(token) = mint_token() else {
            drop(no_acts);
            return self.refuse_pending(&pending, NO_TOKEN);
        };
        let live = Arc::new(Live::new(pending.chat.clone(), token.clone()));
        let replies = {
            let mut st = self.state();
            let current = st.dialogs.get(&pending.chat).is_some_and(|p| Arc::ptr_eq(p, &pending));
            if st.off || !current || pending.cancelled() {
                None
            } else {
                st.dialogs.remove(&pending.chat);
                st.sessions.insert(pending.chat.clone(), live.clone());
                Some(pending.take())
            }
        };
        drop(no_acts);
        let Some(replies) = replies else {
            // Ended while the shell's side was set up; whoever ended it answered the start.
            return self.clean_up();
        };
        // The new list (stop hotkey included) before the yes.
        self.report_shortcuts();
        for reply in replies {
            reply.ok(json!({ "ok": true, "session": token }));
        }
        live.announce();
        self.watch_idle(live);
    }

    /// Registers the stop hotkey (after unregistering one whose state is
    /// unknown) and shows the indicator; either failing refuses the start.
    fn show_controls(&self, desktop: &dyn Desktop, title: &str) -> Result<(), &'static str> {
        let _ops = locked(&self.ui_ops);
        let (registered, unsure) = {
            let ui = locked(&self.ui);
            (ui.hotkey, ui.unsure)
        };
        if registered || unsure {
            let gone = desktop.stop_hotkey(false).is_ok();
            let mut ui = locked(&self.ui);
            ui.hotkey = !gone && registered;
            ui.unsure = !gone;
        }
        if desktop.stop_hotkey(true).is_err() {
            // Maybe registered after all (a late answer): the next clean-up unregisters it.
            locked(&self.ui).unsure = true;
            return Err(NO_HOTKEY);
        }
        locked(&self.ui).hotkey = true;
        if desktop.indicator(&clean_title(title)).is_err() {
            desktop.hide_indicator();
            locked(&self.ui).indicator = false;
            return Err(NO_INDICATOR);
        }
        locked(&self.ui).indicator = true;
        Ok(())
    }

    fn refuse_pending(&self, pending: &Arc<Pending>, reason: &str) {
        {
            let mut st = self.state();
            if st.dialogs.get(&pending.chat).is_some_and(|p| Arc::ptr_eq(p, pending)) {
                st.dialogs.remove(&pending.chat);
            }
        }
        pending.refuse_all(reason);
        self.clean_up();
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

    /// Answers once the act has stopped and released, then puts the shell's UI away.
    fn end(self: &Arc<Self>, taken: Option<Taken>, reply: Reply) {
        let Some(taken) = taken else {
            return reply.err(UNREADABLE, None);
        };
        if let Some(pending) = taken.pending {
            pending.refuse_all(STOPPED_FIRST);
        }
        match taken.live.as_ref().map_or(Ok(()), |l| self.settle(l)) {
            Ok(()) => reply.ok(json!({ "ok": true })),
            Err(reason) => reply.ok(json!({ "ok": false, "reason": reason })),
        }
        self.clean_up();
    }

    /// Waits for an ended session's start to have answered and its act (if
    /// any) to have stopped and released what it pressed. Err when either
    /// didn't happen in time, or a key may still be down.
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
        if !s.announced {
            return Err(NOT_ANNOUNCED.into());
        }
        if s.stuck {
            return Err(act::STUCK.into());
        }
        Ok(())
    }

    /// Once no chat holds a session or has a start admitted: unregisters the
    /// stop hotkey (also when its state is unknown, which reconciles a late
    /// answer) and takes the indicator away, then reports the shortcuts.
    fn clean_up(&self) {
        if let Some(desktop) = self.desktop.as_ref() {
            let _ops = locked(&self.ui_ops);
            let idle = {
                let st = self.state();
                st.sessions.is_empty() && st.dialogs.is_empty()
            };
            let (hotkey, indicator) = {
                let ui = locked(&self.ui);
                (ui.hotkey || ui.unsure, ui.indicator)
            };
            if idle && hotkey {
                let gone = desktop.stop_hotkey(false).is_ok();
                let mut ui = locked(&self.ui);
                if gone {
                    ui.hotkey = false;
                }
                ui.unsure = !gone;
            }
            if idle && indicator {
                desktop.hide_indicator();
                locked(&self.ui).indicator = false;
            }
        }
        self.report_shortcuts();
    }

    /// `computer.close`, or the pipes are gone: end everything at once, act on
    /// nothing more, and say computer use is off until Grunt restarts.
    fn close_all(self: &Arc<Self>) {
        {
            let mut st = self.state();
            if st.off {
                return;
            }
            st.off = true;
        }
        let (lives, pendings) = self.take_all();
        self.spawn(move |me| {
            for p in pendings {
                p.refuse_all(STOPPED_FIRST);
            }
            for l in &lives {
                let _ = me.settle(l);
            }
            me.clean_up();
            if let Some(desktop) = me.desktop.as_ref() {
                desktop.channel_off();
            }
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
                let _ = me.settle(&live);
                me.event("computer.stopped", json!({ "chatId": live.chat, "why": "idle" }));
                me.clean_up();
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
        let read = desktop.cursor();
        if live.ended() {
            // An end came while it was read: abandoned, as a queued request is.
            return reply.err(NO_SESSION, Some(rpc::NO_SESSION_CODE));
        }
        match read {
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
        let found = desktop.facts(&at);
        if live.ended() {
            // An end came while it was looked up: abandoned, as a queued request is.
            return reply.err(NO_SESSION, Some(rpc::NO_SESSION_CODE));
        }
        match found {
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
