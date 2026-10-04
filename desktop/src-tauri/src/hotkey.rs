//! The global hotkey and the quick-chat window it opens (v2 plan, Task 37).

use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, WebviewWindow};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

/// The quick-chat window's label (tauri.conf.json).
pub const QUICK: &str = "quick";

/// Makes `accelerator` (e.g. "Ctrl+Alt+G") the one global hotkey, replacing
/// any earlier one. On failure -- it doesn't parse, or another app holds it --
/// no hotkey is left registered and the error says why; the caller (Settings
/// → Desktop) shows it and can put the old one back.
pub fn set(app: &AppHandle, accelerator: &str) -> Result<(), String> {
    let shortcuts = app.global_shortcut();
    shortcuts.unregister_all().map_err(|e| e.to_string())?;
    shortcuts
        .on_shortcut(accelerator, |app, _shortcut, event| {
            if event.state == ShortcutState::Pressed {
                toggle_quick(app);
            }
        })
        .map_err(|e| e.to_string())
}

/// Shows the quick-chat window on the monitor the cursor is on, or hides it
/// if it is already up and focused.
pub fn toggle_quick(app: &AppHandle) {
    let Some(window) = app.get_webview_window(QUICK) else { return };
    if window.is_visible().unwrap_or(false) && window.is_focused().unwrap_or(false) {
        let _ = window.hide();
        return;
    }
    place_on_cursor_monitor(app, &window);
    let _ = window.show();
    let _ = window.set_focus();
    let _ = window.emit("quick-shown", ());
}

pub fn hide_quick(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(QUICK) {
        let _ = window.hide();
    }
}

fn place_on_cursor_monitor(app: &AppHandle, window: &WebviewWindow) {
    let Ok(cursor) = app.cursor_position() else { return };
    let Ok(Some(monitor)) = app.monitor_from_point(cursor.x, cursor.y) else { return };
    let Ok(size) = window.outer_size() else { return };
    let (x, y) = quick_position(
        (monitor.position().x, monitor.position().y),
        (monitor.size().width, monitor.size().height),
        (size.width, size.height),
    );
    let _ = window.set_position(PhysicalPosition::new(x, y));
}

/// Where the quick window goes on a monitor: centred across, a quarter of
/// the way down, like a launcher. Clamped so a window bigger than the
/// monitor still starts on it.
fn quick_position(monitor_pos: (i32, i32), monitor_size: (u32, u32), window: (u32, u32)) -> (i32, i32) {
    let free_x = monitor_size.0.saturating_sub(window.0) as i32;
    let free_y = monitor_size.1.saturating_sub(window.1) as i32;
    (monitor_pos.0 + free_x / 2, monitor_pos.1 + (monitor_size.1 as i32 / 4).min(free_y))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn centres_across_a_quarter_down() {
        assert_eq!(quick_position((0, 0), (1920, 1080), (560, 380)), (680, 270));
    }

    #[test]
    fn uses_the_monitor_s_own_origin() {
        // A second monitor to the left of the primary one.
        assert_eq!(quick_position((-2560, 0), (2560, 1440), (560, 380)), (-2560 + 1000, 360));
    }

    #[test]
    fn keeps_a_window_bigger_than_the_monitor_on_it() {
        assert_eq!(quick_position((0, 0), (500, 300), (560, 380)), (0, 0));
    }
}
