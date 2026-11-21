//! Copying a secret out of the vault: `electron/secret-clipboard.js` in Rust.
//!
//! The clear runs on its own timer, so it still happens when Markie RS has lost
//! focus to Terminal. Only a SHA-256 fingerprint is kept, never the value, and
//! the clipboard is cleared only if it still holds that exact value: whatever
//! the user copied since is left alone. Lock and quit call `clear_now`.
use sha2::{Digest, Sha256};
use std::sync::{Arc, Mutex};
use std::time::Duration;

pub const CLEAR_AFTER: Duration = Duration::from_secs(30);
/// UTF-16 code units, like the JavaScript limit.
pub const MAX_SECRET_CHARS: usize = 64 * 1024;

pub trait Clipboard: Send + Sync {
    fn read_text(&self) -> Option<String>;
    fn write_secret(&self, text: &str);
    fn clear(&self);
}

/// Runs `job` once after `delay`. A thread in the app, manual in tests.
pub trait Scheduler: Send + Sync {
    fn schedule(&self, delay: Duration, job: Box<dyn FnOnce() + Send>);
}

pub struct ThreadScheduler;

impl Scheduler for ThreadScheduler {
    fn schedule(&self, delay: Duration, job: Box<dyn FnOnce() + Send>) {
        std::thread::spawn(move || {
            std::thread::sleep(delay);
            job();
        });
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CopyError {
    NothingToCopy,
}

struct Pending {
    fingerprint: [u8; 32],
    generation: u64,
}

struct Inner {
    clipboard: Box<dyn Clipboard>,
    pending: Mutex<(Option<Pending>, u64)>,
}

impl Inner {
    /// Clears only if this copy is still the pending one and the clipboard still holds it.
    fn clear_if_unchanged(&self, generation: Option<u64>) -> bool {
        let fingerprint = {
            let mut guard = self.pending.lock().unwrap();
            match &guard.0 {
                Some(p) if generation.is_none_or(|g| g == p.generation) => {
                    let f = p.fingerprint;
                    guard.0 = None;
                    f
                }
                _ => return false,
            }
        };
        match self.clipboard.read_text() {
            Some(current) if !current.is_empty() && digest(&current) == fingerprint => {
                self.clipboard.clear();
                true
            }
            _ => false,
        }
    }
}

fn digest(text: &str) -> [u8; 32] {
    Sha256::digest(text.as_bytes()).into()
}

#[derive(Clone)]
pub struct SecretClipboard {
    inner: Arc<Inner>,
    scheduler: Arc<dyn Scheduler>,
    clear_after: Duration,
}

impl SecretClipboard {
    pub fn new(clipboard: Box<dyn Clipboard>, scheduler: Arc<dyn Scheduler>, clear_after: Duration) -> Self {
        Self { inner: Arc::new(Inner { clipboard, pending: Mutex::new((None, 0)) }), scheduler, clear_after }
    }

    /// Copies `text` and schedules the clear. Returns how long until it clears.
    pub fn copy(&self, text: &str) -> Result<Duration, CopyError> {
        if text.is_empty() || crate::envelope::js_length(text) > MAX_SECRET_CHARS {
            return Err(CopyError::NothingToCopy);
        }
        let generation = {
            let mut guard = self.inner.pending.lock().unwrap();
            guard.1 += 1;
            guard.0 = Some(Pending { fingerprint: digest(text), generation: guard.1 });
            guard.1
        };
        self.inner.clipboard.write_secret(text);
        let inner = Arc::downgrade(&self.inner);
        self.scheduler.schedule(
            self.clear_after,
            Box::new(move || {
                if let Some(inner) = inner.upgrade() {
                    inner.clear_if_unchanged(Some(generation));
                }
            }),
        );
        Ok(self.clear_after)
    }

    /// Lock and quit: clear now if the clipboard still holds the secret.
    pub fn clear_now(&self) -> bool {
        self.inner.clear_if_unchanged(None)
    }

    pub fn has_pending(&self) -> bool {
        self.inner.pending.lock().unwrap().0.is_some()
    }
}

/// The general pasteboard. The secret is also marked with
/// `org.nspasteboard.ConcealedType`, which clipboard managers honour by not
/// keeping it in their history. Electron did not set this marker.
#[cfg(target_os = "macos")]
pub struct MacPasteboard;

#[cfg(target_os = "macos")]
impl Clipboard for MacPasteboard {
    fn read_text(&self) -> Option<String> {
        use objc2_app_kit::{NSPasteboard, NSPasteboardTypeString};
        unsafe { NSPasteboard::generalPasteboard().stringForType(NSPasteboardTypeString).map(|s| s.to_string()) }
    }
    fn write_secret(&self, text: &str) {
        use objc2_app_kit::{NSPasteboard, NSPasteboardTypeString};
        use objc2_foundation::NSString;
        unsafe {
            let board = NSPasteboard::generalPasteboard();
            board.clearContents();
            board.setString_forType(&NSString::from_str(text), NSPasteboardTypeString);
            board.setString_forType(&NSString::from_str(""), &NSString::from_str("org.nspasteboard.ConcealedType"));
        }
    }
    fn clear(&self) {
        use objc2_app_kit::NSPasteboard;
        NSPasteboard::generalPasteboard().clearContents();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Default)]
    struct FakeClipboard(Mutex<Option<String>>);
    impl Clipboard for Arc<FakeClipboard> {
        fn read_text(&self) -> Option<String> {
            self.0.lock().unwrap().clone()
        }
        fn write_secret(&self, text: &str) {
            *self.0.lock().unwrap() = Some(text.to_string());
        }
        fn clear(&self) {
            *self.0.lock().unwrap() = None;
        }
    }

    #[derive(Default)]
    struct ManualScheduler(Mutex<Vec<(Duration, Box<dyn FnOnce() + Send>)>>);
    impl Scheduler for ManualScheduler {
        fn schedule(&self, delay: Duration, job: Box<dyn FnOnce() + Send>) {
            self.0.lock().unwrap().push((delay, job));
        }
    }
    impl ManualScheduler {
        fn fire_all(&self) {
            let jobs: Vec<_> = self.0.lock().unwrap().drain(..).collect();
            for (_, job) in jobs {
                job();
            }
        }
    }

    fn setup() -> (Arc<FakeClipboard>, Arc<ManualScheduler>, SecretClipboard) {
        let board = Arc::new(FakeClipboard::default());
        let scheduler = Arc::new(ManualScheduler::default());
        let secret = SecretClipboard::new(Box::new(board.clone()), scheduler.clone(), CLEAR_AFTER);
        (board, scheduler, secret)
    }

    #[test]
    fn clears_after_the_timer_if_unchanged() {
        let (board, scheduler, secret) = setup();
        assert_eq!(secret.copy("fixture-secret").unwrap(), CLEAR_AFTER);
        assert_eq!(scheduler.0.lock().unwrap()[0].0, CLEAR_AFTER);
        assert!(secret.has_pending());
        scheduler.fire_all();
        assert_eq!(board.read_text(), None);
        assert!(!secret.has_pending());
    }

    #[test]
    fn leaves_what_the_user_copied_since() {
        let (board, scheduler, secret) = setup();
        secret.copy("fixture-secret").unwrap();
        board.write_secret("something else");
        scheduler.fire_all();
        assert_eq!(board.read_text().as_deref(), Some("something else"));
    }

    #[test]
    fn a_new_copy_replaces_the_old_timer_and_clear_now_works() {
        let (board, scheduler, secret) = setup();
        secret.copy("first").unwrap();
        secret.copy("second").unwrap();
        // The first timer fires but belongs to a replaced copy.
        let first = scheduler.0.lock().unwrap().remove(0);
        (first.1)();
        assert_eq!(board.read_text().as_deref(), Some("second"));
        assert!(secret.clear_now());
        assert_eq!(board.read_text(), None);
        assert!(!secret.clear_now());
        assert_eq!(secret.copy("").unwrap_err(), CopyError::NothingToCopy);
        assert_eq!(secret.copy(&"x".repeat(MAX_SECRET_CHARS + 1)).unwrap_err(), CopyError::NothingToCopy);
    }
}
