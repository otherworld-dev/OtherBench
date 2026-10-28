//! Desktop notifications whose click opens the chat they're about (#775), or
//! shows a finished download in its folder.
//!
//! tauri-plugin-notification can't report a click on desktop, so on Windows
//! the toast is shown here directly, with an activation handler that brings
//! OtherBench forward and opens the chat. Elsewhere the plugin shows it and the
//! tray icon opens the last notified chat instead.

use tauri::AppHandle;

/// Shows a notification; clicking it opens `chat_id` in `window` (main or an undocked one), or shows
/// `reveal_path` in Explorer (Windows). A path outside the user's Downloads folder is never revealed.
pub fn show(app: &AppHandle, title: &str, body: &str, chat_id: Option<String>, reveal_path: Option<String>, window: String) -> Result<(), String> {
    let reveal = reveal_path.filter(|p| in_downloads(app, std::path::Path::new(p)));
    #[cfg(windows)]
    {
        windows::show(app, title, body, chat_id, reveal, window)
    }
    #[cfg(not(windows))]
    {
        let _ = (chat_id, reveal, window);
        use tauri_plugin_notification::NotificationExt;
        app.notification().builder().title(title).body(body).show().map_err(|e| e.to_string())
    }
}

/// Whether `path` is a file directly in the user's Downloads folder, where `save_download` puts them.
fn in_downloads(app: &AppHandle, path: &std::path::Path) -> bool {
    use tauri::Manager;
    let Ok(dir) = app.path().download_dir() else { return false };
    match (path.parent().and_then(|p| p.canonicalize().ok()), dir.canonicalize().ok()) {
        (Some(parent), Some(dir)) => parent == dir && path.is_file(),
        _ => false,
    }
}

#[cfg(windows)]
mod windows {
    use tauri::{AppHandle, Emitter};
    use tauri_winrt_notification::Toast;

    /// The app id a toast is shown under. A dev build isn't registered with
    /// Windows, so its toasts borrow PowerShell's (as the notification plugin
    /// does); the installed app uses its own identifier.
    fn app_id(app: &AppHandle) -> String {
        let dev_build = tauri::utils::platform::current_exe()
            .ok()
            .and_then(|exe| exe.parent().map(|dir| dir.to_path_buf()))
            // Path::ends_with compares components, so "/" matches on Windows too.
            .map(|dir| dir.ends_with("target/debug") || dir.ends_with("target/release"))
            .unwrap_or(false);
        if dev_build {
            Toast::POWERSHELL_APP_ID.to_string()
        } else {
            app.config().identifier.clone()
        }
    }

    pub fn show(app: &AppHandle, title: &str, body: &str, chat_id: Option<String>, reveal: Option<String>, window: String) -> Result<(), String> {
        let handle = app.clone();
        Toast::new(&app_id(app))
            .title(title)
            .text1(body)
            .on_activated(move |_action| {
                if let Some(path) = &reveal {
                    use tauri_plugin_opener::OpenerExt;
                    let _ = handle.opener().reveal_item_in_dir(path);
                    return Ok(());
                }
                crate::docks::bring_forward(&handle, &window);
                if let Some(id) = &chat_id {
                    let _ = handle.emit_to(window.as_str(), "open-chat", id.clone());
                }
                Ok(())
            })
            .show()
            .map_err(|e| e.to_string())
    }
}
