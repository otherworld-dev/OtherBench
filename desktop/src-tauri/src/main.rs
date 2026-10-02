// Release builds are GUI apps: no console window alongside the webview.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod sidecar;

use std::path::PathBuf;
use std::sync::{Arc, Condvar, Mutex};

use serde::Serialize;
use tauri::{Manager, RunEvent};

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

/// `GRUNT_NODE` overrides; otherwise `node` from PATH. Task 40 replaces this
/// with a bundled runtime.
fn node_binary() -> PathBuf {
    std::env::var("GRUNT_NODE").map(PathBuf::from).unwrap_or_else(|_| PathBuf::from("node"))
}

fn main() {
    let launch = Arc::new(Launch::default());
    let server: Arc<Mutex<Option<sidecar::Server>>> = Arc::new(Mutex::new(None));

    let app = tauri::Builder::default()
        .manage(AppState { launch: launch.clone(), server: server.clone() })
        .invoke_handler(tauri::generate_handler![bootstrap])
        .setup(move |app| {
            let spec = sidecar::LaunchSpec {
                node: node_binary(),
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
