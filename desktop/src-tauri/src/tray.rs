//! The tray icon: where Grunt lives while its window is closed.

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager};

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

/// Updates the tooltip; the web app calls this whenever its count changes.
pub fn set_status(app: &AppHandle, pending_approvals: u32) {
    if let Some(tray) = app.tray_by_id("main") {
        let _ = tray.set_tooltip(Some(tooltip_text(pending_approvals)));
    }
}

pub fn build(app: &AppHandle) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "Open Grunt", true, None::<&str>)?;
    let new_chat = MenuItem::with_id(app, "new-chat", "New chat", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit Grunt", true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(app, &[&open, &new_chat, &separator, &quit])?;

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
}
