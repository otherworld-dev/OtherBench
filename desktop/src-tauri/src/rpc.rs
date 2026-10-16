//! The computer-use channel between the shell and the server it starts
//! (`.superpowers/sdd/2026-10-12-computer-use/shell-wire-spec.md`, the binding
//! text; `packages/server/src/computer/desktop-channel.ts` is the other end).
//!
//! After the announce line `{"port":N,"rpc":"<word>"}`, the server writes to
//! its stdout and the shell answers on the server's stdin, one JSON object per
//! line:
//!
//!   server to shell   OTHERBENCH-RPC <word> {"id":<n>,"method":"<m>","params":{...}}
//!                     OTHERBENCH-RPC <word> {"method":"computer.close","params":{}}
//!   shell to server   OTHERBENCH-RPC {"id":<n>,"result":<value>}
//!                     OTHERBENCH-RPC {"id":<n>,"error":{"message":"...","code":"..."}}
//!                     OTHERBENCH-RPC {"event":"<name>","params":{...}}
//!
//! `<word>` is new for every launch and only the announce line carries it, so
//! nothing else that writes to the server's stdout can pass for a request.
//! The word stays inside the reader thread (`pump`): it is never logged, shown
//! or handed on.
//!
//! Everything here is pure (no window, no input, no screen) and unit-tested.

use std::io::{BufRead, Write};
use std::sync::{Arc, Mutex, MutexGuard};
use std::thread;
use std::time::{Duration, Instant};

use serde_json::{json, Map, Value};

/// `OTHERBENCH-RPC` and one space, exactly.
pub const PREFIX: &str = "OTHERBENCH-RPC ";

/// The longest line the shell reads from the server, before its line end. A
/// longer one is thrown away as it arrives, without being held.
pub const MAX_LINE_IN: usize = 256 * 1024;

/// The longest line the server reads from the shell (`MAX_RPC_LINE_BYTES`):
/// a longer one closes the channel, so the shell never writes one.
pub const MAX_LINE_OUT: usize = 7_056_044;

/// The longest announce line the shell reads.
const MAX_ANNOUNCE: usize = 4096;

/// The server closes the channel at 100 events in a second; the shell keeps
/// itself to half of that, waiting rather than dropping one.
const EVENTS_PER_SECOND: u32 = 50;

/// What an answer says when the work behind it failed before it could answer.
const FAILED: &str = "The desktop app failed while handling that request.";

/// The error `code` the server acts on: no live session for that chat.
pub const NO_SESSION_CODE: &str = "no-session";

fn locked<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

// ---- the announce line ---------------------------------------------------

/// What the server's first stdout line says: its port, and this launch's
/// word when it opened the channel (`--desktop-rpc`).
#[derive(PartialEq, Eq)]
pub struct Announce {
    pub port: u16,
    pub word: Option<String>,
}

// Never print the word, not even in a test failure.
impl std::fmt::Debug for Announce {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Announce").field("port", &self.port).field("word", &self.word.as_ref().map(|_| "<withheld>")).finish()
    }
}

/// A launch word is 32 lowercase hex digits.
pub fn is_word(word: &str) -> bool {
    word.len() == 32 && word.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// Parses the announce line. A word that is not 32 lowercase hex digits is
/// no word: the channel then stays shut (no line is ever acted on).
pub fn parse_announce(line: &str) -> Result<Announce, String> {
    let value: Value = serde_json::from_str(line.trim()).map_err(|_| "the server's first line was not its announce line".to_string())?;
    let port = value.get("port").and_then(Value::as_u64).ok_or("the server's announce line has no port")?;
    let port = u16::try_from(port).map_err(|_| "the server announced a port out of range".to_string())?;
    if port == 0 {
        return Err("the server announced port 0".into());
    }
    let word = value.get("rpc").and_then(Value::as_str).filter(|w| is_word(w)).map(str::to_string);
    Ok(Announce { port, word })
}

// ---- reading lines ---------------------------------------------------------

#[derive(Debug, PartialEq, Eq)]
pub enum Next {
    /// One whole line, without its `\n` (a `\r` before it is still there).
    Line,
    /// A line over the cap went by; nothing of it was kept.
    Dropped,
    /// The stream ended (a cut-off last line is not a line).
    End,
}

/// Reads the next line into `line`, splitting on the byte 0x0A only. A line
/// longer than `cap` bytes is discarded as it arrives: once it passes the cap,
/// nothing more of it is kept, whatever its length.
pub fn next_line(reader: &mut impl BufRead, cap: usize, line: &mut Vec<u8>) -> Next {
    line.clear();
    let mut dropping = false;
    loop {
        let (found, used) = {
            let buf = match reader.fill_buf() {
                Ok(buf) => buf,
                Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(_) => return Next::End,
            };
            if buf.is_empty() {
                return Next::End;
            }
            match buf.iter().position(|&b| b == b'\n') {
                Some(at) => {
                    if !dropping && line.len() + at <= cap {
                        line.extend_from_slice(&buf[..at]);
                    } else {
                        dropping = true;
                    }
                    (true, at + 1)
                }
                None => {
                    if !dropping && line.len() + buf.len() <= cap {
                        line.extend_from_slice(buf);
                    } else {
                        dropping = true;
                        line.clear();
                    }
                    (false, buf.len())
                }
            }
        };
        reader.consume(used);
        if found {
            if dropping {
                line.clear();
                return Next::Dropped;
            }
            return Next::Line;
        }
    }
}

// ---- what the server sends -------------------------------------------------

#[derive(Debug, Clone, PartialEq)]
pub struct Request {
    pub id: u64,
    pub method: String,
    pub params: Value,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Incoming {
    Request(Request),
    Notification { method: String, params: Value },
}

/// One line from the server, or None for anything that is not a message for
/// this launch: a line without the exact prefix and word, a line that is not
/// UTF-8 or not one JSON object (a lone surrogate escape included: the whole
/// line is ignored), one with no string `method`, or one whose `id` is not a
/// positive integer (it can't be answered, so it is not acted on either).
pub fn parse_line(line: &[u8], word: &str) -> Option<Incoming> {
    let line = line.strip_suffix(b"\r").unwrap_or(line);
    let rest = line.strip_prefix(PREFIX.as_bytes())?;
    let rest = rest.strip_prefix(word.as_bytes())?;
    let body = rest.strip_prefix(b" ")?;
    let text = std::str::from_utf8(body).ok()?;
    let Value::Object(message) = serde_json::from_str::<Value>(text).ok()? else { return None };
    let method = message.get("method")?.as_str()?.to_string();
    let params = message.get("params").cloned().unwrap_or(Value::Null);
    match message.get("id") {
        None => Some(Incoming::Notification { method, params }),
        Some(id) => {
            let id = id.as_u64().filter(|&id| id >= 1)?;
            Some(Incoming::Request(Request { id, method, params }))
        }
    }
}

// ---- what the shell writes -------------------------------------------------

pub fn answer_line(id: u64, result: &Value) -> String {
    format!("{PREFIX}{}\n", json!({ "id": id, "result": result }))
}

pub fn error_line(id: u64, message: &str, code: Option<&str>) -> String {
    let mut error = Map::new();
    error.insert("message".into(), Value::String(message.to_string()));
    if let Some(code) = code {
        error.insert("code".into(), Value::String(code.to_string()));
    }
    format!("{PREFIX}{}\n", json!({ "id": id, "error": error }))
}

pub fn event_line(event: &str, params: &Value) -> String {
    format!("{PREFIX}{}\n", json!({ "event": event, "params": params }))
}

type Broken = Box<dyn Fn() + Send + Sync>;

struct Rate {
    window: Instant,
    count: u32,
}

struct WriterInner {
    /// The server's stdin. One lock for every thread that writes (answers and
    /// events come from different threads): each line is one `write_all`.
    sink: Mutex<Option<Box<dyn Write + Send>>>,
    rate: Mutex<Rate>,
    broken: Mutex<Option<Broken>>,
}

/// Our end of the server's stdin, shared by every thread that answers or
/// tells. Closing it (`close`) is the server's shutdown signal.
#[derive(Clone)]
pub struct Writer(Arc<WriterInner>);

impl Writer {
    pub fn new(sink: Option<Box<dyn Write + Send>>) -> Self {
        Self(Arc::new(WriterInner {
            sink: Mutex::new(sink),
            rate: Mutex::new(Rate { window: Instant::now(), count: 0 }),
            broken: Mutex::new(None),
        }))
    }

    /// Called once if a write fails (the server is gone): the channel is lost.
    pub fn on_broken(&self, hook: impl Fn() + Send + Sync + 'static) {
        *locked(&self.0.broken) = Some(Box::new(hook));
    }

    /// Writes one whole line, then flushes; false once closed or broken.
    fn send(&self, line: &str) -> bool {
        {
            let mut sink = locked(&self.0.sink);
            let Some(out) = sink.as_mut() else { return false };
            if out.write_all(line.as_bytes()).and_then(|_| out.flush()).is_ok() {
                return true;
            }
            sink.take();
        }
        // Outside the lock: the hook ends every session, which may write.
        if let Some(hook) = locked(&self.0.broken).take() {
            hook();
        }
        false
    }

    /// Answers request `id`. A result that would make a line longer than the
    /// server reads is answered with an error instead.
    pub fn answer(&self, id: u64, result: &Value) -> bool {
        let line = answer_line(id, result);
        if line.len() - 1 > MAX_LINE_OUT {
            return self.error(id, "The answer was too large to send.", None);
        }
        self.send(&line)
    }

    pub fn error(&self, id: u64, message: &str, code: Option<&str>) -> bool {
        self.send(&error_line(id, message, code))
    }

    /// Sends an event, never more than `EVENTS_PER_SECOND` in a second: past
    /// that it waits for the next second rather than drop one.
    pub fn event(&self, name: &str, params: &Value) -> bool {
        let mut rate = locked(&self.0.rate);
        let elapsed = rate.window.elapsed();
        if elapsed >= Duration::from_secs(1) {
            rate.window = Instant::now();
            rate.count = 0;
        } else if rate.count >= EVENTS_PER_SECOND {
            thread::sleep(Duration::from_secs(1) - elapsed);
            rate.window = Instant::now();
            rate.count = 0;
        }
        rate.count += 1;
        self.send(&event_line(name, params))
    }

    pub fn close(&self) {
        locked(&self.0.sink).take();
    }
}

/// The answer a request is owed, given out once per request read. It is
/// answered exactly once: by `ok` or `err`, or, if it is dropped unanswered
/// (a worker that failed or panicked, a thread that could not start), with a
/// plain error.
pub struct Reply {
    id: u64,
    writer: Writer,
    done: bool,
}

impl Reply {
    pub fn new(id: u64, writer: Writer) -> Self {
        Self { id, writer, done: false }
    }

    pub fn ok(mut self, result: Value) {
        self.done = true;
        self.writer.answer(self.id, &result);
    }

    pub fn err(mut self, message: &str, code: Option<&str>) {
        self.done = true;
        self.writer.error(self.id, message, code);
    }
}

impl Drop for Reply {
    fn drop(&mut self) {
        if !self.done {
            self.done = true;
            self.writer.error(self.id, FAILED, None);
        }
    }
}

/// What reads the channel: called on the reader thread, in the order the
/// lines arrived. `request` must do its reader-thread part before it returns
/// (a `computer.end` marks the chat's session dead there) and hand the rest
/// to a worker.
pub trait Handler: Send + Sync {
    /// The writer this server's channel answers on, given once before anything is read (events go through it).
    fn attach(&self, writer: Writer);
    fn request(&self, request: Request, reply: Reply);
    /// A notification; true when the shell must act on no further line (`computer.close`).
    fn notification(&self, method: &str, params: &Value) -> bool;
    /// The server's stdout ended: the channel is lost.
    fn lost(&self);
}

/// Reads the server's stdout after the announce line until it closes,
/// handing each message for this launch on. Every other line is read and
/// dropped, so a stray write never fills the pipe and blocks the server.
/// Without a word nothing is ever acted on. After `computer.close` the rest
/// is read and dropped. When the stream ends, `lost` is called once.
pub fn pump(mut reader: impl BufRead, word: Option<String>, writer: &Writer, handler: &dyn Handler) {
    handler.attach(writer.clone());
    let mut line = Vec::new();
    let mut listening = word.is_some();
    loop {
        match next_line(&mut reader, MAX_LINE_IN, &mut line) {
            Next::End => break,
            Next::Dropped => continue,
            Next::Line => {}
        }
        if !listening {
            continue;
        }
        let Some(word) = word.as_deref() else { continue };
        match parse_line(&line, word) {
            Some(Incoming::Request(request)) => {
                let reply = Reply::new(request.id, writer.clone());
                handler.request(request, reply);
            }
            Some(Incoming::Notification { method, params }) => {
                if handler.notification(&method, &params) {
                    listening = false;
                }
            }
            None => {}
        }
    }
    handler.lost();
}

/// Reads the announce line (the first line, at most a few KiB).
pub fn read_announce(reader: &mut impl BufRead) -> Result<String, String> {
    let mut line = Vec::new();
    match next_line(reader, MAX_ANNOUNCE, &mut line) {
        Next::Line => String::from_utf8(line).map_err(|_| "the server's first line was not text".to_string()),
        Next::Dropped => Err("the server's first line was too long to be its announce line".into()),
        Next::End => Err("the server exited before announcing its port".into()),
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::io::Cursor;

    pub const WORD: &str = "0123456789abcdef0123456789abcdef";

    /// What the shell wrote, shared with the test.
    #[derive(Clone, Default)]
    pub struct Sink(pub Arc<Mutex<Vec<u8>>>);
    impl Write for Sink {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(buf);
            Ok(buf.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    impl Sink {
        pub fn lines(&self) -> Vec<String> {
            String::from_utf8(self.0.lock().unwrap().clone()).unwrap().lines().map(str::to_string).collect()
        }
        /// Each line's JSON, after checking it is one `OTHERBENCH-RPC ` line.
        pub fn messages(&self) -> Vec<Value> {
            self.lines()
                .iter()
                .map(|l| {
                    assert!(l.starts_with(PREFIX), "{l}");
                    serde_json::from_str(&l[PREFIX.len()..]).unwrap()
                })
                .collect()
        }
    }

    pub fn writer() -> (Writer, Sink) {
        let sink = Sink::default();
        (Writer::new(Some(Box::new(sink.clone()))), sink)
    }

    fn line(body: &str) -> Vec<u8> {
        format!("{PREFIX}{WORD} {body}").into_bytes()
    }

    #[test]
    fn reads_the_announce_line_and_its_word() {
        let a = parse_announce(&format!("{{\"port\":51234,\"rpc\":\"{WORD}\"}}\n")).unwrap();
        assert_eq!((a.port, a.word.as_deref()), (51234, Some(WORD)));
        assert_eq!(parse_announce("{\"port\":4747}\r\n").unwrap().word, None);
        for bad in ["0123456789ABCDEF0123456789ABCDEF", "0123", "", "0123456789abcdef0123456789abcdeg"] {
            assert_eq!(parse_announce(&format!("{{\"port\":1,\"rpc\":\"{bad}\"}}")).unwrap().word, None, "{bad}");
        }
        assert!(parse_announce("OtherBench server listening").is_err());
        assert!(parse_announce("{\"port\":0}").is_err());
        assert!(parse_announce("{\"port\":70000}").is_err());
        assert!(!format!("{a:?}").contains(WORD));
    }

    #[test]
    fn splits_on_the_newline_byte_only_and_tolerates_cr() {
        let body = "{\"id\":1,\"method\":\"computer.start\",\"params\":{\"chatId\":\"c\",\"title\":\"a\u{2028}b\u{2029}c\"}}";
        let input = format!("{PREFIX}{WORD} {body}\r\n");
        let mut reader = Cursor::new(input.into_bytes());
        let mut buf = Vec::new();
        assert_eq!(next_line(&mut reader, MAX_LINE_IN, &mut buf), Next::Line);
        let Some(Incoming::Request(r)) = parse_line(&buf, WORD) else { panic!("not a request") };
        assert_eq!(r.params["title"], json!("a\u{2028}b\u{2029}c"));
        assert_eq!(next_line(&mut reader, MAX_LINE_IN, &mut buf), Next::End);
    }

    #[test]
    fn drops_a_line_over_the_cap_without_holding_it() {
        // A 300 KiB line, read through a small buffer, holds at most the cap.
        let mut input = vec![b'x'; 300 * 1024];
        input.push(b'\n');
        input.extend_from_slice(&line("{\"id\":2,\"method\":\"computer.hello\"}"));
        input.push(b'\n');
        let mut reader = std::io::BufReader::with_capacity(4096, Cursor::new(input));
        let mut buf = Vec::new();
        assert_eq!(next_line(&mut reader, MAX_LINE_IN, &mut buf), Next::Dropped);
        assert!(buf.capacity() <= MAX_LINE_IN + 4096, "{}", buf.capacity());
        assert_eq!(next_line(&mut reader, MAX_LINE_IN, &mut buf), Next::Line);
        assert!(matches!(parse_line(&buf, WORD), Some(Incoming::Request(Request { id: 2, .. }))));
        // Exactly at the cap is a line; one byte more is not.
        let mut at = vec![b'y'; 10];
        at.push(b'\n');
        assert_eq!(next_line(&mut Cursor::new(at.clone()), 10, &mut buf), Next::Line);
        assert_eq!(next_line(&mut Cursor::new(at), 9, &mut buf), Next::Dropped);
        // A cut-off last line is not a line.
        assert_eq!(next_line(&mut Cursor::new(b"no end".to_vec()), 100, &mut buf), Next::End);
    }

    #[test]
    fn acts_only_on_lines_with_the_exact_prefix_and_word() {
        let ok = "{\"id\":1,\"method\":\"computer.hello\",\"params\":{}}";
        assert!(parse_line(&line(ok), WORD).is_some());
        for bad in [
            format!("OTHERBENCH-RPC {ok}"),
            format!("otherbench-rpc {WORD} {ok}"),
            format!("OTHERBENCH-RPC  {WORD} {ok}"),
            format!("OTHERBENCH-RPC {WORD}{ok}"),
            format!("OTHERBENCH-RPC {} {ok}", WORD.to_uppercase()),
            format!("OTHERBENCH-RPC fedcba9876543210fedcba9876543210 {ok}"),
            format!(" OTHERBENCH-RPC {WORD} {ok}"),
            ok.to_string(),
        ] {
            assert_eq!(parse_line(bad.as_bytes(), WORD), None, "{bad}");
        }
    }

    #[test]
    fn ignores_unreadable_lines_whole() {
        for body in [
            "not json",
            "[1,2]",
            "{\"id\":1}",
            "{\"id\":1,\"method\":7}",
            "{\"id\":0,\"method\":\"computer.hello\"}",
            "{\"id\":-1,\"method\":\"computer.hello\"}",
            "{\"id\":1.5,\"method\":\"computer.hello\"}",
            "{\"id\":\"1\",\"method\":\"computer.hello\"}",
            // A lone surrogate escape: the whole line is ignored, never acted on in part.
            "{\"id\":1,\"method\":\"computer.start\",\"params\":{\"chatId\":\"\\ud800\",\"title\":\"x\"}}",
            "{\"id\":1,\"method\":\"computer.start\",\"params\":{\"chatId\":\"c\",\"title\":\"\\udc00x\"}}",
        ] {
            assert_eq!(parse_line(&line(body), WORD), None, "{body}");
        }
        let mut bytes = line("{\"id\":1,\"method\":\"x\",\"params\":\"");
        bytes.extend_from_slice(&[0xff, 0xfe, b'"', b'}']);
        assert_eq!(parse_line(&bytes, WORD), None);
        // A correctly paired escape is fine.
        assert!(parse_line(&line("{\"id\":1,\"method\":\"m\",\"params\":{\"t\":\"\\ud83d\\ude00\"}}"), WORD).is_some());
    }

    #[test]
    fn tells_requests_from_notifications() {
        assert_eq!(
            parse_line(&line("{\"method\":\"computer.close\",\"params\":{}}"), WORD),
            Some(Incoming::Notification { method: "computer.close".into(), params: json!({}) })
        );
        assert_eq!(
            parse_line(&line("{\"id\":7,\"method\":\"computer.target\",\"params\":{\"x\":1}}"), WORD),
            Some(Incoming::Request(Request { id: 7, method: "computer.target".into(), params: json!({ "x": 1 }) }))
        );
    }

    #[test]
    fn writes_one_prefixed_line_per_message_with_json_types() {
        let (w, sink) = writer();
        assert!(w.answer(7, &json!({ "ok": true, "session": "abc" })));
        assert!(w.error(8, "no\nway", Some(NO_SESSION_CODE)));
        assert!(w.error(9, "plain", None));
        assert!(w.event("computer.stopped", &json!({ "chatId": "c", "why": "hotkey" })));
        let raw = String::from_utf8(sink.0.lock().unwrap().clone()).unwrap();
        assert_eq!(raw.matches('\n').count(), 4);
        assert_eq!(
            sink.messages(),
            vec![
                json!({ "id": 7, "result": { "ok": true, "session": "abc" } }),
                json!({ "id": 8, "error": { "message": "no\nway", "code": "no-session" } }),
                json!({ "id": 9, "error": { "message": "plain" } }),
                json!({ "event": "computer.stopped", "params": { "chatId": "c", "why": "hotkey" } }),
            ]
        );
        assert!(sink.lines()[0].starts_with("OTHERBENCH-RPC {\"id\":7,"));
    }

    #[test]
    fn an_answer_too_long_for_the_server_is_an_error_instead() {
        let (w, sink) = writer();
        w.answer(3, &json!({ "png": "A".repeat(MAX_LINE_OUT) }));
        assert_eq!(sink.messages(), vec![json!({ "id": 3, "error": { "message": "The answer was too large to send." } })]);
    }

    #[test]
    fn a_reply_is_answered_once_even_when_dropped() {
        let (w, sink) = writer();
        Reply::new(1, w.clone()).ok(json!({ "ok": true }));
        drop(Reply::new(2, w.clone()));
        let r = Reply::new(3, w.clone());
        let t = thread::spawn(move || {
            let _r = r;
            panic!("a worker that panics still answers");
        });
        assert!(t.join().is_err());
        let ids: Vec<u64> = sink.messages().iter().map(|m| m["id"].as_u64().unwrap()).collect();
        assert_eq!(ids, [1, 2, 3]);
        assert!(sink.messages()[1]["error"]["message"].is_string());
    }

    struct Broken;
    impl Write for Broken {
        fn write(&mut self, _: &[u8]) -> std::io::Result<usize> {
            Err(std::io::ErrorKind::BrokenPipe.into())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    #[test]
    fn a_failed_write_closes_the_writer_and_says_so_once() {
        let w = Writer::new(Some(Box::new(Broken)));
        let told = Arc::new(Mutex::new(0));
        let t = told.clone();
        w.on_broken(move || *t.lock().unwrap() += 1);
        assert!(!w.answer(1, &json!(1)));
        assert!(!w.error(3, "x", None));
        assert!(!w.answer(2, &json!(1)));
        assert_eq!(*told.lock().unwrap(), 1);
        let (w, sink) = writer();
        w.close();
        assert!(!w.event("x", &json!({})));
        assert!(sink.lines().is_empty());
    }

    #[test]
    fn events_wait_rather_than_flood() {
        let (w, sink) = writer();
        let started = Instant::now();
        for _ in 0..(EVENTS_PER_SECOND + 1) {
            w.event("computer.shortcuts", &json!({ "shortcuts": [] }));
        }
        assert!(started.elapsed() >= Duration::from_millis(500), "{:?}", started.elapsed());
        assert_eq!(sink.lines().len(), EVENTS_PER_SECOND as usize + 1);
    }

    #[derive(Default)]
    struct Recorder {
        seen: Mutex<Vec<String>>,
    }
    impl Handler for Recorder {
        fn attach(&self, _writer: Writer) {
            self.seen.lock().unwrap().push("attach".into());
        }
        fn request(&self, request: Request, reply: Reply) {
            self.seen.lock().unwrap().push(format!("{} {}", request.id, request.method));
            if request.method == "unknown" {
                reply.err("Unknown method.", None);
            } else {
                reply.ok(json!({}));
            }
        }
        fn notification(&self, method: &str, _params: &Value) -> bool {
            self.seen.lock().unwrap().push(method.to_string());
            method == "computer.close"
        }
        fn lost(&self) {
            self.seen.lock().unwrap().push("lost".into());
        }
    }

    #[test]
    fn pump_acts_on_this_launch_only_and_stops_after_close() {
        let mut input = Vec::new();
        for l in [
            b"noise".to_vec(),
            line("{\"id\":1,\"method\":\"computer.hello\",\"params\":{}}"),
            format!("OTHERBENCH-RPC {{\"id\":2,\"method\":\"computer.hello\"}}").into_bytes(),
            vec![0xff, 0xfe],
            line("not json"),
            line("{\"id\":3,\"method\":\"unknown\"}"),
            line("{\"method\":\"computer.other\",\"params\":{}}"),
            line("{\"method\":\"computer.close\",\"params\":{}}"),
            line("{\"id\":4,\"method\":\"computer.hello\"}"),
        ] {
            input.extend_from_slice(&l);
            input.push(b'\n');
        }
        let (w, sink) = writer();
        let rec = Recorder::default();
        pump(Cursor::new(input), Some(WORD.into()), &w, &rec);
        assert_eq!(*rec.seen.lock().unwrap(), ["attach", "1 computer.hello", "3 unknown", "computer.other", "computer.close", "lost"]);
        let answered: Vec<u64> = sink.messages().iter().map(|m| m["id"].as_u64().unwrap()).collect();
        assert_eq!(answered, [1, 3]);
    }

    #[test]
    fn pump_without_a_word_acts_on_nothing() {
        let rec = Recorder::default();
        let (w, _) = writer();
        let mut input = line("{\"id\":1,\"method\":\"computer.hello\"}");
        input.push(b'\n');
        pump(Cursor::new(input), None, &w, &rec);
        assert_eq!(*rec.seen.lock().unwrap(), ["attach", "lost"]);
    }

    #[test]
    fn reads_the_announce_line_with_a_cap() {
        let mut r = Cursor::new(b"{\"port\":5}\nOTHERBENCH-RPC x\n".to_vec());
        assert_eq!(read_announce(&mut r).unwrap(), "{\"port\":5}");
        let mut long = vec![b'{'; 10_000];
        long.push(b'\n');
        assert!(read_announce(&mut Cursor::new(long)).is_err());
        assert!(read_announce(&mut Cursor::new(Vec::new())).is_err());
    }
}
