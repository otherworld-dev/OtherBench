//! The tray icon: where OtherBench lives while its window is closed.

use std::sync::Mutex;

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, Wry};

/// Brings the main window back from the tray, with any undocked ones, and
/// tells the web app, which opens the chat it last sent a notification about:
/// desktop notifications don't report clicks, so this is how one gets acted on.
fn open_from_tray(app: &AppHandle) {
    crate::docks::show_all(app);
    show_main(app);
    let _ = app.emit_to("main", "tray-open", ());
}

/// Brings the main window back: un-minimise, show, focus.
pub fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

/// The tray tooltip: "OtherBench", plus how many tool calls are waiting for
/// approval, so a reply blocked on one shows while the window is hidden.
pub fn tooltip_text(pending_approvals: u32) -> String {
    match pending_approvals {
        0 => "OtherBench".to_string(),
        1 => "OtherBench: 1 tool call waiting for approval".to_string(),
        n => format!("OtherBench: {n} tool calls waiting for approval"),
    }
}

/// At most this many machine lines in the menu, each at most this many
/// characters: the text comes from the web app.
const MAX_MACHINE_LINES: usize = 4;
const MAX_LINE_CHARS: usize = 80;

/// The machine status lines as the menu shows them: blank ones dropped, the
/// rest trimmed and capped in number and length.
pub fn machine_lines(lines: &[String]) -> Vec<String> {
    lines
        .iter()
        .map(|line| line.trim())
        .filter(|line| !line.is_empty())
        .take(MAX_MACHINE_LINES)
        .map(|line| {
            if line.chars().count() > MAX_LINE_CHARS {
                format!("{}…", line.chars().take(MAX_LINE_CHARS - 1).collect::<String>())
            } else {
                line.to_string()
            }
        })
        .collect()
}

/// How the menu's machine lines go from `old` to `new`.
#[derive(Debug, PartialEq, Eq)]
pub enum MachinesChange {
    /// Nothing to do: only the approval count changed, say.
    Same,
    /// As many lines as before: these ones (by position) get new text in place.
    Retext(Vec<(usize, String)>),
    /// A machine was paired or removed: the menu is built again.
    Rebuild,
}

pub fn machines_change(old: &[String], new: &[String]) -> MachinesChange {
    if old.len() != new.len() {
        return MachinesChange::Rebuild;
    }
    let changed: Vec<(usize, String)> = old
        .iter()
        .zip(new)
        .enumerate()
        .filter(|(_, (was, now))| was != now)
        .map(|(i, (_, now))| (i, now.clone()))
        .collect();
    if changed.is_empty() {
        MachinesChange::Same
    } else {
        MachinesChange::Retext(changed)
    }
}

/// The tray menu's machine lines as last shown, with their items, so a status
/// change only retexts a line instead of building the menu again.
struct MachineItems {
    lines: Vec<String>,
    items: Vec<MenuItem<Wry>>,
}

static MACHINES: Mutex<Option<MachineItems>> = Mutex::new(None);

/// Open OtherBench, New chat, each paired machine's status (greyed out, for
/// reading), Quit. `lines` have been through `machine_lines`.
fn menu(app: &AppHandle, lines: &[String]) -> tauri::Result<(Menu<Wry>, Vec<MenuItem<Wry>>)> {
    let open = MenuItem::with_id(app, "open", "Open OtherBench", true, None::<&str>)?;
    let new_chat = MenuItem::with_id(app, "new-chat", "New chat", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &new_chat])?;
    let mut items = Vec::with_capacity(lines.len());
    if !lines.is_empty() {
        menu.append(&PredefinedMenuItem::separator(app)?)?;
        for (i, line) in lines.iter().enumerate() {
            let item = MenuItem::with_id(app, format!("machine-{i}"), line, false, None::<&str>)?;
            menu.append(&item)?;
            items.push(item);
        }
    }
    menu.append(&PredefinedMenuItem::separator(app)?)?;
    menu.append(&MenuItem::with_id(app, "quit", "Quit OtherBench", true, None::<&str>)?)?;
    Ok((menu, items))
}

/// Brings the menu's machine lines up to date: retexted in place while the
/// same number of machines is paired, the menu built again when that changes.
fn show_machines(app: &AppHandle, machines: &[String]) {
    let lines = machine_lines(machines);
    let mut shown = MACHINES.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(current) = shown.as_mut() {
        match machines_change(&current.lines, &lines) {
            MachinesChange::Same => return,
            MachinesChange::Retext(changed) => {
                for (i, text) in changed {
                    if let Some(item) = current.items.get(i) {
                        let _ = item.set_text(text);
                    }
                }
                current.lines = lines;
                return;
            }
            MachinesChange::Rebuild => {}
        }
    }
    let Some(tray) = app.tray_by_id("main") else { return };
    if let Ok((menu, items)) = menu(app, &lines) {
        if tray.set_menu(Some(menu)).is_ok() {
            *shown = Some(MachineItems { lines, items });
        }
    }
}

/// The tooltip while a chat controls the computer (the title is already one clean line).
pub fn control_tooltip(title: &str) -> String {
    let text = format!("OtherBench is controlling this computer ({title})");
    // Windows shows at most 127 characters of a tray tooltip.
    if text.chars().count() > 127 {
        format!("{}…)", text.chars().take(125).collect::<String>())
    } else {
        text
    }
}

/// What the tooltip says when computer use has nothing to say.
pub const COMPUTER_OFF_TOOLTIP: &str = "OtherBench: computer use is off until OtherBench restarts";

/// Computer use's own tooltip (a chat is controlling the computer, or the
/// channel is gone), which the web app's status updates don't replace.
static OVERRIDE: Mutex<Option<String>> = Mutex::new(None);
/// The last approval count the web app reported, for when the override goes.
static PENDING: Mutex<u32> = Mutex::new(0);

/// The tooltip shown: computer use's own line while there is one, else the approval count.
pub fn tooltip_for(override_text: Option<&str>, pending_approvals: u32) -> String {
    override_text.map_or_else(|| tooltip_text(pending_approvals), str::to_string)
}

/// Sets (or clears) computer use's tooltip line and shows the result. Call it
/// on the main thread: tray calls go to the event loop.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn set_override(app: &AppHandle, text: Option<String>) {
    let shown = {
        let mut current = OVERRIDE.lock().unwrap_or_else(|e| e.into_inner());
        *current = text;
        tooltip_for(current.as_deref(), *PENDING.lock().unwrap_or_else(|e| e.into_inner()))
    };
    if let Some(tray) = app.tray_by_id("main") {
        let _ = tray.set_tooltip(Some(shown));
    }
}

/// Updates the tooltip and the machine lines; the web app calls this
/// whenever either changes. Computer use's own line stays while it is set.
pub fn set_status(app: &AppHandle, pending_approvals: u32, machines: &[String]) {
    *PENDING.lock().unwrap_or_else(|e| e.into_inner()) = pending_approvals;
    let shown = tooltip_for(OVERRIDE.lock().unwrap_or_else(|e| e.into_inner()).as_deref(), pending_approvals);
    if let Some(tray) = app.tray_by_id("main") {
        let _ = tray.set_tooltip(Some(shown));
    }
    show_machines(app, machines);
}

pub fn build(app: &AppHandle) -> tauri::Result<()> {
    let (menu, items) = menu(app, &[])?;

    let mut builder = TrayIconBuilder::with_id("main")
        .tooltip(tooltip_text(0))
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "open" => open_from_tray(app),
            "new-chat" => {
                show_main(app);
                let _ = app.emit_to("main", "tray-new-chat", ());
            }
            // Exits the event loop; RunEvent::Exit in main.rs stops the server.
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                open_from_tray(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    *MACHINES.lock().unwrap_or_else(|e| e.into_inner()) = Some(MachineItems { lines: Vec::new(), items });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tooltip_is_plain_with_nothing_pending() {
        assert_eq!(tooltip_text(0), "OtherBench");
    }

    #[test]
    fn tooltip_counts_pending_approvals() {
        assert_eq!(tooltip_text(1), "OtherBench: 1 tool call waiting for approval");
        assert_eq!(tooltip_text(3), "OtherBench: 3 tool calls waiting for approval");
    }

    #[test]
    fn computer_uses_own_line_wins_over_the_approval_count_while_set() {
        assert_eq!(tooltip_for(Some("OtherBench is controlling this computer (Budget)"), 3), "OtherBench is controlling this computer (Budget)");
        assert_eq!(tooltip_for(Some(COMPUTER_OFF_TOOLTIP), 0), COMPUTER_OFF_TOOLTIP);
        assert_eq!(tooltip_for(None, 3), "OtherBench: 3 tool calls waiting for approval");
        assert!(COMPUTER_OFF_TOOLTIP.chars().count() <= 127);
    }

    #[test]
    fn the_control_tooltip_names_the_chat_within_windows_limit() {
        assert_eq!(control_tooltip("Budget"), "OtherBench is controlling this computer (Budget)");
        let long = control_tooltip(&"x".repeat(200));
        assert_eq!(long.chars().count(), 127);
        assert!(long.ends_with("…)"));
    }

    #[test]
    fn machine_lines_drop_blanks_and_are_capped_in_number_and_length() {
        let lines = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert_eq!(machine_lines(&lines(&["  PC: connected  ", "", "   "])), vec!["PC: connected"]);
        assert_eq!(machine_lines(&lines(&["a", "b", "c", "d", "e"])), vec!["a", "b", "c", "d"]);
        let long = machine_lines(&lines(&[&"x".repeat(100)]));
        assert_eq!(long[0].chars().count(), 80);
        assert!(long[0].ends_with('…'));
    }

    #[test]
    fn machine_lines_are_retexted_in_place_unless_the_number_of_machines_changes() {
        let lines = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        let before = lines(&["PC: connected, synced just now", "Laptop: checking…"]);
        assert_eq!(machines_change(&before, &before), MachinesChange::Same);
        assert_eq!(machines_change(&[], &[]), MachinesChange::Same);
        assert_eq!(
            machines_change(&before, &lines(&["PC: connected, synced 1 min ago", "Laptop: checking…"])),
            MachinesChange::Retext(vec![(0, "PC: connected, synced 1 min ago".to_string())])
        );
        assert_eq!(
            machines_change(&before, &lines(&["PC: unreachable since 14:02", "Laptop: connected"])),
            MachinesChange::Retext(vec![(0, "PC: unreachable since 14:02".to_string()), (1, "Laptop: connected".to_string())])
        );
        // Pairing the first machine or removing the last adds or drops the separator too.
        assert_eq!(machines_change(&[], &lines(&["PC: checking…"])), MachinesChange::Rebuild);
        assert_eq!(machines_change(&before, &[]), MachinesChange::Rebuild);
        assert_eq!(machines_change(&before, &before[..1]), MachinesChange::Rebuild);
    }
}
