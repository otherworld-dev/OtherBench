fn main() {
    // An app ACL manifest: each app command then needs its `allow-<command>`
    // permission, which capabilities/default.json grants only to the main and
    // quick windows. Without one, Tauri lets any page it counts as local call
    // every app command, including a website window showing the dev server's
    // pages (Deck #826). main.rs's tests check every registered command is here.
    // `computer_stop` is granted only to the computer-use indicator bar (capabilities/indicator.json).
    let commands = &["bootstrap", "set_tray_status", "launch_args", "set_hotkey", "hide_quick", "open_chat", "show_notification", "open_site", "computer_stop", "save_download", "open_terminal"];
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(tauri_build::AppManifest::new().commands(commands)))
        .expect("failed to run tauri-build");
}
