//! One Markie RS per data folder: Electron's `requestSingleInstanceLock` and
//! `second-instance` event.
//!
//! The first process listens on a Unix socket named after its data folder. A
//! second launch connects, hands over its arguments (files made absolute,
//! `markie-rs://` links as they are) and exits, and the first opens them and
//! comes to the front. A second launch with nothing to open just raises the
//! window, as Electron does.
//!
//! A different `MARKIE_RS_DATA_DIR` is a different instance, the same way a
//! different Electron `--user-data-dir` is, so scratch test runs never hand
//! their files to Kirby's copy.
//!
//! Windows would use a named pipe in the same place; it is not built yet and
//! every launch there is the first.

use std::path::{Path, PathBuf};

/// What the running instance gets from a second launch: one argument per line.
pub fn encode_args(args: &[String]) -> String {
    let mut out = String::new();
    for a in args {
        if a.contains('\n') {
            continue;
        }
        out.push_str(a);
        out.push('\n');
    }
    out
}

pub fn decode_args(text: &str) -> Vec<String> {
    text.lines().filter(|l| !l.is_empty()).map(str::to_string).collect()
}

/// A file argument made absolute against the second launch's working folder,
/// so the first instance opens the same file. Links and flags pass through.
pub fn absolutize(arg: &str, cwd: &Path) -> String {
    if arg.starts_with('-') || arg.contains("://") {
        return arg.to_string();
    }
    let p = Path::new(arg);
    if p.is_absolute() { arg.to_string() } else { cwd.join(p).to_string_lossy().into_owned() }
}

/// The arguments as URLs for the shared open queue: `file://` for paths.
pub fn as_urls(args: &[String]) -> Vec<String> {
    args.iter()
        .filter_map(|a| {
            if a.contains("://") {
                Some(a.clone())
            } else if a.starts_with('-') {
                None
            } else {
                url::Url::from_file_path(a).ok().map(|u| u.to_string())
            }
        })
        .collect()
}

/// The socket for a data folder. Kept in the temp folder because a Unix
/// socket path is limited to about 100 bytes and scratch folders run long.
pub fn socket_path(data_dir: &Path) -> PathBuf {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    data_dir.hash(&mut h);
    std::env::temp_dir().join(format!("markie-rs-{:016x}.sock", h.finish()))
}

pub enum Claim {
    /// This process is the instance. Arguments from later launches arrive here.
    Primary(std::sync::mpsc::Receiver<Vec<String>>),
    /// Another process took the arguments. Exit.
    Handed,
}

#[cfg(unix)]
pub fn claim(data_dir: &Path, args: &[String]) -> Claim {
    use std::io::{Read, Write};
    use std::os::unix::net::{UnixListener, UnixStream};

    let path = socket_path(data_dir);
    if let Ok(mut stream) = UnixStream::connect(&path) {
        let cwd = std::env::current_dir().unwrap_or_default();
        let args: Vec<String> = args.iter().map(|a| absolutize(a, &cwd)).collect();
        if stream.write_all(encode_args(&args).as_bytes()).is_ok() {
            return Claim::Handed;
        }
    }
    // Nobody answered: a socket left by a crash. Take it over.
    let _ = std::fs::remove_file(&path);
    let (tx, rx) = std::sync::mpsc::channel();
    match UnixListener::bind(&path) {
        Ok(listener) => {
            std::thread::Builder::new()
                .name("markie-rs-instance".into())
                .spawn(move || {
                    for stream in listener.incoming().flatten() {
                        let stream: UnixStream = stream;
                        let _ = stream.set_read_timeout(Some(std::time::Duration::from_secs(2)));
                        let mut text = String::new();
                        let _ = stream.take(1 << 20).read_to_string(&mut text);
                        if tx.send(decode_args(&text)).is_err() {
                            break;
                        }
                    }
                })
                .ok();
        }
        Err(e) => eprintln!("markie-rs: single-instance socket unavailable: {e}"),
    }
    Claim::Primary(rx)
}

#[cfg(not(unix))]
pub fn claim(_data_dir: &Path, _args: &[String]) -> Claim {
    let (_tx, rx) = std::sync::mpsc::channel();
    std::mem::forget(_tx);
    Claim::Primary(rx)
}

/// Remove the socket on a clean quit, so the next launch does not first try a dead one.
pub fn release(data_dir: &Path) {
    let _ = std::fs::remove_file(socket_path(data_dir));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn args_round_trip() {
        let args = vec!["/a b/c.md".to_string(), "markie-rs://open?token=t".to_string(), "bad\nline".to_string()];
        assert_eq!(decode_args(&encode_args(&args)), vec!["/a b/c.md".to_string(), "markie-rs://open?token=t".to_string()]);
        assert_eq!(absolutize("notes.md", Path::new("/w")), "/w/notes.md");
        assert_eq!(absolutize("/x.md", Path::new("/w")), "/x.md");
        assert_eq!(absolutize("markie-rs://doc?id=1", Path::new("/w")), "markie-rs://doc?id=1");
        assert_eq!(absolutize("--flag", Path::new("/w")), "--flag");
        assert_eq!(
            as_urls(&["/a b.md".into(), "markie-rs://doc?id=1".into(), "-psn_0_1".into()]),
            vec!["file:///a%20b.md".to_string(), "markie-rs://doc?id=1".to_string()]
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_second_launch_hands_over_and_a_stale_socket_is_taken_over() {
        let dir = tempfile::tempdir().unwrap();
        // A stale socket file from a crashed run.
        std::fs::write(socket_path(dir.path()), "").unwrap();
        let Claim::Primary(rx) = claim(dir.path(), &[]) else { panic!("first launch must be the instance") };
        let Claim::Handed = claim(dir.path(), &["/tmp/x.md".into(), "markie-rs://open?token=t".into()]) else {
            panic!("second launch must hand over")
        };
        let got = rx.recv_timeout(std::time::Duration::from_secs(5)).unwrap();
        assert_eq!(got, vec!["/tmp/x.md".to_string(), "markie-rs://open?token=t".to_string()]);
        let Claim::Handed = claim(dir.path(), &[]) else { panic!() };
        assert_eq!(rx.recv_timeout(std::time::Duration::from_secs(5)).unwrap(), Vec::<String>::new());
        // Another data folder is another instance.
        let other = tempfile::tempdir().unwrap();
        assert!(matches!(claim(other.path(), &[]), Claim::Primary(_)));
        release(dir.path());
        release(other.path());
    }
}
