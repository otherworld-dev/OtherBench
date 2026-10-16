//! Saving a download from the web app into the user's Downloads folder.
//!
//! In the desktop window WebView2 saved a download silently, and the page
//! never learnt where it went. The web app now hands the bytes here instead
//! (`save_download`), gets the full path back, and says so in a toast with
//! "Show in folder". Only OtherBench's own files come this way (chat exports and
//! artifact downloads), but the name is still checked as if it weren't: no
//! folders, no Windows device names, nothing Windows would run on a
//! double-click. Windows' "came from the internet" mark (Mark of the Web) is
//! added as WebView2 did, so a spreadsheet the model made still opens in
//! Protected View.

use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

/// The largest download accepted.
pub const MAX_BYTES: usize = 100 * 1024 * 1024;

/// The extensions OtherBench makes: chat exports (.md, .json) and artifact files, by kind and by code language
/// (`KIND_EXT` and `LANGUAGE_EXT` in packages/core/src/domain/artifacts.ts, less `ps1`). Any other extension,
/// or none, gets `.txt` added (`script.ps1.txt`, `report.pdf.exe.txt`), so whatever comes this way opens in a
/// text editor rather than running. An allowlist rather than a list of what to refuse, since such a list is
/// never complete; a language added in TypeScript later falls back to `.txt`, which is safe.
const ALLOWED_EXTENSIONS: &[&str] = &[
    "md", "json", "txt", "html", "mmd", "svg", "docx", "xlsx", "pptx", "csv", "ts", "tsx", "js", "jsx", "mjs", "cjs", "py", "rs", "go",
    "java", "kt", "rb", "php", "cs", "cpp", "c", "h", "hpp", "swift", "scala", "dart", "lua", "r", "sh", "sql", "yml", "toml", "ini", "xml",
    "css", "scss",
];

/// Characters that change how a name displays without being seen (direction overrides, zero-width and other
/// format characters), which can make a `.exe` name read as a `.xlsx` one.
fn is_invisible(c: char) -> bool {
    matches!(c, '\u{00AD}' | '\u{061C}' | '\u{180E}' | '\u{200B}'..='\u{200F}' | '\u{202A}'..='\u{202E}' | '\u{2060}'..='\u{206F}' | '\u{FEFF}' | '\u{FFF9}'..='\u{FFFB}')
}

/// Names Windows treats as devices, whatever the extension.
const DEVICE_NAMES: &[&str] = &[
    "con", "prn", "aux", "nul", "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8", "com9", "lpt1", "lpt2", "lpt3", "lpt4",
    "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
];

/// `name` as a file name to save under (with `.txt` added when its extension isn't one OtherBench makes), or why it
/// can't be one.
pub fn safe_name(name: &str) -> Result<String, String> {
    let name = name.trim();
    if name.is_empty() || name.chars().count() > 200 {
        return Err("The file name is empty or too long.".into());
    }
    if name.chars().any(|c| c.is_control() || is_invisible(c) || matches!(c, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*')) {
        return Err(format!("\"{name}\" isn't a file name Windows allows."));
    }
    if name.ends_with('.') || name.ends_with(' ') || name == "." || name == ".." {
        return Err(format!("\"{name}\" isn't a file name Windows allows."));
    }
    let stem = name.split('.').next().unwrap_or("").trim_end().to_ascii_lowercase();
    if DEVICE_NAMES.contains(&stem.as_str()) {
        return Err(format!("\"{name}\" is a name Windows keeps for a device."));
    }
    let allowed = name.rsplit_once('.').is_some_and(|(stem, ext)| !stem.is_empty() && ALLOWED_EXTENSIONS.contains(&ext.to_ascii_lowercase().as_str()));
    Ok(if allowed { name.to_string() } else { format!("{name}.txt") })
}

/// Opens a new file in `dir` named `name`, or `stem (1).ext`, `stem (2).ext`, ... when that is taken. The file is
/// created exclusively, so nothing that appears in the meantime is overwritten.
fn create_unique(dir: &Path, name: &str) -> Result<(PathBuf, File), String> {
    let (stem, ext) = match name.rsplit_once('.') {
        Some((s, e)) if !s.is_empty() => (s.to_string(), format!(".{e}")),
        _ => (name.to_string(), String::new()),
    };
    for n in 0..1000 {
        let candidate = if n == 0 { dir.join(name) } else { dir.join(format!("{stem} ({n}){ext}")) };
        match OpenOptions::new().write(true).create_new(true).open(&candidate) {
            Ok(f) => return Ok((candidate, f)),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(format!("Couldn't save {}: {e}", candidate.display())),
        }
    }
    Err(format!("Couldn't find a free name for {name} in {}.", dir.display()))
}

/// Marks `path` as downloaded from the internet (zone 3), as a browser does. NTFS only; elsewhere it is skipped.
fn mark_from_internet(path: &Path) {
    #[cfg(windows)]
    {
        let stream = format!("{}:Zone.Identifier", path.display());
        if let Ok(mut f) = File::create(stream) {
            let _ = f.write_all(b"[ZoneTransfer]\r\nZoneId=3\r\n");
        }
    }
    #[cfg(not(windows))]
    let _ = path;
}

/// Saves `bytes` in `dir` under `name` (checked, made unique) and returns the full path.
pub fn save(dir: &Path, name: &str, bytes: &[u8]) -> Result<PathBuf, String> {
    if bytes.len() > MAX_BYTES {
        return Err(format!("The file is larger than {} MB.", MAX_BYTES / (1024 * 1024)));
    }
    let name = safe_name(name)?;
    std::fs::create_dir_all(dir).map_err(|e| format!("Couldn't open {}: {e}", dir.display()))?;
    let (path, mut file) = create_unique(dir, &name)?;
    if let Err(e) = file.write_all(bytes).and_then(|()| file.sync_all()) {
        drop(file);
        let _ = std::fs::remove_file(&path);
        return Err(format!("Couldn't write {}: {e}", path.display()));
    }
    drop(file);
    mark_from_internet(&path);
    Ok(path)
}

/// The file name the web app sends in the `x-otherbench-name` header, percent-encoded so any name survives a header.
pub fn decode_name(encoded: &str) -> Result<String, String> {
    let bytes = encoded.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = encoded.get(i + 1..i + 3).ok_or("The file name is badly encoded.")?;
            out.push(u8::from_str_radix(hex, 16).map_err(|_| "The file name is badly encoded.")?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).map_err(|_| "The file name is badly encoded.".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("otherbench-download-test-{}-{}", std::process::id(), rand_suffix()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }
    fn rand_suffix() -> u128 {
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
    }

    #[test]
    fn keeps_ordinary_names() {
        for ok in ["expenses.xlsx", "Trip plans.md", "report.final.docx", "café menu.pptx", "main.js", "script.py", "a.MD", "b.Json", "f.svg", "g.mmd", "h.html", "k.sh", "l.csv"] {
            assert_eq!(safe_name(ok).unwrap(), ok);
        }
        // Surrounding spaces are trimmed (Windows would drop a trailing one anyway); a trailing dot is refused.
        assert_eq!(safe_name("  padded.txt  ").unwrap(), "padded.txt");
        assert_eq!(safe_name("trailing.md ").unwrap(), "trailing.md");
    }

    #[test]
    fn adds_txt_to_anything_otherbench_does_not_make() {
        for (given, saved) in [
            ("setup.exe", "setup.exe.txt"),
            ("run.BAT", "run.BAT.txt"),
            ("go.ps1", "go.ps1.txt"),
            ("page.hta", "page.hta.txt"),
            ("short.lnk", "short.lnk.txt"),
            ("report.pdf.exe", "report.pdf.exe.txt"),
            ("tool.jar", "tool.jar.txt"),
            ("help.chm", "help.chm.txt"),
            ("snap.msc", "snap.msc.txt"),
            ("add.xll", "add.xll.txt"),
            ("noext", "noext.txt"),
            (".md", ".md.txt"),
        ] {
            assert_eq!(safe_name(given).unwrap(), saved, "{given}");
        }
    }

    #[test]
    fn refuses_invisible_characters_that_disguise_a_name() {
        for bad in ["evil\u{202E}xslx.exe", "a\u{200B}b.md", "x\u{FEFF}.md", "y\u{2066}z.md", "soft\u{00AD}hy.md"] {
            assert!(safe_name(bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn refuses_folders_devices_and_odd_endings() {
        for bad in ["", "../up.txt", "a/b.txt", "a\\b.txt", "C:evil.txt", "file:stream.txt", "what?.txt", "x*.md", "trailing.", "..", "tab\there.md", "CON", "con.txt", "Lpt1.md", "AUX .txt"] {
            assert!(safe_name(bad).is_err(), "{bad:?} should be refused");
        }
        assert!(safe_name(&"a".repeat(201)).is_err());
    }

    #[test]
    fn saves_and_never_overwrites() {
        let dir = temp();
        let first = save(&dir, "expenses.xlsx", b"one").unwrap();
        let second = save(&dir, "expenses.xlsx", b"two").unwrap();
        let third = save(&dir, "expenses.xlsx", b"three").unwrap();
        assert_eq!(first.file_name().unwrap(), "expenses.xlsx");
        assert_eq!(second.file_name().unwrap(), "expenses (1).xlsx");
        assert_eq!(third.file_name().unwrap(), "expenses (2).xlsx");
        assert_eq!(std::fs::read(&first).unwrap(), b"one");
        assert_eq!(std::fs::read(&third).unwrap(), b"three");
        let plain = save(&dir, "notes", b"x").unwrap();
        let plain2 = save(&dir, "notes", b"y").unwrap();
        assert_eq!(plain.file_name().unwrap(), "notes.txt");
        assert_eq!(plain2.file_name().unwrap(), "notes (1).txt");
        // A name OtherBench doesn't make is saved as text, never as something Windows would run.
        assert_eq!(save(&dir, "run.exe", b"x").unwrap().file_name().unwrap(), "run.exe.txt");
        assert_eq!(std::fs::read(&plain).unwrap(), b"x");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn refuses_a_bad_name_or_a_too_large_file_without_writing() {
        let dir = temp();
        assert!(save(&dir, "../escape.txt", b"x").is_err());
        assert!(save(&dir, "evil\u{202E}xslx.exe", b"x").is_err());
        assert!(save(&dir, "big.bin", &vec![0u8; MAX_BYTES + 1]).is_err());
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 0);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn marks_the_file_as_from_the_internet() {
        let dir = temp();
        let path = save(&dir, "made.xlsx", b"x").unwrap();
        let zone = std::fs::read_to_string(format!("{}:Zone.Identifier", path.display())).unwrap();
        assert!(zone.contains("ZoneId=3"), "{zone}");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn decodes_the_header_name() {
        assert_eq!(decode_name("Trip%20plans%20%C3%A9.md").unwrap(), "Trip plans é.md");
        assert_eq!(decode_name("plain.txt").unwrap(), "plain.txt");
        assert!(decode_name("bad%2").is_err());
        assert!(decode_name("bad%zz").is_err());
        assert!(decode_name("%FF%FE").is_err());
    }
}
