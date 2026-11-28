//! Opening and saving one document, with the bytes-in, bytes-out guarantee:
//! a text file comes back with the encoding, BOM and line endings it had.

use std::path::{Path, PathBuf};

use crate::disk::content_hash;
use crate::drafts::Drafts;
use crate::formats::{DecodedText, Editing, FormatKind, Representation, TextEncoding, check_text, classify, decode_text_owned, encode_text};
use crate::history::{History, Writer};
use crate::save::atomic_write;

/// What the document pane needs to show a file.
#[derive(Clone, Debug)]
pub enum Content {
    /// Editable text, with how to write it back.
    Text { text: String, encoding: TextEncoding, bom: bool },
    /// A format this build can show but not edit yet (Office documents).
    Engine,
    /// HTML: shown, never edited, matching the Electron app.
    Html(String),
}

#[derive(Clone, Debug)]
pub struct Document {
    pub path: PathBuf,
    pub format: FormatKind,
    pub content: Content,
    pub size: u64,
    /// The file's modified time, read with `size` before its bytes, so a
    /// later write moves it ([`crate::disk::DiskMemory::remember_read`]).
    pub modified: Option<std::time::SystemTime>,
}

impl Document {
    /// Large documents open in Source only, as in the Electron app.
    pub fn is_large(&self) -> bool {
        self.size >= LARGE_DOC_BYTES
    }
}

/// At or above this a file opens in Source only (`electron/doc-tiers.js`).
pub const LARGE_DOC_BYTES: u64 = 1_000_000;
/// At or above this Markie refuses the file and says so.
pub const MAX_DOC_BYTES: u64 = 100_000_000;

#[derive(Debug)]
pub enum OpenError {
    TooLarge(u64),
    Io(std::io::Error),
    Text(crate::formats::TextError),
    Unsupported,
}

impl std::fmt::Display for OpenError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            OpenError::TooLarge(n) => write!(
                f,
                "This file is {} MB. Markie opens files up to {} MB.",
                n / 1_000_000,
                MAX_DOC_BYTES / 1_000_000
            ),
            OpenError::Io(e) => write!(f, "Markie could not read this file: {e}"),
            OpenError::Text(e) => write!(f, "{e}"),
            OpenError::Unsupported => f.write_str("Markie does not open this kind of file."),
        }
    }
}

impl std::error::Error for OpenError {}

pub fn open(path: &Path) -> Result<Document, OpenError> {
    // One spelling per file: a relative path from the command line must not
    // become a second registry row or a confusing status bar.
    let path = &std::path::absolute(path).unwrap_or_else(|_| path.to_path_buf());
    let format = classify(&path.to_string_lossy());
    if format == FormatKind::Unsupported {
        return Err(OpenError::Unsupported);
    }
    let meta = std::fs::metadata(path).map_err(OpenError::Io)?;
    let (size, modified) = (meta.len(), meta.modified().ok());
    if size >= MAX_DOC_BYTES {
        return Err(OpenError::TooLarge(size));
    }
    let content = match (format, format.representation(), format.editing()) {
        (FormatKind::Unsupported, ..) => return Err(OpenError::Unsupported),
        (FormatKind::Html, ..) => {
            let bytes = std::fs::read(path).map_err(OpenError::Io)?;
            Content::Html(String::from_utf8_lossy(&bytes).into_owned())
        }
        (_, Representation::Text, _) => {
            let bytes = std::fs::read(path).map_err(OpenError::Io)?;
            let DecodedText { text, encoding, bom, .. } = decode_text_owned(bytes).map_err(OpenError::Text)?;
            Content::Text { text, encoding, bom }
        }
        (_, _, Editing::Engine) => Content::Engine,
        _ => return Err(OpenError::Unsupported),
    };
    Ok(Document { path: path.to_path_buf(), format, content, size, modified })
}

/// Write `text` back in the document's own encoding.
pub fn save_text(path: &Path, text: &str, encoding: TextEncoding, bom: bool) -> anyhow::Result<()> {
    if encoding == TextEncoding::Utf8 && !bom {
        // The bytes are the text's own: no second copy of a large document.
        check_text(text)?;
        atomic_write(path, text.as_bytes())?;
        return Ok(());
    }
    let bytes = encode_text(text, encoding, bom)?;
    atomic_write(path, &bytes)?;
    Ok(())
}

/// What a save done off the main thread hands back: the text now on disk
/// (the document's new saved text, not copied again) and its
/// [`crate::disk::content_hash`].
#[derive(Debug)]
pub struct WrittenText {
    pub text: String,
    pub hash: u64,
}

/// A whole save of a text document, for a background thread. Keeps what the
/// file says now as a version, writes `text` in the document's encoding and
/// hashes it for [`crate::disk::DiskMemory`]. The version's read of the old
/// bytes comes first; then the version, the write and the hash run side by
/// side, so a 100 MB save costs about its slowest part rather than the sum.
/// With `draft`, the text goes to the crash journal first and is cleared once
/// the write lands, as autosave does on the main thread.
pub fn write_text_document(
    history: &History,
    path: &Path,
    text: String,
    encoding: TextEncoding,
    bom: bool,
    draft: Option<&Drafts>,
) -> anyhow::Result<WrittenText> {
    if let Some(drafts) = draft {
        let _ = drafts.save(Some(path), &text);
    }
    let previous = History::read_previous(path);
    let (written, hash) = std::thread::scope(|s| {
        let version = s.spawn(|| {
            let _ = history.capture_previous(path, &text, Writer::User, previous);
        });
        let hash = s.spawn(|| content_hash(text.as_bytes()));
        let written = save_text(path, &text, encoding, bom);
        let _ = version.join();
        (written, hash.join().expect("hash thread"))
    });
    written?;
    if let Some(drafts) = draft {
        let _ = drafts.discard(&Drafts::key_for(Some(path)));
    }
    Ok(WrittenText { text, hash })
}

/// A [`write_text_document`] on its own thread, for a save that must not hold
/// the main thread. Nothing is lost by dropping it: the thread still writes.
/// [`TextWrite::finish`] waits for the write to land, which is what quitting
/// does with a save still running.
pub struct TextWrite {
    thread: Option<std::thread::JoinHandle<anyhow::Result<WrittenText>>>,
}

impl TextWrite {
    /// `text` makes the text on the thread (copying it out of an editor's
    /// rope there); `done` runs on the thread once the write has landed or
    /// failed, to wake whoever waits for it.
    pub fn start(
        history: std::sync::Arc<History>,
        path: PathBuf,
        text: impl FnOnce() -> String + Send + 'static,
        encoding: TextEncoding,
        bom: bool,
        draft: Option<Drafts>,
        done: impl FnOnce() + Send + 'static,
    ) -> std::io::Result<Self> {
        let thread = std::thread::Builder::new().name("markie-save".into()).spawn(move || {
            let result = write_text_document(&history, &path, text(), encoding, bom, draft.as_ref());
            done();
            result
        })?;
        Ok(Self { thread: Some(thread) })
    }

    /// Wait for the write and return what it wrote.
    pub fn finish(mut self) -> anyhow::Result<WrittenText> {
        match self.thread.take().map(|t| t.join()) {
            Some(Ok(result)) => result,
            _ => Err(anyhow::anyhow!("the save stopped before it finished")),
        }
    }
}

/// A name for a new document that does not collide with one in `dir`.
pub fn untitled_path(dir: &Path, extension: &str) -> PathBuf {
    let first = dir.join(format!("Untitled.{extension}"));
    if !first.exists() {
        return first;
    }
    (2..)
        .map(|n| dir.join(format!("Untitled {n}.{extension}")))
        .find(|p| !p.exists())
        .expect("an unused name exists")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicBool, Ordering};

    fn versions(history: &History, path: &Path) -> Vec<String> {
        history.list(path).iter().filter_map(|v| history.read(path, &v.stamp)).collect()
    }

    /// The save done off the main thread lands the exact bytes, keeps what
    /// the file said before as a version, and hands back the text and the
    /// hash the disk check needs.
    #[test]
    fn a_background_save_writes_exact_bytes_and_keeps_the_old_version() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("big.md");
        std::fs::write(&path, "old\r\nlines\r\n").unwrap();
        let history = History::new(&dir.path().join("data"));
        let next = "new\r\nlines 中文\r\n".to_string();
        let written = write_text_document(&history, &path, next.clone(), TextEncoding::Utf8, false, None).unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), next.as_bytes());
        assert_eq!(written.text, next);
        assert_eq!(written.hash, content_hash(next.as_bytes()));
        assert_eq!(versions(&history, &path), vec!["old\r\nlines\r\n".to_string()]);
        // The same text again keeps no second copy of it.
        write_text_document(&history, &path, next.clone(), TextEncoding::Utf8, false, None).unwrap();
        assert_eq!(versions(&history, &path).len(), 1);
        // A change keeps the text it replaces.
        write_text_document(&history, &path, "third".into(), TextEncoding::Utf8, false, None).unwrap();
        assert_eq!(versions(&history, &path), vec!["old\r\nlines\r\n".to_string(), next]);
    }

    #[test]
    fn a_background_save_keeps_the_encoding_and_bom() {
        let dir = tempfile::tempdir().unwrap();
        let history = History::new(&dir.path().join("data"));
        for (name, original) in [
            ("bom.md", b"\xef\xbb\xbfone\ntwo".to_vec()),
            ("le.txt", b"\xff\xfeo\x00k\x00\r\x00\n\x00".to_vec()),
            ("be.txt", b"\xfe\xff\x00o\x00k".to_vec()),
        ] {
            let path = dir.path().join(name);
            std::fs::write(&path, &original).unwrap();
            let Content::Text { text, encoding, bom } = open(&path).unwrap().content else { panic!("text") };
            write_text_document(&history, &path, text, encoding, bom, None).unwrap();
            assert_eq!(std::fs::read(&path).unwrap(), original, "{name}");
        }
    }

    /// A large document is a few hundred thousand lines over many buffers:
    /// the bytes and the version still match exactly.
    #[test]
    fn a_background_save_of_a_large_text_is_exact() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("large.txt");
        let old: String = (0..120_000).map(|i| format!("line {i} of the old text\n")).collect();
        std::fs::write(&path, &old).unwrap();
        let history = History::new(&dir.path().join("data"));
        let next: String = (0..120_000).map(|i| format!("line {i} edited\r\n")).collect();
        write_text_document(&history, &path, next.clone(), TextEncoding::Utf8, false, None).unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), next.as_bytes());
        assert_eq!(versions(&history, &path), vec![old]);
    }

    /// Autosave's draft holds the text until the write lands, and stays when
    /// the write fails.
    #[test]
    fn an_autosave_draft_is_cleared_only_when_the_write_lands() {
        let dir = tempfile::tempdir().unwrap();
        let drafts = Drafts::new(&dir.path().join("data"));
        let history = History::new(&dir.path().join("data"));
        let path = dir.path().join("a.md");
        std::fs::write(&path, "before").unwrap();
        write_text_document(&history, &path, "after".into(), TextEncoding::Utf8, false, Some(&drafts)).unwrap();
        assert_eq!(drafts.read(&Drafts::key_for(Some(&path))), None);
        let missing = dir.path().join("no-such-folder").join("b.md");
        assert!(write_text_document(&history, &missing, "unsaved".into(), TextEncoding::Utf8, false, Some(&drafts)).is_err());
        assert_eq!(drafts.read(&Drafts::key_for(Some(&missing))).as_deref(), Some("unsaved"));
    }

    /// Quitting with a save still running waits for it: `finish` returns only
    /// once the new bytes are on disk, however slow the copy of the text.
    #[test]
    fn finishing_a_running_save_waits_for_the_bytes() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("slow.md");
        std::fs::write(&path, "old").unwrap();
        let history = Arc::new(History::new(&dir.path().join("data")));
        let woke = Arc::new(AtomicBool::new(false));
        let flag = woke.clone();
        let write = TextWrite::start(
            history.clone(),
            path.clone(),
            || {
                std::thread::sleep(std::time::Duration::from_millis(300));
                "new".to_string()
            },
            TextEncoding::Utf8,
            false,
            None,
            move || flag.store(true, Ordering::SeqCst),
        )
        .unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"old");
        let written = write.finish().unwrap();
        assert_eq!(written.text, "new");
        assert_eq!(std::fs::read(&path).unwrap(), b"new");
        assert!(woke.load(Ordering::SeqCst));
        assert_eq!(versions(&history, &path), vec!["old".to_string()]);
    }

    #[test]
    fn a_save_refuses_control_characters_and_writes_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("a.md");
        std::fs::write(&path, "kept").unwrap();
        assert!(save_text(&path, "bad\u{1}", TextEncoding::Utf8, false).is_err());
        assert_eq!(std::fs::read(&path).unwrap(), b"kept");
    }

    #[test]
    fn text_round_trips_through_open_and_save() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("note.md");
        let original = b"\xef\xbb\xbf# Hi\r\nthere\r\n";
        std::fs::write(&path, original).unwrap();
        let doc = open(&path).unwrap();
        let Content::Text { text, encoding, bom } = doc.content else { panic!("text") };
        assert_eq!(doc.format, FormatKind::Markdown);
        save_text(&path, &text, encoding, bom).unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), original);
    }

    /// `electron/doc-tiers.js`: both limits are "at or above".
    #[test]
    fn size_tiers_match_doc_tiers() {
        let dir = tempfile::tempdir().unwrap();
        // Sparse, for the sizes only the size check reads.
        let sized = |name: &str, len: u64| {
            let p = dir.path().join(name);
            std::fs::File::create(&p).unwrap().set_len(len).unwrap();
            p
        };
        let text = |name: &str, len: u64| {
            let p = dir.path().join(name);
            std::fs::write(&p, vec![b'a'; len as usize]).unwrap();
            p
        };
        assert!(!open(&text("under.md", LARGE_DOC_BYTES - 1)).unwrap().is_large());
        assert!(open(&text("large.md", LARGE_DOC_BYTES)).unwrap().is_large());
        assert!(matches!(open(&sized("huge.md", MAX_DOC_BYTES)), Err(OpenError::TooLarge(n)) if n == MAX_DOC_BYTES));
        assert!(!matches!(open(&sized("just-under.txt", MAX_DOC_BYTES - 1)), Err(OpenError::TooLarge(_))));
    }

    #[test]
    fn office_and_unknown_files() {
        let dir = tempfile::tempdir().unwrap();
        let docx = dir.path().join("a.docx");
        std::fs::write(&docx, b"PK\x03\x04").unwrap();
        assert!(matches!(open(&docx).unwrap().content, Content::Engine));
        assert!(matches!(open(&dir.path().join("a.png")), Err(OpenError::Unsupported)));
    }

    #[test]
    fn untitled_names_do_not_collide() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(untitled_path(dir.path(), "md").file_name().unwrap(), "Untitled.md");
        std::fs::write(dir.path().join("Untitled.md"), "").unwrap();
        assert_eq!(untitled_path(dir.path(), "md").file_name().unwrap(), "Untitled 2.md");
    }
}
