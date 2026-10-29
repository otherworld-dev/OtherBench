// Release builds are GUI apps: no console window alongside the webview.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod computer;
mod docks;
mod download;
mod folder;
mod hotkey;
mod legacy;
mod links;
mod notify;
mod rpc;
mod sidecar;
mod tray;
mod update;

use std::path::PathBuf;
use std::sync::{Arc, Condvar, Mutex};

use serde::Serialize;
use tauri::{Emitter, Manager, RunEvent, WindowEvent};

/// Passed by the autostart entry so a sign-in launch goes straight to the tray.
const MINIMIZED_FLAG: &str = "--minimized";

/// What the web app needs to reach its server (web/src/desktop/bridge.ts).
#[derive(Clone, Serialize)]
struct Bootstrap {
    #[serde(rename = "baseUrl")]
    base_url: String,
    token: String,
}

/// Startup outcome, filled in once by the launcher thread. `bootstrap`
/// waits on it, so the window can appear before the server is ready.
#[derive(Default)]
struct Launch {
    result: Mutex<Option<Result<Bootstrap, String>>>,
    ready: Condvar,
}

struct AppState {
    launch: Arc<Launch>,
    server: Arc<Mutex<Option<sidecar::Server>>>,
    /// This launch's own arguments (`--open-folder`, `--send`), handed to the
    /// web app once by `launch_args`; a second launch's arrive as `open-args`.
    args: Mutex<Option<Vec<String>>>,
}

/// The arguments OtherBench was started with, the first time it's asked and never
/// again, so a reload of the web app doesn't act on them twice.
#[tauri::command]
fn launch_args(state: tauri::State<'_, AppState>) -> Vec<String> {
    state.args.lock().map(|mut a| a.take().unwrap_or_default()).unwrap_or_default()
}

#[tauri::command]
async fn bootstrap(state: tauri::State<'_, AppState>) -> Result<Bootstrap, String> {
    let launch = state.launch.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut guard = launch.result.lock().map_err(|e| e.to_string())?;
        while guard.is_none() {
            guard = launch.ready.wait(guard).map_err(|e| e.to_string())?;
        }
        guard.clone().expect("checked above")
    })
    .await
    .map_err(|e| e.to_string())?
}

/// The web app's status for the tray (web/src/desktop/useTrayStatus.ts):
/// the tooltip shows how many tool calls are waiting for approval, and the
/// menu each paired machine's status line.
#[tauri::command]
fn set_tray_status(app: tauri::AppHandle, pending_approvals: u32, machines: Option<Vec<String>>) {
    tray::set_status(&app, pending_approvals, &machines.unwrap_or_default());
}

/// Makes `accelerator` the global hotkey for quick chat (Settings → Desktop).
/// The error, if any, is shown in Settings rather than failing silently.
#[tauri::command]
fn set_hotkey(app: tauri::AppHandle, shell: tauri::State<'_, Arc<computer::Shell>>, accelerator: String) -> Result<(), String> {
    hotkey::set(&app, &accelerator, || shell.shortcuts_changed())
}

#[tauri::command]
fn hide_quick(app: tauri::AppHandle) {
    hotkey::hide_quick(&app);
}

/// The indicator bar's Stop (computer.rs). The only command the indicator window may call.
#[tauri::command]
fn computer_stop(app: tauri::AppHandle) {
    computer::stop_from_shell(&app, "button");
}

/// A desktop notification; clicking it opens `chat_id` in `window` (the window
/// that holds its mode: main unless it is an undocked one), or shows
/// `reveal_path` in its folder (notify.rs).
#[tauri::command]
fn show_notification(app: tauri::AppHandle, title: String, body: String, chat_id: Option<String>, reveal_path: Option<String>, window: Option<String>) -> Result<(), String> {
    let window = window.filter(|w| docks::is_target(w) && app.get_webview_window(w).is_some()).unwrap_or_else(|| "main".to_string());
    notify::show(&app, &title, &body, chat_id, reveal_path, window)
}

/// Saves a download from the web app in the user's Downloads folder (download.rs) and returns its full path.
/// The file comes as the raw request body; its name, percent-encoded, in the `x-otherbench-name` header.
#[tauri::command]
async fn save_download(app: tauri::AppHandle, request: tauri::ipc::Request<'_>) -> Result<String, String> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("Expected the file's bytes.".into());
    };
    let name = request.headers().get("x-otherbench-name").and_then(|v| v.to_str().ok()).ok_or("Expected the file's name.")?;
    let name = download::decode_name(name)?;
    let dir = app.path().download_dir().map_err(|e| e.to_string())?;
    download::save(&dir, &name, bytes).map(|p| p.display().to_string())
}

/// The Files tree's Open in Explorer: opens a folder, never a file (folder.rs).
#[tauri::command]
fn open_folder(path: String) -> Result<(), String> {
    folder::open(&path)
}

/// Quick chat's Expand: the main window opens the chat and the quick window goes away.
#[tauri::command]
async fn open_chat(app: tauri::AppHandle, chat_id: String) {
    tray::show_main(&app);
    let _ = app.emit_to("main", "open-chat", chat_id);
    hotkey::hide_quick(&app);
}

/// Opens `view` (code or overview) in its own window (docks.rs).
///
/// This and every other command that builds, shows, focuses or closes a window
/// is async on purpose. A synchronous command runs inside WebView2's message
/// handler on the main thread, and a window built there deadlocks (a white
/// frame that can't be closed), while showing or focusing another webview from
/// there makes the windows fight over focus and leaves clicks queued for seconds.
#[tauri::command]
async fn undock(app: tauri::AppHandle, view: String) -> Result<(), String> {
    docks::undock(&app, &view)
}

/// Puts `view` back in the main window, closing its own.
#[tauri::command]
async fn dock(app: tauri::AppHandle, view: String) {
    docks::dock(&app, &view);
}

/// The views in windows of their own now.
#[tauri::command]
async fn undocked() -> Vec<String> {
    docks::current()
}

/// Brings one of the app's windows forward (the mode switch, when a mode is in another window).
#[tauri::command]
async fn show_window(app: tauri::AppHandle, window: String) {
    if docks::is_target(&window) {
        docks::bring_forward(&app, &window);
    }
}

/// Hands `request` (a chat, an app, an issue or a card to open; web/src/desktop/windows.ts
/// reads it) to the window that holds it and brings that window forward. A
/// window that isn't open gets the main window instead.
#[tauri::command]
async fn open_in(app: tauri::AppHandle, window: String, request: serde_json::Value) {
    let target = if docks::is_target(&window) && app.get_webview_window(&window).is_some() { window } else { "main".to_string() };
    docks::bring_forward(&app, &target);
    let _ = app.emit_to(target.as_str(), "open-request", request);
}

/// Which of the app's windows has focus, if any: a notification isn't shown for a chat whose window is being looked at.
#[tauri::command]
async fn focused_window(app: tauri::AppHandle) -> Option<String> {
    ["main", "code", "overview"]
        .into_iter()
        .find(|label| app.get_webview_window(label).and_then(|w| w.is_focused().ok()).unwrap_or(false))
        .map(str::to_string)
}

/// The webview origins the bundled UI can be served from. Windows uses
/// `http://tauri.localhost` by default; Linux and macOS use `tauri://localhost`.
/// Debug builds load the Vite dev server instead.
fn cors_origins() -> Vec<String> {
    let mut origins = vec![
        "http://tauri.localhost".to_string(),
        "https://tauri.localhost".to_string(),
        "tauri://localhost".to_string(),
    ];
    if cfg!(debug_assertions) {
        origins.push("http://localhost:5173".to_string());
    }
    origins
}

/// The server entry point. `OTHERBENCH_SERVER_SCRIPT` overrides; otherwise a
/// bundled `server/cli.js` resource if present (packaging, Task 40), else
/// the built server in this checkout -- which is what dev runs use.
fn server_script(app: &tauri::AppHandle) -> PathBuf {
    if let Ok(p) = std::env::var("OTHERBENCH_SERVER_SCRIPT") {
        return PathBuf::from(p);
    }
    if let Ok(dir) = app.path().resource_dir() {
        let bundled = dir.join("server").join("cli.js");
        if bundled.exists() {
            return bundled;
        }
    }
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join("packages")
        .join("server")
        .join("dist")
        .join("cli.js")
}

/// `OTHERBENCH_NODE` overrides; otherwise the Node runtime the installer carries
/// (`node/node.exe` among the resources, Task 40), else `node` from PATH --
/// which is what dev runs use.
fn node_binary(app: &tauri::AppHandle) -> PathBuf {
    if let Ok(p) = std::env::var("OTHERBENCH_NODE") {
        return PathBuf::from(p);
    }
    if let Ok(dir) = app.path().resource_dir() {
        let bundled = dir.join("node").join(if cfg!(windows) { "node.exe" } else { "node" });
        if bundled.exists() {
            return bundled;
        }
    }
    PathBuf::from("node")
}

fn main() {
    // Before the builder: the webview opens its storage folder as the windows are made.
    legacy::adopt_webview_data();
    let launch = Arc::new(Launch::default());
    let server: Arc<Mutex<Option<sidecar::Server>>> = Arc::new(Mutex::new(None));

    let app = tauri::Builder::default()
        // Must be the first plugin. A second launch exits immediately and
        // its arguments arrive here, in the running instance -- which also
        // means a second instance never tries to open the locked database.
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            tray::show_main(app);
            let _ = app.emit_to("main", "open-args", argv);
        }))
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec![MINIMIZED_FLAG]),
        ))
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(AppState { launch: launch.clone(), server: server.clone(), args: Mutex::new(Some(std::env::args().collect())) })
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        // Undocked windows open where they were last, on the same screen (docks.rs).
        // Only theirs: the main window keeps its place as before.
        .plugin(
            tauri_plugin_window_state::Builder::new()
                .with_state_flags(tauri_plugin_window_state::StateFlags::SIZE | tauri_plugin_window_state::StateFlags::POSITION | tauri_plugin_window_state::StateFlags::MAXIMIZED)
                .with_filter(docks::is_view)
                .build(),
        )
        .invoke_handler(tauri::generate_handler![bootstrap, set_tray_status, launch_args, set_hotkey, hide_quick, open_chat, show_notification, computer_stop, save_download, open_folder, undock, dock, undocked, show_window, open_in, focused_window])
        // Closing the main window hides it; the app keeps running in the
        // tray until Quit, so in-flight replies aren't cut off.
        .on_window_event(|window, event| {
            // The quick-chat window is only ever hidden too: the hotkey brings it back.
            // Closing an undocked window docks its view again (quitting doesn't ask, so they come back).
            if let WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" || window.label() == hotkey::QUICK {
                    api.prevent_close();
                    let _ = window.hide();
                } else if docks::is_view(window.label()) {
                    docks::closed(window.app_handle(), window.label());
                }
            }
        })
        .setup(move |app| {
            // Built here, not by Tauri, so they get the link rules (links.rs).
            links::app_windows(app.handle())?;
            tray::build(app.handle())?;
            // The window is created hidden (tauri.conf.json) so a sign-in
            // launch never flashes it on screen; so are the undocked ones.
            let minimized = std::env::args().any(|a| a == MINIMIZED_FLAG);
            docks::restore(app.handle(), !minimized);
            if !minimized {
                tray::show_main(app.handle());
            }

            let spec = sidecar::LaunchSpec {
                node: node_binary(app.handle()),
                script: server_script(app.handle()),
                cors_origins: cors_origins(),
                log_dir: app.path().app_log_dir()?,
            };
            // The server's computer-use channel (rpc.rs) is answered here
            // (computer.rs). Off, with no driver at all, unless the switch is set.
            let shell = computer::shell(app.handle());
            app.manage(shell.clone());
            let launch = launch.clone();
            let server = server.clone();
            let handler: Arc<dyn rpc::Handler> = shell;
            std::thread::spawn(move || {
                let outcome = sidecar::start(&spec, handler).map(|s| {
                    let boot = Bootstrap { base_url: format!("http://127.0.0.1:{}", s.port), token: s.token.clone() };
                    *server.lock().expect("server lock") = Some(s);
                    boot
                });
                if let Err(e) = &outcome {
                    eprintln!("[otherbench-desktop] server failed to start: {e}");
                }
                *launch.result.lock().expect("launch lock") = Some(outcome);
                launch.ready.notify_all();
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building the OtherBench desktop app");

    app.run(move |handle, event| {
        if let RunEvent::Exit = event {
            // Sessions end and the server is told (computer.stopped "quit") before its pipes close.
            computer::shutdown(handle);
            let state = handle.state::<AppState>();
            let taken = state.server.lock().ok().and_then(|mut s| s.take());
            if let Some(s) = taken {
                s.stop();
            }
        }
    });
}

#[cfg(test)]
mod tests {
    /// The commands `generate_handler!` registers, read from this file.
    fn registered() -> Vec<String> {
        let src = include_str!("main.rs");
        let start = src.find("generate_handler![").unwrap() + "generate_handler![".len();
        let end = start + src[start..].find(']').unwrap();
        src[start..end].split(',').map(|c| c.trim().to_string()).filter(|c| !c.is_empty()).collect()
    }

    /// Tauri lets any page it counts as local call an app command unless the
    /// app declares an ACL manifest. With one, a command needs its
    /// `allow-<command>` permission. The app windows (main, quick and the
    /// undocked ones) get every command but `computer_stop`; the indicator bar
    /// gets only that one.
    #[test]
    fn every_app_command_needs_a_permission_only_the_right_windows_have() {
        let build = include_str!("../build.rs");
        let app: serde_json::Value = serde_json::from_str(include_str!("../capabilities/default.json")).unwrap();
        let indicator: serde_json::Value = serde_json::from_str(include_str!("../capabilities/indicator.json")).unwrap();
        let app_granted = app["permissions"].to_string();
        let indicator_granted = indicator["permissions"].to_string();
        let commands = registered();
        assert!(commands.len() >= 16, "{commands:?}");
        for command in commands {
            assert!(build.contains(&format!("\"{command}\"")), "{command} is missing from the app manifest in build.rs");
            let permission = format!("\"allow-{}\"", command.replace('_', "-"));
            if command == "computer_stop" {
                assert!(indicator_granted.contains(&permission), "{permission} is not granted to the indicator");
                assert!(!app_granted.contains(&permission), "{permission} must not be granted to the app windows");
            } else {
                assert!(app_granted.contains(&permission), "{permission} is not granted to the app windows");
                assert!(!indicator_granted.contains(&permission), "{permission} must not be granted to the indicator");
            }
        }
    }

    #[test]
    fn the_app_windows_open_web_links_and_reveal_files_but_never_open_them() {
        let caps: serde_json::Value = serde_json::from_str(include_str!("../capabilities/default.json")).unwrap();
        assert_eq!(caps["windows"], serde_json::json!(["main", "quick", "code", "overview"]));
        for view in crate::docks::VIEWS {
            assert!(caps["windows"].as_array().unwrap().iter().any(|w| w == view), "{view} needs the app permissions");
        }
        assert!(caps.get("remote").is_none());
        let permissions = caps["permissions"].to_string();
        assert!(permissions.contains("opener:allow-open-url"), "web links need the opener: {permissions}");
        assert!(!permissions.contains("open-path"), "Show in folder must never open a file: {permissions}");
    }

    /// WebView2 deadlocks a window built in a synchronous command, and stalls on
    /// one shown or focused from there (tauri's WebviewWindowBuilder docs), so
    /// the commands that touch another window are async.
    #[test]
    fn the_commands_that_touch_windows_are_async() {
        let src = include_str!("main.rs");
        for command in ["undock", "dock", "undocked", "show_window", "open_in", "focused_window", "open_chat"] {
            assert!(src.contains(&format!("async fn {command}(")), "{command} touches a window, so it must be an async command");
        }
    }

    #[test]
    fn the_indicator_window_can_only_stop() {
        let indicator: serde_json::Value = serde_json::from_str(include_str!("../capabilities/indicator.json")).unwrap();
        assert_eq!(indicator["windows"], serde_json::json!(["computer-indicator"]));
        assert_eq!(indicator["permissions"], serde_json::json!(["core:default", "allow-computer-stop"]));
        assert!(indicator.get("remote").is_none());
        assert_eq!(crate::computer::INDICATOR, "computer-indicator");
    }
}
