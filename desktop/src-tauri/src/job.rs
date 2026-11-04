//! What the server leaves running when it dies hard.
//!
//! A terminal's shell, and whatever it started (a dev server holding its
//! port), outlive the server if the server is killed or crashes: on Windows a
//! process doesn't end with its parent, and node only ends its own direct
//! children. So on Windows the server is put in a job object of ours, which
//! everything it starts inherits (children don't leave it unless they ask
//! to, which the job allows):
//!
//! - this app killed or crashing closes our handle, and Windows ends the job
//!   (`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`);
//! - the server exiting on its own while the app runs (a crash) ends the job
//!   at once, from a thread that waits on the server's process;
//! - the server killed after the shutdown grace ends it too;
//! - a clean exit leaves what the server chose to leave running, as before:
//!   the kill-on-close limit is taken off and the job let go.
//!
//! A process the server starts in the moment between its spawn and its
//! assignment to the job isn't in it: node starts nothing long-lived then.
//! Elsewhere this does nothing.

use std::process::Child;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

pub struct Guard {
    stopping: Arc<AtomicBool>,
    #[cfg(windows)]
    job: Option<Arc<win::Job>>,
}

impl Guard {
    /// Puts `child` in a new job and watches it. A failure is logged and leaves the server as it was before this.
    pub fn attach(child: &Child) -> Guard {
        let stopping = Arc::new(AtomicBool::new(false));
        #[cfg(windows)]
        {
            let job = match win::Job::new().and_then(|job| job.assign(child).map(|()| Arc::new(job))) {
                Ok(job) => job,
                Err(e) => {
                    eprintln!("[otherbench-desktop] the server's processes won't end with it after a crash: {e}");
                    return Guard { stopping, job: None };
                }
            };
            let (watched, flag) = (job.clone(), stopping.clone());
            win::on_exit(child.id(), move || {
                if !flag.load(Ordering::SeqCst) {
                    eprintln!("[otherbench-desktop] the server exited unexpectedly; ending what it left running");
                    watched.terminate();
                }
            });
            Guard { stopping, job: Some(job) }
        }
        #[cfg(not(windows))]
        {
            let _ = child;
            Guard { stopping }
        }
    }

    /// The server is being told to stop: its exit from now on isn't a crash.
    pub fn stopping(&self) {
        self.stopping.store(true, Ordering::SeqCst);
    }

    /// The server exited when asked: what it left running stays.
    pub fn exited_cleanly(self) {
        self.stopping();
        #[cfg(windows)]
        if let Some(job) = &self.job {
            job.release();
        }
    }

    /// The server had to be killed: everything it started goes with it.
    pub fn exited_forcibly(self) {
        self.stopping();
        #[cfg(windows)]
        if let Some(job) = &self.job {
            job.terminate();
        }
    }
}

#[cfg(windows)]
mod win {
    use std::ffi::c_void;
    use std::os::windows::io::AsRawHandle;
    use std::process::Child;

    use windows::core::PCWSTR;
    use windows::Win32::Foundation::{CloseHandle, HANDLE};
    use windows::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation, SetInformationJobObject, TerminateJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT, JOB_OBJECT_LIMIT_BREAKAWAY_OK, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    use windows::Win32::System::Threading::{OpenProcess, WaitForSingleObject, INFINITE, PROCESS_SYNCHRONIZE};

    pub struct Job(HANDLE);

    // A job handle can be used and closed from any thread.
    unsafe impl Send for Job {}
    unsafe impl Sync for Job {}

    impl Job {
        pub fn new() -> Result<Job, String> {
            let handle = unsafe { CreateJobObjectW(None, PCWSTR::null()) }.map_err(|e| format!("no job object: {e}"))?;
            let job = Job(handle);
            job.limit(JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_BREAKAWAY_OK)?;
            Ok(job)
        }

        /// A process that asks to leave the job may (BREAKAWAY_OK): that's deliberate, and refusing it would make its
        /// start fail. Nothing leaves silently.
        fn limit(&self, flags: JOB_OBJECT_LIMIT) -> Result<(), String> {
            let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
            info.BasicLimitInformation.LimitFlags = flags;
            unsafe {
                SetInformationJobObject(
                    self.0,
                    JobObjectExtendedLimitInformation,
                    &info as *const _ as *const c_void,
                    size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                )
            }
            .map_err(|e| format!("can't set the job's limits: {e}"))
        }

        pub fn assign(&self, child: &Child) -> Result<(), String> {
            unsafe { AssignProcessToJobObject(self.0, HANDLE(child.as_raw_handle())) }.map_err(|e| format!("can't put the server in the job: {e}"))
        }

        pub fn terminate(&self) {
            let _ = unsafe { TerminateJobObject(self.0, 1) };
        }

        /// Closing the handle no longer ends what's in the job.
        pub fn release(&self) {
            let _ = self.limit(JOB_OBJECT_LIMIT_BREAKAWAY_OK);
        }
    }

    impl Drop for Job {
        fn drop(&mut self) {
            let _ = unsafe { CloseHandle(self.0) };
        }
    }

    /// Calls `then` on a thread of its own once process `pid` has exited. A handle of its own is opened now, while
    /// the caller's `Child` holds the process (so the id can't have been reused), and nothing happens if it can't be.
    pub fn on_exit(pid: u32, then: impl FnOnce() + Send + 'static) {
        let Ok(process) = (unsafe { OpenProcess(PROCESS_SYNCHRONIZE, false, pid) }) else { return };
        let process = Job(process); // closes the handle on drop, as for a job
        std::thread::spawn(move || {
            unsafe { WaitForSingleObject(process.0, INFINITE) };
            drop(process);
            then();
        });
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    use std::process::{Command, Stdio};
    use std::thread;
    use std::time::{Duration, Instant};
    use windows::Win32::Foundation::{CloseHandle, WAIT_TIMEOUT};
    use windows::Win32::System::Diagnostics::ToolHelp::{CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS};
    use windows::Win32::System::Threading::{OpenProcess, TerminateProcess, WaitForSingleObject, PROCESS_SYNCHRONIZE, PROCESS_TERMINATE};

    /// `cmd` (our child) starts a long `ping` (the grandchild) a second in, after the child is in the job, as the
    /// server starts a terminal long after it is. Returns the child and the grandchild's pid.
    fn child_with_grandchild() -> (Child, Guard, u32) {
        let mut child = Command::new("cmd.exe")
            .args(["/d", "/c", "ping -n 2 127.0.0.1 >nul & ping -n 60 127.0.0.1 >nul"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("cmd starts");
        let guard = Guard::attach(&child);
        let started = Instant::now();
        loop {
            thread::sleep(Duration::from_millis(250));
            // The second ping: the first is gone a second or so in.
            if started.elapsed() > Duration::from_millis(2500) {
                if let [pid] = children_named(child.id(), "PING.EXE")[..] {
                    return (child, guard, pid);
                }
            }
            if started.elapsed() > Duration::from_secs(15) {
                let _ = child.kill();
                panic!("no grandchild appeared");
            }
        }
    }

    fn children_named(parent: u32, name: &str) -> Vec<u32> {
        let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) }.expect("snapshot");
        let mut entry = PROCESSENTRY32W { dwSize: size_of::<PROCESSENTRY32W>() as u32, ..Default::default() };
        let mut out = Vec::new();
        if unsafe { Process32FirstW(snapshot, &mut entry) }.is_ok() {
            loop {
                let exe = String::from_utf16_lossy(&entry.szExeFile[..entry.szExeFile.iter().position(|&c| c == 0).unwrap_or(entry.szExeFile.len())]);
                if entry.th32ParentProcessID == parent && exe.eq_ignore_ascii_case(name) {
                    out.push(entry.th32ProcessID);
                }
                if unsafe { Process32NextW(snapshot, &mut entry) }.is_err() {
                    break;
                }
            }
        }
        let _ = unsafe { CloseHandle(snapshot) };
        out
    }

    fn alive(pid: u32) -> bool {
        let Ok(h) = (unsafe { OpenProcess(PROCESS_SYNCHRONIZE, false, pid) }) else { return false };
        let running = unsafe { WaitForSingleObject(h, 0) } == WAIT_TIMEOUT;
        let _ = unsafe { CloseHandle(h) };
        running
    }

    fn gone_within(pid: u32, ms: u64) -> bool {
        let deadline = Instant::now() + Duration::from_millis(ms);
        while Instant::now() < deadline {
            if !alive(pid) {
                return true;
            }
            thread::sleep(Duration::from_millis(50));
        }
        false
    }

    fn end(pid: u32) {
        if let Ok(h) = unsafe { OpenProcess(PROCESS_TERMINATE, false, pid) } {
            let _ = unsafe { TerminateProcess(h, 1) };
            let _ = unsafe { CloseHandle(h) };
        }
    }

    #[test]
    fn a_crash_ends_what_the_server_left_running() {
        let (mut child, guard, grandchild) = child_with_grandchild();
        // The server dies without being asked: its grandchild would be orphaned, but the watcher ends the job.
        let _ = child.kill();
        let _ = child.wait();
        let ended = gone_within(grandchild, 5000);
        end(grandchild);
        drop(guard);
        assert!(ended, "the grandchild outlived the crash");
    }

    #[test]
    fn a_forced_stop_ends_what_the_server_left_running() {
        let (mut child, guard, grandchild) = child_with_grandchild();
        guard.stopping();
        let _ = child.kill();
        let _ = child.wait();
        thread::sleep(Duration::from_millis(300));
        assert!(alive(grandchild), "stopping isn't a crash: the watcher leaves it to the stop");
        guard.exited_forcibly();
        let ended = gone_within(grandchild, 5000);
        end(grandchild);
        assert!(ended, "the grandchild outlived a forced stop");
    }

    #[test]
    fn a_clean_exit_leaves_what_the_server_left_running() {
        let (mut child, guard, grandchild) = child_with_grandchild();
        guard.stopping();
        let _ = child.kill();
        let _ = child.wait();
        guard.exited_cleanly();
        thread::sleep(Duration::from_millis(500));
        let survived = alive(grandchild);
        end(grandchild);
        assert!(survived, "a clean exit ended the job");
    }
}
