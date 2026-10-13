//! The tray icon: where Grunt lives while its window is closed.

use std::sync::Mutex;

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, Wry};

/// Brings the main window back from the tray and tells the web app, which
/// opens the chat it last sent a notification about: desktop notifications
/// don't report clicks, so this is how one gets acted on.
fn open_from_tray(app: &AppHandle) {
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

/// The tray tooltip: "Grunt", plus how many tool calls are waiting for
/// approval, so a reply blocked on one shows while the window is hidden.
pub fn tooltip_text(pending_approvals: u32) -> String {
    match pending_approvals {
        0 => "Grunt".to_string(),
        1 => "Grunt: 1 tool call waiting for approval".to_string(),
        n => format!("Grunt: {n} tool calls waiting for approval"),
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

/// Open Grunt, New chat, each paired machine's status (greyed out, for
/// reading), Quit.
fn menu(app: &AppHandle, machines: &[String]) -> tauri::Result<Menu<Wry>> {
    let open = MenuItem::with_id(app, "open", "Open Grunt", true, None::<&str>)?;
    let new_chat = MenuItem::with_id(app, "new-chat", "New chat", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &new_chat])?;
    let lines = machine_lines(machines);
    if !lines.is_empty() {
        menu.append(&PredefinedMenuItem::separator(app)?)?;
        for (i, line) in lines.iter().enumerate() {
            menu.append(&MenuItem::with_id(app, format!("machine-{i}"), line, false, None::<&str>)?)?;
        }
    }
    menu.append(&PredefinedMenuItem::separator(app)?)?;
    menu.append(&MenuItem::with_id(app, "quit", "Quit Grunt", true, None::<&str>)?)?;
    Ok(menu)
}

/// The tooltip while a chat controls the computer (the title is already one clean line).
pub fn control_tooltip(title: &str) -> String {
    let text = format!("Grunt is controlling this computer ({title})");
    // Windows shows at most 127 characters of a tray tooltip.
    if text.chars().count() > 127 {
        format!("{}…)", text.chars().take(125).collect::<String>())
    } else {
        text
    }
}

/// What the tooltip says when computer use has nothing to say.
pub const COMPUTER_OFF_TOOLTIP: &str = "Grunt: computer use is off until Grunt restarts";

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
        if let Ok(menu) = menu(app, machines) {
            let _ = tray.set_menu(Some(menu));
        }
    }
}

pub fn build(app: &AppHandle) -> tauri::Result<()> {
    let menu = menu(app, &[])?;

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
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tooltip_is_plain_with_nothing_pending() {
        assert_eq!(tooltip_text(0), "Grunt");
    }

    #[test]
    fn tooltip_counts_pending_approvals() {
        assert_eq!(tooltip_text(1), "Grunt: 1 tool call waiting for approval");
        assert_eq!(tooltip_text(3), "Grunt: 3 tool calls waiting for approval");
    }

    #[test]
    fn computer_uses_own_line_wins_over_the_approval_count_while_set() {
        assert_eq!(tooltip_for(Some("Grunt is controlling this computer (Budget)"), 3), "Grunt is controlling this computer (Budget)");
        assert_eq!(tooltip_for(Some(COMPUTER_OFF_TOOLTIP), 0), COMPUTER_OFF_TOOLTIP);
        assert_eq!(tooltip_for(None, 3), "Grunt: 3 tool calls waiting for approval");
        assert!(COMPUTER_OFF_TOOLTIP.chars().count() <= 127);
    }

    #[test]
    fn the_control_tooltip_names_the_chat_within_windows_limit() {
        assert_eq!(control_tooltip("Budget"), "Grunt is controlling this computer (Budget)");
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
}
