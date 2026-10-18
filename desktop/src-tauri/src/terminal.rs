//! A terminal window in a chat's workspace folder (Inspector → Workspace →
//! Open terminal), for the commands the user runs themselves: logins, prompts,
//! anything interactive. Only the desktop app can start one; the server has no
//! route for it, since with sign-in on a browser on another machine reaches
//! every server route.
//!
//! The folder is never put on a command line. It becomes the child's working
//! directory and the terminal is told to open "here": Windows Terminal splits
//! its arguments on `;`, so a folder named `a; b` would otherwise be read as a
//! second command.

use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::process::Command;

/// The folder, if a terminal may open in it: an absolute path to a directory that exists.
pub fn folder(raw: &str) -> Result<PathBuf, String> {
    let path = Path::new(raw.trim());
    if !path.is_absolute() {
        return Err(format!("Not an absolute path: {raw}"));
    }
    if !path.is_dir() {
        return Err(format!("No such folder on this machine: {raw}"));
    }
    Ok(path.to_path_buf())
}

/// What to try, in order: a program and its arguments, run in the folder.
fn candidates() -> Vec<(&'static str, &'static [&'static str])> {
    if cfg!(windows) {
        // `-d .` is the working directory. PowerShell gets a console of its own (see `open`).
        vec![("wt.exe", &["-d", "."]), ("powershell.exe", &["-NoLogo"])]
    } else if cfg!(target_os = "macos") {
        vec![("open", &["-a", "Terminal", "."])]
    } else {
        vec![("x-terminal-emulator", &[]), ("gnome-terminal", &[]), ("konsole", &[]), ("xterm", &[])]
    }
}

/// Opens a terminal window in `raw`. The first candidate that is installed wins.
pub fn open(raw: &str) -> Result<(), String> {
    let dir = folder(raw)?;
    let mut tried = Vec::new();
    for (program, args) in candidates() {
        let mut cmd = Command::new(program);
        cmd.args(args).current_dir(&dir);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            // Release builds have no console, debug ones do; either way PowerShell gets its own window.
            const CREATE_NEW_CONSOLE: u32 = 0x0000_0010;
            cmd.creation_flags(CREATE_NEW_CONSOLE);
        }
        match cmd.spawn() {
            Ok(_) => return Ok(()),
            Err(e) if e.kind() == ErrorKind::NotFound => tried.push(program),
            Err(e) => return Err(format!("{program} didn't start: {e}")),
        }
    }
    Err(format!("No terminal found: tried {}.", tried.join(" and ")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn opens_only_in_a_folder_that_exists() {
        let dir = std::env::temp_dir();
        assert_eq!(folder(dir.to_str().unwrap()).unwrap(), dir);
        let file = dir.join(format!("otherbench-terminal-test-{}", std::process::id()));
        std::fs::write(&file, b"x").unwrap();
        let missing = dir.join("otherbench-terminal-test-missing").join("nope");
        for bad in [file.to_str().unwrap(), missing.to_str().unwrap(), "relative\\folder", "relative/folder", ""] {
            assert!(folder(bad).is_err(), "{bad} should be refused");
        }
        std::fs::remove_file(&file).unwrap();
    }

    #[test]
    fn the_folder_never_goes_on_a_command_line() {
        // Every argument is a fixed string: the folder only ever reaches a terminal as its working directory.
        for (program, args) in candidates() {
            assert!(!program.is_empty());
            for arg in args {
                assert!(*arg == "." || arg.starts_with('-') || *arg == "Terminal", "{program} {arg}");
            }
        }
    }
}
