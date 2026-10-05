// Release builds are GUI apps: no console window alongside the webview.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod hotkey;
mod notify;
mod sidecar;
mod tray;

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

/// The arguments Grunt was started with, the first time it's asked and never
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
/// the tooltip shows how many tool calls are waiting for approval.
#[tauri::command]
fn set_tray_status(app: tauri::AppHandle, pending_approvals: u32) {
    tray::set_status(&app, pending_approvals);
}

/// Makes `accelerator` the global hotkey for quick chat (Settings → Desktop).
/// The error, if any, is shown in Settings rather than failing silently.
#[tauri::command]
fn set_hotkey(app: tauri::AppHandle, accelerator: String) -> Result<(), String> {
    hotkey::set(&app, &accelerator)
}

#[tauri::command]
fn hide_quick(app: tauri::AppHandle) {
    hotkey::hide_quick(&app);
}

/// A desktop notification; clicking it opens `chat_id` (notify.rs).
#[tauri::command]
fn show_notification(app: tauri::AppHandle, title: String, body: String, chat_id: Option<String>) -> Result<(), String> {
    notify::show(&app, &title, &body, chat_id)
}

/// Quick chat's Expand: the main window opens the chat and the quick window goes away.
#[tauri::command]
fn open_chat(app: tauri::AppHandle, chat_id: String) {
    tray::show_main(&app);
    let _ = app.emit_to("main", "open-chat", chat_id);
    hotkey::hide_quick(&app);
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

/// The server entry point. `GRUNT_SERVER_SCRIPT` overrides; otherwise a
/// bundled `server/cli.js` resource if present (packaging, Task 40), else
/// the built server in this checkout -- which is what dev runs use.
fn server_script(app: &tauri::AppHandle) -> PathBuf {
    if let Ok(p) = std::env::var("GRUNT_SERVER_SCRIPT") {
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

/// `GRUNT_NODE` overrides; otherwise the Node runtime the installer carries
/// (`node/node.exe` among the resources, Task 40), else `node` from PATH --
/// which is what dev runs use.
fn node_binary(app: &tauri::AppHandle) -> PathBuf {
    if let Ok(p) = std::env::var("GRUNT_NODE") {
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
        .manage(AppState { launch: launch.clone(), server: server.clone(), args: Mutex::new(Some(std::env::args().collect())) })
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .invoke_handler(tauri::generate_handler![bootstrap, set_tray_status, launch_args, set_hotkey, hide_quick, open_chat, show_notification])
        // Closing the main window hides it; the app keeps running in the
        // tray until Quit, so in-flight replies aren't cut off.
        .on_window_event(|window, event| {
            // The quick-chat window is only ever hidden too: the hotkey brings it back.
            if let WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" || window.label() == hotkey::QUICK {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .setup(move |app| {
            tray::build(app.handle())?;
            // The window is created hidden (tauri.conf.json) so a sign-in
            // launch never flashes it on screen.
            if !std::env::args().any(|a| a == MINIMIZED_FLAG) {
                tray::show_main(app.handle());
            }

            let spec = sidecar::LaunchSpec {
                node: node_binary(app.handle()),
                script: server_script(app.handle()),
                cors_origins: cors_origins(),
                log_dir: app.path().app_log_dir()?,
            };
            let launch = launch.clone();
            let server = server.clone();
            std::thread::spawn(move || {
                let outcome = sidecar::start(&spec).map(|s| {
                    let boot = Bootstrap { base_url: format!("http://127.0.0.1:{}", s.port), token: s.token.clone() };
                    *server.lock().expect("server lock") = Some(s);
                    boot
                });
                if let Err(e) = &outcome {
                    eprintln!("[grunt-desktop] server failed to start: {e}");
                }
                *launch.result.lock().expect("launch lock") = Some(outcome);
                launch.ready.notify_all();
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building the Grunt desktop app");

    app.run(move |handle, event| {
        if let RunEvent::Exit = event {
            let state = handle.state::<AppState>();
            let taken = state.server.lock().ok().and_then(|mut s| s.take());
            if let Some(s) = taken {
                s.stop();
            }
        }
    });
}
