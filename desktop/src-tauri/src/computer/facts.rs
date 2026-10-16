//! What the shell reports about a window: facts only, never a judgement
//! (core's `classifyTarget` decides). A fact that can't be established is
//! left out, which core reads as "ask every time" or "refuse"; `shellView`
//! is true when unsure. The pure parts of finding them out live here; the
//! Win32 calls are in win.rs.

use std::collections::HashMap;

use serde_json::{json, Map, Value};

/// The longest window title reported, in UTF-16 units (cut, not refused).
pub const MAX_TITLE_UNITS: usize = 1024;

/// The marker every page of OtherBench's web UI carries in its title. Core's
/// `OTHERBENCH_UI_TITLE_MARKER` (packages/core/src/domain/computer-apps.ts) is the
/// same string, and core refuses such a window before any card; this is the
/// one rule the shell holds besides its own shortcuts, because a browser's
/// window can turn into OtherBench's page between the card and the action (the
/// same window, process and run). A page that copies the marker only gets
/// itself refused.
pub const OTHERBENCH_UI_TITLE_MARKER: &str = "[otherbench-ui]";

/// Whether a window title shows OtherBench's own UI: it holds the marker, in any
/// letter case.
pub fn shows_otherbench_ui(title: &str) -> bool {
    title.to_ascii_lowercase().contains(OTHERBENCH_UI_TITLE_MARKER)
}

/// The titles a browser's undocked developer tools window starts with
/// (Chrome and Edge, Firefox), lower case. Core's `DEVTOOLS_TITLE_PREFIXES`
/// is the same list: such a window is a console for any page, OtherBench's own
/// included, and belongs to the browser's process, so a browser grant would
/// otherwise reach it.
pub const DEVTOOLS_TITLE_PREFIXES: [&str; 2] = ["devtools - ", "developer tools - "];

/// Whether a window title is that of an undocked developer tools window.
pub fn is_dev_tools(title: &str) -> bool {
    let lower = title.to_ascii_lowercase();
    DEVTOOLS_TITLE_PREFIXES.iter().any(|prefix| lower.starts_with(prefix))
}

/// What an action is checked against before every step: who owns the
/// window, which window it is, and its title now.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Identity {
    pub path: String,
    pub shell_view: bool,
    pub window_id: String,
    pub pid: u32,
    pub started_at: String,
    /// The window's title as it is now: never compared with the card's, only
    /// checked for OtherBench's marker (`shows_otherbench_ui`).
    pub title: String,
}

/// Every `ComputerTarget` fact (packages/core/src/ports/computer.ts).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Facts {
    pub id: Identity,
    /// None: unknown (left out). Some(None): the image has no OriginalFilename.
    pub original_name: Option<Option<String>>,
    /// The subject of a verified Authenticode signature, else None (`null`).
    pub signer: Option<String>,
    pub console: Option<bool>,
    pub location: Location,
    pub elevated: bool,
    pub ui_access: bool,
    pub otherbench: Option<bool>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Location {
    Fixed,
    Network,
    Removable,
    Unknown,
}

impl Location {
    pub fn as_str(self) -> &'static str {
        match self {
            Location::Fixed => "fixed",
            Location::Network => "network",
            Location::Removable => "removable",
            Location::Unknown => "unknown",
        }
    }

    /// From `GetDriveTypeW`: 2 removable, 3 fixed, 4 remote, 5 CD-ROM; anything else unknown.
    pub fn from_drive_type(drive_type: u32) -> Self {
        match drive_type {
            3 => Location::Fixed,
            4 => Location::Network,
            2 | 5 => Location::Removable,
            _ => Location::Unknown,
        }
    }
}

impl Facts {
    /// The `computer.target` answer. Facts that are unknown are left out.
    pub fn to_json(&self) -> Value {
        let mut m = Map::new();
        m.insert("path".into(), json!(self.id.path));
        if let Some(name) = &self.original_name {
            m.insert("originalName".into(), json!(name));
        }
        m.insert("signer".into(), json!(self.signer));
        if let Some(console) = self.console {
            m.insert("console".into(), json!(console));
        }
        m.insert("location".into(), json!(self.location.as_str()));
        m.insert("elevated".into(), json!(self.elevated));
        m.insert("uiAccess".into(), json!(self.ui_access));
        if let Some(otherbench) = self.otherbench {
            m.insert("otherbench".into(), json!(otherbench));
        }
        m.insert("shellView".into(), json!(self.id.shell_view));
        m.insert("title".into(), json!(self.id.title));
        m.insert("windowId".into(), json!(self.id.window_id));
        m.insert("pid".into(), json!(self.id.pid));
        m.insert("startedAt".into(), json!(self.id.started_at));
        Value::Object(m)
    }
}

/// `computer.act`'s `expect`: what must still be true of the live window.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Expect {
    pub app: String,
    pub shell_view: bool,
    pub window_id: String,
    pub pid: u32,
    pub started_at: String,
}

impl Expect {
    /// All five fields, each of the right type, or None.
    pub fn parse(v: Option<&Value>) -> Option<Expect> {
        let v = v?.as_object()?;
        Some(Expect {
            app: v.get("app")?.as_str().filter(|s| !s.is_empty())?.to_string(),
            shell_view: v.get("shellView")?.as_bool()?,
            window_id: v.get("windowId")?.as_str().filter(|s| !s.is_empty())?.to_string(),
            pid: u32::try_from(v.get("pid")?.as_u64()?).ok()?,
            started_at: v.get("startedAt")?.as_str().filter(|s| !s.is_empty())?.to_string(),
        })
    }

    /// All five equal, the path byte for byte (no case folding, no trimming),
    /// and the window not showing OtherBench's own UI.
    pub fn matches(&self, id: &Identity) -> bool {
        self.app.as_bytes() == id.path.as_bytes()
            && self.shell_view == id.shell_view
            && self.window_id == id.window_id
            && self.pid == id.pid
            && self.started_at == id.started_at
            && !shows_otherbench_ui(&id.title)
            && !is_dev_tools(&id.title)
    }
}

/// A final path (`GetFinalPathNameByHandleW`) without its `\\?\` prefix, in
/// one defined way: `\\?\C:\x` is `C:\x`, `\\?\UNC\s\sh\x` is `\\s\sh\x`.
/// Anything else (a volume GUID path, a device path) is None: refused.
pub fn strip_verbatim(path: &str) -> Option<String> {
    if let Some(rest) = path.strip_prefix("\\\\?\\UNC\\") {
        let mut parts = rest.split('\\');
        let (server, share) = (parts.next()?, parts.next()?);
        if server.is_empty() || share.is_empty() || parts.next().map_or(true, str::is_empty) {
            return None;
        }
        return Some(format!("\\\\{rest}"));
    }
    let rest = path.strip_prefix("\\\\?\\")?;
    let b = rest.as_bytes();
    if b.len() > 3 && b[0].is_ascii_alphabetic() && b[1] == b':' && b[2] == b'\\' {
        return Some(rest.to_string());
    }
    None
}

/// The root `GetDriveTypeW` needs for a path: `C:\` or `\\server\share\`.
pub fn drive_root(path: &str) -> Option<String> {
    if let Some(rest) = path.strip_prefix("\\\\") {
        let mut parts = rest.split('\\');
        let (server, share) = (parts.next()?, parts.next()?);
        return (!server.is_empty() && !share.is_empty()).then(|| format!("\\\\{server}\\{share}\\"));
    }
    let b = path.as_bytes();
    (b.len() >= 3 && b[0].is_ascii_alphabetic() && b[1] == b':' && b[2] == b'\\').then(|| path[..3].to_string())
}

/// The subsystem field of a PE image's optional header (2 GUI, 3 console),
/// from the file's first bytes; None when it isn't a PE image or is cut short.
pub fn pe_subsystem(bytes: &[u8]) -> Option<u16> {
    let u16_at = |at: usize| bytes.get(at..at + 2).map(|b| u16::from_le_bytes([b[0], b[1]]));
    let u32_at = |at: usize| bytes.get(at..at + 4).map(|b| u32::from_le_bytes([b[0], b[1], b[2], b[3]]));
    if bytes.get(0..2)? != b"MZ" {
        return None;
    }
    let pe = u32_at(0x3C)? as usize;
    if bytes.get(pe..pe + 4)? != b"PE\0\0" {
        return None;
    }
    let optional = pe.checked_add(24)?;
    match u16_at(optional)? {
        0x10B | 0x20B => u16_at(optional + 68),
        _ => None,
    }
}

/// Whether `bytes` bytes at address `at` lie wholly inside the buffer at
/// `start` of `len` bytes (a value `VerQueryValueW` points into it).
pub fn inside(start: usize, len: usize, at: usize, bytes: usize) -> bool {
    at >= start && at.checked_sub(start).and_then(|offset| offset.checked_add(bytes)).is_some_and(|end| end <= len)
}

/// The console subsystem.
pub const SUBSYSTEM_CONSOLE: u16 = 3;

/// Window classes of a console or terminal host.
pub fn is_console_class(class: &str) -> bool {
    matches!(class, "ConsoleWindowClass" | "CASCADIA_HOSTING_WINDOW_CLASS" | "PseudoConsoleWindow")
}

/// Whether a window is a file dialog or shell file view, from its class and
/// its descendants' classes. True when unsure: a class that couldn't be read,
/// a list that couldn't be finished, or a menu (whose owner can't be told
/// reliably, so a context menu over a file view counts as one).
pub fn shell_view(root_class: Option<&str>, descendants: &[String], complete: bool) -> bool {
    let Some(root) = root_class else { return true };
    if !complete || root == "#32768" {
        return true;
    }
    let has = |class: &str| descendants.iter().any(|c| c == class);
    has("SHELLDLL_DefView") || (root == "#32770" && has("DirectUIHWND"))
}

/// Whether `pid` is `own` or descended from it, walking parent ids. A parent
/// that started after its child is not its parent (the id was reused) and
/// ends the walk. `started` gives a process's creation time when it can be
/// read. None when the walk can't finish (too deep, a loop): unknown.
pub fn descends_from(pid: u32, own: u32, parents: &HashMap<u32, u32>, started: &dyn Fn(u32) -> Option<u64>) -> Option<bool> {
    let mut current = pid;
    let mut seen = Vec::new();
    for _ in 0..64 {
        if current == own {
            return Some(true);
        }
        if seen.contains(&current) {
            return None;
        }
        seen.push(current);
        let Some(&parent) = parents.get(&current) else { return Some(false) };
        if parent == 0 || parent == current {
            return Some(false);
        }
        if let (Some(child_at), Some(parent_at)) = (started(current), started(parent)) {
            if parent_at > child_at {
                return Some(false);
            }
        }
        current = parent;
    }
    None
}

/// A window title as reported: at most 1024 UTF-16 units, decoded lossily
/// (an unpaired surrogate, a pair cut in half, becomes U+FFFD).
pub fn title_from_units(units: &[u16]) -> String {
    String::from_utf16_lossy(&units[..units.len().min(MAX_TITLE_UNITS)])
}

/// Text from a Win32 call, refusing an unpaired surrogate (never lossy):
/// a path must always give the same string for the same program.
pub fn strict_utf16(units: &[u16]) -> Option<String> {
    String::from_utf16(units).ok()
}

/// The file name of a path, for comparing with a known program's name.
pub fn file_name(path: &str) -> &str {
    path.rsplit('\\').next().unwrap_or(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn id() -> Identity {
        Identity {
            path: "C:\\Program Files\\Fake App\\FakeApp.exe".into(),
            shell_view: false,
            window_id: "1234".into(),
            pid: 42,
            started_at: "133000000000000000".into(),
            title: "Fake App".into(),
        }
    }

    #[test]
    fn reports_every_fact_and_leaves_out_the_unknown_ones() {
        let mut f = Facts {
            id: id(),
            original_name: Some(Some("FakeApp.exe".into())),
            signer: Some("Fake Corp".into()),
            console: Some(false),
            location: Location::Fixed,
            elevated: false,
            ui_access: false,
            otherbench: Some(false),
        };
        assert_eq!(
            f.to_json(),
            json!({
                "path": "C:\\Program Files\\Fake App\\FakeApp.exe", "originalName": "FakeApp.exe", "signer": "Fake Corp", "console": false,
                "location": "fixed", "elevated": false, "uiAccess": false, "otherbench": false, "shellView": false, "title": "Fake App",
                "windowId": "1234", "pid": 42, "startedAt": "133000000000000000"
            })
        );
        f.original_name = Some(None);
        f.signer = None;
        assert_eq!(f.to_json()["originalName"], Value::Null);
        assert_eq!(f.to_json()["signer"], Value::Null);
        f.original_name = None;
        f.console = None;
        f.otherbench = None;
        let j = f.to_json();
        for left_out in ["originalName", "console", "otherbench"] {
            assert!(j.get(left_out).is_none(), "{left_out}");
        }
        assert!(j["pid"].is_u64());
    }

    #[test]
    fn never_matches_a_window_showing_otherbenchs_own_ui() {
        let e = Expect::parse(Some(&json!({ "app": id().path, "shellView": false, "windowId": "1234", "pid": 42, "startedAt": "133000000000000000" }))).unwrap();
        // The same window, process and run, now titled as OtherBench's page: a browser that went to OtherBench.
        for title in ["OtherBench [otherbench-ui] - Google Chrome", "OTHERBENCH [OTHERBENCH-UI]", "x [otherbench-ui]"] {
            let mut now = id();
            now.title = title.into();
            assert!(!e.matches(&now), "{title}");
            assert!(shows_otherbench_ui(title), "{title}");
        }
        for title in ["OtherBench", "otherbench-ui", "[otherbench ui]", ""] {
            let mut now = id();
            now.title = title.into();
            assert!(e.matches(&now), "{title}");
        }
        assert_eq!(OTHERBENCH_UI_TITLE_MARKER, "[otherbench-ui]", "core's OTHERBENCH_UI_TITLE_MARKER is the same string");
    }

    #[test]
    fn never_matches_a_browsers_undocked_developer_tools() {
        let e = Expect::parse(Some(&json!({ "app": id().path, "shellView": false, "windowId": "1234", "pid": 42, "startedAt": "133000000000000000" }))).unwrap();
        for title in ["DevTools - example.com/", "devtools - x", "Developer Tools - Inbox - https://mail.example.com/"] {
            let mut now = id();
            now.title = title.into();
            assert!(!e.matches(&now), "{title}");
            assert!(is_dev_tools(title), "{title}");
        }
        for title in ["Chrome DevTools docs - Google Chrome", "DevTools", " DevTools - x"] {
            let mut now = id();
            now.title = title.into();
            assert!(e.matches(&now), "{title}");
        }
        assert_eq!(DEVTOOLS_TITLE_PREFIXES, ["devtools - ", "developer tools - "], "core's DEVTOOLS_TITLE_PREFIXES are the same");
    }

    #[test]
    fn checks_the_whole_expectation_byte_for_byte() {
        let e = Expect::parse(Some(&json!({ "app": id().path, "shellView": false, "windowId": "1234", "pid": 42, "startedAt": "133000000000000000" }))).unwrap();
        assert!(e.matches(&id()));
        let mut other = id();
        other.path = other.path.to_lowercase();
        assert!(!e.matches(&other));
        let mut other = id();
        other.path.push(' ');
        assert!(!e.matches(&other));
        let mut other = id();
        other.shell_view = true;
        assert!(!e.matches(&other));
        let mut other = id();
        other.window_id = "1235".into();
        assert!(!e.matches(&other));
        let mut other = id();
        other.pid = 43;
        assert!(!e.matches(&other));
        let mut other = id();
        other.started_at = "1".into();
        assert!(!e.matches(&other));
    }

    #[test]
    fn a_partial_or_mistyped_expectation_is_none() {
        let whole = json!({ "app": "C:\\a.exe", "shellView": false, "windowId": "1", "pid": 2, "startedAt": "3" });
        assert!(Expect::parse(Some(&whole)).is_some());
        assert!(Expect::parse(None).is_none());
        assert!(Expect::parse(Some(&json!(null))).is_none());
        for field in ["app", "shellView", "windowId", "pid", "startedAt"] {
            let mut partial = whole.clone();
            partial.as_object_mut().unwrap().remove(field);
            assert!(Expect::parse(Some(&partial)).is_none(), "{field}");
        }
        for (field, bad) in [("app", json!(1)), ("app", json!("")), ("shellView", json!("false")), ("windowId", json!(1)), ("pid", json!("2")), ("pid", json!(-1)), ("pid", json!(2.5)), ("pid", json!(5_000_000_000u64)), ("startedAt", json!(3))] {
            let mut wrong = whole.clone();
            wrong[field] = bad.clone();
            assert!(Expect::parse(Some(&wrong)).is_none(), "{field} {bad}");
        }
    }

    #[test]
    fn strips_the_verbatim_prefix_one_way_only() {
        assert_eq!(strip_verbatim("\\\\?\\C:\\Program Files\\App\\app.exe").as_deref(), Some("C:\\Program Files\\App\\app.exe"));
        assert_eq!(strip_verbatim("\\\\?\\UNC\\server\\share\\app.exe").as_deref(), Some("\\\\server\\share\\app.exe"));
        for refused in ["\\\\?\\Volume{01234567-89ab-cdef-0123-456789abcdef}\\app.exe", "\\\\?\\UNC\\server", "\\\\?\\UNC\\server\\share", "C:\\plain.exe", "\\\\.\\C:\\x", "\\\\?\\C:"] {
            assert_eq!(strip_verbatim(refused), None, "{refused}");
        }
    }

    #[test]
    fn finds_the_drive_root_and_names_its_type() {
        assert_eq!(drive_root("C:\\x\\y.exe").as_deref(), Some("C:\\"));
        assert_eq!(drive_root("\\\\server\\share\\y.exe").as_deref(), Some("\\\\server\\share\\"));
        assert_eq!(drive_root("relative.exe"), None);
        assert_eq!(Location::from_drive_type(3), Location::Fixed);
        assert_eq!(Location::from_drive_type(4), Location::Network);
        assert_eq!(Location::from_drive_type(2), Location::Removable);
        assert_eq!(Location::from_drive_type(5), Location::Removable);
        assert_eq!(Location::from_drive_type(6), Location::Unknown);
        assert_eq!(Location::from_drive_type(0), Location::Unknown);
    }

    fn pe(subsystem: u16, magic: u16) -> Vec<u8> {
        let mut b = vec![0u8; 0x200];
        b[0..2].copy_from_slice(b"MZ");
        b[0x3C..0x40].copy_from_slice(&0x80u32.to_le_bytes());
        b[0x80..0x84].copy_from_slice(b"PE\0\0");
        b[0x98..0x9A].copy_from_slice(&magic.to_le_bytes());
        b[0x98 + 68..0x98 + 70].copy_from_slice(&subsystem.to_le_bytes());
        b
    }

    #[test]
    fn reads_the_subsystem_of_a_pe_image() {
        assert_eq!(pe_subsystem(&pe(3, 0x20B)), Some(SUBSYSTEM_CONSOLE));
        assert_eq!(pe_subsystem(&pe(2, 0x10B)), Some(2));
        assert_eq!(pe_subsystem(&pe(2, 0x999)), None);
        assert_eq!(pe_subsystem(b"MZ"), None);
        assert_eq!(pe_subsystem(b"not an image at all"), None);
        assert_eq!(pe_subsystem(&pe(3, 0x20B)[..0x90]), None);
    }

    #[test]
    fn a_version_value_must_lie_inside_its_buffer() {
        assert!(inside(1000, 100, 1000, 100));
        assert!(inside(1000, 100, 1050, 50));
        assert!(!inside(1000, 100, 1050, 51));
        assert!(!inside(1000, 100, 999, 2));
        assert!(!inside(1000, 100, usize::MAX - 1, 4));
        assert!(!inside(1000, 100, 1001, usize::MAX));
        assert!(inside(1000, 100, 1100, 0));
    }

    #[test]
    fn a_file_view_or_anything_unsure_is_a_shell_view() {
        let c = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert!(!shell_view(Some("Notepad"), &c(&["Edit"]), true));
        assert!(shell_view(Some("CabinetWClass"), &c(&["ShellTabWindowClass", "SHELLDLL_DefView", "DirectUIHWND"]), true));
        assert!(shell_view(Some("#32770"), &c(&["DUIViewWndClassName", "DirectUIHWND"]), true));
        assert!(!shell_view(Some("#32770"), &c(&["Button", "Static"]), true));
        assert!(shell_view(Some("#32768"), &[], true));
        assert!(shell_view(None, &[], true));
        assert!(shell_view(Some("Notepad"), &[], false));
        assert!(shell_view(Some("Chrome_WidgetWin_1"), &c(&["SHELLDLL_DefView"]), true));
    }

    #[test]
    fn walks_the_parent_chain_and_stops_at_a_reused_id() {
        let parents: HashMap<u32, u32> = [(30, 20), (20, 10), (10, 4), (50, 10), (60, 60), (70, 71), (71, 70)].into_iter().collect();
        let times: HashMap<u32, u64> = [(10, 100), (20, 200), (30, 300), (50, 50)].into_iter().collect();
        let started = |p: u32| times.get(&p).copied();
        assert_eq!(descends_from(30, 10, &parents, &started), Some(true));
        assert_eq!(descends_from(10, 10, &parents, &started), Some(true));
        assert_eq!(descends_from(20, 30, &parents, &started), Some(false));
        // 50's "parent" 10 started after it: the id was reused.
        assert_eq!(descends_from(50, 10, &parents, &started), Some(false));
        assert_eq!(descends_from(60, 10, &parents, &started), Some(false));
        assert_eq!(descends_from(70, 10, &parents, &started), None);
        assert_eq!(descends_from(99, 10, &parents, &started), Some(false));
    }

    #[test]
    fn titles_are_capped_and_lossy_paths_are_refused() {
        let long: Vec<u16> = "x".repeat(2000).encode_utf16().collect();
        assert_eq!(title_from_units(&long).len(), MAX_TITLE_UNITS);
        assert_eq!(title_from_units(&[0x61, 0xD800, 0x62]), "a\u{FFFD}b");
        assert_eq!(strict_utf16(&[0x61, 0xD800, 0x62]), None);
        assert_eq!(strict_utf16(&"C:\\a.exe".encode_utf16().collect::<Vec<_>>()).as_deref(), Some("C:\\a.exe"));
        assert_eq!(file_name("C:\\Windows\\ApplicationFrameHost.exe"), "ApplicationFrameHost.exe");
    }
}
