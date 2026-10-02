//! The Grunt server as a child process of the shell.
//!
//! The server is started with `serve --port 0 --announce`, its per-launch
//! token in `GRUNT_TOKEN` (never on the command line, which every process on
//! the machine can read), and stdin piped. Its first stdout line is
//! `{"port":N}`; everything else it logs goes to stderr, which is copied to
//! `server.log` in the app's log directory. Dropping our end of stdin is the
//! shutdown signal: the server closes and exits when its stdin ends, which
//! also covers this process dying without running any cleanup at all.

use std::fs::{self, File};
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

/// How long to wait for the announce line before giving up.
const ANNOUNCE_TIMEOUT: Duration = Duration::from_secs(15);
/// How long the server gets to exit on its own after stdin closes before it is killed.
const SHUTDOWN_GRACE: Duration = Duration::from_secs(3);

pub struct LaunchSpec {
    pub node: PathBuf,
    pub script: PathBuf,
    pub cors_origins: Vec<String>,
    pub log_dir: PathBuf,
}

pub struct Server {
    child: Child,
    stdin: Option<ChildStdin>,
    pub port: u16,
    pub token: String,
}

/// 32 random bytes as lowercase hex.
pub fn generate_token() -> Result<String, String> {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).map_err(|e| format!("no randomness available: {e}"))?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

/// Parses the server's `{"port":N}` handshake line.
pub fn parse_announce(line: &str) -> Result<u16, String> {
    #[derive(serde::Deserialize)]
    struct Announce {
        port: u16,
    }
    let parsed: Announce = serde_json::from_str(line.trim())
        .map_err(|e| format!("unexpected first line from the server ({e}): {line:?}"))?;
    if parsed.port == 0 {
        return Err("the server announced port 0".into());
    }
    Ok(parsed.port)
}

fn tail(path: &Path, max_bytes: u64) -> String {
    let Ok(mut f) = File::open(path) else { return String::new() };
    let len = f.metadata().map(|m| m.len()).unwrap_or(0);
    let mut buf = String::new();
    if len > max_bytes {
        use std::io::{Seek, SeekFrom};
        let _ = f.seek(SeekFrom::Start(len - max_bytes));
    }
    let _ = f.read_to_string(&mut buf);
    buf
}

pub fn start(spec: &LaunchSpec) -> Result<Server, String> {
    let token = generate_token()?;
    fs::create_dir_all(&spec.log_dir).map_err(|e| format!("cannot create log directory: {e}"))?;
    let log_path = spec.log_dir.join("server.log");
    let mut log = File::create(&log_path).map_err(|e| format!("cannot create {}: {e}", log_path.display()))?;

    let mut cmd = Command::new(&spec.node);
    cmd.arg(&spec.script).args(["serve", "--port", "0", "--announce"]);
    for origin in &spec.cors_origins {
        cmd.args(["--cors-origin", origin]);
    }
    cmd.env("GRUNT_TOKEN", &token)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = cmd.spawn().map_err(|e| {
        format!(
            "could not start the Grunt server ({} {}): {e}",
            spec.node.display(),
            spec.script.display()
        )
    })?;

    let stdout = child.stdout.take().expect("stdout is piped");
    let mut stderr = child.stderr.take().expect("stderr is piped");

    // stderr -> server.log, for the life of the process.
    let mut log_for_thread = log.try_clone().map_err(|e| e.to_string())?;
    thread::spawn(move || {
        let mut buf = [0u8; 8192];
        while let Ok(n) = stderr.read(&mut buf) {
            if n == 0 {
                break;
            }
            let _ = log_for_thread.write_all(&buf[..n]);
        }
    });

    // First stdout line is the handshake; anything after it is drained so a
    // stray write can never block the server on a full pipe.
    let (tx, rx) = mpsc::channel::<Result<String, String>>();
    thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        let mut first = String::new();
        let sent = match reader.read_line(&mut first) {
            Ok(0) => tx.send(Err("the server exited before announcing its port".into())),
            Ok(_) => tx.send(Ok(first)),
            Err(e) => tx.send(Err(format!("reading the server's stdout failed: {e}"))),
        };
        drop(sent);
        let mut sink = Vec::new();
        let _ = reader.read_to_end(&mut sink);
    });

    let line = match rx.recv_timeout(ANNOUNCE_TIMEOUT) {
        Ok(Ok(line)) => line,
        Ok(Err(e)) => return Err(fail(child, &log_path, e)),
        Err(_) => return Err(fail(child, &log_path, "the server did not announce a port within 15s".into())),
    };
    let port = parse_announce(&line).map_err(|e| {
        let _ = writeln!(log, "[grunt-desktop] {e}");
        e
    })?;

    Ok(Server { stdin: child.stdin.take(), child, port, token })
}

fn fail(mut child: Child, log_path: &Path, reason: String) -> String {
    let _ = child.kill();
    let _ = child.wait();
    let log_tail = tail(log_path, 4000);
    if log_tail.trim().is_empty() {
        reason
    } else {
        format!("{reason}\n\nServer log ({}):\n{log_tail}", log_path.display())
    }
}

impl Server {
    /// Closes the server's stdin, waits briefly for it to exit, then kills it.
    pub fn stop(mut self) {
        drop(self.stdin.take());
        let deadline = Instant::now() + SHUTDOWN_GRACE;
        while Instant::now() < deadline {
            match self.child.try_wait() {
                Ok(Some(_)) => return,
                Ok(None) => thread::sleep(Duration::from_millis(50)),
                Err(_) => break,
            }
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_a_valid_announce_line() {
        assert_eq!(parse_announce("{\"port\":51234}\n"), Ok(51234));
    }

    #[test]
    fn tolerates_crlf() {
        assert_eq!(parse_announce("{\"port\":4747}\r\n"), Ok(4747));
    }

    #[test]
    fn rejects_garbage() {
        assert!(parse_announce("Grunt server listening on http://127.0.0.1:4747").is_err());
    }

    #[test]
    fn rejects_port_zero_and_out_of_range() {
        assert!(parse_announce("{\"port\":0}").is_err());
        assert!(parse_announce("{\"port\":70000}").is_err());
    }

    #[test]
    fn token_is_64_lowercase_hex_chars_and_unique() {
        let a = generate_token().unwrap();
        let b = generate_token().unwrap();
        assert_eq!(a.len(), 64);
        assert!(a.chars().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()));
        assert_ne!(a, b);
    }
}
