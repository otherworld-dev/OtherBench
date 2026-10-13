//! The keys a `key` action may press: exactly the names in core's `KEY_NAMES`
//! and `KEY_MODIFIERS` (packages/core/src/domain/computer-keys.ts), in their
//! canonical lower-case form, and nothing else. No Windows key, no Print
//! Screen, no Caps Lock, no F13-F24, no aliases: core sends the canonical
//! text, so anything else is refused, never guessed at. The shell decides
//! nothing about which combinations are wise (core does); it only refuses
//! what it can't press as told and its own global shortcuts.

use std::str::FromStr;

use tauri_plugin_global_shortcut::{Code, Modifiers, Shortcut};

use super::Input;

/// Core's caps on a `key` action's text (`KEY_LIMITS`).
pub const MAX_TEXT: usize = 64;
pub const MAX_NAMES: usize = 4;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Key {
    pub name: &'static str,
    pub vk: u16,
    pub extended: bool,
    /// The physical key a global shortcut names, to compare with Grunt's own.
    pub code: Code,
}

const fn k(name: &'static str, vk: u16, extended: bool, code: Code) -> Key {
    Key { name, vk, extended, code }
}

/// The modifiers, in canonical order: the left-hand virtual keys.
pub const MODIFIERS: [(&str, u16, Modifiers); 3] = [("ctrl", 0xA2, Modifiers::CONTROL), ("alt", 0xA4, Modifiers::ALT), ("shift", 0xA0, Modifiers::SHIFT)];

/// Every key in core's `KEY_NAMES`.
pub const KEYS: [Key; 75] = [
    k("return", 0x0D, false, Code::Enter),
    k("tab", 0x09, false, Code::Tab),
    k("escape", 0x1B, false, Code::Escape),
    k("backspace", 0x08, false, Code::Backspace),
    k("space", 0x20, false, Code::Space),
    k("delete", 0x2E, true, Code::Delete),
    k("insert", 0x2D, true, Code::Insert),
    k("home", 0x24, true, Code::Home),
    k("end", 0x23, true, Code::End),
    k("page_up", 0x21, true, Code::PageUp),
    k("page_down", 0x22, true, Code::PageDown),
    k("up", 0x26, true, Code::ArrowUp),
    k("down", 0x28, true, Code::ArrowDown),
    k("left", 0x25, true, Code::ArrowLeft),
    k("right", 0x27, true, Code::ArrowRight),
    k("menu", 0x5D, true, Code::ContextMenu),
    k("minus", 0xBD, false, Code::Minus),
    k("equal", 0xBB, false, Code::Equal),
    k("comma", 0xBC, false, Code::Comma),
    k("period", 0xBE, false, Code::Period),
    k("slash", 0xBF, false, Code::Slash),
    k("semicolon", 0xBA, false, Code::Semicolon),
    k("apostrophe", 0xDE, false, Code::Quote),
    k("bracketleft", 0xDB, false, Code::BracketLeft),
    k("bracketright", 0xDD, false, Code::BracketRight),
    k("backslash", 0xDC, false, Code::Backslash),
    k("grave", 0xC0, false, Code::Backquote),
    k("f1", 0x70, false, Code::F1),
    k("f2", 0x71, false, Code::F2),
    k("f3", 0x72, false, Code::F3),
    k("f4", 0x73, false, Code::F4),
    k("f5", 0x74, false, Code::F5),
    k("f6", 0x75, false, Code::F6),
    k("f7", 0x76, false, Code::F7),
    k("f8", 0x77, false, Code::F8),
    k("f9", 0x78, false, Code::F9),
    k("f10", 0x79, false, Code::F10),
    k("f11", 0x7A, false, Code::F11),
    k("f12", 0x7B, false, Code::F12),
    k("a", 0x41, false, Code::KeyA),
    k("b", 0x42, false, Code::KeyB),
    k("c", 0x43, false, Code::KeyC),
    k("d", 0x44, false, Code::KeyD),
    k("e", 0x45, false, Code::KeyE),
    k("f", 0x46, false, Code::KeyF),
    k("g", 0x47, false, Code::KeyG),
    k("h", 0x48, false, Code::KeyH),
    k("i", 0x49, false, Code::KeyI),
    k("j", 0x4A, false, Code::KeyJ),
    k("k", 0x4B, false, Code::KeyK),
    k("l", 0x4C, false, Code::KeyL),
    k("m", 0x4D, false, Code::KeyM),
    k("n", 0x4E, false, Code::KeyN),
    k("o", 0x4F, false, Code::KeyO),
    k("p", 0x50, false, Code::KeyP),
    k("q", 0x51, false, Code::KeyQ),
    k("r", 0x52, false, Code::KeyR),
    k("s", 0x53, false, Code::KeyS),
    k("t", 0x54, false, Code::KeyT),
    k("u", 0x55, false, Code::KeyU),
    k("v", 0x56, false, Code::KeyV),
    k("w", 0x57, false, Code::KeyW),
    k("x", 0x58, false, Code::KeyX),
    k("y", 0x59, false, Code::KeyY),
    k("z", 0x5A, false, Code::KeyZ),
    k("0", 0x30, false, Code::Digit0),
    k("1", 0x31, false, Code::Digit1),
    k("2", 0x32, false, Code::Digit2),
    k("3", 0x33, false, Code::Digit3),
    k("4", 0x34, false, Code::Digit4),
    k("5", 0x35, false, Code::Digit5),
    k("6", 0x36, false, Code::Digit6),
    k("7", 0x37, false, Code::Digit7),
    k("8", 0x38, false, Code::Digit8),
    k("9", 0x39, false, Code::Digit9),
];

pub fn key(name: &str) -> Option<&'static Key> {
    KEYS.iter().find(|k| k.name == name)
}

/// One key combination, as it will be pressed: its modifiers (virtual keys,
/// canonical order) and then its key.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Combo {
    pub text: String,
    pub modifiers: Vec<u16>,
    pub mods: Modifiers,
    pub key: &'static Key,
}

/// Reads a `key` action's text: one combination of at most three distinct
/// modifiers and then one key, every name exactly as core writes it.
pub fn parse_combo(text: &str) -> Result<Combo, String> {
    if text.chars().count() > MAX_TEXT {
        return Err(format!("That is too long to be one key combination (at most {MAX_TEXT} characters); nothing was pressed."));
    }
    if text.is_empty() || text.chars().any(|c| c.is_whitespace()) {
        return Err("The desktop app presses one key combination per action; nothing was pressed.".into());
    }
    let names: Vec<&str> = text.split('+').collect();
    if names.len() > MAX_NAMES {
        return Err(format!("A key combination is at most {MAX_NAMES} keys; nothing was pressed."));
    }
    let (last, mods) = names.split_last().ok_or("There is no key to press.")?;
    let Some(key) = key(last) else {
        return Err("The desktop app doesn't know that key; nothing was pressed.".into());
    };
    let mut modifiers = Vec::new();
    let mut flags = Modifiers::empty();
    for name in mods {
        let Some((_, vk, flag)) = MODIFIERS.iter().find(|(n, _, _)| n == name) else {
            return Err("The desktop app presses one key with its modifiers, every name one it knows; nothing was pressed.".into());
        };
        if flags.contains(*flag) {
            return Err("That key combination names a modifier twice; nothing was pressed.".into());
        }
        flags |= *flag;
        modifiers.push(*vk);
    }
    Ok(Combo { text: text.to_string(), modifiers, mods: flags, key })
}

/// Refuses a combination that is one of the shell's own global shortcuts
/// (the shell's list, not the server's). An entry that can't be read refuses
/// every combination.
pub fn refuse_own(combo: &Combo, own: &[String]) -> Result<(), String> {
    for accelerator in own {
        let Ok(shortcut) = Shortcut::from_str(accelerator) else {
            return Err("The desktop app couldn't read one of its own shortcuts, so it presses no key combinations; nothing was pressed.".into());
        };
        if shortcut.mods == combo.mods && shortcut.key == combo.key.code {
            return Err(format!("Grunt never sends {}: it's one of Grunt's own shortcuts. Nothing was pressed.", combo.text));
        }
    }
    Ok(())
}

/// Every key down in order, then every key up in reverse: one call, so no
/// key is left down and there is no key-down without its key-up.
pub fn events(combo: &Combo) -> Vec<Input> {
    let mut keys: Vec<(u16, bool)> = combo.modifiers.iter().map(|&vk| (vk, false)).collect();
    keys.push((combo.key.vk, combo.key.extended));
    let mut out: Vec<Input> = keys.iter().map(|&(vk, extended)| Input::Key { vk, extended, up: false }).collect();
    out.extend(keys.iter().rev().map(|&(vk, extended)| Input::Key { vk, extended, up: true }));
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `KEY_NAMES` from packages/core/src/domain/computer-keys.ts, in its order.
    const CORE_KEY_NAMES: [&str; 75] = [
        "return", "tab", "escape", "backspace", "space", "delete", "insert", "home", "end", "page_up", "page_down", "up", "down", "left", "right", "menu", "minus",
        "equal", "comma", "period", "slash", "semicolon", "apostrophe", "bracketleft", "bracketright", "backslash", "grave", "f1", "f2", "f3", "f4", "f5", "f6",
        "f7", "f8", "f9", "f10", "f11", "f12", "a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l", "m", "n", "o", "p", "q", "r", "s", "t", "u", "v", "w",
        "x", "y", "z", "0", "1", "2", "3", "4", "5", "6", "7", "8", "9",
    ];

    #[test]
    fn knows_every_name_core_sends_and_nothing_else() {
        let ours: Vec<&str> = KEYS.iter().map(|k| k.name).collect();
        assert_eq!(ours, CORE_KEY_NAMES);
        assert_eq!(MODIFIERS.map(|m| m.0), ["ctrl", "alt", "shift"]);
        for never in ["super", "win", "lwin", "meta", "print", "printscreen", "caps_lock", "f13", "f24", "kp_enter", "Return", "Ctrl", "enter", "esc", "control", "pgup"] {
            assert!(key(never).is_none() && !MODIFIERS.iter().any(|m| m.0 == never), "{never}");
        }
        let mut vks: Vec<u16> = KEYS.iter().map(|k| k.vk).collect();
        vks.sort_unstable();
        vks.dedup();
        assert_eq!(vks.len(), KEYS.len(), "two names share a virtual key");
    }

    #[test]
    fn presses_one_canonical_combination() {
        let c = parse_combo("ctrl+shift+s").unwrap();
        assert_eq!(c.modifiers, [0xA2, 0xA0]);
        assert_eq!(c.key.vk, 0x53);
        assert_eq!(c.mods, Modifiers::CONTROL | Modifiers::SHIFT);
        assert_eq!(parse_combo("return").unwrap().key.vk, 0x0D);
        assert!(parse_combo("page_down").unwrap().key.extended);
        assert_eq!(parse_combo("alt+f4").unwrap().key.vk, 0x73);
    }

    #[test]
    fn refuses_what_it_cannot_press_as_told() {
        for bad in [
            "",
            "ctrl+a ctrl+c",
            "ctrl+a\tb",
            "ctrl+shift+alt+ctrl+s",
            "ctrl+alt+shift+a+b",
            "ctrl",
            "ctrl+",
            "+s",
            "s+ctrl",
            "a+b",
            "ctrl+ctrl+s",
            "Ctrl+S",
            "super+r",
            "win+r",
            "print",
            "caps_lock",
            "f13",
            "ctrl+banana",
            &"a".repeat(65),
        ] {
            assert!(parse_combo(bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn refuses_its_own_shortcuts_however_they_are_spelled() {
        let own = vec!["Ctrl+Shift+Space".to_string(), "Ctrl+Alt+Backspace".to_string(), "F9".to_string(), "CommandOrControl+Shift+KeyG".to_string()];
        for mine in ["ctrl+shift+space", "ctrl+alt+backspace", "f9", "ctrl+shift+g"] {
            assert!(refuse_own(&parse_combo(mine).unwrap(), &own).is_err(), "{mine}");
        }
        for other in ["ctrl+space", "shift+space", "ctrl+f9", "ctrl+shift+h", "ctrl+s"] {
            assert!(refuse_own(&parse_combo(other).unwrap(), &own).is_ok(), "{other}");
        }
        let unreadable = vec!["Ctrl+Banana".to_string()];
        assert!(refuse_own(&parse_combo("ctrl+s").unwrap(), &unreadable).is_err());
        assert!(refuse_own(&parse_combo("ctrl+s").unwrap(), &[]).is_ok());
    }

    #[test]
    fn every_key_down_has_its_key_up() {
        let e = events(&parse_combo("ctrl+shift+delete").unwrap());
        assert_eq!(
            e,
            [
                Input::Key { vk: 0xA2, extended: false, up: false },
                Input::Key { vk: 0xA0, extended: false, up: false },
                Input::Key { vk: 0x2E, extended: true, up: false },
                Input::Key { vk: 0x2E, extended: true, up: true },
                Input::Key { vk: 0xA0, extended: false, up: true },
                Input::Key { vk: 0xA2, extended: false, up: true },
            ]
        );
    }
}
