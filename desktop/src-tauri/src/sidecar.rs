//! The OtherBench server as a child process of the shell.
//!
//! The server is started with `serve --port 0 --announce --desktop-rpc`, its
//! per-launch token in `OTHERBENCH_TOKEN` (never on the command line, which every
//! process on the machine can read), and stdin piped. Its first stdout line is
//! `{"port":N,"rpc":"<word>"}`; after it, stdout and stdin carry only the
//! computer-use channel (rpc.rs). Everything it logs goes to stderr, which is
//! copied to `server.log` in the app's log directory. Dropping our end of
//! stdin is the shutdown signal: the server closes and exits when its stdin
//! ends, which also covers this process dying without running any cleanup.

use std::fs::{self, File};
use std::io::{BufReader, Read, Write};

use crate::rpc;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{mpsc, Arc};
use std::thread;
use std::time::{Duration, Instant};

/// A Windows path without its `\\?\` (verbatim) prefix. Tauri's resource
/// directory carries one, and Node can't start a script from such a path
/// (it fails with `EISDIR: lstat 'C:'`). `\\?\UNC\server\share` becomes
/// `\\server\share`; any other path is returned as it was.
pub fn plain_path(path: &Path) -> PathBuf {
    let s = path.to_string_lossy();
    if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
        return PathBuf::from(format!(r"\\{rest}"));
    }
    if let Some(rest) = s.strip_prefix(r"\\?\") {
        return PathBuf::from(rest);
    }
    path.to_path_buf()
}

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
    /// Our end of the server's stdin: answers and events go through it, and closing it is the shutdown signal.
    writer: rpc::Writer,
    pub port: u16,
    pub token: String,
}

/// 32 random bytes as lowercase hex.
pub fn generate_token() -> Result<String, String> {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).map_err(|e| format!("no randomness available: {e}"))?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

/// The port in the server's `{"port":N,"rpc":"<word>"}` handshake line (the
/// reader thread in `start` takes the word too). The error never quotes the
/// line: it may hold this launch's word.
#[cfg(test)]
fn parse_announce(line: &str) -> Result<u16, String> {
    rpc::parse_announce(line).map(|a| a.port)
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

/// Starts the server. `handler` reads the computer-use channel (computer.rs)
/// from the server's stdout, on a thread of its own, and is told when the
/// channel is lost.
pub fn start(spec: &LaunchSpec, handler: Arc<dyn rpc::Handler>) -> Result<Server, String> {
    let token = generate_token()?;
    fs::create_dir_all(&spec.log_dir).map_err(|e| format!("cannot create log directory: {e}"))?;
    let log_path = spec.log_dir.join("server.log");
    let mut log = File::create(&log_path).map_err(|e| format!("cannot create {}: {e}", log_path.display()))?;

    let mut cmd = Command::new(plain_path(&spec.node));
    cmd.arg(plain_path(&spec.script)).args(["serve", "--port", "0", "--announce", "--desktop-rpc"]);
    for origin in &spec.cors_origins {
        cmd.args(["--cors-origin", origin]);
    }
    cmd.env("OTHERBENCH_TOKEN", &token)
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
            "could not start the OtherBench server ({} {}): {e}",
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

    // Our end of the server's stdin. A write that fails means the server is
    // gone: the channel is lost, as when its stdout ends.
    let writer = rpc::Writer::new(child.stdin.take().map(|s| Box::new(s) as Box<dyn Write + Send>));
    {
        let handler = handler.clone();
        writer.on_broken(move || handler.lost());
    }

    // The first stdout line is the handshake; it carries this launch's word,
    // which stays in this thread. After it come OTHERBENCH-RPC requests (rpc.rs);
    // anything else is read and dropped, so a stray write can never block the
    // server on a full pipe.
    let (tx, rx) = mpsc::channel::<Result<u16, String>>();
    let pump_writer = writer.clone();
    thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        let word = match rpc::read_announce(&mut reader).and_then(|line| rpc::parse_announce(&line)) {
            Ok(announce) => {
                let _ = tx.send(Ok(announce.port));
                announce.word
            }
            Err(e) => {
                let _ = tx.send(Err(e));
                None
            }
        };
        drop(tx);
        rpc::pump(reader, word, &pump_writer, &*handler);
    });

    let port = match rx.recv_timeout(ANNOUNCE_TIMEOUT) {
        Ok(Ok(port)) => port,
        Ok(Err(e)) => {
            let _ = writeln!(log, "[otherbench-desktop] {e}");
            return Err(fail(child, &log_path, e));
        }
        Err(_) => return Err(fail(child, &log_path, "the server did not announce a port within 15s".into())),
    };

    Ok(Server { writer, child, port, token })
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
        self.writer.close();
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
        assert!(parse_announce("OtherBench server listening on http://127.0.0.1:4747").is_err());
    }

    #[test]
    fn rejects_port_zero_and_out_of_range() {
        assert!(parse_announce("{\"port\":0}").is_err());
        assert!(parse_announce("{\"port\":70000}").is_err());
    }

    #[test]
    fn strips_the_verbatim_prefix_node_cannot_start_a_script_from() {
        assert_eq!(
            plain_path(Path::new(r"\\?\C:\Users\Adam\AppData\Local\OtherBench\server\cli.js")),
            PathBuf::from(r"C:\Users\Adam\AppData\Local\OtherBench\server\cli.js")
        );
        assert_eq!(plain_path(Path::new(r"\\?\UNC\server\share\cli.js")), PathBuf::from(r"\\server\share\cli.js"));
        assert_eq!(plain_path(Path::new(r"C:\plain\cli.js")), PathBuf::from(r"C:\plain\cli.js"));
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
