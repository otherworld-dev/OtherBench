//! `computer.act`: reading the action and its expectation, enforcing core's
//! caps again (refusing, never clamping), and carrying it out with a check of
//! the WHOLE expectation before every key combination, every chunk of at most
//! 20 typed characters, every button event and every scroll notch. Every key
//! and button pressed is released on every way out (`Press`, whose `Drop`
//! releases), and only what was pressed is released.

use std::time::Instant;

use serde_json::Value;

use super::facts::{is_dev_tools, shows_grunt_ui, Expect};
use super::image::Shot;
use super::keys::{self, Combo};
use super::session::Live;
use super::{Desktop, Input, Keyboard, Where};

/// Core's caps (`COMPUTER_LIMITS`).
pub const MAX_TYPED: usize = 4000;
pub const TYPE_CHUNK: usize = 20;
pub const SCROLL_MIN: u64 = 1;
pub const SCROLL_MAX: u64 = 10;

pub const MODIFIER_HELD: &str = "A modifier key is held; nothing was done.";
pub const KEYBOARD_UNKNOWN: &str = "Grunt couldn't read the keyboard state (is the computer locked?); nothing was done.";
pub const WINDOW_CHANGED: &str =
    "The window there is not the one this action was approved for, so nothing more was done. Take a screenshot and try again.";
pub const WINDOW_UNREADABLE: &str = "Grunt couldn't tell which window is there now, so nothing more was done.";
pub const STOPPED: &str = "Control of this computer ended, so nothing more was done.";
pub const GRUNT_UI: &str = "That window is showing Grunt's own pages now, so nothing more was done. Grunt never controls itself.";
pub const DEV_TOOLS: &str = "That window is a browser's developer tools now, so nothing more was done.";
pub const TOO_LONG: &str = "The action took too long and was stopped part way.";
pub const SCREEN_CHANGED: &str = "The screen changed size since the last screenshot; take another. Nothing more was done.";
pub const NO_SCREENSHOT: &str = "Take a screenshot first; nothing was done.";
pub const OUTSIDE: &str = "That point is not inside the last screenshot; nothing was done.";
pub const INPUT_REFUSED: &str =
    "Windows didn't take all of the input (the app may be running as administrator, or the computer is locked); nothing more was done.";
pub const STUCK: &str = "Grunt couldn't release a key or button it pressed; check the keyboard and mouse.";
pub const CURSOR_MOVED: &str = "The mouse pointer moved away from the point that was checked, so nothing more was done.";
pub const NO_EXPECTATION: &str = "The action didn't say which window it was approved for, so nothing was done.";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Button {
    Left,
    Right,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Direction {
    Up,
    Down,
    Left,
    Right,
}

/// An action, as it will be carried out. Points are in the screenshot's pixels.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Action {
    Move { at: (u32, u32) },
    Click { at: (u32, u32), button: Button, count: u8 },
    Scroll { at: (u32, u32), direction: Direction, amount: u8 },
    Type { text: String },
    Key { combo: Combo },
}

/// Reads `{ action, expect }`. `shot` is the session's last screenshot.
pub fn parse(params: &Value, shot: Option<Shot>) -> Result<(Action, Expect), String> {
    let expect = Expect::parse(params.get("expect")).ok_or(NO_EXPECTATION)?;
    let action = params.get("action").and_then(Value::as_object).ok_or("The action couldn't be read; nothing was done.")?;
    let name = action.get("action").and_then(Value::as_str).unwrap_or("");
    let point = || -> Result<(u32, u32), String> {
        let shot = shot.ok_or(NO_SCREENSHOT)?;
        let c = action.get("coordinate").and_then(Value::as_array).ok_or(OUTSIDE)?;
        let (Some(x), Some(y), 2) = (c.first().and_then(Value::as_i64), c.get(1).and_then(Value::as_i64), c.len()) else {
            return Err(OUTSIDE.into());
        };
        if !shot.contains(x, y) {
            return Err(OUTSIDE.into());
        }
        Ok((x as u32, y as u32))
    };
    let parsed = match name {
        "mouse_move" => Action::Move { at: point()? },
        "left_click" => Action::Click { at: point()?, button: Button::Left, count: 1 },
        "right_click" => Action::Click { at: point()?, button: Button::Right, count: 1 },
        "double_click" => Action::Click { at: point()?, button: Button::Left, count: 2 },
        "triple_click" => Action::Click { at: point()?, button: Button::Left, count: 3 },
        "scroll" => {
            let at = point()?;
            let direction = match action.get("scroll_direction").and_then(Value::as_str) {
                Some("up") => Direction::Up,
                Some("down") => Direction::Down,
                Some("left") => Direction::Left,
                Some("right") => Direction::Right,
                _ => return Err("A scroll needs a direction: up, down, left or right. Nothing was done.".into()),
            };
            let amount = action.get("scroll_amount").and_then(Value::as_u64).filter(|n| (SCROLL_MIN..=SCROLL_MAX).contains(n));
            let amount = amount.ok_or(format!("A scroll is {SCROLL_MIN} to {SCROLL_MAX} notches; nothing was done."))?;
            Action::Scroll { at, direction, amount: amount as u8 }
        }
        "type" => {
            let text = action.get("text").and_then(Value::as_str).ok_or("There is no text to type; nothing was done.")?;
            let count = text.chars().count();
            if count == 0 || count > MAX_TYPED {
                return Err(format!("Typed text is 1 to {MAX_TYPED} characters; nothing was done."));
            }
            if text.chars().any(|c| c.is_control() && c != '\n' && c != '\t') {
                return Err("Typed text may hold line breaks and tabs but no other control characters; nothing was done.".into());
            }
            Action::Type { text: text.to_string() }
        }
        "key" => {
            let text = action.get("text").and_then(Value::as_str).ok_or("There is no key combination to press; nothing was done.")?;
            Action::Key { combo: keys::parse_combo(text)? }
        }
        _ => return Err("The desktop app doesn't do that action; nothing was done.".into()),
    };
    Ok((parsed, expect))
}

/// One line for the indicator: what was done, never what was typed.
pub fn label(action: &Action) -> String {
    let at = |p: &(u32, u32)| format!("{}, {}", p.0, p.1);
    match action {
        Action::Move { at: p } => format!("move the mouse to {}", at(p)),
        Action::Click { at: p, button: Button::Right, .. } => format!("right-click at {}", at(p)),
        Action::Click { at: p, count: 2, .. } => format!("double-click at {}", at(p)),
        Action::Click { at: p, count: 3, .. } => format!("triple-click at {}", at(p)),
        Action::Click { at: p, .. } => format!("click at {}", at(p)),
        Action::Scroll { at: p, direction, amount } => format!("scroll {} {amount} at {}", format!("{direction:?}").to_lowercase(), at(p)),
        Action::Type { text } => {
            let n = text.chars().count();
            format!("type {n} character{}", if n == 1 { "" } else { "s" })
        }
        Action::Key { combo } => format!("press {}", combo.text),
    }
}

/// Typed text as events: `\n` is Enter, `\t` is Tab, anything else is its
/// UTF-16 units as characters, each down then up.
pub fn typing(chars: &[char]) -> Vec<Input> {
    let mut out = Vec::new();
    for &c in chars {
        let vk = match c {
            '\n' => Some(0x0D),
            '\t' => Some(0x09),
            _ => None,
        };
        if let Some(vk) = vk {
            out.push(Input::Key { vk, extended: false, up: false });
            out.push(Input::Key { vk, extended: false, up: true });
            continue;
        }
        let mut units = [0u16; 2];
        for &unit in c.encode_utf16(&mut units).iter() {
            out.push(Input::Unicode { unit, up: false });
            out.push(Input::Unicode { unit, up: true });
        }
    }
    out
}

/// The keys and buttons this action has down. On every way out (an error,
/// a stop, a panic) the downs still outstanding are released, last first;
/// nothing else is ever released.
///
/// Every input goes out through `send` (or `move_to`), which takes one last
/// look immediately before it, with nothing slow in between: control still
/// held, time left, no modifier down, and for the mouse the cursor still at
/// the checked point. The look and the send happen while the session is held
/// (`Live::while_live`), so an end read meanwhile waits for this one send,
/// and nothing is sent once it has been read.
pub struct Press<'a> {
    desktop: &'a dyn Desktop,
    live: &'a Live,
    deadline: Instant,
    down: Vec<Input>,
}

impl<'a> Press<'a> {
    pub fn new(desktop: &'a dyn Desktop, live: &'a Live, deadline: Instant) -> Self {
        Self { desktop, live, deadline, down: Vec::new() }
    }

    fn last_look(&self, cursor_at: Option<(i32, i32)>) -> Result<(), String> {
        if Instant::now() >= self.deadline {
            return Err(TOO_LONG.into());
        }
        match self.desktop.keyboard() {
            Keyboard::Clear => {}
            Keyboard::Held => return Err(MODIFIER_HELD.into()),
            Keyboard::Unknown => return Err(KEYBOARD_UNKNOWN.into()),
        }
        if let Some(point) = cursor_at {
            if self.desktop.cursor().ok() != Some(point) {
                return Err(CURSOR_MOVED.into());
            }
        }
        Ok(())
    }

    /// Moves the cursor after the last look.
    pub fn move_to(&mut self, x: i32, y: i32) -> Result<(), String> {
        self.live.while_live(|| {
            self.last_look(None)?;
            self.desktop.move_to(x, y)
        })
    }

    /// Sends events in one go after the last look, noting exactly which were
    /// taken. `cursor_at`: a mouse step's checked point, where the cursor must still be.
    pub fn send(&mut self, inputs: &[Input], cursor_at: Option<(i32, i32)>) -> Result<(), String> {
        let taken = self.live.while_live(|| {
            self.last_look(cursor_at)?;
            Ok(self.desktop.send(inputs).min(inputs.len()))
        })?;
        for event in &inputs[..taken] {
            if event.release().is_some() {
                self.down.push(*event);
            } else if event.is_up() {
                if let Some(at) = self.down.iter().rposition(|d| d.release() == Some(*event)) {
                    self.down.remove(at);
                }
            }
        }
        if taken == inputs.len() {
            Ok(())
        } else {
            Err(INPUT_REFUSED.into())
        }
    }

    /// Releases what is still down, last first; false if any up wasn't
    /// taken. Never gated: what was pressed is released even after an end.
    pub fn release(&mut self) -> bool {
        let mut released = true;
        while let Some(down) = self.down.pop() {
            if let Some(up) = down.release() {
                if self.desktop.send(&[up]) != 1 {
                    released = false;
                }
            }
        }
        released
    }
}

impl Drop for Press<'_> {
    fn drop(&mut self) {
        if !self.release() {
            self.live.set_stuck();
        }
    }
}

/// What each step is checked against.
struct Checks<'a> {
    desktop: &'a dyn Desktop,
    live: &'a Live,
    expect: &'a Expect,
    deadline: Instant,
}

impl Checks<'_> {
    /// Before every step: control still held, time left, no modifier down,
    /// and the live window (under the point, or the foreground) is exactly the
    /// approved one. `may_activate`: the first check of a `type` or `key` may
    /// bring exactly `expect.windowId` forward, once, and check again. The
    /// window lookup can be slow, so `Press` looks again right before the send.
    fn check(&self, at: &Where, may_activate: bool) -> Result<(), String> {
        if self.live.ended() {
            return Err(STOPPED.into());
        }
        if Instant::now() >= self.deadline {
            return Err(TOO_LONG.into());
        }
        match self.desktop.keyboard() {
            Keyboard::Clear => {}
            Keyboard::Held => return Err(MODIFIER_HELD.into()),
            Keyboard::Unknown => return Err(KEYBOARD_UNKNOWN.into()),
        }
        let now = self.desktop.identity(at).map_err(|_| WINDOW_UNREADABLE.to_string())?;
        // A window that shows Grunt's own UI now (a browser that went to it) is
        // never acted in, and never brought forward to be.
        if shows_grunt_ui(&now.title) {
            return Err(GRUNT_UI.into());
        }
        if is_dev_tools(&now.title) {
            return Err(DEV_TOOLS.into());
        }
        if self.expect.matches(&now) {
            return Ok(());
        }
        if !may_activate {
            return Err(WINDOW_CHANGED.into());
        }
        // Only the approved window, and only while it still is the approved one.
        let window = Where::Window(self.expect.window_id.clone());
        match self.desktop.identity(&window) {
            Ok(it) if self.expect.matches(&it) => {}
            _ => return Err(WINDOW_CHANGED.into()),
        }
        if self.live.ended() || !self.desktop.activate(&self.expect.window_id) {
            return Err(WINDOW_CHANGED.into());
        }
        match self.desktop.identity(&Where::Foreground) {
            Ok(after) if self.expect.matches(&after) => Ok(()),
            _ => Err(WINDOW_CHANGED.into()),
        }
    }

    /// For a mouse step: the screen is still the size the screenshot was taken at.
    fn screen(&self, shot: &Shot) -> Result<(), String> {
        match self.desktop.screen_size() {
            Ok(size) if size == (shot.screen_w, shot.screen_h) => Ok(()),
            _ => Err(SCREEN_CHANGED.into()),
        }
    }
}

/// Carries an action out. `shot` is the session's last screenshot now (a
/// point is checked against it again). Err is the reason it stopped; nothing
/// more was done after that point.
pub fn run(desktop: &dyn Desktop, live: &Live, action: &Action, expect: &Expect, shot: Option<Shot>, deadline: Instant) -> Result<(), String> {
    let checks = Checks { desktop, live, expect, deadline };
    let mut press = Press::new(desktop, live, deadline);
    let outcome = steps(&checks, &mut press, action, shot);
    if !press.release() {
        live.set_stuck();
        return Err(STUCK.into());
    }
    outcome
}

/// Button events or wheel notches each with an absolute move to the checked
/// point just before it, in the same batch: they land there, not wherever
/// the cursor went meanwhile.
pub fn at_point(x: i32, y: i32, events: &[Input]) -> Vec<Input> {
    events.iter().flat_map(|e| [Input::MoveTo { x, y }, *e]).collect()
}

fn steps(checks: &Checks, press: &mut Press, action: &Action, shot: Option<Shot>) -> Result<(), String> {
    let pointer = |at: &(u32, u32)| -> Result<(Shot, (i32, i32)), String> {
        let shot = shot.ok_or(NO_SCREENSHOT)?;
        if !shot.contains(at.0 as i64, at.1 as i64) {
            return Err(OUTSIDE.into());
        }
        Ok((shot, shot.to_screen(at.0, at.1)))
    };
    let goto = |press: &mut Press, shot: &Shot, (x, y): (i32, i32)| -> Result<(), String> {
        checks.screen(shot)?;
        checks.check(&Where::Point(x, y), false)?;
        press.move_to(x, y)
    };
    match action {
        Action::Move { at } => {
            let (shot, point) = pointer(at)?;
            goto(press, &shot, point)
        }
        Action::Click { at, button, count } => {
            let (shot, (x, y)) = pointer(at)?;
            goto(press, &shot, (x, y))?;
            let right = *button == Button::Right;
            for _ in 0..*count {
                // Immediately before each button event: the first click can change what is under the point.
                checks.screen(&shot)?;
                checks.check(&Where::Point(x, y), false)?;
                press.send(&at_point(x, y, &[Input::Button { right, up: false }, Input::Button { right, up: true }]), Some((x, y)))?;
            }
            Ok(())
        }
        Action::Scroll { at, direction, amount } => {
            let (shot, (x, y)) = pointer(at)?;
            goto(press, &shot, (x, y))?;
            let (delta, horizontal) = match direction {
                Direction::Up => (120, false),
                Direction::Down => (-120, false),
                Direction::Left => (-120, true),
                Direction::Right => (120, true),
            };
            for _ in 0..*amount {
                checks.screen(&shot)?;
                checks.check(&Where::Point(x, y), false)?;
                press.send(&at_point(x, y, &[Input::Wheel { delta, horizontal }]), Some((x, y)))?;
            }
            Ok(())
        }
        Action::Type { text } => {
            let chars: Vec<char> = text.chars().collect();
            for (i, chunk) in chars.chunks(TYPE_CHUNK).enumerate() {
                checks.check(&Where::Foreground, i == 0)?;
                press.send(&typing(chunk), None)?;
            }
            Ok(())
        }
        Action::Key { combo } => {
            checks.check(&Where::Foreground, true)?;
            press.send(&keys::events(combo), None)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn shot() -> Shot {
        Shot { width: 1366, height: 768, screen_w: 1366, screen_h: 768 }
    }

    fn expect() -> Value {
        json!({ "app": "C:\\Program Files\\Fake App\\FakeApp.exe", "shellView": false, "windowId": "100", "pid": 7, "startedAt": "1" })
    }

    fn act(action: Value) -> Value {
        json!({ "chatId": "c", "session": "t", "action": action, "expect": expect() })
    }

    #[test]
    fn reads_every_action_core_sends() {
        let ok = |a: Value| parse(&act(a), Some(shot())).map(|(a, _)| a);
        assert_eq!(ok(json!({ "action": "left_click", "coordinate": [10, 20] })), Ok(Action::Click { at: (10, 20), button: Button::Left, count: 1 }));
        assert_eq!(ok(json!({ "action": "right_click", "coordinate": [0, 0] })), Ok(Action::Click { at: (0, 0), button: Button::Right, count: 1 }));
        assert_eq!(ok(json!({ "action": "double_click", "coordinate": [1, 2] })), Ok(Action::Click { at: (1, 2), button: Button::Left, count: 2 }));
        assert_eq!(ok(json!({ "action": "triple_click", "coordinate": [1, 2] })), Ok(Action::Click { at: (1, 2), button: Button::Left, count: 3 }));
        assert_eq!(ok(json!({ "action": "mouse_move", "coordinate": [1365, 767] })), Ok(Action::Move { at: (1365, 767) }));
        assert_eq!(
            ok(json!({ "action": "scroll", "coordinate": [1, 2], "scroll_direction": "down", "scroll_amount": 10 })),
            Ok(Action::Scroll { at: (1, 2), direction: Direction::Down, amount: 10 })
        );
        assert_eq!(ok(json!({ "action": "type", "text": "a\nb\tc" })), Ok(Action::Type { text: "a\nb\tc".into() }));
        assert!(matches!(ok(json!({ "action": "key", "text": "ctrl+s" })), Ok(Action::Key { .. })));
    }

    #[test]
    fn refuses_a_partial_expectation() {
        for field in ["app", "shellView", "windowId", "pid", "startedAt"] {
            let mut p = act(json!({ "action": "type", "text": "x" }));
            p["expect"].as_object_mut().unwrap().remove(field);
            assert_eq!(parse(&p, Some(shot())).unwrap_err(), NO_EXPECTATION, "{field}");
        }
        let mut p = act(json!({ "action": "type", "text": "x" }));
        p.as_object_mut().unwrap().remove("expect");
        assert_eq!(parse(&p, Some(shot())).unwrap_err(), NO_EXPECTATION);
    }

    #[test]
    fn refuses_a_point_without_a_screenshot_or_outside_it() {
        let click = |c: Value| act(json!({ "action": "left_click", "coordinate": c }));
        assert_eq!(parse(&click(json!([1, 2])), None).unwrap_err(), NO_SCREENSHOT);
        for bad in [json!([1366, 0]), json!([0, 768]), json!([-1, 0]), json!([1.5, 2]), json!(["1", 2]), json!([1]), json!([1, 2, 3]), json!("1,2"), json!(null)] {
            assert_eq!(parse(&click(bad.clone()), Some(shot())).unwrap_err(), OUTSIDE, "{bad}");
        }
        assert_eq!(parse(&act(json!({ "action": "left_click" })), Some(shot())).unwrap_err(), OUTSIDE);
    }

    #[test]
    fn refuses_every_broken_cap_rather_than_clamping() {
        let bad = |a: Value| parse(&act(a.clone()), Some(shot())).expect_err(&a.to_string());
        bad(json!({ "action": "scroll", "coordinate": [1, 2], "scroll_direction": "down", "scroll_amount": 0 }));
        bad(json!({ "action": "scroll", "coordinate": [1, 2], "scroll_direction": "down", "scroll_amount": 11 }));
        bad(json!({ "action": "scroll", "coordinate": [1, 2], "scroll_direction": "down", "scroll_amount": 2.5 }));
        bad(json!({ "action": "scroll", "coordinate": [1, 2], "scroll_direction": "Down", "scroll_amount": 2 }));
        bad(json!({ "action": "scroll", "coordinate": [1, 2], "scroll_amount": 2 }));
        bad(json!({ "action": "type", "text": "x".repeat(MAX_TYPED + 1) }));
        bad(json!({ "action": "type", "text": "" }));
        for control in ["a\rb", "\u{1b}[2J", "a\u{0}b", "a\u{7f}", "a\u{85}b", "\u{8}"] {
            bad(json!({ "action": "type", "text": control }));
        }
        bad(json!({ "action": "key", "text": "ctrl+a ctrl+c" }));
        bad(json!({ "action": "key", "text": "super+r" }));
        bad(json!({ "action": "key", "text": "a".repeat(65) }));
        bad(json!({ "action": "key", "text": "ctrl+alt+shift+a+b" }));
        bad(json!({ "action": "wait", "duration": 1 }));
        bad(json!({ "action": "left_click_drag", "coordinate": [1, 2] }));
        bad(json!({ "action": "screenshot" }));
        assert!(parse(&act(json!({ "action": "type", "text": "\u{1F600}".repeat(MAX_TYPED) })), Some(shot())).is_ok());
    }

    #[test]
    fn labels_never_hold_typed_text() {
        let typed = Action::Type { text: "my password\nhunter2".into() };
        assert_eq!(label(&typed), "type 19 characters");
        assert_eq!(label(&Action::Type { text: "x".into() }), "type 1 character");
        assert_eq!(label(&Action::Click { at: (1, 2), button: Button::Left, count: 2 }), "double-click at 1, 2");
        assert_eq!(label(&Action::Scroll { at: (1, 2), direction: Direction::Down, amount: 3 }), "scroll down 3 at 1, 2");
        assert_eq!(label(&Action::Key { combo: keys::parse_combo("ctrl+s").unwrap() }), "press ctrl+s");
    }

    #[test]
    fn types_line_breaks_and_tabs_as_keys_and_the_rest_as_characters() {
        let e = typing(&['a', '\n', '\t', '\u{1F600}']);
        assert_eq!(
            e,
            [
                Input::Unicode { unit: 0x61, up: false },
                Input::Unicode { unit: 0x61, up: true },
                Input::Key { vk: 0x0D, extended: false, up: false },
                Input::Key { vk: 0x0D, extended: false, up: true },
                Input::Key { vk: 0x09, extended: false, up: false },
                Input::Key { vk: 0x09, extended: false, up: true },
                Input::Unicode { unit: 0xD83D, up: false },
                Input::Unicode { unit: 0xD83D, up: true },
                Input::Unicode { unit: 0xDE00, up: false },
                Input::Unicode { unit: 0xDE00, up: true },
            ]
        );
    }
}
