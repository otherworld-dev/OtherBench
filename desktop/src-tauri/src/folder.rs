//! The Files tree's Open in Explorer (web/src/viewer/FileTree.tsx): opens a
//! folder in the system file manager. Only ever a plain folder, and the file
//! manager is started by name rather than through the default handler, so
//! nothing is run: a macOS `.app` is a folder that `open` would launch, and a
//! Windows folder named `x.{CLSID}` stands in for a shell object. A file is
//! shown in its folder instead (`reveal_item_in_dir`), never opened.

use std::path::{Path, PathBuf};
use std::process::Command;

/// Folder name endings a default handler treats as something to run: macOS bundles, and Windows `.{CLSID}` junctions.
const PACKAGE_ENDINGS: &[&str] = &[".app", ".bundle", ".framework", ".plugin", ".kext", ".prefpane", ".appex", ".xpc", ".qlgenerator", ".mdimporter", ".saver", ".wdgt"];

/// `path` as a folder that is safe to open: absolute, a plain folder now (links followed), and not a package.
pub fn folder_to_open(path: &str) -> Result<PathBuf, String> {
    let given = Path::new(path);
    if !given.is_absolute() {
        return Err("Expected a full path.".into());
    }
    let folder = std::fs::canonicalize(given).map_err(|_| "That folder isn't there any more.".to_string())?;
    if !folder.is_dir() {
        return Err("That isn't a folder.".into());
    }
    let name = folder.file_name().map(|n| n.to_string_lossy().to_lowercase()).unwrap_or_default();
    if PACKAGE_ENDINGS.iter().any(|e| name.ends_with(e)) || (name.ends_with('}') && name.contains(".{")) {
        return Err("That folder can't be opened from here.".into());
    }
    Ok(plain(folder))
}

/// Windows' `canonicalize` gives `\\?\C:\...`, which Explorer doesn't take: back to `C:\...` (and `\\?\UNC\` to `\\`).
fn plain(path: PathBuf) -> PathBuf {
    let s = path.to_string_lossy();
    if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
        PathBuf::from(format!(r"\\{rest}"))
    } else if let Some(rest) = s.strip_prefix(r"\\?\") {
        PathBuf::from(rest)
    } else {
        path
    }
}

pub fn open(path: &str) -> Result<(), String> {
    let folder = folder_to_open(path)?;
    let mut child = file_manager(&folder).spawn().map_err(|e| e.to_string())?;
    // Reaped off-thread: Explorer exits 1 even when it worked, so its status says nothing.
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(())
}

#[cfg(windows)]
fn file_manager(folder: &Path) -> Command {
    use std::os::windows::process::CommandExt;
    // By full path, never a search; quoted by hand, as Explorer splits an unquoted argument at commas (a path can't hold a `"`).
    let windir = std::env::var_os("SystemRoot").map(PathBuf::from).unwrap_or_else(|| PathBuf::from(r"C:\Windows"));
    let mut cmd = Command::new(windir.join("explorer.exe"));
    cmd.raw_arg(format!("\"{}\"", folder.display()));
    cmd
}

#[cfg(target_os = "macos")]
fn file_manager(folder: &Path) -> Command {
    let mut cmd = Command::new("/usr/bin/open");
    cmd.arg("-a").arg("Finder").arg(folder);
    cmd
}

#[cfg(all(unix, not(target_os = "macos")))]
fn file_manager(folder: &Path) -> Command {
    let mut cmd = Command::new("xdg-open");
    cmd.arg(folder);
    cmd
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp() -> PathBuf {
        let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let dir = std::env::temp_dir().join(format!("otherbench-folder-test-{}-{stamp}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn opens_a_folder_by_its_real_path() {
        let dir = temp();
        assert_eq!(folder_to_open(dir.to_str().unwrap()).unwrap(), plain(std::fs::canonicalize(&dir).unwrap()));
        assert!(!folder_to_open(dir.to_str().unwrap()).unwrap().to_string_lossy().starts_with(r"\\?\"));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn refuses_a_file_a_relative_path_and_a_missing_folder() {
        let dir = temp();
        let file = dir.join("tool.exe");
        std::fs::write(&file, b"MZ").unwrap();
        assert_eq!(folder_to_open(file.to_str().unwrap()).unwrap_err(), "That isn't a folder.");
        assert_eq!(folder_to_open("src").unwrap_err(), "Expected a full path.");
        assert_eq!(folder_to_open(dir.join("gone").to_str().unwrap()).unwrap_err(), "That folder isn't there any more.");
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn refuses_folders_a_default_handler_would_run() {
        let dir = temp();
        for name in ["Calc.app", "Thing.Bundle", "bin.{645FF040-5081-101B-9F08-00AA002F954E}"] {
            let package = dir.join(name);
            std::fs::create_dir_all(&package).unwrap();
            assert_eq!(folder_to_open(package.to_str().unwrap()).unwrap_err(), "That folder can't be opened from here.", "{name}");
        }
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn drops_the_verbatim_prefix() {
        assert_eq!(plain(PathBuf::from(r"\\?\C:\repo")), PathBuf::from(r"C:\repo"));
        assert_eq!(plain(PathBuf::from(r"\\?\UNC\server\share")), PathBuf::from(r"\\server\share"));
        assert_eq!(plain(PathBuf::from("/home/a")), PathBuf::from("/home/a"));
    }
}
