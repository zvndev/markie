//! One authenticated newline-delimited request per Unix connection.
use crate::{METHODS, Reply};
use serde_json::{Value, json};
use std::fs::{self, File, OpenOptions};
use std::io::{self, BufRead, BufReader, Read, Write};
use std::net::Shutdown;
use std::os::unix::fs::{DirBuilderExt, FileTypeExt, OpenOptionsExt, PermissionsExt};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering::Relaxed};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};
use subtle::ConstantTimeEq;

pub const DISCOVERY: &str = "agent-bridge-a65.json";
pub const SOCKET: &str = "markie-rs.sock";
pub const MAX_REQUEST: usize = 64 * 1024;
pub const TIMEOUT: Duration = Duration::from_secs(600);
const CONNECTION_LIMIT: usize = 16;

pub struct Request {
    pub method: String,
    pub params: Value,
}

pub struct Bridge {
    socket: PathBuf,
    discovery: PathBuf,
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
    _lock: File,
}

impl Bridge {
    pub fn start(
        data: &Path,
        handle: impl Fn(Request) -> Reply + Send + Sync + 'static,
    ) -> io::Result<Self> {
        let dir = data.join("agent");
        fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(&dir)?;
        if !fs::symlink_metadata(&dir)?.file_type().is_dir() {
            return Err(io::Error::other("Agent directory is not a directory"));
        }
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o700))?;
        let dir = dir.canonicalize()?;
        let lock_path = dir.join("bridge.lock");
        if fs::symlink_metadata(&lock_path).is_ok_and(|m| !m.is_file() || m.is_symlink()) {
            return Err(io::Error::other("Invalid Markie RS agent lock"));
        }
        let lock = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .mode(0o600)
            .open(lock_path)?;
        lock.try_lock()
            .map_err(|_| io::Error::other("Another Markie RS bridge owns this data directory"))?;
        let socket = dir.join(SOCKET);
        let discovery = dir.join(DISCOVERY);
        match fs::symlink_metadata(&socket) {
            Ok(m) if m.file_type().is_socket() => fs::remove_file(&socket)?,
            Ok(_) => return Err(io::Error::other("Refusing to overwrite a non-socket")),
            Err(e) if e.kind() == io::ErrorKind::NotFound => {}
            Err(e) => return Err(e),
        }
        let mut key = [0; 32];
        getrandom::fill(&mut key)
            .map_err(|_| io::Error::other("Could not generate bridge authentication"))?;
        let token: String = key.iter().map(|n| format!("{n:02x}")).collect();
        let listener = UnixListener::bind(&socket)?;
        let start = || -> io::Result<()> {
            fs::set_permissions(&socket, fs::Permissions::from_mode(0o600))?;
            listener.set_nonblocking(true)?;
            let mut file = tempfile::NamedTempFile::new_in(&dir)?;
            serde_json::to_writer(
                &mut file,
                &json!({
                    "socket": socket, "token": token, "pid": std::process::id(),
                    "app": "Markie RS", "version": env!("CARGO_PKG_VERSION"),
                    "startedAt": chrono::Utc::now().to_rfc3339(),
                }),
            )?;
            file.persist(&discovery)?;
            Ok(())
        };
        if let Err(error) = start() {
            let _ = fs::remove_file(&socket);
            return Err(error);
        }
        let stop = Arc::new(AtomicBool::new(false));
        let mut bridge = Self {
            socket,
            discovery,
            stop: stop.clone(),
            thread: None,
            _lock: lock,
        };
        let handle = Arc::new(handle);
        let count = Arc::new(AtomicUsize::new(0));
        bridge.thread = Some(thread::Builder::new().name("markie-agent".into()).spawn(
            move || {
                while !stop.load(Relaxed) {
                    match listener.accept() {
                        Ok((mut stream, _)) => {
                            if count.load(Relaxed) >= CONNECTION_LIMIT {
                                let _ = write_reply(
                                    &mut stream,
                                    Err("Markie RS is busy. Try again.".into()),
                                );
                                continue;
                            }
                            count.fetch_add(1, Relaxed);
                            let count = count.clone();
                            let handle = handle.clone();
                            let token = token.clone();
                            let _ = thread::Builder::new()
                                .name("markie-agent-request".into())
                                .spawn({
                                    let slot = ConnectionSlot(count);
                                    move || {
                                        let _slot = slot;
                                        let _ = serve(stream, &token, &*handle);
                                    }
                                });
                        }
                        Err(e) if e.kind() == io::ErrorKind::WouldBlock => {
                            thread::sleep(Duration::from_millis(20))
                        }
                        Err(e) if e.kind() == io::ErrorKind::Interrupted => {}
                        Err(_) => break,
                    }
                }
            },
        )?);
        Ok(bridge)
    }

    pub fn discovery(&self) -> &Path {
        &self.discovery
    }
}

struct ConnectionSlot(Arc<AtomicUsize>);
impl Drop for ConnectionSlot {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Relaxed);
    }
}

impl Drop for Bridge {
    fn drop(&mut self) {
        self.stop.store(true, Relaxed);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
        let _ = fs::remove_file(&self.discovery);
        let _ = fs::remove_file(&self.socket);
    }
}

fn serve(mut stream: UnixStream, token: &str, handle: &dyn Fn(Request) -> Reply) -> io::Result<()> {
    // Darwin may inherit O_NONBLOCK from the listener. A fragmented request
    // is not a disconnect; wait for the rest of its line up to the deadline.
    stream.set_nonblocking(false)?;
    let deadline = Instant::now() + TIMEOUT;
    let mut line = Vec::new();
    let mut reader = BufReader::new(&stream).take((MAX_REQUEST + 1) as u64);
    loop {
        let time_left = deadline.saturating_duration_since(Instant::now());
        if time_left.is_zero() {
            return Ok(());
        }
        stream.set_read_timeout(Some(time_left))?;
        let bytes = match reader.fill_buf() {
            Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
            other => other?,
        };
        if bytes.is_empty() {
            return Ok(());
        }
        let newline = bytes.iter().position(|b| *b == b'\n');
        let amount = newline.map_or(bytes.len(), |i| i + 1);
        line.extend_from_slice(&bytes[..amount]);
        reader.consume(amount);
        if line.len() > MAX_REQUEST || newline.is_some() {
            break;
        }
    }
    let response = if line.len() > MAX_REQUEST {
        Err("Request too large.".into())
    } else {
        parse_request(&line, token).and_then(handle)
    };
    write_reply(&mut stream, response)
}

fn parse_request(line: &[u8], token: &str) -> Result<Request, String> {
    let req: Value = serde_json::from_slice(line).map_err(|_| "Bad request.")?;
    let key = req["token"].as_str().unwrap_or_default();
    if !bool::from(token.as_bytes().ct_eq(key.as_bytes())) {
        return Err("Not authorized.".into());
    }
    let method = req["method"].as_str();
    if !method.is_some_and(|m| METHODS.contains(&m)) {
        let display = match req.get("method") {
            None => "undefined".into(),
            Some(Value::String(s)) => s.clone(),
            Some(Value::Object(_)) => "[object Object]".into(),
            Some(other) => other.to_string(),
        };
        return Err(format!("Unknown method: {display}"));
    }
    let params = &req["params"];
    Ok(Request {
        method: method.unwrap_or_default().into(),
        params: if params.is_object() || params.is_array() {
            params.clone()
        } else {
            json!({})
        },
    })
}

fn write_reply(stream: &mut UnixStream, response: Reply) -> io::Result<()> {
    stream.set_write_timeout(Some(Duration::from_secs(2)))?;
    let reply = match response {
        Ok(result) => json!({"ok": true, "result": result}),
        Err(error) => json!({"ok": false, "error": error}),
    };
    serde_json::to_writer(&mut *stream, &reply)?;
    stream.write_all(b"\n")?;
    stream.shutdown(Shutdown::Write)
}
