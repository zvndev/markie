//! The thread that keeps two-way Docs in sync while Markie is open.
//!
//! The window sends it what it sees (`Cmd`): a synced file saved, the window
//! focused, a file with unsaved edits, Sync Now. The thread runs the
//! `Scheduler` and `Detector` (`sync.rs`), one round per due file, and
//! shares a `Status` the window reads to draw each Doc's row and the file
//! header: Sending…, Waiting for connection, notices for conflicts and
//! stopped Docs, and the files it rewrote so an open editor reloads them.
//! Every minute it also reads each synced file, so edits made by another
//! app while Markie is open are sent too.
use crate::api::SyncSource;
use crate::error::GoogleError;
use crate::store::{self, Stopped};
use crate::sync::{Action, Detect, Detector, Scheduler, Synced, stopped_line, sync_doc};
use markie_core::history::History;
use rusqlite::Connection;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{Receiver, RecvTimeoutError, Sender, channel};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Cmd {
    /// Markie saved this file (or the open file changed on disk).
    Saved(PathBuf),
    /// The window came to the front.
    Focus,
    /// Sync these now (a row's Sync Now, or after turning sync on).
    SyncNow(Vec<PathBuf>),
    /// An editor has unsaved edits in this file, or not any more.
    Hold(PathBuf, bool),
    Stop,
}

/// What a Doc is doing right now, beyond what its record says.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Live {
    Sending,
    /// Offline or backing off after an error: the edit waits, never lost.
    Waiting,
    /// A local save is waiting out the debounce.
    Pending,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Notice {
    pub text: String,
    pub warn: bool,
    pub path: PathBuf,
    /// Markie's version, kept beside the file, for "Compare".
    pub conflict: Option<PathBuf>,
}

#[derive(Debug, Default)]
pub struct Status {
    pub live: HashMap<PathBuf, Live>,
    /// Files a round rewrote, with the text written, for an open editor.
    pub wrote: Vec<(PathBuf, String)>,
    pub notices: Vec<Notice>,
    /// The grant was revoked: connect again.
    pub reconnect: bool,
    /// The last call couldn't reach Google.
    pub offline: bool,
    pub detect: Option<Detect>,
    /// Bumped on every change, so the window knows to redraw.
    pub generation: u64,
    pub running: bool,
}

/// What a round needs, made on the worker's own thread.
pub trait Env {
    fn src(&self) -> &dyn SyncSource;
    fn db(&self) -> &Connection;
    fn history(&self) -> Option<&History> {
        None
    }
    /// Remember how changes are found, for the next launch.
    fn save_detect(&self, _d: Detect) {}
}

pub struct Worker {
    tx: Sender<Cmd>,
    pub status: Arc<Mutex<Status>>,
    thread: Option<std::thread::JoinHandle<()>>,
}

#[derive(Debug, Clone)]
pub struct Timing {
    /// How often the thread wakes to check what's due.
    pub tick: Duration,
    pub poll: Duration,
    pub debounce: Duration,
}

impl Default for Timing {
    fn default() -> Self {
        Self { tick: Duration::from_millis(500), poll: crate::sync::POLL, debounce: crate::sync::DEBOUNCE }
    }
}

impl Worker {
    /// Start the thread. `make` builds the environment on that thread.
    pub fn spawn(make: impl FnOnce() -> Option<Box<dyn Env>> + Send + 'static, timing: Timing, detect: Option<Detect>) -> Self {
        let (tx, rx) = channel();
        let status = Arc::new(Mutex::new(Status { running: true, detect, ..Default::default() }));
        let st = status.clone();
        let thread = std::thread::Builder::new()
            .name("markie-google-sync".into())
            .spawn(move || {
                if let Some(env) = make() {
                    run(&*env, &rx, &st, timing, detect);
                }
                if let Ok(mut s) = st.lock() {
                    s.running = false;
                    s.live.clear();
                    s.generation += 1;
                }
            })
            .ok();
        Self { tx, status, thread }
    }

    pub fn send(&self, cmd: Cmd) {
        let _ = self.tx.send(cmd);
    }

    /// Stop and wait for the round in progress to end.
    pub fn stop(mut self) {
        let _ = self.tx.send(Cmd::Stop);
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

impl Drop for Worker {
    fn drop(&mut self) {
        let _ = self.tx.send(Cmd::Stop);
    }
}

fn two_way(db: &Connection) -> Vec<(PathBuf, store::SyncRecord)> {
    store::all(db).unwrap_or_default().into_iter().filter(|(_, r)| r.two_way && r.stopped.is_none()).collect()
}

fn bump(st: &Mutex<Status>, f: impl FnOnce(&mut Status)) {
    if let Ok(mut s) = st.lock() {
        f(&mut s);
        s.generation += 1;
    }
}

fn name(p: &Path) -> String {
    p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()
}

fn run(env: &dyn Env, rx: &Receiver<Cmd>, st: &Mutex<Status>, timing: Timing, detect: Option<Detect>) {
    let mut sched = Scheduler::default();
    sched.interval = Some(timing.poll);
    sched.debounce = Some(timing.debounce);
    let mut detector = Detector::new(detect);
    let mut stopped = false;
    while !stopped {
        let mut cmds = Vec::new();
        match rx.recv_timeout(timing.tick) {
            Ok(c) => cmds.push(c),
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => break,
        }
        cmds.extend(rx.try_iter());
        let now = Instant::now();
        let records = two_way(env.db());
        let synced = |p: &Path| records.iter().any(|(q, _)| q == p);
        for c in cmds {
            match c {
                Cmd::Saved(p) if synced(&p) => {
                    sched.saved(&p, now);
                    bump(st, |s| {
                        s.live.insert(p, Live::Pending);
                    });
                }
                Cmd::Saved(_) => {}
                Cmd::Focus => sched.focus(),
                Cmd::SyncNow(ps) => ps.iter().for_each(|p| sched.changed(p)),
                Cmd::Hold(p, h) => sched.hold(&p, h),
                Cmd::Stop => stopped = true,
            }
        }
        if stopped {
            break;
        }
        if st.lock().is_ok_and(|s| s.reconnect) {
            continue;
        }
        for action in sched.due(now) {
            match action {
                Action::Poll => {
                    let records = two_way(env.db());
                    // Edits by other apps while Markie is open.
                    for (p, r) in &records {
                        if let Ok(text) = std::fs::read_to_string(p)
                            && !r.matches_base(&text)
                            && !sched.pending(p)
                        {
                            sched.changed(p);
                        } else if !p.exists() {
                            sched.changed(p);
                        }
                    }
                    match detector.poll(env.src(), &records, now) {
                        Ok(ids) => {
                            for (p, r) in &records {
                                if ids.contains(&r.doc_id) {
                                    sched.changed(p);
                                }
                            }
                            if let Some(m) = detector.mode
                                && st.lock().is_ok_and(|s| s.detect != Some(m))
                            {
                                env.save_detect(m);
                                bump(st, |s| s.detect = Some(m));
                            }
                            bump(st, |s| s.offline = false);
                        }
                        Err(GoogleError::Reconnect) => bump(st, |s| s.reconnect = true),
                        Err(e) if e.is_transient() => {
                            sched.pause_for(&e, now);
                            bump(st, |s| s.offline = true);
                        }
                        Err(_) => {}
                    }
                }
                Action::Sync(paths) => {
                    for p in paths {
                        bump(st, |s| {
                            s.live.insert(p.clone(), Live::Sending);
                        });
                        let result = sync_doc(env.src(), env.db(), &p, chrono::Local::now(), env.history());
                        let now = Instant::now();
                        sched.done(&p, &result.as_ref().map(|_| ()).map_err(Clone::clone), now);
                        bump(st, |s| {
                            s.live.remove(&p);
                            match &result {
                                Ok(r) => {
                                    s.offline = false;
                                    if r.requests > 0 {
                                        sched.wrote(now);
                                    }
                                    if matches!(r.outcome, Synced::Pulled | Synced::Pushed { pulled: true } | Synced::Conflict { .. })
                                        && let Ok(text) = std::fs::read_to_string(&p)
                                    {
                                        s.wrote.push((p.clone(), text));
                                    }
                                    match &r.outcome {
                                        Synced::Conflict { copy, .. } => s.notices.push(Notice {
                                            text: format!("\u{201c}{}\u{201d} changed in Google and here in the same place. Google\u{2019}s text is in the file; yours is kept as \u{201c}{}\u{201d}.", name(&p), name(copy)),
                                            warn: true,
                                            path: p.clone(),
                                            conflict: Some(copy.clone()),
                                        }),
                                        Synced::Stopped(why) => {
                                            sched.forget(&p);
                                            s.notices.push(Notice { text: format!("\u{201c}{}\u{201d}: {}", name(&p), stopped_line(*why)), warn: *why != Stopped::FileDeleted, path: p.clone(), conflict: None });
                                        }
                                        _ => {}
                                    }
                                }
                                Err(GoogleError::Reconnect) => s.reconnect = true,
                                Err(e) if e.is_transient() => {
                                    s.offline = matches!(e, GoogleError::Network(_) | GoogleError::Timeout);
                                    s.live.insert(p.clone(), Live::Waiting);
                                }
                                Err(_) => {}
                            }
                        });
                        if st.lock().is_ok_and(|s| s.reconnect) {
                            break;
                        }
                    }
                }
            }
        }
        // Rows waiting on a retry say so.
        let records = two_way(env.db());
        bump(st, |s| {
            for (p, _) in &records {
                if sched.retrying(p) && s.live.get(p) != Some(&Live::Sending) {
                    s.live.insert(p.clone(), Live::Waiting);
                } else if !sched.retrying(p) && s.live.get(p) == Some(&Live::Waiting) {
                    s.live.remove(p);
                }
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api::GoogleApi;
    use crate::fake::FakeGoogle;
    use crate::tokens::Grant;
    use markie_vault::device::MemorySecretStore;
    use serde_json::json;

    struct TestEnv {
        db: Connection,
        api: GoogleApi<'static, MemorySecretStore>,
    }

    impl Env for TestEnv {
        fn src(&self) -> &dyn SyncSource {
            &self.api
        }
        fn db(&self) -> &Connection {
            &self.db
        }
    }

    fn wait(st: &Mutex<Status>, what: impl Fn(&Status) -> bool) -> bool {
        for _ in 0..400 {
            if what(&st.lock().unwrap()) {
                return true;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        false
    }

    #[test]
    fn a_save_reaches_google_after_the_debounce_and_a_google_edit_comes_back() {
        let google = FakeGoogle::start();
        let dir = tempfile::tempdir().unwrap();
        let dbfile = dir.path().join("registry.db");
        let cfg: &'static _ = Box::leak(Box::new(google.config()));
        let grant: &'static _ = Box::leak(Box::new(Grant::new(MemorySecretStore::default())));
        google.add_doc("d1", "Plan", 1, json!({"tabs": [{"documentTab": {"body": {"content": [{"paragraph": {"elements": [{"textRun": {"content": "One\n", "textStyle": {}}}], "paragraphStyle": {"namedStyleType": "NORMAL_TEXT"}}}]}}}]}));
        google.set_pick(&["d1"]);
        crate::connect::connect_and_pick(cfg, grant, None, &|url| {
            let url = url.to_string();
            std::thread::spawn(move || FakeGoogle::browse(&url));
        }, &std::sync::atomic::AtomicBool::new(false), Duration::from_secs(20))
        .unwrap();
        let path = {
            let db = Connection::open(&dbfile).unwrap();
            let api = GoogleApi::new(cfg, grant);
            let r = crate::import::import_picked(&api, &db, &dir.path().join("G"), &["d1".into()], chrono::Local::now(), true, &mut |_| {}, &Default::default()).unwrap();
            r.imported[0].path.clone()
        };
        let worker = Worker::spawn(
            move || Some(Box::new(TestEnv { db: Connection::open(&dbfile).unwrap(), api: GoogleApi::new(cfg, grant) }) as Box<dyn Env>),
            Timing { tick: Duration::from_millis(10), poll: Duration::from_millis(200), debounce: Duration::from_millis(50) },
            None,
        );
        std::fs::write(&path, "One, from Markie\n").unwrap();
        worker.send(Cmd::Saved(path.clone()));
        let gm = || google.markdown("d1");
        for _ in 0..400 {
            if gm() == "One, from Markie\n" {
                break;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        assert_eq!(gm(), "One, from Markie\n");
        google.collaborate("d1", &[json!({"insertText": {"location": {"index": 1}, "text": "Yes. "}})]);
        worker.send(Cmd::Focus);
        assert!(wait(&worker.status, |s| s.wrote.iter().any(|(_, t)| t == "Yes. One, from Markie\n")));
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "Yes. One, from Markie\n");
        // Unsaved edits hold the file; the trash stops it with a notice.
        google.trash("d1");
        worker.send(Cmd::SyncNow(vec![path.clone()]));
        assert!(wait(&worker.status, |s| s.notices.iter().any(|n| n.text.contains("trash"))));
        worker.stop();
    }
}
