//! Websites never open inside OtherBench: they go to the default browser.
//! The web app sends its links there itself (bridge.ts `openInBrowser`); every
//! window is also built here, with rules for whatever the web app doesn't
//! catch. A window never navigates itself to a website (a link dropped onto
//! it), and a request for a new window ("Open link in new window", a
//! Shift- or middle-click, `window.open`) never opens one inside OtherBench.

use tauri::webview::NewWindowResponse;
use tauri::{AppHandle, Runtime, Url, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_opener::OpenerExt;

/// Whether a window may go to `url` itself: anything but a website. The app's
/// own pages (tauri.localhost, the dev server on localhost) and the server on
/// 127.0.0.1 are not websites.
fn stays_in_app(url: &Url) -> bool {
    if !matches!(url.scheme(), "http" | "https") {
        return true;
    }
    matches!(url.host_str(), Some("tauri.localhost" | "localhost" | "127.0.0.1" | "[::1]"))
}

fn to_browser<R: Runtime>(app: &AppHandle<R>, url: &Url) {
    if let Err(e) = app.opener().open_url(url.as_str(), None::<&str>) {
        eprintln!("[otherbench-desktop] couldn't open {url} in the browser: {e}");
    }
}

/// `builder` with the link rules: a website it navigates to, or asks a new
/// window for, opens in the default browser instead, and no new window opens.
fn with_rules<'a, R: Runtime>(builder: WebviewWindowBuilder<'a, R, AppHandle<R>>, app: &AppHandle<R>) -> WebviewWindowBuilder<'a, R, AppHandle<R>> {
    let (navigating, opening) = (app.clone(), app.clone());
    builder
        .on_navigation(move |url| {
            if stays_in_app(url) {
                return true;
            }
            to_browser(&navigating, url);
            false
        })
        .on_new_window(move |url, _| {
            if !stays_in_app(&url) {
                to_browser(&opening, &url);
            }
            NewWindowResponse::Deny
        })
}

/// A new window with the link rules. Every window OtherBench builds starts here.
pub fn window<'a, R: Runtime>(app: &'a AppHandle<R>, label: &str, url: WebviewUrl) -> WebviewWindowBuilder<'a, R, AppHandle<R>> {
    with_rules(WebviewWindowBuilder::new(app, label, url), app)
}

/// The windows tauri.conf.json describes (main and quick chat), built hidden as it says.
/// They are `create: false` there, so Tauri leaves them to this and they get the link rules.
pub fn app_windows<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    for config in &app.config().app.windows {
        with_rules(WebviewWindowBuilder::from_config(app, config)?, app).build()?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn websites_leave_the_app_and_its_own_pages_stay() {
        for site in ["https://example.com/a?b=1", "http://example.com", "https://localhost.example.com", "http://192.168.1.10:8080"] {
            assert!(!stays_in_app(&Url::parse(site).unwrap()), "{site} should open in the browser");
        }
        for own in ["http://tauri.localhost/index.html?view=quick", "https://tauri.localhost", "tauri://localhost", "http://localhost:5173/", "http://127.0.0.1:4747/otherbench-ca.crt", "http://[::1]:4747", "about:blank", "data:text/plain,x"] {
            assert!(stays_in_app(&Url::parse(own).unwrap()), "{own} should stay in the app");
        }
    }

    /// Every .rs file under `dir`, with its path.
    fn sources(dir: &std::path::Path, out: &mut Vec<(String, String)>) {
        for entry in std::fs::read_dir(dir).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                sources(&path, out);
            } else if path.extension().is_some_and(|e| e == "rs") {
                out.push((path.display().to_string(), std::fs::read_to_string(&path).unwrap()));
            }
        }
    }

    /// Tauri builds a window tauri.conf.json describes itself unless it says `create: false`,
    /// and then no new-window rule can be added to it; any other window is built in code.
    #[test]
    fn every_window_is_built_here_with_the_rules() {
        let conf: serde_json::Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let windows = conf["app"]["windows"].as_array().unwrap();
        assert_eq!(windows.len(), 2);
        for w in windows {
            assert_eq!(w["create"], false, "Tauri must leave {} to app_windows", w["label"]);
        }
        let mut files = Vec::new();
        sources(std::path::Path::new(concat!(env!("CARGO_MANIFEST_DIR"), "/src")), &mut files);
        assert!(files.len() > 10, "{files:?}");
        for (path, src) in files {
            if path.ends_with("links.rs") {
                continue;
            }
            for builder in ["WebviewWindowBuilder::new", "WebviewWindowBuilder::from_config", "WebviewBuilder::new", "WindowBuilder::new"] {
                assert!(!src.contains(builder), "{path} uses {builder}: build windows with links::window so they get the link rules");
            }
        }
    }
}
