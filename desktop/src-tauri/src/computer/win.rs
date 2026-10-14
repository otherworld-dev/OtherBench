//! The Win32 calls computer use makes (Windows only).
//!
//! NOTHING in this file may run in a test or an unattended session: it reads
//! the real screen, moves the real mouse and presses real keys. It is only
//! reached through desktop.rs, which only exists when the shell was started
//! with GRUNT_COMPUTER_USE=1 for Adam's live check. No test calls it.
//!
//! Facts are found conservatively: when one can't be established it is left
//! out or the target is refused, `shellView` is true when unsure, and a
//! signer is reported only from a signature Windows verified. Everything
//! here that can only be confirmed on a real machine is listed in the Task
//! 13-14 report as "unverified live".

use std::collections::HashMap;
use std::ffi::c_void;
use std::io::Read;
use std::mem::size_of;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{mpsc, Arc};
use std::time::Duration;

use windows::core::{BOOL, PCWSTR, PWSTR};
use windows::Win32::Foundation::{CloseHandle, GetLastError, FILETIME, HANDLE, HWND, INVALID_HANDLE_VALUE, LPARAM, POINT, WPARAM};
use windows::Win32::Graphics::Gdi::{
    CreateCompatibleDC, CreateDIBSection, DeleteDC, DeleteObject, GdiFlush, GetDC, ReleaseDC, SelectObject, SetBrushOrgEx, SetStretchBltMode, StretchBlt,
    BITMAPINFO, BITMAPINFOHEADER, BI_RGB, CAPTUREBLT, DIB_RGB_COLORS, HALFTONE, HGDIOBJ, SRCCOPY,
};
use windows::Win32::Security::Cryptography::{CertGetNameStringW, CERT_NAME_SIMPLE_DISPLAY_TYPE};
use windows::Win32::Security::WinTrust::{
    WTHelperGetProvSignerFromChain, WTHelperProvDataFromStateData, WinVerifyTrust, WINTRUST_ACTION_GENERIC_VERIFY_V2, WINTRUST_DATA, WINTRUST_FILE_INFO,
    WTD_CACHE_ONLY_URL_RETRIEVAL, WTD_CHOICE_FILE, WTD_REVOKE_NONE, WTD_STATEACTION_CLOSE, WTD_STATEACTION_VERIFY, WTD_UI_NONE,
};
use windows::Win32::Security::{GetTokenInformation, TokenElevation, TokenUIAccess, TOKEN_ELEVATION, TOKEN_QUERY};
use windows::Win32::Storage::FileSystem::{
    CreateFileW, GetDriveTypeW, GetFileVersionInfoSizeW, GetFileVersionInfoW, GetFinalPathNameByHandleW, VerQueryValueW, FILE_FLAGS_AND_ATTRIBUTES,
    FILE_NAME_NORMALIZED, FILE_READ_ATTRIBUTES, GETFINALPATHNAMEBYHANDLE_FLAGS, FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING, VOLUME_NAME_DOS,
};
use windows::Win32::System::Diagnostics::ToolHelp::{CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS};
use windows::Win32::System::StationsAndDesktops::{CloseDesktop, GetUserObjectInformationW, OpenInputDesktop, DESKTOP_CONTROL_FLAGS, DESKTOP_READOBJECTS, UOI_NAME};
use windows::Win32::System::Threading::{
    GetCurrentProcess, GetCurrentProcessId, GetCurrentThreadId, GetProcessTimes, OpenProcess, OpenProcessToken, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
    PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows::Win32::UI::Input::KeyboardAndMouse::{
    GetAsyncKeyState, MapVirtualKeyW, SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, INPUT_MOUSE, KEYBDINPUT, KEYBD_EVENT_FLAGS, KEYEVENTF_EXTENDEDKEY, KEYEVENTF_KEYUP,
    KEYEVENTF_UNICODE, MAPVK_VK_TO_VSC, MOUSEEVENTF_ABSOLUTE, MOUSEEVENTF_HWHEEL, MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_MOVE, MOUSEEVENTF_VIRTUALDESK, MOUSEEVENTF_LEFTUP, MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP,
    MOUSEEVENTF_WHEEL, MOUSEINPUT, MOUSE_EVENT_FLAGS, VIRTUAL_KEY,
};
use windows::Win32::UI::WindowsAndMessaging::{
    EnumChildWindows, EnumThreadWindows, GetAncestor, GetClassNameW, GetCursorPos, GetForegroundWindow, GetSystemMetrics, GetWindow, GetWindowTextW,
    GetWindowThreadProcessId, IsWindow, MessageBoxW, PostMessageW, SetCursorPos, SetForegroundWindow, SetWindowDisplayAffinity, WindowFromPoint, GA_ROOT,
    GW_OWNER, IDOK, MB_DEFBUTTON2, MB_ICONWARNING, MB_OKCANCEL, MB_SETFOREGROUND, MB_TOPMOST, SM_CXSCREEN, SM_CXVIRTUALSCREEN, SM_CYSCREEN, SM_CYVIRTUALSCREEN, SM_XVIRTUALSCREEN, SM_YVIRTUALSCREEN, WDA_EXCLUDEFROMCAPTURE, WM_CLOSE,
};

use super::facts::{self, Facts, Identity, Location};
use super::{image, Capture, Consent, Dialog, Input, Keyboard, Where};

/// A handle closed when it goes.
struct Owned(HANDLE);

impl Drop for Owned {
    fn drop(&mut self) {
        if !self.0.is_invalid() {
            unsafe {
                let _ = CloseHandle(self.0);
            }
        }
    }
}

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

fn filetime(t: FILETIME) -> u64 {
    ((t.dwHighDateTime as u64) << 32) | t.dwLowDateTime as u64
}

// ---- the screen ---------------------------------------------------------------

pub fn screen_size() -> Result<(u32, u32), String> {
    let (w, h) = unsafe { (GetSystemMetrics(SM_CXSCREEN), GetSystemMetrics(SM_CYSCREEN)) };
    if w <= 0 || h <= 0 {
        return Err("Grunt couldn't read the screen size.".into());
    }
    Ok((w as u32, h as u32))
}

/// The primary monitor, scaled down to fit `max` with HALFTONE: top-down BGRA rows.
pub fn capture(max: (u32, u32)) -> Result<Capture, String> {
    let (screen_w, screen_h) = screen_size()?;
    let (w, h) = image::fit(screen_w, screen_h, max);
    unsafe {
        let screen = GetDC(None);
        if screen.is_invalid() {
            return Err("Grunt couldn't read the screen.".into());
        }
        let memory = CreateCompatibleDC(Some(screen));
        let mut info = BITMAPINFO::default();
        info.bmiHeader.biSize = size_of::<BITMAPINFOHEADER>() as u32;
        info.bmiHeader.biWidth = w as i32;
        info.bmiHeader.biHeight = -(h as i32);
        info.bmiHeader.biPlanes = 1;
        info.bmiHeader.biBitCount = 32;
        info.bmiHeader.biCompression = BI_RGB.0;
        let mut bits: *mut c_void = std::ptr::null_mut();
        let bitmap = match CreateDIBSection(Some(memory), &info, DIB_RGB_COLORS, &mut bits, None, 0) {
            Ok(b) => b,
            Err(_) => {
                let _ = DeleteDC(memory);
                ReleaseDC(None, screen);
                return Err("Grunt couldn't capture the screen.".into());
            }
        };
        let previous = SelectObject(memory, HGDIOBJ(bitmap.0));
        SetStretchBltMode(memory, HALFTONE);
        let _ = SetBrushOrgEx(memory, 0, 0, None);
        let copied = StretchBlt(memory, 0, 0, w as i32, h as i32, Some(screen), 0, 0, screen_w as i32, screen_h as i32, SRCCOPY | CAPTUREBLT).as_bool();
        let _ = GdiFlush();
        let bgra = if copied && !bits.is_null() { std::slice::from_raw_parts(bits as *const u8, w as usize * h as usize * 4).to_vec() } else { Vec::new() };
        SelectObject(memory, previous);
        let _ = DeleteObject(HGDIOBJ(bitmap.0));
        let _ = DeleteDC(memory);
        ReleaseDC(None, screen);
        if bgra.is_empty() {
            return Err("Grunt couldn't capture the screen.".into());
        }
        Ok(Capture { bgra, width: w, height: h, screen_w, screen_h })
    }
}

pub fn cursor() -> Result<(i32, i32), String> {
    let mut p = POINT::default();
    unsafe { GetCursorPos(&mut p) }.map_err(|_| "Grunt couldn't read the cursor.".to_string())?;
    Ok((p.x, p.y))
}

pub fn move_to(x: i32, y: i32) -> Result<(), String> {
    unsafe { SetCursorPos(x, y) }.map_err(|_| "Grunt couldn't move the mouse; nothing more was done.".to_string())
}

/// Keeps a window (the indicator bar) out of screenshots.
pub fn exclude_from_capture(window: isize) {
    unsafe {
        let _ = SetWindowDisplayAffinity(HWND(window as *mut c_void), WDA_EXCLUDEFROMCAPTURE);
    }
}

// ---- input ---------------------------------------------------------------------

/// The virtual desktop: left, top, width, height.
fn virtual_desktop() -> (i32, i32, i32, i32) {
    unsafe { (GetSystemMetrics(SM_XVIRTUALSCREEN), GetSystemMetrics(SM_YVIRTUALSCREEN), GetSystemMetrics(SM_CXVIRTUALSCREEN), GetSystemMetrics(SM_CYVIRTUALSCREEN)) }
}

/// One event as an INPUT; None for an absolute move to a point off the virtual desktop.
fn as_input(event: &Input, desk: (i32, i32, i32, i32)) -> Option<INPUT> {
    let key = |vk: u16, scan: u16, flags: KEYBD_EVENT_FLAGS| INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 { ki: KEYBDINPUT { wVk: VIRTUAL_KEY(vk), wScan: scan, dwFlags: flags, time: 0, dwExtraInfo: 0 } },
    };
    let mouse_at = |flags: MOUSE_EVENT_FLAGS, data: i32, dx: i32, dy: i32| INPUT {
        r#type: INPUT_MOUSE,
        Anonymous: INPUT_0 { mi: MOUSEINPUT { dx, dy, mouseData: data as u32, dwFlags: flags, time: 0, dwExtraInfo: 0 } },
    };
    let mouse = |flags: MOUSE_EVENT_FLAGS, data: i32| mouse_at(flags, data, 0, 0);
    Some(match *event {
        Input::Key { vk, extended, up } => {
            let mut flags = KEYBD_EVENT_FLAGS(0);
            if extended {
                flags |= KEYEVENTF_EXTENDEDKEY;
            }
            if up {
                flags |= KEYEVENTF_KEYUP;
            }
            let scan = unsafe { MapVirtualKeyW(vk as u32, MAPVK_VK_TO_VSC) } as u16;
            key(vk, scan, flags)
        }
        Input::Unicode { unit, up } => key(0, unit, if up { KEYEVENTF_UNICODE | KEYEVENTF_KEYUP } else { KEYEVENTF_UNICODE }),
        Input::Button { right: false, up: false } => mouse(MOUSEEVENTF_LEFTDOWN, 0),
        Input::Button { right: false, up: true } => mouse(MOUSEEVENTF_LEFTUP, 0),
        Input::Button { right: true, up: false } => mouse(MOUSEEVENTF_RIGHTDOWN, 0),
        Input::Button { right: true, up: true } => mouse(MOUSEEVENTF_RIGHTUP, 0),
        Input::Wheel { delta, horizontal } => mouse(if horizontal { MOUSEEVENTF_HWHEEL } else { MOUSEEVENTF_WHEEL }, delta),
        Input::MoveTo { x, y } => {
            let (dx, dy) = image::absolute(x, y, desk)?;
            mouse_at(MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK, 0, dx, dy)
        }
    })
}

/// Inserts the events in one call; how many Windows took (they go in order,
/// so the first that many). A batch with a move it can't express is not sent at all.
pub fn send(events: &[Input]) -> usize {
    let desk = virtual_desktop();
    let Some(inputs) = events.iter().map(|e| as_input(e, desk)).collect::<Option<Vec<INPUT>>>() else { return 0 };
    if inputs.is_empty() {
        return 0;
    }
    (unsafe { SendInput(&inputs, size_of::<INPUT>() as i32) }) as usize
}

/// False when the input desktop isn't the user's (locked, a UAC prompt): then
/// the keyboard can't be read and no input would reach the user's apps.
fn input_desktop_is_default() -> bool {
    unsafe {
        let Ok(desktop) = OpenInputDesktop(DESKTOP_CONTROL_FLAGS(0), false, DESKTOP_READOBJECTS) else { return false };
        let mut name = [0u16; 64];
        let mut needed = 0u32;
        let read = GetUserObjectInformationW(HANDLE(desktop.0), UOI_NAME, Some(name.as_mut_ptr() as *mut c_void), (name.len() * 2) as u32, Some(&mut needed));
        let _ = CloseDesktop(desktop);
        let len = name.iter().position(|&u| u == 0).unwrap_or(name.len());
        read.is_ok() && String::from_utf16_lossy(&name[..len]).eq_ignore_ascii_case("Default")
    }
}

/// The modifier state as Windows has it now (both Ctrl, Alt, Shift and Windows keys).
pub fn keyboard() -> Keyboard {
    if !input_desktop_is_default() {
        return Keyboard::Unknown;
    }
    const MODIFIERS: [i32; 11] = [0x10, 0x11, 0x12, 0xA0, 0xA1, 0xA2, 0xA3, 0xA4, 0xA5, 0x5B, 0x5C];
    for vk in MODIFIERS {
        if (unsafe { GetAsyncKeyState(vk) } as u16) & 0x8000 != 0 {
            return Keyboard::Held;
        }
    }
    Keyboard::Clear
}

// ---- windows -------------------------------------------------------------------

fn window_id(window: HWND) -> String {
    (window.0 as usize).to_string()
}

/// The top-level window a lookup names, if there is one.
pub fn window(at: &Where) -> Option<HWND> {
    unsafe {
        let found = match at {
            Where::Point(x, y) => WindowFromPoint(POINT { x: *x, y: *y }),
            Where::Foreground => GetForegroundWindow(),
            Where::Window(id) => {
                let raw: usize = id.parse().ok()?;
                let window = HWND(raw as *mut c_void);
                if !IsWindow(Some(window)).as_bool() || GetAncestor(window, GA_ROOT) != window {
                    return None;
                }
                return Some(window);
            }
        };
        if found.is_invalid() {
            return None;
        }
        let root = GetAncestor(found, GA_ROOT);
        Some(if root.is_invalid() { found } else { root })
    }
}

fn class_of(window: HWND) -> Option<String> {
    let mut buf = [0u16; 256];
    let n = unsafe { GetClassNameW(window, &mut buf) };
    (n > 0).then(|| String::from_utf16_lossy(&buf[..n as usize]))
}

fn window_pid(window: HWND) -> u32 {
    let mut pid = 0u32;
    unsafe { GetWindowThreadProcessId(window, Some(&mut pid)) };
    pid
}

/// Every descendant window's class, up to a cap; false when the list was cut short.
fn descendant_classes(window: HWND) -> (Vec<String>, bool) {
    struct Walk {
        classes: Vec<String>,
        complete: bool,
    }
    unsafe extern "system" fn visit(child: HWND, lparam: LPARAM) -> BOOL {
        let walk = unsafe { &mut *(lparam.0 as *mut Walk) };
        if walk.classes.len() >= 4096 {
            walk.complete = false;
            return BOOL(0);
        }
        match class_of(child) {
            Some(class) => walk.classes.push(class),
            None => walk.complete = false,
        }
        BOOL(1)
    }
    let mut walk = Walk { classes: Vec::new(), complete: true };
    unsafe {
        let _ = EnumChildWindows(Some(window), Some(visit), LPARAM(&mut walk as *mut Walk as isize));
    }
    (walk.classes, walk.complete)
}

fn is_shell_view(window: HWND) -> bool {
    let (classes, complete) = descendant_classes(window);
    facts::shell_view(class_of(window).as_deref(), &classes, complete)
}

/// A packaged app (Calculator, Settings) draws inside ApplicationFrameHost;
/// the app is the process of a child window of another process.
fn packaged_app_pid(frame: HWND, frame_pid: u32) -> Option<u32> {
    struct Search {
        frame_pid: u32,
        found: Option<u32>,
    }
    unsafe extern "system" fn visit(child: HWND, lparam: LPARAM) -> BOOL {
        let search = unsafe { &mut *(lparam.0 as *mut Search) };
        let pid = window_pid(child);
        if pid != 0 && pid != search.frame_pid && class_of(child).as_deref() == Some("Windows.UI.Core.CoreWindow") {
            search.found = Some(pid);
            return BOOL(0);
        }
        BOOL(1)
    }
    let mut search = Search { frame_pid, found: None };
    unsafe {
        let _ = EnumChildWindows(Some(frame), Some(visit), LPARAM(&mut search as *mut Search as isize));
    }
    search.found
}

struct Process {
    pid: u32,
    handle: Owned,
    path: String,
    started: u64,
}

fn open_process(pid: u32) -> Result<Owned, String> {
    unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) }.map(Owned).map_err(|_| "Grunt can't open that app's process.".to_string())
}

fn started_at(process: HANDLE) -> Option<u64> {
    let (mut created, mut exited, mut kernel, mut user) = (FILETIME::default(), FILETIME::default(), FILETIME::default(), FILETIME::default());
    unsafe { GetProcessTimes(process, &mut created, &mut exited, &mut kernel, &mut user) }.ok()?;
    Some(filetime(created))
}

/// The final path of a process's image: long names, links, junctions and
/// substituted drives resolved, on-disk case, `\\?\` stripped one way. An
/// unpaired surrogate anywhere is refused, never decoded lossily.
fn image_path(process: HANDLE) -> Result<String, String> {
    let unreadable = || "Grunt can't read that app's program path.".to_string();
    let mut image = vec![0u16; 32768];
    let mut len = image.len() as u32;
    unsafe { QueryFullProcessImageNameW(process, PROCESS_NAME_WIN32, PWSTR(image.as_mut_ptr()), &mut len) }.map_err(|_| unreadable())?;
    image.truncate(len as usize);
    image.push(0);
    let file = unsafe {
        CreateFileW(
            PCWSTR(image.as_ptr()),
            FILE_READ_ATTRIBUTES.0,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            None,
            OPEN_EXISTING,
            FILE_FLAGS_AND_ATTRIBUTES(0),
            None,
        )
    }
    .map(Owned)
    .map_err(|_| unreadable())?;
    let mut buf = vec![0u16; 32768];
    let n = unsafe { GetFinalPathNameByHandleW(file.0, &mut buf, GETFINALPATHNAMEBYHANDLE_FLAGS(FILE_NAME_NORMALIZED.0 | VOLUME_NAME_DOS.0)) } as usize;
    if n == 0 || n >= buf.len() {
        return Err(unreadable());
    }
    let full = facts::strict_utf16(&buf[..n]).ok_or_else(unreadable)?;
    facts::strip_verbatim(&full).ok_or_else(unreadable)
}

fn process(pid: u32) -> Result<Process, String> {
    let handle = open_process(pid)?;
    let path = image_path(handle.0)?;
    let started = started_at(handle.0).ok_or("Grunt can't tell when that app started.")?;
    Ok(Process { pid, handle, path, started })
}

/// The process a window belongs to, a packaged app resolved to the app
/// itself when that works (otherwise the frame host is reported).
fn owner(window: HWND) -> Result<Process, String> {
    let pid = window_pid(window);
    if pid == 0 {
        return Err("Grunt can't tell which app owns that window.".into());
    }
    let frame = process(pid)?;
    if facts::file_name(&frame.path).eq_ignore_ascii_case("ApplicationFrameHost.exe") {
        if let Some(app) = packaged_app_pid(window, pid).and_then(|p| process(p).ok()) {
            return Ok(app);
        }
    }
    Ok(frame)
}

pub fn identity(window: HWND) -> Result<Identity, String> {
    let owner = owner(window)?;
    Ok(Identity { path: owner.path, shell_view: is_shell_view(window), window_id: window_id(window), pid: owner.pid, started_at: owner.started.to_string(), title: title(window) })
}

/// Elevation and UI access from the process token; None when it can't be read.
fn token_flags(process: HANDLE) -> Option<(bool, bool)> {
    let mut token = HANDLE::default();
    unsafe { OpenProcessToken(process, TOKEN_QUERY, &mut token) }.ok()?;
    let token = Owned(token);
    let mut elevation = TOKEN_ELEVATION::default();
    let mut ui_access = 0u32;
    let mut returned = 0u32;
    unsafe {
        GetTokenInformation(token.0, TokenElevation, Some(&mut elevation as *mut _ as *mut c_void), size_of::<TOKEN_ELEVATION>() as u32, &mut returned).ok()?;
        GetTokenInformation(token.0, TokenUIAccess, Some(&mut ui_access as *mut u32 as *mut c_void), size_of::<u32>() as u32, &mut returned).ok()?;
    }
    Some((elevation.TokenIsElevated != 0, ui_access != 0))
}

/// Parent ids of every process now.
fn parents() -> Option<HashMap<u32, u32>> {
    let snapshot = Owned(unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) }.ok()?);
    let mut entry = PROCESSENTRY32W { dwSize: size_of::<PROCESSENTRY32W>() as u32, ..Default::default() };
    let mut map = HashMap::new();
    unsafe { Process32FirstW(snapshot.0, &mut entry) }.ok()?;
    loop {
        map.insert(entry.th32ProcessID, entry.th32ParentProcessID);
        if unsafe { Process32NextW(snapshot.0, &mut entry) }.is_err() {
            break;
        }
    }
    Some(map)
}

fn started_by_pid(pid: u32) -> Option<u64> {
    if pid == unsafe { GetCurrentProcessId() } {
        return started_at(unsafe { GetCurrentProcess() });
    }
    started_at(open_process(pid).ok()?.0)
}

/// Grunt's own process, any process descended from it (its webview and
/// server children), or a window owned by a Grunt window. None: unknown.
fn is_grunt(window: HWND, pid: u32) -> Option<bool> {
    let own = unsafe { GetCurrentProcessId() };
    let parents = parents()?;
    let ours = |p: u32| facts::descends_from(p, own, &parents, &started_by_pid);
    if ours(window_pid(window))? || ours(pid)? {
        return Some(true);
    }
    let mut current = window;
    for _ in 0..32 {
        match unsafe { GetWindow(current, GW_OWNER) } {
            Ok(owner) if !owner.is_invalid() => {
                if ours(window_pid(owner))? {
                    return Some(true);
                }
                current = owner;
            }
            _ => return Some(false),
        }
    }
    None
}

/// Console or terminal host by class, or a console-subsystem image; None when the image can't be read.
fn is_console(window: HWND, path: &str) -> Option<bool> {
    if class_of(window).is_some_and(|c| facts::is_console_class(&c)) {
        return Some(true);
    }
    let mut head = Vec::new();
    std::fs::File::open(path).ok()?.take(65536).read_to_end(&mut head).ok()?;
    facts::pe_subsystem(&head).map(|s| s == facts::SUBSYSTEM_CONSOLE)
}

fn location(path: &str) -> Location {
    if path.starts_with("\\\\") {
        return Location::Network;
    }
    match facts::drive_root(path) {
        Some(root) => Location::from_drive_type(unsafe { GetDriveTypeW(PCWSTR(wide(&root).as_ptr())) }),
        None => Location::Unknown,
    }
}

/// VERSIONINFO OriginalFilename: Some(None) when the image has none, None when it couldn't be read.
fn original_name(path: &str) -> Option<Option<String>> {
    let name = wide(path);
    unsafe {
        let size = GetFileVersionInfoSizeW(PCWSTR(name.as_ptr()), None);
        if size == 0 {
            // ERROR_RESOURCE_DATA/TYPE/NAME/LANG_NOT_FOUND: no version information at all.
            return matches!(GetLastError().0, 1812..=1815).then_some(None);
        }
        let mut data = vec![0u8; size as usize];
        GetFileVersionInfoW(PCWSTR(name.as_ptr()), None, size, data.as_mut_ptr() as *mut c_void).ok()?;
        let mut ptr: *mut c_void = std::ptr::null_mut();
        let mut len = 0u32;
        let mut keys = Vec::new();
        let translation = wide("\\VarFileInfo\\Translation");
        // A value is read only where it lies wholly inside the buffer; anything else is inconsistent and refused.
        let start = data.as_ptr() as usize;
        if VerQueryValueW(data.as_ptr() as *const c_void, PCWSTR(translation.as_ptr()), &mut ptr, &mut len).as_bool() && !ptr.is_null() && len >= 4 {
            if !facts::inside(start, data.len(), ptr as usize, len as usize) || (ptr as usize) % 2 != 0 {
                return None;
            }
            let pairs = std::slice::from_raw_parts(ptr as *const u16, (len / 2) as usize);
            keys.extend(pairs.chunks_exact(2).map(|p| format!("{:04x}{:04x}", p[0], p[1])));
        }
        keys.extend(["040904b0", "040904e4", "000004b0"].map(String::from));
        for key in keys {
            let sub = wide(&format!("\\StringFileInfo\\{key}\\OriginalFilename"));
            let mut ptr: *mut c_void = std::ptr::null_mut();
            let mut len = 0u32;
            if VerQueryValueW(data.as_ptr() as *const c_void, PCWSTR(sub.as_ptr()), &mut ptr, &mut len).as_bool() && !ptr.is_null() {
                // A string value's length is in UTF-16 units.
                let bytes = (len as usize).checked_mul(2)?;
                if !facts::inside(start, data.len(), ptr as usize, bytes) || (ptr as usize) % 2 != 0 {
                    return None;
                }
                let units = std::slice::from_raw_parts(ptr as *const u16, len as usize);
                let end = units.iter().position(|&u| u == 0).unwrap_or(units.len());
                return facts::strict_utf16(&units[..end]).map(Some);
            }
        }
        Some(None)
    }
}

/// The subject of the file's embedded Authenticode signature, only when
/// Windows verified it (chain to a trusted root, no revocation check, no
/// network). A catalog-signed or unsigned file, or anything that fails, is None.
fn signer(path: &str) -> Option<String> {
    let name = wide(path);
    let mut file = WINTRUST_FILE_INFO {
        cbStruct: size_of::<WINTRUST_FILE_INFO>() as u32,
        pcwszFilePath: PCWSTR(name.as_ptr()),
        hFile: HANDLE::default(),
        pgKnownSubject: std::ptr::null_mut(),
    };
    let mut data = WINTRUST_DATA {
        cbStruct: size_of::<WINTRUST_DATA>() as u32,
        dwUIChoice: WTD_UI_NONE,
        fdwRevocationChecks: WTD_REVOKE_NONE,
        dwUnionChoice: WTD_CHOICE_FILE,
        dwStateAction: WTD_STATEACTION_VERIFY,
        dwProvFlags: WTD_CACHE_ONLY_URL_RETRIEVAL,
        ..Default::default()
    };
    data.Anonymous.pFile = &mut file;
    let mut action = WINTRUST_ACTION_GENERIC_VERIFY_V2;
    let no_ui = HWND(INVALID_HANDLE_VALUE.0);
    unsafe {
        let status = WinVerifyTrust(no_ui, &mut action, &mut data as *mut WINTRUST_DATA as *mut c_void);
        let subject = if status == 0 { signer_subject(data.hWVTStateData) } else { None };
        data.dwStateAction = WTD_STATEACTION_CLOSE;
        WinVerifyTrust(no_ui, &mut action, &mut data as *mut WINTRUST_DATA as *mut c_void);
        subject
    }
}

unsafe fn signer_subject(state: HANDLE) -> Option<String> {
    let provider = unsafe { WTHelperProvDataFromStateData(state) };
    if provider.is_null() {
        return None;
    }
    let signer = unsafe { WTHelperGetProvSignerFromChain(provider, 0, false, 0) };
    if signer.is_null() {
        return None;
    }
    let signer = unsafe { &*signer };
    if signer.csCertChain == 0 || signer.pasCertChain.is_null() {
        return None;
    }
    let cert = unsafe { (*signer.pasCertChain).pCert };
    if cert.is_null() {
        return None;
    }
    let n = unsafe { CertGetNameStringW(cert, CERT_NAME_SIMPLE_DISPLAY_TYPE, 0, None, None) } as usize;
    if n <= 1 {
        return None;
    }
    let mut buf = vec![0u16; n];
    let n = unsafe { CertGetNameStringW(cert, CERT_NAME_SIMPLE_DISPLAY_TYPE, 0, None, Some(&mut buf)) } as usize;
    let end = buf[..n.min(buf.len())].iter().position(|&u| u == 0).unwrap_or(n.min(buf.len()));
    facts::strict_utf16(&buf[..end]).filter(|s| !s.is_empty())
}

fn title(window: HWND) -> String {
    let mut buf = vec![0u16; facts::MAX_TITLE_UNITS + 1];
    let n = unsafe { GetWindowTextW(window, &mut buf) }.max(0) as usize;
    facts::title_from_units(&buf[..n.min(buf.len())])
}

/// Every `ComputerTarget` fact about a top-level window, or a refusal.
pub fn facts(window: HWND) -> Result<Facts, String> {
    let owner = owner(window)?;
    let (elevated, ui_access) = token_flags(owner.handle.0).ok_or("Grunt can't read that app's permissions.")?;
    Ok(Facts {
        grunt: is_grunt(window, owner.pid),
        console: is_console(window, &owner.path),
        location: location(&owner.path),
        original_name: original_name(&owner.path),
        signer: signer(&owner.path),
        elevated,
        ui_access,
        id: Identity {
            shell_view: is_shell_view(window),
            window_id: window_id(window),
            pid: owner.pid,
            started_at: owner.started.to_string(),
            title: title(window),
            path: owner.path,
        },
    })
}

/// Brings exactly this window forward.
pub fn activate(window: HWND) -> bool {
    unsafe { SetForegroundWindow(window).as_bool() }
}

// ---- the start dialog --------------------------------------------------------------

/// Posts WM_CLOSE to every top-level window of a thread (a message box closes as Cancel).
fn close_thread_windows(thread: u32) {
    unsafe extern "system" fn close(window: HWND, _: LPARAM) -> BOOL {
        unsafe {
            let _ = PostMessageW(Some(window), WM_CLOSE, WPARAM(0), LPARAM(0));
        }
        BOOL(1)
    }
    unsafe {
        let _ = EnumThreadWindows(thread, Some(close), LPARAM(0));
    }
}

/// The native start dialog: a message box with OK and Cancel (Cancel the
/// default), on a thread of its own so it can be closed from outside. The
/// text is plain; Windows draws the buttons.
pub fn consent(text: &str, caption: &str, dialog: &Dialog) -> Consent {
    let (tx, rx) = mpsc::channel();
    let thread = Arc::new(AtomicU32::new(0));
    let (text, caption, id) = (wide(text), wide(caption), thread.clone());
    let started = std::thread::Builder::new().name("computer-use-dialog".into()).spawn(move || {
        id.store(unsafe { GetCurrentThreadId() }, Ordering::SeqCst);
        let answer = unsafe {
            MessageBoxW(None, PCWSTR(text.as_ptr()), PCWSTR(caption.as_ptr()), MB_OKCANCEL | MB_ICONWARNING | MB_DEFBUTTON2 | MB_SETFOREGROUND | MB_TOPMOST)
        };
        let _ = tx.send(answer);
    });
    if started.is_err() {
        return Consent::Failed;
    }
    loop {
        match rx.recv_timeout(Duration::from_millis(100)) {
            Ok(answer) if answer == IDOK => return Consent::Yes,
            Ok(answer) if answer.0 == 0 => return Consent::Failed,
            Ok(_) => return Consent::No,
            Err(mpsc::RecvTimeoutError::Timeout) => {
                if dialog.should_close() {
                    let id = thread.load(Ordering::SeqCst);
                    if id != 0 {
                        close_thread_windows(id);
                    }
                }
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => return Consent::Failed,
        }
    }
}
