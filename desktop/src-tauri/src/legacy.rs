//! OtherBench was called Grunt until October 2026, with the identifier
//! `dev.otherworld.grunt`. The webview keeps its storage (the web app's saved
//! preferences) and the shell its logs in the identifier's folder under
//! `%LOCALAPPDATA%`, so the first start under the new identifier moves the
//! old folder across before any window opens. Only while the new folder
//! doesn't exist yet. If Grunt is still running the move fails, and the app
//! starts with its default preferences, which is all that is lost.

use std::path::Path;

const LEGACY_IDENTIFIER: &str = "dev.otherworld.grunt";
/// tauri.conf.json's `identifier` (a test checks they agree).
const IDENTIFIER: &str = "dev.otherworld.otherbench";

/// Moves Grunt's webview data and logs to OtherBench's folder. Windows only
/// (the one place Grunt was installed): elsewhere `LOCALAPPDATA` isn't set.
pub fn adopt_webview_data() {
    if let Some(base) = std::env::var_os("LOCALAPPDATA") {
        adopt_in(Path::new(&base));
    }
}

/// Whether it moved the folder.
fn adopt_in(base: &Path) -> bool {
    let old = base.join(LEGACY_IDENTIFIER);
    let new = base.join(IDENTIFIER);
    if new.exists() || !old.is_dir() {
        return false;
    }
    std::fs::rename(&old, &new).is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;

    fn temp_base(name: &str) -> PathBuf {
        let base = std::env::temp_dir().join(format!("otherbench-legacy-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        fs::create_dir_all(&base).unwrap();
        base
    }

    #[test]
    fn identifier_matches_tauri_conf() {
        let conf: serde_json::Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        assert_eq!(conf["identifier"], IDENTIFIER);
    }

    #[test]
    fn moves_grunts_folder_once() {
        let base = temp_base("move");
        fs::create_dir_all(base.join(LEGACY_IDENTIFIER).join("EBWebView")).unwrap();
        fs::write(base.join(LEGACY_IDENTIFIER).join("EBWebView").join("prefs"), "x").unwrap();

        assert!(adopt_in(&base));
        assert!(!base.join(LEGACY_IDENTIFIER).exists());
        assert_eq!(fs::read_to_string(base.join(IDENTIFIER).join("EBWebView").join("prefs")).unwrap(), "x");
        assert!(!adopt_in(&base), "nothing left to move");
        fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn leaves_both_alone_once_the_new_folder_exists() {
        let base = temp_base("exists");
        fs::create_dir_all(base.join(LEGACY_IDENTIFIER)).unwrap();
        fs::create_dir_all(base.join(IDENTIFIER)).unwrap();

        assert!(!adopt_in(&base));
        assert!(base.join(LEGACY_IDENTIFIER).exists());
        fs::remove_dir_all(&base).unwrap();
    }
}
