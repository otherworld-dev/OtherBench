fn main() {
    // An app ACL manifest: each app command then needs its `allow-<command>`
    // permission, which capabilities/default.json grants only to the app windows
    // (main, quick and the undocked code and overview). Without one, Tauri lets any page it counts as local call
    // every app command. main.rs's tests check every registered command is here.
    // `computer_stop` is granted only to the computer-use indicator bar (capabilities/indicator.json).
    let commands = &["bootstrap", "set_tray_status", "launch_args", "set_hotkey", "hide_quick", "open_chat", "show_notification", "computer_stop", "save_download", "open_folder", "undock", "dock", "undocked", "show_window", "open_in", "focused_window"];
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(tauri_build::AppManifest::new().commands(commands)))
        .expect("failed to run tauri-build");
}
