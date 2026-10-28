//! Undocked views: Code mode and the Overview can each leave the main window
//! for one of their own, so they can sit on another screen. The window loads
//! the app with `?view=code` or `?view=overview` and is labelled the same.
//!
//! Which views are undocked is remembered here, in `undocked.json` beside the
//! window-state plugin's file, and changes only when the user undocks or docks
//! one (closing the window docks it). Quitting closes the windows without a
//! close request, so they come back on the next launch where they were (the
//! window-state plugin, main.rs, puts them back on their screen).
//!
//! Every change is announced to all the app's windows as `docks-changed` with
//! the undocked list, so each knows which modes it holds (web/src/desktop/windows.ts).

use std::path::PathBuf;
use std::sync::Mutex;

use tauri::{AppHandle, Emitter, Manager, WebviewUrl};

/// The views that can be undocked, as window labels.
pub const VIEWS: [&str; 2] = ["code", "overview"];

/// The windows `open_in` and `show_window` may bring forward.
const TARGETS: [&str; 3] = ["main", "code", "overview"];

/// The undocked views, in `VIEWS` order. Loaded at setup.
static UNDOCKED: Mutex<Vec<String>> = Mutex::new(Vec::new());

pub fn is_view(label: &str) -> bool {
    VIEWS.contains(&label)
}

pub fn is_target(label: &str) -> bool {
    TARGETS.contains(&label)
}

fn file(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_config_dir().ok().map(|dir| dir.join("undocked.json"))
}

/// The views in `list` that can be undocked, once each, in `VIEWS` order.
pub fn known(list: &[String]) -> Vec<String> {
    VIEWS.iter().filter(|v| list.iter().any(|l| l == *v)).map(|v| v.to_string()).collect()
}

/// The undocked views now.
pub fn current() -> Vec<String> {
    UNDOCKED.lock().unwrap_or_else(|e| e.into_inner()).clone()
}

/// Records `view` as undocked or not, saves the list and tells every window.
fn record(app: &AppHandle, view: &str, undocked: bool) {
    let list = {
        let mut current = UNDOCKED.lock().unwrap_or_else(|e| e.into_inner());
        let mut next: Vec<String> = current.iter().filter(|v| *v != view).cloned().collect();
        if undocked {
            next.push(view.to_string());
        }
        *current = known(&next);
        current.clone()
    };
    if let Some(path) = file(app) {
        let saved = path.parent().map_or(Ok(()), std::fs::create_dir_all).and_then(|()| std::fs::write(&path, serde_json::to_string(&list).unwrap_or_default()));
        if let Err(e) = saved {
            eprintln!("[otherbench-desktop] couldn't save the undocked windows: {e}");
        }
    }
    let _ = app.emit("docks-changed", list);
}

/// Brings a window forward: un-minimise, show, focus.
pub fn bring_forward(app: &AppHandle, label: &str) {
    if let Some(w) = app.get_webview_window(label) {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

/// Builds `view`'s window if it isn't there, showing it unless `show` is false.
fn build(app: &AppHandle, view: &str, show: bool) -> Result<(), String> {
    if app.get_webview_window(view).is_some() {
        if show {
            bring_forward(app, view);
        }
        return Ok(());
    }
    let title = if view == "code" { "OtherBench Code" } else { "OtherBench Overview" };
    crate::links::window(app, view, WebviewUrl::App(format!("index.html?view={view}").into()))
        .title(title)
        .inner_size(1280.0, 820.0)
        .min_inner_size(800.0, 500.0)
        .visible(show)
        .disable_drag_drop_handler()
        .build()
        .map_err(|e| e.to_string())?;
    if show {
        bring_forward(app, view);
    }
    Ok(())
}

/// Opens `view` in its own window, or brings it forward if it already has one.
pub fn undock(app: &AppHandle, view: &str) -> Result<(), String> {
    if !is_view(view) {
        return Err(format!("{view} can't be undocked."));
    }
    build(app, view, true)?;
    if !current().iter().any(|v| v == view) {
        record(app, view, true);
    }
    Ok(())
}

/// Puts `view` back in the main window: its window closes (`closed` records it).
pub fn dock(app: &AppHandle, view: &str) {
    if !is_view(view) {
        return;
    }
    match app.get_webview_window(view) {
        Some(w) => {
            let _ = w.close();
        }
        None => closed(app, view),
    }
    crate::tray::show_main(app);
}

/// The user closed `view`'s window: it is docked again.
pub fn closed(app: &AppHandle, view: &str) {
    if current().iter().any(|v| v == view) {
        record(app, view, false);
    }
}

/// At setup: the views undocked when OtherBench last quit get their windows back,
/// hidden on a sign-in launch until the tray brings them out.
pub fn restore(app: &AppHandle, show: bool) {
    let saved: Vec<String> = file(app)
        .and_then(|path| std::fs::read_to_string(path).ok())
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default();
    let list = known(&saved);
    *UNDOCKED.lock().unwrap_or_else(|e| e.into_inner()) = list.clone();
    for view in list {
        if let Err(e) = build(app, &view, show) {
            eprintln!("[otherbench-desktop] couldn't reopen the {view} window: {e}");
        }
    }
}

/// The tray's Open: the undocked windows come out with the main one.
pub fn show_all(app: &AppHandle) {
    for view in current() {
        bring_forward(app, &view);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_known_views_are_kept_once_each_in_order() {
        let list = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert_eq!(known(&list(&["overview", "code", "code", "main", "quick"])), list(&["code", "overview"]));
        assert_eq!(known(&list(&["computer-indicator"])), Vec::<String>::new());
    }

    #[test]
    fn the_main_window_is_a_target_but_never_a_view() {
        assert!(is_target("main") && !is_view("main"));
        assert!(is_view("code") && is_view("overview"));
        assert!(!is_target("quick") && !is_target("computer-indicator"));
    }
}
