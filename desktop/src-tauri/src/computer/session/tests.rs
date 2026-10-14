//! The shell's side of the wire, against a fake desktop that touches nothing
//! (no window, no key, no screen): shell-wire-spec.md section 10, items 1-10.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};

use super::*;
use crate::computer::facts::{Facts, Identity, Location};
use crate::computer::{Capture, Input, Keyboard};
use crate::rpc::tests::{writer, Sink};
use crate::rpc::Handler;

const QUICK: &str = "Ctrl+Shift+Space";

fn app() -> Identity {
    Identity {
        path: "C:\\Program Files\\Fake App\\FakeApp.exe".into(),
        shell_view: false,
        window_id: "100".into(),
        pid: 7,
        started_at: "133".into(),
        title: "Fake App".into(),
    }
}

fn grunt() -> Identity {
    Identity {
        path: "C:\\Program Files\\Grunt\\grunt-desktop.exe".into(),
        shell_view: false,
        window_id: "900".into(),
        pid: 9,
        started_at: "1".into(),
        title: "Grunt".into(),
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Mode {
    Yes,
    No,
    Fail,
    /// Wait for `answer`, or until the dialog must close.
    Hold,
}

struct Fake {
    mode: Mutex<Mode>,
    answer: Mutex<Option<Consent>>,
    dialogs: Mutex<Vec<String>>,
    dialog_closed: AtomicBool,
    hotkey: Mutex<Vec<bool>>,
    hotkey_fails: AtomicBool,
    indicator: Mutex<Vec<Option<String>>>,
    labels: Mutex<Vec<String>>,
    screen: Mutex<(u32, u32)>,
    capture_size: Mutex<Option<(u32, u32)>>,
    captures: AtomicUsize,
    cursor: Mutex<(i32, i32)>,
    at_point: Mutex<Identity>,
    foreground: Mutex<Identity>,
    window: Mutex<Option<Identity>>,
    activate_works: AtomicBool,
    activated: Mutex<Vec<String>>,
    looks: AtomicUsize,
    keyboard: Mutex<Keyboard>,
    sent: Mutex<Vec<Input>>,
    sends: AtomicUsize,
    /// How many events each send call takes, call by call (when empty: all).
    take: Mutex<VecDeque<usize>>,
    /// After this many send calls, every lookup sees this window instead.
    change_after: Mutex<Option<(usize, Identity)>>,
    send_delay: Mutex<Duration>,
    in_send: AtomicUsize,
    overlap: AtomicBool,
    moves: Mutex<Vec<(i32, i32)>>,
    /// A slow window lookup, and what happens in the world while it is slow (after the delay).
    identity_delay: Mutex<Duration>,
    on_identity: Mutex<Option<Box<dyn Fn(&Fake) + Send + Sync>>>,
    /// The shell's own UI (hotkey, indicator) takes this long.
    ui_delay: Mutex<Duration>,
    /// How many sends were under way when each dialog was shown.
    in_send_at_dialog: Mutex<Vec<usize>>,
    /// Every send call's events, as taken.
    batches: Mutex<Vec<Vec<Input>>>,
    indicator_fails: AtomicBool,
    channel_off: AtomicBool,
}

impl Fake {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            mode: Mutex::new(Mode::Yes),
            answer: Mutex::new(None),
            dialogs: Mutex::new(Vec::new()),
            dialog_closed: AtomicBool::new(false),
            hotkey: Mutex::new(Vec::new()),
            hotkey_fails: AtomicBool::new(false),
            indicator: Mutex::new(Vec::new()),
            labels: Mutex::new(Vec::new()),
            screen: Mutex::new((1366, 768)),
            capture_size: Mutex::new(None),
            captures: AtomicUsize::new(0),
            cursor: Mutex::new((10, 20)),
            at_point: Mutex::new(app()),
            foreground: Mutex::new(app()),
            window: Mutex::new(Some(app())),
            activate_works: AtomicBool::new(true),
            activated: Mutex::new(Vec::new()),
            looks: AtomicUsize::new(0),
            keyboard: Mutex::new(Keyboard::Clear),
            sent: Mutex::new(Vec::new()),
            sends: AtomicUsize::new(0),
            take: Mutex::new(VecDeque::new()),
            change_after: Mutex::new(None),
            send_delay: Mutex::new(Duration::ZERO),
            in_send: AtomicUsize::new(0),
            overlap: AtomicBool::new(false),
            moves: Mutex::new(Vec::new()),
            identity_delay: Mutex::new(Duration::ZERO),
            on_identity: Mutex::new(None),
            ui_delay: Mutex::new(Duration::ZERO),
            in_send_at_dialog: Mutex::new(Vec::new()),
            batches: Mutex::new(Vec::new()),
            indicator_fails: AtomicBool::new(false),
            channel_off: AtomicBool::new(false),
        })
    }

    fn sent(&self) -> Vec<Input> {
        self.sent.lock().unwrap().clone()
    }

    fn lookup(&self, at: &Where) -> Identity {
        if let Some((after, id)) = self.change_after.lock().unwrap().clone() {
            if self.sends.load(Ordering::SeqCst) >= after {
                return id;
            }
        }
        match at {
            Where::Point(..) => self.at_point.lock().unwrap().clone(),
            Where::Foreground => self.foreground.lock().unwrap().clone(),
            Where::Window(_) => unreachable!(),
        }
    }
}

impl Desktop for Fake {
    fn consent(&self, text: &str, dialog: &Dialog) -> Consent {
        self.dialogs.lock().unwrap().push(text.to_string());
        self.in_send_at_dialog.lock().unwrap().push(self.in_send.load(Ordering::SeqCst));
        let mode = *self.mode.lock().unwrap();
        let answer = match mode {
            Mode::Yes => Consent::Yes,
            Mode::No => Consent::No,
            Mode::Fail => Consent::Failed,
            Mode::Hold => loop {
                if dialog.should_close() {
                    self.dialog_closed.store(true, Ordering::SeqCst);
                    break Consent::No;
                }
                if let Some(a) = self.answer.lock().unwrap().take() {
                    break a;
                }
                thread::sleep(Duration::from_millis(2));
            },
        };
        answer
    }
    fn stop_hotkey(&self, on: bool) -> Result<(), String> {
        thread::sleep(*self.ui_delay.lock().unwrap());
        if on && self.hotkey_fails.load(Ordering::SeqCst) {
            return Err("taken".into());
        }
        self.hotkey.lock().unwrap().push(on);
        Ok(())
    }
    fn indicator(&self, title: &str) -> Result<(), String> {
        thread::sleep(*self.ui_delay.lock().unwrap());
        if self.indicator_fails.load(Ordering::SeqCst) {
            return Err("no window".into());
        }
        self.indicator.lock().unwrap().push(Some(title.to_string()));
        Ok(())
    }
    fn hide_indicator(&self) {
        thread::sleep(*self.ui_delay.lock().unwrap());
        self.indicator.lock().unwrap().push(None);
    }
    fn channel_off(&self) {
        self.channel_off.store(true, Ordering::SeqCst);
    }
    fn indicator_action(&self, label: &str) {
        self.labels.lock().unwrap().push(label.to_string());
    }
    fn capture(&self, max: (u32, u32)) -> Result<Capture, String> {
        self.captures.fetch_add(1, Ordering::SeqCst);
        let (sw, sh) = *self.screen.lock().unwrap();
        let forced = *self.capture_size.lock().unwrap();
        let (w, h) = forced.unwrap_or_else(|| image::fit(sw, sh, max));
        // A forced size is noise, so it doesn't compress below the limit; the rest is blank (quick to encode).
        let mut seed = 0x2545_F491_u32;
        let bgra = if forced.is_some() {
            (0..w * h * 4)
                .map(|_| {
                    seed ^= seed << 13;
                    seed ^= seed >> 17;
                    seed ^= seed << 5;
                    seed as u8
                })
                .collect()
        } else {
            vec![0; (w * h * 4) as usize]
        };
        Ok(Capture { bgra, width: w, height: h, screen_w: sw, screen_h: sh })
    }
    fn screen_size(&self) -> Result<(u32, u32), String> {
        Ok(*self.screen.lock().unwrap())
    }
    fn cursor(&self) -> Result<(i32, i32), String> {
        Ok(*self.cursor.lock().unwrap())
    }
    fn facts(&self, at: &Where) -> Result<Facts, String> {
        self.looks.fetch_add(1, Ordering::SeqCst);
        Ok(Facts {
            id: self.lookup(at),
            original_name: Some(Some("FakeApp.exe".into())),
            signer: Some("Fake Corp".into()),
            console: Some(false),
            location: Location::Fixed,
            elevated: false,
            ui_access: false,
            grunt: Some(false),
        })
    }
    fn identity(&self, at: &Where) -> Result<Identity, String> {
        self.looks.fetch_add(1, Ordering::SeqCst);
        if let Where::Window(id) = at {
            return self.window.lock().unwrap().clone().filter(|w| &w.window_id == id).ok_or_else(|| "gone".into());
        }
        let looked = self.lookup(at);
        thread::sleep(*self.identity_delay.lock().unwrap());
        if let Some(hook) = self.on_identity.lock().unwrap().as_ref() {
            hook(self);
        }
        Ok(looked)
    }
    fn activate(&self, window_id: &str) -> bool {
        self.activated.lock().unwrap().push(window_id.to_string());
        if !self.activate_works.load(Ordering::SeqCst) {
            return false;
        }
        if let Some(w) = self.window.lock().unwrap().clone() {
            *self.foreground.lock().unwrap() = w;
        }
        true
    }
    fn keyboard(&self) -> Keyboard {
        *self.keyboard.lock().unwrap()
    }
    fn move_to(&self, x: i32, y: i32) -> Result<(), String> {
        self.moves.lock().unwrap().push((x, y));
        *self.cursor.lock().unwrap() = (x, y);
        Ok(())
    }
    fn send(&self, inputs: &[Input]) -> usize {
        if self.in_send.fetch_add(1, Ordering::SeqCst) > 0 {
            self.overlap.store(true, Ordering::SeqCst);
        }
        let delay = *self.send_delay.lock().unwrap();
        thread::sleep(delay);
        let n = self.take.lock().unwrap().pop_front().map_or(inputs.len(), |t| t.min(inputs.len()));
        self.sent.lock().unwrap().extend_from_slice(&inputs[..n]);
        self.batches.lock().unwrap().push(inputs[..n].to_vec());
        for event in &inputs[..n] {
            if let Input::MoveTo { x, y } = event {
                *self.cursor.lock().unwrap() = (*x, *y);
            }
        }
        self.sends.fetch_add(1, Ordering::SeqCst);
        self.in_send.fetch_sub(1, Ordering::SeqCst);
        n
    }
}

fn limits() -> Limits {
    Limits {
        dialog: Duration::from_secs(5),
        idle: Duration::from_secs(60),
        idle_tick: Duration::from_millis(10),
        settle: Duration::from_millis(1500),
        act: Duration::from_secs(10),
        debounce: Duration::from_millis(20),
    }
}

struct H {
    shell: Shell,
    fake: Arc<Fake>,
    w: Writer,
    sink: Sink,
    next: AtomicU64,
}

impl H {
    fn new() -> Self {
        Self::with(Fake::new(), limits())
    }

    fn with(fake: Arc<Fake>, limits: Limits) -> Self {
        let shell = Shell::new(|| vec![QUICK.to_string()], Some(fake.clone() as Arc<dyn Desktop>), limits);
        let (w, sink) = writer();
        shell.attach(w.clone());
        Self { shell, fake, w, sink, next: AtomicU64::new(1) }
    }

    fn send(&self, method: &str, params: Value) -> u64 {
        let id = self.next.fetch_add(1, Ordering::SeqCst);
        self.shell.request(Request { id, method: method.into(), params }, Reply::new(id, self.w.clone()));
        id
    }

    /// The position of the answer to `id` among every line written, and the answer.
    fn answer_at(&self, id: u64) -> (usize, Value) {
        let until = Instant::now() + Duration::from_secs(5);
        loop {
            let all = self.sink.messages();
            if let Some(at) = all.iter().position(|m| m.get("id") == Some(&json!(id))) {
                assert_eq!(all.iter().filter(|m| m.get("id") == Some(&json!(id))).count(), 1, "answered twice: {id}");
                return (at, all[at].clone());
            }
            assert!(Instant::now() < until, "no answer to {id}: {all:?}");
            thread::sleep(Duration::from_millis(2));
        }
    }

    fn answer(&self, id: u64) -> Value {
        self.answer_at(id).1
    }

    fn result(&self, id: u64) -> Value {
        let a = self.answer(id);
        a.get("result").cloned().unwrap_or_else(|| panic!("not a result: {a}"))
    }

    fn call(&self, method: &str, params: Value) -> Value {
        let id = self.send(method, params);
        self.answer(id)
    }

    fn events(&self, name: &str) -> Vec<Value> {
        self.sink.messages().into_iter().filter(|m| m["event"] == json!(name)).map(|m| m["params"].clone()).collect()
    }

    fn hello(&self) -> Value {
        let a = self.call("computer.hello", json!({}));
        a["result"].clone()
    }

    fn start(&self, chat: &str) -> String {
        let r = self.result(self.send("computer.start", json!({ "chatId": chat, "title": "Budget" })));
        assert_eq!(r["ok"], json!(true), "{r}");
        r["session"].as_str().unwrap().to_string()
    }

    fn shot(&self, chat: &str, token: &str) -> Value {
        self.call("computer.screenshot", json!({ "chatId": chat, "session": token }))
    }

    fn act(&self, chat: &str, token: &str, action: Value) -> Value {
        self.result(self.send("computer.act", json!({ "chatId": chat, "session": token, "action": action, "expect": expect(&app()) })))
    }
}

fn expect(id: &Identity) -> Value {
    json!({ "app": id.path, "shellView": id.shell_view, "windowId": id.window_id, "pid": id.pid, "startedAt": id.started_at })
}

fn no_session(a: &Value) -> bool {
    a["error"] == json!({ "message": NO_SESSION, "code": "no-session" })
}

fn wait_for(what: &str, ok: impl Fn() -> bool) {
    let until = Instant::now() + Duration::from_secs(5);
    while !ok() {
        assert!(Instant::now() < until, "timed out waiting for {what}");
        thread::sleep(Duration::from_millis(2));
    }
}

/// A left click's batch: each button event right after an absolute move to the point.
fn click_at(x: i32, y: i32) -> Vec<Input> {
    vec![Input::MoveTo { x, y }, Input::Button { right: false, up: false }, Input::MoveTo { x, y }, Input::Button { right: false, up: true }]
}

/// Every key or button down in `sent` has its up after it, and nothing is left down.
fn balanced(sent: &[Input]) -> bool {
    let mut down: Vec<Input> = Vec::new();
    for e in sent {
        if e.release().is_some() {
            down.push(*e);
        } else if e.is_up() {
            match down.iter().rposition(|d| d.release() == Some(*e)) {
                Some(at) => {
                    down.remove(at);
                }
                None => return false,
            }
        }
    }
    down.is_empty()
}

// 1 --------------------------------------------------------------------------

#[test]
fn an_unknown_method_gets_an_error_with_its_id() {
    let h = H::new();
    assert_eq!(h.call("computer.dance", json!({})), json!({ "id": 1, "error": { "message": "Unknown method." } }));
}

// 2 --------------------------------------------------------------------------

#[test]
fn hello_answers_every_field_and_no_event_comes_before_it() {
    let h = H::new();
    h.shell.shortcuts_changed();
    thread::sleep(Duration::from_millis(60));
    assert!(h.sink.lines().is_empty(), "an event before the hello");
    let r = h.hello();
    assert_eq!(r["available"], json!(true));
    assert_eq!(r["sessions"], json!(0));
    assert_eq!(r["platform"], json!(crate::computer::node_platform(std::env::consts::OS)));
    assert_eq!(r["shortcuts"], json!([QUICK]));
    assert!(r["version"].is_string());
}

#[test]
fn hello_with_computer_use_off_says_so_and_no_start_is_ever_shown() {
    let shell = Shell::new(|| vec![QUICK.to_string()], None, limits());
    let (w, sink) = writer();
    shell.attach(w.clone());
    shell.request(Request { id: 1, method: "computer.hello".into(), params: json!({}) }, Reply::new(1, w.clone()));
    shell.request(Request { id: 2, method: "computer.start".into(), params: json!({ "chatId": "c", "title": "t" }) }, Reply::new(2, w.clone()));
    shell.request(Request { id: 3, method: "computer.end".into(), params: json!({ "chatId": "c" }) }, Reply::new(3, w.clone()));
    shell.request(Request { id: 4, method: "computer.act".into(), params: json!({ "chatId": "c", "session": "x" }) }, Reply::new(4, w));
    wait_for("four answers", || sink.messages().len() == 4);
    let by_id = |id: u64| sink.messages().into_iter().find(|m| m["id"] == json!(id)).unwrap();
    assert_eq!(by_id(1)["result"]["available"], json!(false));
    assert_eq!(by_id(1)["result"]["sessions"], json!(0));
    assert_eq!(by_id(2)["result"], json!({ "ok": false, "reason": OFF_REASON }));
    assert_eq!(by_id(3)["result"], json!({ "ok": true }));
    assert!(no_session(&by_id(4)));
}

#[test]
fn hello_drops_every_session_dialog_and_key_before_answering() {
    let h = H::new();
    h.hello();
    let token = h.start("a");
    assert_eq!(*h.fake.hotkey.lock().unwrap(), [true]);
    let r = h.hello();
    assert_eq!(r["sessions"], json!(0));
    assert_eq!(r["shortcuts"], json!([QUICK]), "the stop hotkey is gone by the time the hello answers");
    assert_eq!(*h.fake.hotkey.lock().unwrap(), [true, false]);
    assert_eq!(h.fake.indicator.lock().unwrap().last(), Some(&None));
    assert!(no_session(&h.shot("a", &token)));

    // A dialog that is up is dismissed, and its start answered no.
    *h.fake.mode.lock().unwrap() = Mode::Hold;
    let start = h.send("computer.start", json!({ "chatId": "b", "title": "t" }));
    wait_for("the dialog", || h.fake.dialogs.lock().unwrap().len() == 2);
    let (hello_at, hello) = {
        let id = h.send("computer.hello", json!({}));
        h.answer_at(id)
    };
    let (start_at, start) = h.answer_at(start);
    assert_eq!(start["result"]["ok"], json!(false));
    assert!(start_at < hello_at);
    assert_eq!(hello["result"]["sessions"], json!(0));
    wait_for("the dialog to close", || h.fake.dialog_closed.load(Ordering::SeqCst));
    assert!(h.events("computer.stopped").is_empty(), "a hello's drops are not the shell's own stops");
}

// 3 --------------------------------------------------------------------------

#[test]
fn a_yes_mints_a_token_and_reports_the_stop_hotkey_before_answering() {
    let h = H::new();
    h.hello();
    let id = h.send("computer.start", json!({ "chatId": "a", "title": "Budget sheet" }));
    let (answer_at, answer) = h.answer_at(id);
    let token = answer["result"]["session"].as_str().unwrap().to_string();
    assert_eq!(answer["result"]["ok"], json!(true));
    assert!(token.len() >= 16 && token.len() <= 128 && token.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-'), "{token}");
    let messages = h.sink.messages();
    let event_at = messages.iter().position(|m| m["event"] == json!("computer.shortcuts")).expect("a shortcuts event");
    assert!(event_at < answer_at, "the event must come before the start's answer");
    assert_eq!(messages[event_at]["params"], json!({ "shortcuts": [QUICK, STOP_HOTKEY] }));
    assert_eq!(*h.fake.indicator.lock().unwrap(), [Some("Budget sheet".to_string())]);
    assert!(h.fake.dialogs.lock().unwrap()[0].contains("the chat named '\u{2068}Budget sheet\u{2069}'"));

    // The hot path: the same token, no dialog, no event.
    let lines = h.sink.lines().len();
    let again = h.result(h.send("computer.start", json!({ "chatId": "a", "title": "Budget sheet" })));
    assert_eq!(again, json!({ "ok": true, "session": token }));
    assert_eq!(h.fake.dialogs.lock().unwrap().len(), 1);
    assert_eq!(h.sink.lines().len(), lines + 1);

    // A new session (after an end) gets a new token.
    assert_eq!(h.result(h.send("computer.end", json!({ "chatId": "a", "session": token }))), json!({ "ok": true }));
    let next = h.start("a");
    assert_ne!(next, token);
}

#[test]
fn no_closed_or_failed_holds_nothing() {
    for (mode, reason) in [(Mode::No, DECLINED), (Mode::Fail, NOT_ASKED)] {
        let h = H::new();
        h.hello();
        *h.fake.mode.lock().unwrap() = mode;
        let r = h.result(h.send("computer.start", json!({ "chatId": "a", "title": "t" })));
        assert_eq!(r, json!({ "ok": false, "reason": reason }));
        assert!(h.fake.hotkey.lock().unwrap().is_empty());
        assert!(h.fake.indicator.lock().unwrap().is_empty());
        assert!(no_session(&h.shot("a", "x".repeat(64).as_str())));
        assert!(h.events("computer.shortcuts").is_empty());
    }
}

#[test]
fn a_dialog_nobody_answers_closes_itself_as_no() {
    let h = H::with(Fake::new(), Limits { dialog: Duration::from_millis(100), ..limits() });
    h.hello();
    *h.fake.mode.lock().unwrap() = Mode::Hold;
    let r = h.result(h.send("computer.start", json!({ "chatId": "a", "title": "t" })));
    assert_eq!(r, json!({ "ok": false, "reason": UNANSWERED }));
    assert!(h.fake.dialog_closed.load(Ordering::SeqCst));
}

#[test]
fn one_dialog_per_chat_and_one_chat_at_a_time() {
    let h = H::new();
    h.hello();
    *h.fake.mode.lock().unwrap() = Mode::Hold;
    let first = h.send("computer.start", json!({ "chatId": "a", "title": "t" }));
    wait_for("the dialog", || h.fake.dialogs.lock().unwrap().len() == 1);
    let second = h.send("computer.start", json!({ "chatId": "a", "title": "t" }));
    let other = h.result(h.send("computer.start", json!({ "chatId": "b", "title": "t" })));
    assert_eq!(other, json!({ "ok": false, "reason": BUSY }));
    *h.fake.answer.lock().unwrap() = Some(Consent::Yes);
    let (a, b) = (h.result(first), h.result(second));
    assert_eq!(a["ok"], json!(true));
    assert_eq!(a, b);
    assert_eq!(h.fake.dialogs.lock().unwrap().len(), 1);
    // Another chat while one holds a session: refused, no dialog.
    *h.fake.mode.lock().unwrap() = Mode::Yes;
    assert_eq!(h.result(h.send("computer.start", json!({ "chatId": "b", "title": "t" }))), json!({ "ok": false, "reason": BUSY }));
    assert_eq!(h.fake.dialogs.lock().unwrap().len(), 1);
}

#[test]
fn no_session_without_the_stop_hotkey() {
    let h = H::new();
    h.hello();
    h.fake.hotkey_fails.store(true, Ordering::SeqCst);
    let r = h.result(h.send("computer.start", json!({ "chatId": "a", "title": "t" })));
    assert_eq!(r, json!({ "ok": false, "reason": NO_HOTKEY }));
    assert!(h.fake.indicator.lock().unwrap().is_empty());
}

#[test]
fn the_title_is_one_plain_line_marked_as_the_chats_name() {
    assert_eq!(clean_title("Budget\nsheet\t\u{202E}gpj.exe"), "Budget sheet gpj.exe");
    assert_eq!(clean_title("  "), "this chat");
    assert_eq!(clean_title("\u{200B}"), "this chat");
    let long = clean_title(&"x".repeat(200));
    assert_eq!(long.chars().count(), 80);
    assert!(long.ends_with('\u{2026}'));
    let text = dialog_text("OK to everything");
    assert!(text.starts_with("Let Grunt control this computer for the chat named '\u{2068}OK to everything\u{2069}'?"));
    assert!(text.ends_with("Stop any time with Ctrl+Alt+Backspace."));
}

// 4 --------------------------------------------------------------------------

#[test]
fn every_session_request_needs_the_chats_live_token() {
    let h = H::new();
    h.hello();
    let a = h.start("a");
    let old = a.clone();
    h.result(h.send("computer.end", json!({ "chatId": "a" })));
    let a = h.start("a");
    assert_ne!(a, old);
    let looks = h.fake.looks.load(Ordering::SeqCst);
    for params in [
        json!({ "chatId": "a" }),
        json!({ "chatId": "a", "session": old }),
        json!({ "chatId": "a", "session": a.to_uppercase() }),
        json!({ "chatId": "a", "session": format!("{a} ") }),
        json!({ "chatId": "b", "session": a }),
        json!({ "chatId": "A", "session": a }),
        json!({ "session": a }),
        json!({ "chatId": "a", "session": 5 }),
    ] {
        for method in ["computer.screenshot", "computer.cursor", "computer.target", "computer.act"] {
            let mut p = params.clone();
            p["x"] = json!(1);
            p["y"] = json!(1);
            p["action"] = json!({ "action": "type", "text": "x" });
            p["expect"] = expect(&app());
            assert!(no_session(&h.call(method, p.clone())), "{method} {p}");
        }
    }
    assert_eq!(h.fake.captures.load(Ordering::SeqCst), 0);
    assert_eq!(h.fake.looks.load(Ordering::SeqCst), looks);
    assert!(h.fake.sent().is_empty());
}

// 5 --------------------------------------------------------------------------

#[test]
fn an_end_for_a_chat_with_nothing_is_ok() {
    let h = H::new();
    h.hello();
    assert_eq!(h.result(h.send("computer.end", json!({ "chatId": "nobody" }))), json!({ "ok": true }));
    assert_eq!(h.result(h.send("computer.end", json!({ "chatId": "nobody", "session": "old" }))), json!({ "ok": true }));
    assert!(h.answer(h.send("computer.end", json!({}))).get("error").is_some());
}

#[test]
fn an_end_cancels_a_dialog_and_its_start_is_answered_first() {
    let h = H::new();
    h.hello();
    *h.fake.mode.lock().unwrap() = Mode::Hold;
    let start = h.send("computer.start", json!({ "chatId": "a", "title": "t" }));
    wait_for("the dialog", || h.fake.dialogs.lock().unwrap().len() == 1);
    let end = h.send("computer.end", json!({ "chatId": "a" }));
    let (start_at, start) = h.answer_at(start);
    let (end_at, end) = h.answer_at(end);
    assert_eq!(start["result"], json!({ "ok": false, "reason": STOPPED_FIRST }));
    assert_eq!(end["result"], json!({ "ok": true }));
    assert!(start_at < end_at);
    wait_for("the dialog to close", || h.fake.dialog_closed.load(Ordering::SeqCst));
    // An OK that comes after creates nothing.
    assert!(h.fake.hotkey.lock().unwrap().is_empty());
    assert!(h.events("computer.stopped").is_empty());
}

#[test]
fn an_end_stops_a_running_act_and_nothing_is_pressed_after_its_answer() {
    let h = H::new();
    h.hello();
    let t = h.start("a");
    *h.fake.send_delay.lock().unwrap() = Duration::from_millis(40);
    let act = h.send("computer.act", json!({ "chatId": "a", "session": t, "action": { "action": "type", "text": "x".repeat(400) }, "expect": expect(&app()) }));
    wait_for("typing to start", || h.fake.sends.load(Ordering::SeqCst) >= 2);
    let asked = Instant::now();
    let end = h.send("computer.end", json!({ "chatId": "a", "session": t }));
    let (end_at, end) = h.answer_at(end);
    assert!(asked.elapsed() < Duration::from_secs(1), "{:?}", asked.elapsed());
    assert_eq!(end["result"], json!({ "ok": true }));
    let pressed = h.fake.sent().len();
    let (act_at, act) = h.answer_at(act);
    assert_eq!(act["result"]["ok"], json!(false));
    assert!(act_at < end_at, "the act's answer comes before the end's");
    thread::sleep(Duration::from_millis(150));
    assert_eq!(h.fake.sent().len(), pressed, "something was pressed after the end's answer");
    assert!(h.fake.sends.load(Ordering::SeqCst) < 20, "typing went on");
    assert!(balanced(&h.fake.sent()));
    wait_for("the stop hotkey to go", || *h.fake.hotkey.lock().unwrap() == [true, false]);
}

#[test]
fn an_end_that_could_not_release_a_key_says_so() {
    let h = H::new();
    h.hello();
    let t = h.start("a");
    h.shot("a", &t);
    *h.fake.take.lock().unwrap() = VecDeque::from([0]);
    let r = h.act("a", &t, json!({ "action": "left_click", "coordinate": [5, 5] }));
    assert_eq!(r, json!({ "ok": false, "reason": act::INPUT_REFUSED }));
    assert!(h.fake.sent().is_empty(), "nothing went in, so nothing is down");
    // ctrl goes down, and its up is not taken.
    *h.fake.take.lock().unwrap() = VecDeque::from([1, 0]);
    let r = h.act("a", &t, json!({ "action": "key", "text": "ctrl+s" }));
    assert_eq!(r, json!({ "ok": false, "reason": act::STUCK }));
    let end = h.result(h.send("computer.end", json!({ "chatId": "a" })));
    assert_eq!(end, json!({ "ok": false, "reason": act::STUCK }));
}

// 6 --------------------------------------------------------------------------

#[test]
fn an_act_presses_what_it_is_told_and_says_so_on_the_indicator() {
    let h = H::new();
    h.hello();
    let t = h.start("a");
    h.shot("a", &t);
    assert_eq!(h.act("a", &t, json!({ "action": "left_click", "coordinate": [10, 20] })), json!({ "ok": true }));
    assert_eq!(h.fake.sent(), click_at(10, 20));
    assert_eq!(*h.fake.moves.lock().unwrap(), [(10, 20)]);
    assert_eq!(h.act("a", &t, json!({ "action": "key", "text": "ctrl+s" })), json!({ "ok": true }));
    assert_eq!(h.act("a", &t, json!({ "action": "type", "text": "hi\n" })), json!({ "ok": true }));
    assert_eq!(h.act("a", &t, json!({ "action": "scroll", "coordinate": [1, 1], "scroll_direction": "up", "scroll_amount": 3 })), json!({ "ok": true }));
    assert!(balanced(&h.fake.sent()));
    assert_eq!(*h.fake.labels.lock().unwrap(), ["click at 10, 20", "press ctrl+s", "type 3 characters", "scroll up 3 at 1, 1"]);
}

#[test]
fn an_act_refuses_before_anything_is_pressed() {
    let h = H::new();
    h.hello();
    let t = h.start("a");
    let call = |action: Value, expect: Value| h.result(h.send("computer.act", json!({ "chatId": "a", "session": t, "action": action, "expect": expect })));
    // No screenshot yet.
    assert_eq!(call(json!({ "action": "left_click", "coordinate": [1, 1] }), expect(&app()))["reason"], json!(act::NO_SCREENSHOT));
    h.shot("a", &t);
    let mut partial = expect(&app());
    partial.as_object_mut().unwrap().remove("startedAt");
    assert_eq!(call(json!({ "action": "type", "text": "x" }), partial)["reason"], json!(act::NO_EXPECTATION));
    assert_eq!(call(json!({ "action": "left_click", "coordinate": [1366, 1] }), expect(&app()))["reason"], json!(act::OUTSIDE));
    assert_eq!(call(json!({ "action": "scroll", "coordinate": [1, 1], "scroll_direction": "up", "scroll_amount": 11 }), expect(&app()))["ok"], json!(false));
    assert_eq!(call(json!({ "action": "type", "text": "x".repeat(4001) }), expect(&app()))["ok"], json!(false));
    assert_eq!(call(json!({ "action": "key", "text": "ctrl+a ctrl+c" }), expect(&app()))["ok"], json!(false));
    // Its own shortcuts, whatever the server thinks.
    for own in ["ctrl+shift+space", "ctrl+alt+backspace"] {
        let r = call(json!({ "action": "key", "text": own }), expect(&app()));
        assert!(r["reason"].as_str().unwrap().contains("Grunt's own shortcuts"), "{own}: {r}");
    }
    // A held modifier or an unreadable keyboard, for every kind of action.
    for (state, reason) in [(Keyboard::Held, act::MODIFIER_HELD), (Keyboard::Unknown, act::KEYBOARD_UNKNOWN)] {
        *h.fake.keyboard.lock().unwrap() = state;
        for action in [
            json!({ "action": "left_click", "coordinate": [1, 1] }),
            json!({ "action": "mouse_move", "coordinate": [1, 1] }),
            json!({ "action": "scroll", "coordinate": [1, 1], "scroll_direction": "up", "scroll_amount": 1 }),
            json!({ "action": "type", "text": "x" }),
            json!({ "action": "key", "text": "return" }),
        ] {
            assert_eq!(call(action.clone(), expect(&app())), json!({ "ok": false, "reason": reason }), "{action}");
        }
    }
    assert!(h.fake.sent().is_empty(), "nothing pressed and nothing released");
    assert!(h.fake.moves.lock().unwrap().is_empty());
}

#[test]
fn the_whole_expectation_is_checked_before_every_chunk() {
    let h = H::new();
    h.hello();
    let t = h.start("a");
    let mut moved = app();
    moved.window_id = "101".into();
    *h.fake.change_after.lock().unwrap() = Some((2, moved));
    let r = h.act("a", &t, json!({ "action": "type", "text": "y".repeat(100) }));
    assert_eq!(r, json!({ "ok": false, "reason": act::WINDOW_CHANGED }));
    assert_eq!(h.fake.sends.load(Ordering::SeqCst), 2, "two chunks of 20, then the check failed");
    assert_eq!(h.fake.sent().len(), 2 * 20 * 2);
    // A path that differs only in case, or a fresh file view, is not the approved window.
    let changes: [fn(&mut Identity); 3] = [|i| i.path = i.path.to_lowercase(), |i| i.shell_view = true, |i| i.started_at = "134".into()];
    for change in changes {
        let h = H::new();
        h.hello();
        let t = h.start("a");
        let mut other = app();
        change(&mut other);
        *h.fake.change_after.lock().unwrap() = Some((0, other));
        h.fake.activate_works.store(false, Ordering::SeqCst);
        assert_eq!(h.act("a", &t, json!({ "action": "key", "text": "ctrl+s" }))["ok"], json!(false));
        assert!(h.fake.sent().is_empty());
    }
}

#[test]
fn nothing_more_is_done_once_the_approved_window_shows_grunts_own_ui() {
    // The same browser window, process and run: only the page changed, to Grunt's.
    let mut grunt_page = app();
    grunt_page.title = "Grunt [grunt-ui] - Google Chrome".into();
    let h = H::new();
    h.hello();
    let t = h.start("a");
    *h.fake.change_after.lock().unwrap() = Some((1, grunt_page.clone()));
    let r = h.act("a", &t, json!({ "action": "type", "text": "y".repeat(100) }));
    assert_eq!(r, json!({ "ok": false, "reason": act::GRUNT_UI }));
    assert_eq!(h.fake.sends.load(Ordering::SeqCst), 1, "one chunk of 20, then the check failed");
    // Already showing it: nothing at all, a key and a click alike.
    let h = H::new();
    h.hello();
    let t = h.start("a");
    h.shot("a", &t);
    *h.fake.change_after.lock().unwrap() = Some((0, grunt_page));
    assert_eq!(h.act("a", &t, json!({ "action": "key", "text": "return" })), json!({ "ok": false, "reason": act::GRUNT_UI }));
    assert_eq!(h.act("a", &t, json!({ "action": "left_click", "coordinate": [10, 10] })), json!({ "ok": false, "reason": act::GRUNT_UI }));
    assert!(h.fake.sent().is_empty());
    assert!(h.fake.activated.lock().unwrap().is_empty(), "never brought forward either");
    // The browser's undocked developer tools, the same way.
    let mut dev_tools = app();
    dev_tools.title = "DevTools - example.com/".into();
    let h = H::new();
    h.hello();
    let t = h.start("a");
    *h.fake.change_after.lock().unwrap() = Some((0, dev_tools));
    assert_eq!(h.act("a", &t, json!({ "action": "key", "text": "return" })), json!({ "ok": false, "reason": act::DEV_TOOLS }));
    assert!(h.fake.sent().is_empty());
}

#[test]
fn a_double_click_sends_no_second_click_once_the_window_changed() {
    let h = H::new();
    h.hello();
    let t = h.start("a");
    h.shot("a", &t);
    *h.fake.change_after.lock().unwrap() = Some((1, grunt()));
    let r = h.act("a", &t, json!({ "action": "triple_click", "coordinate": [10, 10] }));
    assert_eq!(r, json!({ "ok": false, "reason": act::WINDOW_CHANGED }));
    assert_eq!(h.fake.sent(), click_at(10, 10));
    // The same for a scroll's notches.
    let h = H::new();
    h.hello();
    let t = h.start("a");
    h.shot("a", &t);
    *h.fake.change_after.lock().unwrap() = Some((2, grunt()));
    let r = h.act("a", &t, json!({ "action": "scroll", "coordinate": [1, 1], "scroll_direction": "down", "scroll_amount": 10 }));
    assert_eq!(r["ok"], json!(false));
    assert_eq!(h.fake.sends.load(Ordering::SeqCst), 2);
}

#[test]
fn the_approved_window_may_be_brought_forward_once_and_only_it() {
    let h = H::new();
    h.hello();
    let t = h.start("a");
    *h.fake.foreground.lock().unwrap() = grunt();
    assert_eq!(h.act("a", &t, json!({ "action": "type", "text": "hello" })), json!({ "ok": true }));
    assert_eq!(*h.fake.activated.lock().unwrap(), ["100"]);
    // It doesn't come forward: refused, never retried.
    let h = H::new();
    h.hello();
    let t = h.start("a");
    *h.fake.foreground.lock().unwrap() = grunt();
    h.fake.activate_works.store(false, Ordering::SeqCst);
    assert_eq!(h.act("a", &t, json!({ "action": "key", "text": "return" }))["reason"], json!(act::WINDOW_CHANGED));
    assert_eq!(h.fake.activated.lock().unwrap().len(), 1);
    // The window by that id is no longer the approved one: not activated at all.
    let h = H::new();
    h.hello();
    let t = h.start("a");
    *h.fake.foreground.lock().unwrap() = grunt();
    let mut replaced = app();
    replaced.pid = 8;
    *h.fake.window.lock().unwrap() = Some(replaced);
    assert_eq!(h.act("a", &t, json!({ "action": "key", "text": "return" }))["ok"], json!(false));
    assert!(h.fake.activated.lock().unwrap().is_empty());
    // A mouse action never activates anything.
    let h = H::new();
    h.hello();
    let t = h.start("a");
    h.shot("a", &t);
    *h.fake.at_point.lock().unwrap() = grunt();
    assert_eq!(h.act("a", &t, json!({ "action": "left_click", "coordinate": [1, 1] }))["ok"], json!(false));
    assert!(h.fake.activated.lock().unwrap().is_empty());
    assert!(h.fake.sent().is_empty());
}

#[test]
fn a_partial_input_is_released_and_only_what_was_pressed() {
    let h = H::new();
    h.hello();
    let t = h.start("a");
    // Windows takes only ctrl's down; the guard sends only ctrl's up.
    *h.fake.take.lock().unwrap() = VecDeque::from([1]);
    let r = h.act("a", &t, json!({ "action": "key", "text": "ctrl+s" }));
    assert_eq!(r, json!({ "ok": false, "reason": act::INPUT_REFUSED }));
    assert_eq!(h.fake.sent(), [Input::Key { vk: 0xA2, extended: false, up: false }, Input::Key { vk: 0xA2, extended: false, up: true }]);
}

#[test]
fn one_act_at_a_time() {
    let h = H::new();
    h.hello();
    let t = h.start("a");
    *h.fake.send_delay.lock().unwrap() = Duration::from_millis(5);
    let a = h.send("computer.act", json!({ "chatId": "a", "session": t, "action": { "action": "type", "text": "a".repeat(100) }, "expect": expect(&app()) }));
    let b = h.send("computer.act", json!({ "chatId": "a", "session": t, "action": { "action": "type", "text": "b".repeat(100) }, "expect": expect(&app()) }));
    assert_eq!(h.result(a), json!({ "ok": true }));
    assert_eq!(h.result(b), json!({ "ok": true }));
    assert!(!h.fake.overlap.load(Ordering::SeqCst));
    // Each act's text arrived whole, one after the other.
    let typed: String = h.fake.sent().iter().filter_map(|e| if let Input::Unicode { unit, up: false } = e { Some(*unit as u8 as char) } else { None }).collect();
    assert!(typed == format!("{}{}", "a".repeat(100), "b".repeat(100)) || typed == format!("{}{}", "b".repeat(100), "a".repeat(100)));
}

// 7 --------------------------------------------------------------------------

#[test]
fn close_or_a_lost_pipe_ends_everything_and_nothing_more_is_acted_on() {
    for lost in [false, true] {
        let h = H::new();
        h.hello();
        let t = h.start("a");
        if lost {
            h.shell.lost();
        } else {
            assert!(h.shell.notification("computer.close", &json!({})));
        }
        wait_for("the hotkey to go", || h.fake.hotkey.lock().unwrap().last() == Some(&false));
        wait_for("the indicator to go", || h.fake.indicator.lock().unwrap().last() == Some(&None));
        let lines = h.sink.lines().len();
        let id = h.send("computer.screenshot", json!({ "chatId": "a", "session": t }));
        wait_for("the dropped request to be answered", || h.sink.lines().len() > lines);
        assert!(h.answer(id).get("result").is_none());
        assert_eq!(h.fake.captures.load(Ordering::SeqCst), 0);
        assert!(h.events("computer.stopped").is_empty());
    }
}

// 8 --------------------------------------------------------------------------

#[test]
fn the_shells_own_stop_is_told_after_everything_an_end_does() {
    let h = H::new();
    h.hello();
    let t = h.start("a");
    // An act is stopped and has answered before the server is told.
    *h.fake.send_delay.lock().unwrap() = Duration::from_millis(30);
    let act = h.send("computer.act", json!({ "chatId": "a", "session": t, "action": { "action": "type", "text": "x".repeat(200) }, "expect": expect(&app()) }));
    wait_for("typing to start", || h.fake.sends.load(Ordering::SeqCst) >= 1);
    h.shell.stop("button");
    let messages = h.sink.messages();
    let stopped_at = messages.iter().position(|m| m["event"] == json!("computer.stopped")).expect("stopped");
    assert_eq!(messages[stopped_at]["params"], json!({ "chatId": "a", "why": "button" }));
    let (act_at, act) = h.answer_at(act);
    assert_eq!(act["result"]["ok"], json!(false));
    assert!(act_at < stopped_at);
    // Then the UI is put away and the list reported, as after an end's answer.
    let last_shortcuts = messages.iter().rposition(|m| m["event"] == json!("computer.shortcuts")).unwrap();
    assert!(last_shortcuts > stopped_at);
    assert_eq!(messages[last_shortcuts]["params"], json!({ "shortcuts": [QUICK] }));
    assert_eq!(*h.fake.hotkey.lock().unwrap(), [true, false]);
    assert!(no_session(&h.shot("a", &t)));
    // A server's end is never answered with computer.stopped.
    let h = H::new();
    h.hello();
    h.start("a");
    h.result(h.send("computer.end", json!({ "chatId": "a" })));
    assert!(h.events("computer.stopped").is_empty());
}

#[test]
fn a_quick_chat_hotkey_change_is_reported_once_after_a_quiet_spell() {
    let h = H::new();
    h.hello();
    for _ in 0..20 {
        h.shell.shortcuts_changed();
    }
    thread::sleep(Duration::from_millis(100));
    assert!(h.events("computer.shortcuts").is_empty(), "the list didn't change, so nothing is told");
}

// 9 --------------------------------------------------------------------------

#[test]
fn a_request_read_after_an_end_is_no_session_whoever_runs_it() {
    for _ in 0..20 {
        let h = H::new();
        h.hello();
        let t = h.start("a");
        let end = h.send("computer.end", json!({ "chatId": "a", "session": t }));
        let shot = h.send("computer.screenshot", json!({ "chatId": "a", "session": t }));
        let act = h.send("computer.act", json!({ "chatId": "a", "session": t, "action": { "action": "type", "text": "x" }, "expect": expect(&app()) }));
        assert!(no_session(&h.answer(shot)));
        assert!(no_session(&h.answer(act)));
        assert_eq!(h.result(end), json!({ "ok": true }));
        assert!(h.fake.sent().is_empty());
        assert_eq!(h.fake.captures.load(Ordering::SeqCst), 0);
    }
}

// 10 -------------------------------------------------------------------------

#[test]
fn idle_counts_from_the_last_look_or_act_never_from_a_start() {
    let h = H::with(Fake::new(), Limits { idle: Duration::from_millis(400), ..limits() });
    h.hello();
    let t = h.start("a");
    // A small screen, so each look is quick to encode however loaded the machine is.
    *h.fake.screen.lock().unwrap() = (200, 100);
    for _ in 0..6 {
        thread::sleep(Duration::from_millis(80));
        assert_eq!(h.shot("a", &t)["result"]["width"], json!(200));
    }
    assert!(h.events("computer.stopped").is_empty(), "looks keep it alive");
    for _ in 0..6 {
        thread::sleep(Duration::from_millis(80));
        h.send("computer.start", json!({ "chatId": "a", "title": "t" }));
    }
    wait_for("the idle stop", || !h.events("computer.stopped").is_empty());
    assert_eq!(h.events("computer.stopped")[0], json!({ "chatId": "a", "why": "idle" }));
    assert!(no_session(&h.shot("a", &t)));
}

#[test]
fn a_screenshot_is_strict_base64_png_whose_header_is_its_size() {
    let h = H::new();
    h.hello();
    let t = h.start("a");
    *h.fake.screen.lock().unwrap() = (1920, 1080);
    let r = h.shot("a", &t)["result"].clone();
    assert_eq!((r["width"].clone(), r["height"].clone()), (json!(1365), json!(768)));
    let b64 = r["png"].as_str().unwrap();
    assert!(b64.len() % 4 == 0 && b64.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'+' || b == b'/' || b == b'='));
    let png = base64::engine::general_purpose::STANDARD.decode(b64).unwrap();
    assert_eq!(&png[..8], &[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]);
    assert_eq!(u32::from_be_bytes(png[16..20].try_into().unwrap()), 1365);
    assert_eq!(u32::from_be_bytes(png[20..24].try_into().unwrap()), 768);
    // A capture over 5 MB is an error, never the result.
    *h.fake.capture_size.lock().unwrap() = Some((1800, 1000));
    let big = h.shot("a", &t);
    assert_eq!(big["error"], json!({ "message": TOO_BIG }));
}

#[test]
fn the_cursor_and_a_point_are_checked_against_the_last_screenshot_never_clamped() {
    let h = H::new();
    h.hello();
    let t = h.start("a");
    let ask = |m: &str, p: Value| {
        let mut p = p;
        p["chatId"] = json!("a");
        p["session"] = json!(t);
        h.call(m, p)
    };
    assert_eq!(ask("computer.cursor", json!({}))["error"], json!({ "message": NO_CURSOR }));
    assert_eq!(ask("computer.target", json!({ "x": 1, "y": 1 }))["result"], json!({ "refuse": "Take a screenshot first." }));
    assert_eq!(ask("computer.target", json!({ "foreground": true }))["result"]["path"], json!(app().path));
    h.shot("a", &t);
    assert_eq!(ask("computer.cursor", json!({}))["result"], json!({ "x": 10, "y": 20 }));
    for off in [(-5, 10), (10, -1), (1366, 10), (-1920, 500)] {
        *h.fake.cursor.lock().unwrap() = off;
        assert_eq!(ask("computer.cursor", json!({}))["error"], json!({ "message": NO_CURSOR }), "{off:?}");
    }
    for (x, y) in [(json!(1366), json!(0)), (json!(-1), json!(0)), (json!(1.5), json!(0)), (json!("1"), json!(0))] {
        assert_eq!(ask("computer.target", json!({ "x": x, "y": y }))["result"], json!({ "refuse": "That point is not inside the last screenshot." }));
    }
    let facts = ask("computer.target", json!({ "x": 5, "y": 6 }))["result"].clone();
    for field in ["path", "originalName", "signer", "console", "location", "elevated", "uiAccess", "grunt", "shellView", "title", "windowId", "pid", "startedAt"] {
        assert!(facts.get(field).is_some(), "{field}");
    }
    // The screen changed size: refused until a new screenshot.
    *h.fake.screen.lock().unwrap() = (1920, 1080);
    assert!(ask("computer.target", json!({ "x": 5, "y": 6 }))["result"]["refuse"].is_string());
    *h.fake.cursor.lock().unwrap() = (10, 20);
    assert!(ask("computer.cursor", json!({}))["error"].is_object());
}

// Fix round 1 ------------------------------------------------------------------

#[test]
fn a_click_is_refused_when_the_cursor_moved_after_the_check() {
    let h = H::new();
    h.hello();
    let t = h.start("a");
    h.shot("a", &t);
    *h.fake.on_identity.lock().unwrap() = Some(Box::new(|f: &Fake| *f.cursor.lock().unwrap() = (500, 500)));
    let r = h.act("a", &t, json!({ "action": "left_click", "coordinate": [10, 20] }));
    assert_eq!(r["ok"], json!(false), "{r}");
    assert!(h.fake.sent().is_empty(), "a click went to wherever the cursor was");
}

#[test]
fn nothing_is_pressed_once_an_end_comes_during_a_slow_lookup() {
    let h = H::new();
    h.hello();
    let t = h.start("a");
    *h.fake.identity_delay.lock().unwrap() = Duration::from_millis(300);
    let looks = h.fake.looks.load(Ordering::SeqCst);
    let act = h.send("computer.act", json!({ "chatId": "a", "session": t, "action": { "action": "type", "text": "x" }, "expect": expect(&app()) }));
    wait_for("the lookup", || h.fake.looks.load(Ordering::SeqCst) > looks);
    let end = h.send("computer.end", json!({ "chatId": "a" }));
    assert_eq!(h.result(end), json!({ "ok": true }));
    assert_eq!(h.result(act)["ok"], json!(false));
    thread::sleep(Duration::from_millis(100));
    assert!(h.fake.sent().is_empty(), "a key went out after the end was read");
}

#[test]
fn nothing_is_pressed_once_the_deadline_passes_during_a_slow_lookup() {
    let h = H::with(Fake::new(), Limits { act: Duration::from_millis(100), ..limits() });
    h.hello();
    let t = h.start("a");
    *h.fake.identity_delay.lock().unwrap() = Duration::from_millis(250);
    assert_eq!(h.act("a", &t, json!({ "action": "key", "text": "return" })), json!({ "ok": false, "reason": act::TOO_LONG }));
    assert!(h.fake.sent().is_empty());
}

#[test]
fn a_modifier_pressed_during_the_lookup_is_seen_before_the_send() {
    let h = H::new();
    h.hello();
    let t = h.start("a");
    h.shot("a", &t);
    *h.fake.on_identity.lock().unwrap() = Some(Box::new(|f: &Fake| *f.keyboard.lock().unwrap() = Keyboard::Held));
    for action in [json!({ "action": "key", "text": "ctrl+s" }), json!({ "action": "type", "text": "x" }), json!({ "action": "left_click", "coordinate": [1, 1] })] {
        *h.fake.keyboard.lock().unwrap() = Keyboard::Clear;
        assert_eq!(h.act("a", &t, action.clone()), json!({ "ok": false, "reason": act::MODIFIER_HELD }), "{action}");
    }
    assert!(h.fake.sent().is_empty());
}

#[test]
fn an_end_answers_without_waiting_for_the_shells_own_ui() {
    let h = H::new();
    h.hello();
    h.start("a");
    *h.fake.ui_delay.lock().unwrap() = Duration::from_secs(2);
    let asked = Instant::now();
    assert_eq!(h.result(h.send("computer.end", json!({ "chatId": "a" }))), json!({ "ok": true }));
    assert!(asked.elapsed() < Duration::from_millis(800), "{:?}", asked.elapsed());
}

#[test]
fn an_end_read_before_the_dialog_is_up_cancels_the_start() {
    for _ in 0..20 {
        let h = H::new();
        h.hello();
        let start = h.send("computer.start", json!({ "chatId": "a", "title": "t" }));
        let end = h.send("computer.end", json!({ "chatId": "a" }));
        assert_eq!(h.result(start), json!({ "ok": false, "reason": STOPPED_FIRST }));
        assert_eq!(h.result(end), json!({ "ok": true }));
        thread::sleep(Duration::from_millis(20));
        assert!(h.fake.dialogs.lock().unwrap().is_empty(), "a dialog for a chat the server had ended");
    }
}

#[test]
fn no_dialog_is_shown_while_an_act_is_still_pressing() {
    let h = H::with(Fake::new(), Limits { settle: Duration::from_millis(10), ..limits() });
    h.hello();
    let t = h.start("a");
    *h.fake.send_delay.lock().unwrap() = Duration::from_millis(300);
    let act = h.send("computer.act", json!({ "chatId": "a", "session": t, "action": { "action": "type", "text": "x".repeat(100) }, "expect": expect(&app()) }));
    wait_for("typing to start", || h.fake.in_send.load(Ordering::SeqCst) > 0);
    h.shell.stop("button");
    let start = h.send("computer.start", json!({ "chatId": "b", "title": "t" }));
    assert_eq!(h.result(act)["ok"], json!(false));
    assert_eq!(h.result(start)["ok"], json!(true));
    assert_eq!(*h.fake.in_send_at_dialog.lock().unwrap(), [0, 0], "a dialog was shown while an act was pressing");
}

#[test]
fn an_end_never_says_ok_before_the_start_it_ended_has_said_yes() {
    let h = H::with(Fake::new(), Limits { settle: Duration::from_millis(100), ..limits() });
    h.hello();
    let events = locked(&h.shell.0.events);
    let start = h.send("computer.start", json!({ "chatId": "a", "title": "t" }));
    wait_for("the session", || h.shell.0.state().sessions.contains_key("a"));
    let end = h.send("computer.end", json!({ "chatId": "a" }));
    let (end_at, end) = h.answer_at(end);
    assert_eq!(end["result"]["ok"], json!(false), "{end}");
    drop(events);
    let (start_at, _) = h.answer_at(start);
    assert!(end_at < start_at);
}

#[test]
fn every_button_event_and_notch_goes_with_a_move_to_the_checked_point() {
    let h = H::new();
    h.hello();
    let t = h.start("a");
    h.shot("a", &t);
    for action in [
        json!({ "action": "left_click", "coordinate": [10, 20] }),
        json!({ "action": "right_click", "coordinate": [10, 20] }),
        json!({ "action": "triple_click", "coordinate": [10, 20] }),
        json!({ "action": "scroll", "coordinate": [10, 20], "scroll_direction": "left", "scroll_amount": 4 }),
    ] {
        assert_eq!(h.act("a", &t, action.clone()), json!({ "ok": true }), "{action}");
    }
    let batches = h.fake.batches.lock().unwrap().clone();
    assert_eq!(batches.len(), 1 + 1 + 3 + 4);
    for batch in batches {
        for (i, event) in batch.iter().enumerate() {
            if matches!(event, Input::Button { .. } | Input::Wheel { .. }) {
                assert!(i > 0 && batch[i - 1] == Input::MoveTo { x: 10, y: 20 }, "{batch:?}");
            }
        }
    }
}

#[test]
fn a_start_whose_indicator_cant_be_shown_is_refused_and_leaves_nothing() {
    let h = H::new();
    h.hello();
    h.fake.indicator_fails.store(true, Ordering::SeqCst);
    let r = h.result(h.send("computer.start", json!({ "chatId": "a", "title": "t" })));
    assert_eq!(r, json!({ "ok": false, "reason": NO_INDICATOR }));
    assert!(no_session(&h.shot("a", &"x".repeat(64))));
    assert_eq!(h.fake.hotkey.lock().unwrap().last(), Some(&false), "the stop hotkey is taken back");
    assert!(!h.shell.0.state().sessions.contains_key("a"));
}

#[test]
fn a_stop_hotkey_of_unknown_state_is_unregistered_before_the_next_start() {
    let h = H::new();
    h.hello();
    h.fake.hotkey_fails.store(true, Ordering::SeqCst);
    assert_eq!(h.result(h.send("computer.start", json!({ "chatId": "a", "title": "t" })))["reason"], json!(NO_HOTKEY));
    h.fake.hotkey_fails.store(false, Ordering::SeqCst);
    h.start("a");
    // The refused start's clean-up unregistered it (state unknown); the next start registered it afresh.
    assert_eq!(*h.fake.hotkey.lock().unwrap(), [false, true]);
}

#[test]
fn a_lost_channel_says_computer_use_is_off() {
    let h = H::new();
    h.hello();
    h.shell.lost();
    wait_for("the off notice", || h.fake.channel_off.load(Ordering::SeqCst));
}

#[test]
fn quitting_is_not_held_up_by_a_worker_holding_the_ui() {
    let h = H::new();
    h.hello();
    h.start("a");
    let ops = locked(&h.shell.0.ui_ops);
    let asked = Instant::now();
    h.shell.shutdown(Duration::from_millis(200));
    assert!(asked.elapsed() < Duration::from_millis(600), "{:?}", asked.elapsed());
    drop(ops);
    wait_for("the quit to finish", || !h.events("computer.stopped").is_empty());
    assert_eq!(h.events("computer.stopped")[0], json!({ "chatId": "a", "why": "quit" }));
}
