//! Websites opened from a chat (Deck #826): each in its own window, labelled
//! so that no capability matches it, so the page gets no IPC into OtherBench.

use std::sync::atomic::{AtomicU32, Ordering};

use tauri::{AppHandle, Url, WebviewUrl, WebviewWindowBuilder};

/// Website windows are labelled `site-<n>`; capabilities/default.json names only "main" and "quick".
pub const LABEL_PREFIX: &str = "site-";
static NEXT: AtomicU32 = AtomicU32::new(1);

/// The address, if a website window may open it: http or https only.
pub fn site_url(raw: &str) -> Result<Url, String> {
    let url = Url::parse(raw.trim()).map_err(|_| format!("Not a web address: {raw}"))?;
    match url.scheme() {
        "http" | "https" => Ok(url),
        other => Err(format!("Only http and https addresses open in OtherBench, not {other}:")),
    }
}

/// Opens `raw` in a new website window.
pub fn open(app: &AppHandle, raw: &str) -> Result<(), String> {
    let url = site_url(raw)?;
    let label = format!("{LABEL_PREFIX}{}", NEXT.fetch_add(1, Ordering::Relaxed));
    let title = url.host_str().unwrap_or("Website").to_string();
    WebviewWindowBuilder::new(app, label, WebviewUrl::External(url))
        .title(title)
        .inner_size(1100.0, 800.0)
        .build()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn opens_only_http_and_https() {
        assert!(site_url("https://example.com/a?b=1").is_ok());
        assert!(site_url("  http://localhost:8080 ").is_ok());
        for bad in ["file:///C:/Windows/win.ini", "javascript:alert(1)", "tauri://localhost", "ftp://x", "not a url", ""] {
            assert!(site_url(bad).is_err(), "{bad} should be refused");
        }
    }

    #[test]
    fn site_windows_match_no_capability() {
        let caps: serde_json::Value = serde_json::from_str(include_str!("../capabilities/default.json")).unwrap();
        let windows: Vec<&str> = caps["windows"].as_array().unwrap().iter().map(|w| w.as_str().unwrap()).collect();
        assert_eq!(windows, ["main", "quick"]);
        assert!(caps.get("remote").is_none());
        let permissions = caps["permissions"].to_string();
        assert!(!permissions.contains("open-path"), "Show in folder must never open a file: {permissions}");
    }
}
